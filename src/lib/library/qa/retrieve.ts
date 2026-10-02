import path from "node:path";

import { getPrismaClient } from "@/lib/db/prisma";
import { compareDocumentVersions, documentSignalVersion } from "@/lib/bridge/document-signals";
import { getDocumentVersionSignals, getEffectiveDocumentSignals, getSeparatedRelationshipPairIdentities, humanIdentityCorrectionVersion, knowledgeRelationshipPairKey, relationshipGenerationVersion } from "@/lib/bridge/persistent-knowledge";
import { workingKnowledgeTerms } from "@/lib/bridge/scan-working-knowledge";
import { searchLibrary } from "@/lib/library/search";
import { librarySearchIndexVersion } from "@/lib/library/search-index";
import { routeLibraryQuestion } from "./route-question";
import { maxAnswerSources, type AnswerContext, type AnswerContextSource, type AnswerVersion } from "./types";

type StoredExcerpt = { start: number; end: number; text: string };

function excerpts(value: unknown): StoredExcerpt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => item && typeof item === "object" &&
    typeof item.start === "number" && typeof item.end === "number" &&
    typeof item.text === "string" && item.text.length <= 240 &&
    item.end - item.start === item.text.length
      ? [{ start: item.start, end: item.end, text: item.text }] : []).slice(0, 8);
}

function bestExcerpt(value: unknown, terms: string[]) {
  const available = excerpts(value);
  return available.sort((a, b) => {
    const score = (item: StoredExcerpt) => terms.filter((term) =>
      workingKnowledgeTerms(item.text).includes(term)).length;
    return score(b) - score(a) || a.start - b.start;
  })[0] ?? null;
}

const readableRoot = {
  isEnabled: true, readPermission: true, status: "CONNECTED" as const,
  disconnectedAt: null, hiddenFromActiveListAt: null, mergedAt: null,
  canonicalConnectedLibraryId: null,
};

const activeScanStatuses = [
  "PENDING", "SCANNING", "READING", "EXAMINING", "GENERATING_SUGGESTIONS",
] as const;

