import path from "node:path";

import { getPrismaClient } from "@/lib/db/prisma";
import { compareDocumentVersions, documentSignalVersion } from "@/lib/bridge/document-signals";
import { getDocumentVersionSignals, getEffectiveDocumentSignals, getSeparatedRelationshipPairIdentities, humanIdentityCorrectionVersion, knowledgeRelationshipPairKey, relationshipGenerationVersion } from "@/lib/bridge/persistent-knowledge";
import { workingKnowledgeTerms } from "@/lib/bridge/scan-working-knowledge";
import { countKnowledgeWork, type KnowledgeWork } from "@/lib/bridge/knowledge-work";
import { searchLibrary } from "@/lib/library/search";
import { librarySearchIndexVersion } from "@/lib/library/search-index";
import { getScannedFileExamineRoute, getScanSessionRoute } from "@/lib/library/routes";
import { routeLibraryQuestion } from "./route-question";
import { maxAnswerSources, type AnswerContext, type AnswerContextSource, type AnswerVersion } from "./types";

type StoredExcerpt = { start: number; end: number; text: string };

type VersionSignal = Awaited<ReturnType<typeof getDocumentVersionSignals>>[number];

function normalizedRevision(value: string | null) {
  if (!value) return null;
  const parts = value.split(".").map(Number);
  while (parts.length > 1 && parts.at(-1) === 0) parts.pop();
  return parts;
}

function familyHasAmbiguousPair(family: VersionSignal[]) {
  const groups = new Map<string, VersionSignal[]>();
  for (const signal of family) {
    const revision = normalizedRevision(signal.revisionNumber);
    const key = revision ? revision.join(".") : "<missing>";
    const group = groups.get(key);
    if (group) group.push(signal);
    else groups.set(key, [signal]);
  }
  for (const group of groups.values()) {
    if (group.length > 1 && (group.some((signal) => !signal.revisionDate) ||
      new Set(group.map((signal) => signal.revisionDate)).size !== group.length)) return true;
  }
  const missingRevision = groups.get("<missing>");
  if (missingRevision?.length && (family.some((signal) => !signal.revisionDate) ||
    new Set(family.map((signal) => signal.revisionDate)).size !== family.length)) return true;
  if (family.some((signal) => !signal.revisionDate &&
    (!signal.revisionNumber || (groups.get(normalizedRevision(signal.revisionNumber)!.join("."))?.length ?? 0) > 1))) {
    return true;
  }

  // Numeric and date markers must not order two revision groups in opposite
  // directions. Checking group date ranges after numeric sorting detects every
  // such inversion without comparing every member pair.
  const orderedGroups = [...groups.entries()].filter(([key]) => key !== "<missing>")
    .map(([, signals]) => signals)
    .sort((left, right) => {
      const a = normalizedRevision(left[0].revisionNumber)!;
      const b = normalizedRevision(right[0].revisionNumber)!;
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
      }
      return 0;
    });
  let latestEarlierDate: string | null = null;
  for (const group of orderedGroups) {
    const dates = group.flatMap((signal) => signal.revisionDate ? [signal.revisionDate] : []).sort();
    if (dates.length && latestEarlierDate && dates[0] < latestEarlierDate) return true;
    if (dates.length && (!latestEarlierDate || dates.at(-1)! > latestEarlierDate)) {
      latestEarlierDate = dates.at(-1)!;
    }
  }
  return false;
}

export function groupDocumentVersionSignalsByFamily(signals: VersionSignal[]) {
  const families = new Map<string, VersionSignal[]>();
  for (const signal of signals) {
    const key = `${signal.connectedLibraryId}\0${signal.identityHash}`;
    const family = families.get(key);
    if (family) family.push(signal);
    else families.set(key, [signal]);
  }
  return families;
}

export function assessDocumentVersionFamily(
  family: VersionSignal[],
  separated: boolean,
) {
  if (separated || family.length < 2 || familyHasAmbiguousPair(family)) {
    return { maximum: null, olderSignals: [], safe: false, separated, family };
  }

  // A complete family can contain every file in a scan. Never materialize its
  // pairwise comparison graph: retain one candidate, then verify that candidate
  // against the complete family. This is linear in both work and memory.
  let maximum = family[0];
  for (let index = 1; index < family.length; index += 1) {
    const order = compareDocumentVersions(maximum, family[index]);
    if (order === null) {
      return { maximum: null, olderSignals: [], safe: false, separated: false, family };
    }
    if (order === -1) maximum = family[index];
  }
  const olderSignals: VersionSignal[] = [];
  for (const signal of family) {
    if (signal === maximum) continue;
    if (compareDocumentVersions(maximum, signal) !== 1) {
      return { maximum: null, olderSignals: [], safe: false, separated: false, family };
    }
    olderSignals.push(signal);
  }
  olderSignals.sort((left, right) =>
    `${left.fileKey}\0${left.checksum}`.localeCompare(`${right.fileKey}\0${right.checksum}`));
  return { maximum, olderSignals, safe: true, separated: false, family };
}

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

export async function retrieveQuestionContext(question: string, permittedRootIds?: string[], work?: KnowledgeWork): Promise<AnswerContext> {
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

  let results = await searchLibrary(route.searchQuery, rootIds, {
    includeEntityMatches: true,
    // Search remains display-bounded, but Ask must see every candidate from the
    // bounded retrieval window before deciding whether an entity is ambiguous.
    includeAllEntityMatches: true,
    includeAllVersionMatches: route.kind === "VERSION",
    includeHistoryList: route.historyList,
  });
  const requestedHashesByResultId = new Map(results.flatMap((result) =>
    result.matchedEntityHashes?.length ? [[result.id, result.matchedEntityHashes] as const] : []));
  const indexIds = results.filter((result) => result.kind === "FILE").map((result) => result.id);
  const [loadedEntries, memories, metadataFiles] = await Promise.all([
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
        select: { status: true, libraryDocumentId: true },
      } } } },
    }),
    prisma.scannedFile.findMany({
      where: { id: { in: indexIds }, sourceUnavailableAt: null,
        scanSession: { connectedFolderId: { in: rootIds }, connectedFolder: readableRoot } },
      select: { id: true, checksum: true, relativePath: true, sessionId: true,
        scanSession: { select: { connectedFolderId: true } } },
    }),
  ]);
  let entries = loadedEntries;
  let entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const memoriesById = new Map(memories.map((entry) => [entry.id, entry]));
  // A reviewed document can contribute Memory in many roots. Fetch its physical
  // copies once, rather than returning/scanning the entire copy list per source.
  const memoryDocumentIds = [...new Set(memories.flatMap((entry) => entry.searchSources.map((source) => source.observationSession.libraryDocumentId)))];
  const memoryKeysByDocumentRoot = new Map<string, Set<string>>();
  for (let offset = 0; offset < memoryDocumentIds.length; offset += 500) {
    const files = await prisma.scannedFile.findMany({
      where: { libraryDocumentId: { in: memoryDocumentIds.slice(offset, offset + 500) } },
      select: { checksum: true, relativePath: true, libraryDocumentId: true,
        scanSession: { select: { connectedFolderId: true } } },
    });
    for (const file of files) {
      countKnowledgeWork(work, "memoryFileVisits");
      const rootId = file.scanSession.connectedFolderId;
      const key = `${file.libraryDocumentId}\0${rootId}`;
      const keys = memoryKeysByDocumentRoot.get(key) ?? new Set<string>();
      keys.add(file.checksum ? `sha256:${file.checksum}` : `${rootId}:${file.relativePath}`);
      memoryKeysByDocumentRoot.set(key, keys);
    }
  }
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
  let versionEntries = route.kind === "VERSION"
    ? [...new Map(results.flatMap((result) => {
      const entry = result.kind === "FILE" ? entriesById.get(result.id) : null;
      return entry && rootById.has(entry.connectedLibraryId) &&
      entry.checksum === entry.scannedFile.checksum &&
      entry.relativePath === entry.scannedFile.relativePath &&
      entry.scanSessionId === entry.scannedFile.sessionId &&
      entry.connectedLibraryId === entry.scannedFile.scanSession.connectedFolderId &&
      (route.wantsHistory || entry.isCurrent && latestIds.has(entry.scanSessionId))
        ? [[`${entry.connectedLibraryId}\0${entry.fileKey}\0${entry.checksum}`, entry] as const]
        : [];
    })).values()]
    : [];
  let allVersionSignals = route.kind === "VERSION"
    ? await getDocumentVersionSignals(versionEntries, route.wantsHistory, true) : [];
  let versionMembersMissingSearchEntries = false;
  if (route.kind === "VERSION" && allVersionSignals.length) {
    const endpoints = [...new Map(allVersionSignals.map((signal) => [
      `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`,
      { connectedLibraryId: signal.connectedLibraryId, fileKey: signal.fileKey, checksum: signal.checksum },
    ])).values()];
    const chunks = Array.from({ length: Math.ceil(endpoints.length / 100) }, (_, index) =>
      endpoints.slice(index * 100, index * 100 + 100));
    const expandedEntries = (await Promise.all(chunks.map((chunk) => prisma.librarySearchEntry.findMany({
      where: { indexVersion: librarySearchIndexVersion, connectedLibrary: readableRoot,
        scannedFile: { sourceUnavailableAt: null }, OR: chunk },
      include: { scannedFile: { select: { libraryDocumentId: true, checksum: true,
        relativePath: true, sessionId: true, scanSession: { select: { connectedFolderId: true } } } } },
      orderBy: [{ connectedLibraryId: "asc" }, { fileKey: "asc" }, { checksum: "asc" }, { id: "asc" }],
    })))).flat().filter((entry) => rootById.has(entry.connectedLibraryId) &&
      entry.checksum === entry.scannedFile.checksum && entry.relativePath === entry.scannedFile.relativePath &&
      entry.scanSessionId === entry.scannedFile.sessionId &&
      entry.connectedLibraryId === entry.scannedFile.scanSession.connectedFolderId &&
      (route.wantsHistory || entry.isCurrent && latestIds.has(entry.scanSessionId)));
    const expandedByEndpoint = new Map(expandedEntries.map((entry) => [
      `${entry.connectedLibraryId}\0${entry.fileKey}\0${entry.checksum}`, entry,
    ]));
    versionMembersMissingSearchEntries = allVersionSignals.some((signal) => !expandedByEndpoint.has(
      `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`));
    // Family identities are root-scoped. Keep every authorized endpoint
    // through discovery and expansion even when two roots contain identical
    // bytes; physical-copy deduplication belongs to bounded source selection.
    versionEntries = [...expandedByEndpoint.values()];
    entries = [...new Map([...entries, ...versionEntries].map((entry) => [entry.id, entry])).values()];
    entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    const existingResultIds = new Set(results.map((result) => result.id));
    results = [...results, ...versionEntries.flatMap((entry) => existingResultIds.has(entry.id) ? [] : [{
      id: entry.id, kind: "FILE" as const, rootName: rootById.get(entry.connectedLibraryId)!.displayName,
      relativePath: entry.relativePath, fileType: entry.fileType,
      href: entry.isCurrent ? getScannedFileExamineRoute(entry.scanSessionId, entry.scannedFileId)
        : getScanSessionRoute(entry.scanSessionId),
      state: entry.isCurrent ? "Current scan" : "Historical scan",
      reason: "Member of a matched document family", excerpt: null, sourceRange: null, score: 0,
    }])];
    const eligibleEndpoints = new Set(versionEntries.map((entry) =>
      `${entry.connectedLibraryId}\0${entry.fileKey}\0${entry.checksum}`));
    allVersionSignals = allVersionSignals.filter((signal) => eligibleEndpoints.has(
      `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`));
  }
  const allSeparatedVersionPairs = route.kind === "VERSION"
    ? await getSeparatedRelationshipPairIdentities(versionEntries, ["PROBABLE_REVISION"])
    : new Map<string, Set<string>>();
  const versionEntryByEndpoint = new Map(versionEntries.map((entry) =>
    [`${entry.connectedLibraryId}\0${entry.fileKey}\0${entry.checksum}`, entry]));
  const versionFamilyMap = groupDocumentVersionSignalsByFamily(allVersionSignals.filter((signal) =>
    versionEntryByEndpoint.has(`${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`)));
  const versionFamilies = [...versionFamilyMap.values()]
    .filter((family) => family.length > 1)
    .sort((left, right) => {
      const leftKey = `${left[0].connectedLibraryId}\0${left[0].identityHash}`;
      const rightKey = `${right[0].connectedLibraryId}\0${right[0].identityHash}`;
      return leftKey.localeCompare(rightKey);
    });
  const separatedVersionIdentities = new Set([...allSeparatedVersionPairs.values()].flatMap((identities) =>
    [...identities]));
  const hasUnscopedVersionSeparation = [...allSeparatedVersionPairs.values()].some((identities) =>
    identities.size === 0);
  const assessedFamilies = versionFamilies.map((family) => assessDocumentVersionFamily(
    family,
    hasUnscopedVersionSeparation || separatedVersionIdentities.has(family[0].identityHash),
  ));
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
      const documentRoots = new Set<string>();
      for (const source of entry.searchSources) {
        countKnowledgeWork(work, "memorySourceVisits");
        documentRoots.add(`${source.observationSession.libraryDocumentId}\0${source.connectedLibraryId}`);
      }
      const corroborationKeys = new Set<string>();
      for (const pair of documentRoots) {
        countKnowledgeWork(work, "memoryPairVisits");
        for (const key of memoryKeysByDocumentRoot.get(pair) ?? []) corroborationKeys.add(key);
      }
      sources.push({ id: `S${sources.length + 1}`, sourceType: "APPROVED_MEMORY",
        title: entry.title.slice(0, 160), rootName: [...new Set(entry.searchSources.map((source) =>
          rootById.get(source.connectedLibraryId)!.displayName))].sort((left, right) =>
          left.localeCompare(right)).join("; "),
        relativePath: null, href: "/admin/library/memory", trustState: "Human-approved Memory",
        timeState: "Active", text: `${entry.title}. ${entry.description}`.slice(0, 400),
        sourceRange: null, physicalIdentity: `memory:${entry.id}`,
        corroborationKeys: [...corroborationKeys].sort(),
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
  const ambiguityEndpointKeys = new Set(ambiguityEntries.map((entry) =>
    `${entry.connectedLibraryId}\0${entry.fileKey}\0${entry.checksum}`));
  const effectiveIdentitiesByEndpoint = new Map<string, Set<string>>();
  for (const signal of effectiveSignals) {
    if (signal.kind !== identityKind || !ambiguityEndpointKeys.has(
      `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`)) continue;
    const endpoint = `${signal.fileKey}\0${signal.checksum}`;
    effectiveIdentitiesByEndpoint.set(endpoint, new Set([
      ...(effectiveIdentitiesByEndpoint.get(endpoint) ?? []), signal.identityHash,
    ]));
  }
  let hasSeparatedMatchingIdentity = false;
  for (const [pairKey, separated] of separatedIdentityPairs) {
    const [leftFileKey, leftChecksum, rightFileKey, rightChecksum] = pairKey.split("\0");
    const leftIdentities = effectiveIdentitiesByEndpoint.get(`${leftFileKey}\0${leftChecksum}`);
    const rightIdentities = effectiveIdentitiesByEndpoint.get(`${rightFileKey}\0${rightChecksum}`);
    if (leftIdentities && rightIdentities && [...separated].some((hash) =>
      leftIdentities.has(hash) && rightIdentities.has(hash))) {
      hasSeparatedMatchingIdentity = true;
      break;
    }
  }
  return { route, sources, relationships, versions,
    versionFamilyCount: assessedFamilies.length,
    versionAssessmentComplete: !versionMembersMissingSearchEntries &&
      assessedFamilies.every((family) => family.safe),
    indexIncomplete: indexIncomplete || sources.some((source) => source.trustState === "Metadata only"),
    ambiguousEntity: entityHashes.size > 1 || hasSeparatedMatchingIdentity };
}