export async function retrieveQuestionContext(question: string, permittedRootIds?: string[]): Promise<AnswerContext> {
  const route = routeLibraryQuestion(question);
  const prisma = getPrismaClient();
  const roots = await prisma.connectedLibrary.findMany({
    select: { id: true, displayName: true, scanSessions: {
      select: { id: true, searchIndexStatus: true, startedAt: true }, take: 1,
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      where: { status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] } },
    } },
    where: { ...readableRoot, ...(permittedRootIds ? { id: { in: permittedRootIds } } : {}) },
  });
  const rootById = new Map(roots.map((root) => [root.id, root]));
  const rootIds = roots.map((root) => root.id);
  const latestIds = new Set(roots.flatMap((root) => root.scanSessions.map((session) => session.id)));
  if (!rootIds.length) return { route, sources: [], relationships: [], versions: [],
    indexIncomplete: false, ambiguousEntity: false };
  const newerActiveSessions = await Promise.all(roots.map((root) => prisma.scanSession.findFirst({
    where: { connectedFolderId: root.id, status: { in: [...activeScanStatuses] },
      ...(root.scanSessions[0] ? { OR: [
        { startedAt: { gt: root.scanSessions[0].startedAt } },
        { startedAt: root.scanSessions[0].startedAt, id: { gt: root.scanSessions[0].id } },
      ] } : {}) },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  })));
  const indexIncomplete = roots.some((root, index) => !root.scanSessions.length ||
    root.scanSessions[0].searchIndexStatus !== "COMPLETED" ||
    Boolean(newerActiveSessions[index]));

  const results = await searchLibrary(route.searchQuery, rootIds, {
    includeEntityMatches: true,
    // Search remains display-bounded, but Ask must see every candidate from the
    // bounded retrieval window before deciding whether an entity is ambiguous.
    includeAllEntityMatches: true,
    includeAllVersionMatches: route.kind === "VERSION",
  });
  const requestedHashesByResultId = new Map(results.flatMap((result) =>
    result.matchedEntityHashes?.length ? [[result.id, result.matchedEntityHashes] as const] : []));
  const indexIds = results.filter((result) => result.kind === "FILE").map((result) => result.id);
  const [entries, memories, metadataFiles] = await Promise.all([
    prisma.librarySearchEntry.findMany({
      where: { id: { in: indexIds }, connectedLibraryId: { in: rootIds },
        indexVersion: librarySearchIndexVersion, connectedLibrary: readableRoot,
        scannedFile: { sourceUnavailableAt: null } },
      include: { scannedFile: { select: { libraryDocumentId: true, checksum: true,
        relativePath: true, sessionId: true, scanSession: { select: { connectedFolderId: true } } } } },
    }),
    prisma.memoryEntry.findMany({
      where: { id: { in: results.filter((result) => result.kind === "MEMORY").map((result) => result.id) },
        status: "ACTIVE", searchProvenanceComplete: true,
        searchSources: { some: {}, every: {
          connectedLibraryId: { in: rootIds },
          observationSession: { status: { in: ["APPROVED", "MODIFIED"] } },
        } } },
      include: { searchSources: { select: { connectedLibraryId: true, observationSession: {
        select: { status: true, libraryDocument: { select: { scannedFiles: {
          select: { checksum: true, relativePath: true, scanSession: { select: { connectedFolderId: true } } },
        } } } },
      } } } },
    }),
    prisma.scannedFile.findMany({
      where: { id: { in: indexIds }, sourceUnavailableAt: null,
        scanSession: { connectedFolderId: { in: rootIds }, connectedFolder: readableRoot } },
      select: { id: true, checksum: true, relativePath: true, sessionId: true,
        scanSession: { select: { connectedFolderId: true } } },
    }),
  ]);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const memoriesById = new Map(memories.map((entry) => [entry.id, entry]));
  const metadataById = new Map(metadataFiles.map((file) => [file.id, file]));
  const eligibleMatchedEntries = results.flatMap((result) => {
    if (result.kind !== "FILE" || !requestedHashesByResultId.has(result.id)) return [];
    const entry = entriesById.get(result.id);
    return entry && rootById.has(entry.connectedLibraryId) &&
      entry.checksum === entry.scannedFile.checksum &&
      entry.relativePath === entry.scannedFile.relativePath &&
      entry.scanSessionId === entry.scannedFile.sessionId &&
      entry.connectedLibraryId === entry.scannedFile.scanSession.connectedFolderId &&
      (route.wantsHistory || entry.isCurrent && latestIds.has(entry.scanSessionId))
      ? [entry] : [];
  });
  // Answer sources already collapse byte-identical copies by checksum. Apply
  // the same physical-source identity before counting request-bound hashes or
  // evaluating separations, choosing the first stable ranked authorized copy.
  // Distinct bytes remain distinct even when their typed entity names match.
  const ambiguityEntries = [...new Map(eligibleMatchedEntries.map((entry) => [
    entry.checksum ? `sha256:${entry.checksum}` : `${entry.connectedLibraryId}:${entry.fileKey}`,
    entry,
  ])).values()];
  const versionEntries = route.kind === "VERSION"
    ? [...new Map(results.flatMap((result) => {
      const entry = result.kind === "FILE" ? entriesById.get(result.id) : null;
      return entry && rootById.has(entry.connectedLibraryId) &&
      entry.checksum === entry.scannedFile.checksum &&
      entry.relativePath === entry.scannedFile.relativePath &&
      entry.scanSessionId === entry.scannedFile.sessionId &&
      entry.connectedLibraryId === entry.scannedFile.scanSession.connectedFolderId &&
      (route.wantsHistory || entry.isCurrent && latestIds.has(entry.scanSessionId))
        ? [[entry.checksum ? `sha256:${entry.checksum}` : `${entry.connectedLibraryId}:${entry.fileKey}`, entry] as const]
        : [];
    })).values()]
    : [];
  const [allVersionSignals, allSeparatedVersionPairs] = route.kind === "VERSION"
    ? await Promise.all([
      getDocumentVersionSignals(versionEntries, route.wantsHistory),
      getSeparatedRelationshipPairIdentities(versionEntries, ["PROBABLE_REVISION"]),
    ]) : [[], new Map<string, Set<string>>()];
  const versionEntryByEndpoint = new Map(versionEntries.map((entry) =>
    [`${entry.connectedLibraryId}\0${entry.fileKey}\0${entry.checksum}`, entry]));
  const versionFamilyMap = new Map<string, typeof allVersionSignals>();
  for (const signal of allVersionSignals) {
    if (!versionEntryByEndpoint.has(`${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`)) continue;
    const key = `${signal.connectedLibraryId}\0${signal.identityHash}`;
    versionFamilyMap.set(key, [...(versionFamilyMap.get(key) ?? []), signal]);
  }
  const versionFamilies = [...versionFamilyMap.values()]
    .filter((family) => family.length > 1)
    .sort((left, right) => {
      const leftKey = `${left[0].connectedLibraryId}\0${left[0].identityHash}`;
      const rightKey = `${right[0].connectedLibraryId}\0${right[0].identityHash}`;
      return leftKey.localeCompare(rightKey);
    });
  const assessedFamilies = versionFamilies.map((family) => {
    const comparisons = family.flatMap((left, index) => family.slice(index + 1).map((right) => ({
      left, right, order: compareDocumentVersions(left, right),
      separated: allSeparatedVersionPairs.has(knowledgeRelationshipPairKey(left, right)),
    })));
    const separated = comparisons.some((comparison) => comparison.separated);
    const ambiguous = comparisons.some((comparison) => comparison.order === null);
    const older = new Set(comparisons.flatMap((comparison) => comparison.order === null ? [] : [
      comparison.order === 1
        ? `${comparison.right.connectedLibraryId}\0${comparison.right.fileKey}\0${comparison.right.checksum}`
        : `${comparison.left.connectedLibraryId}\0${comparison.left.fileKey}\0${comparison.left.checksum}`,
    ]));
    const maxima = family.filter((signal) => !older.has(
      `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`));
    const maximum = !separated && !ambiguous && maxima.length === 1 ? maxima[0] : null;
    const olderSignals = maximum ? family.filter((signal) => signal !== maximum)
      .sort((left, right) => `${left.fileKey}\0${left.checksum}`.localeCompare(`${right.fileKey}\0${right.checksum}`)) : [];
    return { maximum, olderSignals, safe: Boolean(maximum), separated, family };
  });
  const assessableVersionEndpoints = new Set(assessedFamilies.flatMap((family) => !family.separated
    ? family.family.map((signal) =>
      `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`) : []));
  const reservedVersionEntryIds: string[] = [];
  // Give each safely ordered family a maximal-revision comparison before
  // reserving supplemental comparisons. This keeps the model context bounded
  // while preventing an early family from consuming the entire source budget.
  for (const family of assessedFamilies) {
    if (!family.maximum || !family.olderSignals[0]) continue;
    for (const signal of [family.maximum, family.olderSignals[0]]) {
      const entry = versionEntryByEndpoint.get(
        `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`);
      if (entry && !reservedVersionEntryIds.includes(entry.id) && reservedVersionEntryIds.length < maxAnswerSources) {
        reservedVersionEntryIds.push(entry.id);
      }
    }
  }
  for (const assessed of assessedFamilies) {
    if (assessed.safe || assessed.separated) continue;
    for (const signal of assessed.family.slice(0, 2)) {
      const entry = versionEntryByEndpoint.get(
        `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`);
      if (entry && !reservedVersionEntryIds.includes(entry.id) && reservedVersionEntryIds.length < maxAnswerSources) {
        reservedVersionEntryIds.push(entry.id);
      }
    }
  }
  for (const family of assessedFamilies) {
    for (const signal of family.olderSignals.slice(1)) {
      const entry = versionEntryByEndpoint.get(
        `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`);
      if (entry && !reservedVersionEntryIds.includes(entry.id) && reservedVersionEntryIds.length < maxAnswerSources) {
        reservedVersionEntryIds.push(entry.id);
      }
    }
  }
  const resultById = new Map(results.map((result) => [result.id, result]));
  const sourceResults = [...reservedVersionEntryIds.flatMap((id) => resultById.get(id) ?? []),
    ...results.filter((result) => !reservedVersionEntryIds.includes(result.id))];
  const sources: AnswerContextSource[] = [];
  const sourceEntryById = new Map<string, (typeof entries)[number]>();
  const physicalSeen = new Set<string>();
  for (const result of sourceResults) {
    if (sources.length >= maxAnswerSources) break;
    if (result.kind === "MEMORY") {
      const entry = memoriesById.get(result.id);
      if (!entry || !entry.searchSources.length || entry.searchSourceCount !== entry.searchSources.length ||
        entry.searchSources.some((source) => !rootById.has(source.connectedLibraryId) ||
          !["APPROVED", "MODIFIED"].includes(source.observationSession.status))) continue;
      sources.push({ id: `S${sources.length + 1}`, sourceType: "APPROVED_MEMORY",
        title: entry.title.slice(0, 160), rootName: [...new Set(entry.searchSources.map((source) =>
          rootById.get(source.connectedLibraryId)!.displayName))].sort((left, right) =>
          left.localeCompare(right)).join("; "),
        relativePath: null, href: "/admin/library/memory", trustState: "Human-approved Memory",
        timeState: "Active", text: `${entry.title}. ${entry.description}`.slice(0, 400),
        sourceRange: null, physicalIdentity: `memory:${entry.id}`,
        corroborationKeys: [...new Set(entry.searchSources.flatMap((source) =>
          source.observationSession.libraryDocument.scannedFiles
            .filter((file) => file.scanSession.connectedFolderId === source.connectedLibraryId)
            .map((file) => file.checksum ? `sha256:${file.checksum}` :
              `${source.connectedLibraryId}:${file.relativePath}`)))],
      });
      continue;
    }
    const entry = entriesById.get(result.id);
    if (entry) {
      const root = rootById.get(entry.connectedLibraryId);
      if (!root || entry.checksum !== entry.scannedFile.checksum ||
        entry.relativePath !== entry.scannedFile.relativePath ||
        entry.scanSessionId !== entry.scannedFile.sessionId ||
        entry.connectedLibraryId !== entry.scannedFile.scanSession.connectedFolderId ||
        (!route.wantsHistory && (!entry.isCurrent || !latestIds.has(entry.scanSessionId)))) continue;
      const physicalIdentity = entry.checksum ? `sha256:${entry.checksum}` : entry.fileKey;
      if (physicalSeen.has(physicalIdentity)) continue;
      physicalSeen.add(physicalIdentity);
      const excerpt = bestExcerpt(entry.sourceExcerpts, workingKnowledgeTerms(route.searchQuery));
      const source: AnswerContextSource = { id: `S${sources.length + 1}`,
        sourceType: excerpt ? "SOURCE_EXCERPT" : "FILE_METADATA",
        title: path.posix.basename(entry.relativePath), rootName: root.displayName,
        relativePath: entry.relativePath, href: result.href,
        trustState: entry.knowledgeState === "APPROVED" ? "Human reviewed" : "Provisional source evidence",
        timeState: entry.isCurrent ? "Current scan" : "Historical scan",
        text: excerpt?.text ?? `File name: ${path.posix.basename(entry.relativePath)}`,
        sourceRange: excerpt ? { start: excerpt.start, end: excerpt.end } : null,
        physicalIdentity, corroborationKeys: [physicalIdentity] };
      sources.push(source);
      sourceEntryById.set(source.id, entry);
      continue;
    }
    const file = metadataById.get(result.id);
    if (!file || !latestIds.has(file.sessionId)) continue;
    const root = rootById.get(file.scanSession.connectedFolderId);
    if (!root) continue;
    const physicalIdentity = file.checksum ? `sha256:${file.checksum}` : `${root.id}:${file.relativePath}`;
    if (physicalSeen.has(physicalIdentity)) continue;
    physicalSeen.add(physicalIdentity);
    sources.push({ id: `S${sources.length + 1}`, sourceType: "FILE_METADATA",
      title: path.posix.basename(file.relativePath), rootName: root.displayName,
      relativePath: file.relativePath, href: result.href, trustState: "Metadata only",
      timeState: "Current scan", text: `File name: ${path.posix.basename(file.relativePath)}`,
      sourceRange: null, physicalIdentity, corroborationKeys: [physicalIdentity] });
  }

  const fileEntries = [...sourceEntryById.values()];
  const [signals, separatedVersionPairs] = await Promise.all([
    getDocumentVersionSignals(fileEntries, route.wantsHistory),
    getSeparatedRelationshipPairIdentities(fileEntries, ["PROBABLE_REVISION"]),
  ]);
  const byEntry = new Map([...sourceEntryById.entries()]);
  const versions: AnswerVersion[] = [];
  const sourceIds = [...byEntry.keys()];
  for (let i = 0; i < sourceIds.length; i += 1) {
    for (let j = i + 1; j < sourceIds.length; j += 1) {
      const leftId = sourceIds[i], rightId = sourceIds[j];
      const left = byEntry.get(leftId)!; const right = byEntry.get(rightId)!;
      const leftSignal = signals.find((signal) => signal.kind === "DOCUMENT_FAMILY" &&
        signal.connectedLibraryId === left.connectedLibraryId &&
        signal.fileKey === left.fileKey && signal.checksum === left.checksum);
      const rightSignal = signals.find((signal) => signal.kind === "DOCUMENT_FAMILY" &&
        signal.connectedLibraryId === right.connectedLibraryId &&
        signal.fileKey === right.fileKey && signal.checksum === right.checksum &&
        signal.connectedLibraryId === leftSignal?.connectedLibraryId &&
        signal.identityHash === leftSignal?.identityHash);
      if (!leftSignal || !rightSignal) continue;
      if (route.kind === "VERSION" && (!assessableVersionEndpoints.has(
        `${leftSignal.connectedLibraryId}\0${leftSignal.fileKey}\0${leftSignal.checksum}`) ||
        !assessableVersionEndpoints.has(
          `${rightSignal.connectedLibraryId}\0${rightSignal.fileKey}\0${rightSignal.checksum}`))) continue;
      if (separatedVersionPairs.has(knowledgeRelationshipPairKey(leftSignal, rightSignal))) continue;
      const order = compareDocumentVersions(leftSignal, rightSignal);
      versions.push({ leftSourceId: leftId, rightSourceId: rightId,
        newerSourceId: order === null ? null : order === 1 ? leftId : rightId,
        ordering: order === null ? "AMBIGUOUS" : "ORDERED" });
    }
  }
  for (const version of versions) {
    if (version.ordering !== "ORDERED") continue;
    const olderId = version.newerSourceId === version.leftSourceId
      ? version.rightSourceId : version.leftSourceId;
    const older = sources.find((source) => source.id === olderId);
    if (older?.timeState === "Current scan") older.timeState = "Earlier document version";
  }

  const documentIds = fileEntries.flatMap((entry) => entry.scannedFile.libraryDocumentId
    ? [entry.scannedFile.libraryDocumentId] : []);
  const observations = documentIds.length ? await prisma.observationSession.findMany({
    where: { libraryDocumentId: { in: documentIds } },
    select: { id: true, libraryDocumentId: true, status: true }, take: 80,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  }) : [];
  const latestObservationByDocument = new Map<string, { id: string; status: string }>();
  for (const observation of observations) {
    if (!latestObservationByDocument.has(observation.libraryDocumentId)) {
      latestObservationByDocument.set(observation.libraryDocumentId, observation);
    }
  }
  const sourceIdByObservation = new Map([...latestObservationByDocument].flatMap(([documentId, observation]) =>
    observation.status === "REJECTED" ? [] :
    [...sourceEntryById.entries()].filter(([, entry]) =>
      entry.scannedFile.libraryDocumentId === documentId)
      .map(([sourceId]) => [observation.id, sourceId] as const)));
  const connections = sourceIdByObservation.size > 1 ? await prisma.knowledgeConnection.findMany({
    take: 24,
    // The cap is semantic: reviewed relationships win, and equal-priority rows
    // have stable membership across the initial and post-model retrievals.
    orderBy: [{ status: "desc" }, { id: "asc" }],
    where: { status: { in: ["CONFIRMED", "NEW"] },
      supersededAt: null,
      generationVersion: { in: [relationshipGenerationVersion, documentSignalVersion,
        humanIdentityCorrectionVersion] },
      sourceChecksum: { not: null }, targetChecksum: { not: null },
      sourceObservationSessionId: { in: [...sourceIdByObservation.keys()] },
      targetObservationSessionId: { in: [...sourceIdByObservation.keys()] } },
    select: { sourceObservationSessionId: true, targetObservationSessionId: true,
      sourceChecksum: true, targetChecksum: true, status: true, reasoning: true },
  }) : [];
  const relationships = connections.flatMap((connection) => {
    const leftSourceId = sourceIdByObservation.get(connection.sourceObservationSessionId);
    const rightSourceId = sourceIdByObservation.get(connection.targetObservationSessionId);
    const left = leftSourceId ? sourceEntryById.get(leftSourceId) : null;
    const right = rightSourceId ? sourceEntryById.get(rightSourceId) : null;
    return leftSourceId && rightSourceId && leftSourceId !== rightSourceId &&
      left?.checksum === connection.sourceChecksum && right?.checksum === connection.targetChecksum
      ? [{ leftSourceId, rightSourceId, status: connection.status === "CONFIRMED"
        ? "CONFIRMED" as const : "PROVISIONAL" as const,
        explanation: connection.reasoning.slice(0, 240) }] : [];
  });
  // VERSION/HISTORY deliberately take routing precedence, so retain the entity
  // type parsed from the question rather than trying to infer it from its name.
  const identityKind = route.entityKind;
  const [effectiveSignals, separatedIdentityPairs] = identityKind ? await Promise.all([
    getEffectiveDocumentSignals(rootIds, route.wantsHistory ? {
      historicalEntries: ambiguityEntries.map((entry) => ({
        checksum: entry.checksum, connectedLibraryId: entry.connectedLibraryId,
        fileKey: entry.fileKey, isCurrent: entry.isCurrent,
      })),
    } : undefined),
    getSeparatedRelationshipPairIdentities(ambiguityEntries, [`SAME_${identityKind}`]),
  ]) : [[], new Map<string, Set<string>>()];
  // Search has already bound the requested name to exact typed evidence. Use
  // those admitted identities rather than every same-kind signal on a selected
  // multi-signal document (for example, a file mentioning both Alice and Bob).
  const entityHashes = identityKind ? new Set(ambiguityEntries.flatMap((entry) =>
    (requestedHashesByResultId.get(entry.id) ?? []).map((hash) =>
      `${entry.connectedLibraryId}:${hash}`))) : new Set<string>();
  const effectiveIdentitiesByEndpoint = new Map<string, Set<string>>();
  for (const signal of effectiveSignals) {
    if (signal.kind !== identityKind || !ambiguityEntries.some((entry) =>
      entry.connectedLibraryId === signal.connectedLibraryId &&
      entry.fileKey === signal.fileKey && entry.checksum === signal.checksum)) continue;
    const endpoint = `${signal.fileKey}\0${signal.checksum}`;
    effectiveIdentitiesByEndpoint.set(endpoint, new Set([
      ...(effectiveIdentitiesByEndpoint.get(endpoint) ?? []), signal.identityHash,
    ]));
  }
  const hasSeparatedMatchingIdentity = ambiguityEntries.some((left, leftIndex) =>
    ambiguityEntries.slice(leftIndex + 1).some((right) => {
      const separated = separatedIdentityPairs.get(knowledgeRelationshipPairKey(left, right));
      const leftIdentities = effectiveIdentitiesByEndpoint.get(`${left.fileKey}\0${left.checksum}`);
      const rightIdentities = effectiveIdentitiesByEndpoint.get(`${right.fileKey}\0${right.checksum}`);
      return Boolean(separated && leftIdentities && rightIdentities && [...separated].some((hash) =>
        leftIdentities.has(hash) && rightIdentities.has(hash)));
    }));
  return { route, sources, relationships, versions,
    versionFamilyCount: assessedFamilies.length,
    versionAssessmentComplete: assessedFamilies.every((family) => family.safe),
    indexIncomplete: indexIncomplete || sources.some((source) => source.trustState === "Metadata only"),
    ambiguousEntity: entityHashes.size > 1 || hasSeparatedMatchingIdentity };
}
