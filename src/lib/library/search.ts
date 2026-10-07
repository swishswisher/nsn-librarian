import { Prisma } from "@prisma/client";
import { eligibleMemorySql } from "./memory-provenance";
import { currentReadableRootWhere } from "@/lib/bridge/current-readable-root";
import path from "node:path";

import { verifiedSourceExcerpts } from "@/lib/ai/source-evidence";
import { getPrismaClient } from "@/lib/db/prisma";
import { documentSignalEntityLabels, documentSignalVersion, resolveDocumentEvidence } from "@/lib/bridge/document-signals";
import { buildVersionStateIndex, versionEndpoint } from "@/lib/bridge/document-version-index";
import type { KnowledgeWork } from "@/lib/bridge/knowledge-work";
import {
  getDocumentVersionSignals,
  getEligibleDocumentSignals,
  getEffectiveDocumentSignals,
  getSeparatedRelationshipPairIdentities,
  knowledgeRelationshipPairKey,
  usableScanSnapshotWhere,
} from "@/lib/bridge/persistent-knowledge";
import { mediaCategoryForFileType } from "@/lib/bridge/media-kind";
import { observationSourceEvidenceText, searchTopicIds, workingKnowledgeTerms } from "@/lib/bridge/scan-working-knowledge";
import { getScannedFileExamineRoute, getScanSessionRoute } from "@/lib/library/routes";
import { parseExplicitEntityQuery } from "./entity-query";
import { librarySearchIndexVersion, type SearchExcerpt } from "./search-index";

export const searchCandidateLimit = 120;
export const searchSpecificCandidateLimit = 32;
export const searchResultLimit = 20;

export type LibrarySearchResult = {
  id: string;
  rootName: string;
  relativePath: string;
  fileType: string;
  href: string;
  state: string;
  reason: string;
  excerpt: string | null;
  sourceRange: { start: number; end: number } | null;
  score: number;
  kind?: "FILE" | "MEMORY";
  /** Root-scoped effective identities that admitted an explicit entity result. */
  matchedEntityHashes?: string[];
  /** Bounded human review text for Ask; never an original-document quotation. */
  humanReviewedEvidence?: string;
  /** Bounded canonical field quotation, retaining its precise document offsets. */
  entitySourceExcerpt?: SearchExcerpt;
};

export type SearchIntent = {
  query: string;
  terms: string[];
  concepts: string[];
  wantsHistory: boolean;
  fileType: string | null;
  entityName: string | null;
  entityKind: "CLIENT" | "PROJECT" | null;
};

export function compareSearchResults(a: LibrarySearchResult, b: LibrarySearchResult) {
  return b.score - a.score || a.relativePath.localeCompare(b.relativePath) ||
    a.rootName.localeCompare(b.rootName) || (a.kind ?? "FILE").localeCompare(b.kind ?? "FILE") ||
    a.id.localeCompare(b.id);
}

export function parseSearchIntent(value: string): SearchIntent {
  const query = value.trim().slice(0, 120);
  const normalized = query.toLowerCase();
  const fileType = /\b(pdf|docx?|html?|markdown|images?|audio|video)\b/i.exec(query)?.[1]?.toLowerCase() ?? null;
  const entity = parseExplicitEntityQuery(query);
  return {
    query,
    terms: workingKnowledgeTerms(query).slice(0, 12),
    concepts: searchTopicIds(query),
    wantsHistory: /\b(older|earlier|previous|versions?|history|historical)\b/.test(normalized),
    fileType,
    entityName: entity.entityName?.toLowerCase() ?? null,
    entityKind: entity.entityKind,
  };
}

function validExcerpts(value: unknown): SearchExcerpt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    item && typeof item === "object" && !Array.isArray(item) &&
    typeof item.start === "number" && typeof item.end === "number" &&
    typeof item.text === "string" && item.text.length <= 240 &&
    item.end - item.start === item.text.length
      ? [{ start: item.start, end: item.end, text: item.text }]
      : [],
  ).slice(0, 8);
}

function matchesEntityPhrase(value: string, phrase: string) {
  const text = value.normalize("NFKC").toLowerCase();
  const name = phrase.normalize("NFKC").toLowerCase();
  let offset = text.indexOf(name);
  while (offset >= 0) {
    if (!/[\p{L}\p{N}]/u.test(text[offset - 1] ?? "") &&
        !/[\p{L}\p{N}]/u.test(text[offset + name.length] ?? "")) return true;
    offset = text.indexOf(name, offset + 1);
  }
  return false;
}

function signalEvidenceMatchesEntity(
  resolution: ReturnType<typeof resolveDocumentEvidence>,
  rangesValue: unknown,
  kind: "CLIENT" | "PROJECT",
  entityName: string,
  allowUnranged: boolean,
  identity: { connectedLibraryId: string; identityHash: string },
) {
  return documentSignalEntityLabels(resolution, kind, rangesValue, allowUnranged, identity)
    .some((label) => matchesEntityPhrase(label, entityName));
}

export function rankSearchEntry(entry: {
  relativePath: string;
  sourceTerms: string[];
  reviewedTerms: string[];
  concepts: string[];
  entityHashes: string[];
  knowledgeState: string;
  isCurrent: boolean;
  sourceExcerpts: unknown;
}, intent: SearchIntent, linkedEntities: Set<string> = new Set()) {
  const lowerPath = entry.relativePath.toLowerCase();
  const lowerName = path.posix.basename(lowerPath);
  const query = intent.query.toLowerCase();
  const nameExact = lowerName === query;
  const pathExact = lowerPath === query;
  const nameContains = lowerName.includes(query);
  const pathContains = lowerPath.includes(query);
  const sourceMatches = intent.terms.filter((term) => entry.sourceTerms.includes(term));
  const pathTerms = new Set(workingKnowledgeTerms(entry.relativePath));
  const pathMatches = intent.terms.filter((term) => pathTerms.has(term));
  const reviewedMatches = intent.terms.filter((term) => entry.reviewedTerms.includes(term));
  const conceptMatches = intent.concepts.filter((concept) => entry.concepts.includes(concept));
  const entityMatches = entry.entityHashes.filter((hash) => linkedEntities.has(hash));
  const excerpts = validExcerpts(entry.sourceExcerpts);
  const matchingExcerpt = excerpts.find((excerpt) =>
    intent.terms.some((term) => workingKnowledgeTerms(excerpt.text).includes(term)),
  ) ?? null;
  let score = 0;
  let reason = "";
  if (nameExact || pathExact) { score += 220; reason = "Exact file name or path"; }
  else if (nameContains) { score += 40; reason = "File name match"; }
  else if (pathContains) { score += 25; reason = "Folder or path match"; }
  else if (pathMatches.length) {
    score += Math.min(pathMatches.length, 3) * 10;
    reason = "File name or folder words match";
  }
  if (sourceMatches.length) {
    score += Math.min(sourceMatches.length, 4) * 18;
    if (!reason) reason = "Matching words in verified source material";
  }
  if (reviewedMatches.length && entry.knowledgeState === "APPROVED") {
    score += Math.min(reviewedMatches.length, 3) * 12;
    if (!reason) reason = "Matches a human correction";
  }
  if (conceptMatches.length) {
    score += Math.min(conceptMatches.length, 2) * 52;
    if (!nameExact && !pathExact) reason = "Related subject supported by source material";
  }
  if (entityMatches.length) {
    score += 22;
    if (!reason) reason = "Shares a resolved identity with matching material";
  }
  if (!score) return null;
  if (entry.isCurrent) score += 5;
  if (entry.knowledgeState === "APPROVED") score += 3;
  if (!entry.isCurrent) score -= 10;
  return { score, reason, matchingExcerpt };
}

export async function searchLibrary(value: string, permittedRootIds?: string[], options?: {
  includeEntityMatches?: boolean;
  /** Keep the bounded ranked file set so Ask can check identity ambiguity before UI truncation. */
  includeAllEntityMatches?: boolean;
  /** Keep all ranked file candidates so Ask can assess complete version families before source truncation. */
  includeAllVersionMatches?: boolean;
  includeHistoryList?: boolean;
  work?: KnowledgeWork;
}): Promise<LibrarySearchResult[]> {
  const intent = parseSearchIntent(value);
  if (intent.query.length < 2) return [];
  const prisma = getPrismaClient();
  // This is a single-human installation today. Root grants remain an explicit
  // database predicate; there is no per-user library ownership model to infer.
  const readableRoots = await prisma.connectedLibrary.findMany({
    select: { id: true, displayName: true, physicalInventoryGeneration: true, scanSessions: {
      orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { id: true, inventoryGeneration: true }, take: 1,
      where: usableScanSnapshotWhere,
    } },
    where: { ...currentReadableRootWhere, ...(permittedRootIds ? { id: { in: permittedRootIds } } : {}),
      ...(!intent.wantsHistory ? { executionRuns: { none: { OR: [ { status: { in: ["PENDING", "RUNNING"] as const } },
        { undoRuns: { some: { status: { in: ["PENDING", "RUNNING"] as const } } } } ] } } } : {}) },
  });
  const roots = readableRoots.filter((root) => intent.wantsHistory || root.scanSessions[0]?.inventoryGeneration === root.physicalInventoryGeneration);
  const rootById = new Map(roots.map((root) => [root.id, root]));
  const rootIds = roots.map((root) => root.id);
  const latestSessionIds = roots.flatMap((root) => root.scanSessions.map((session) => session.id));
  if (rootIds.length === 0 || latestSessionIds.length === 0) return [];

  const retainedHistoryList = Boolean(options?.includeHistoryList && intent.wantsHistory && !intent.entityKind);
  const scope = {
    connectedLibraryId: { in: rootIds },
    indexVersion: librarySearchIndexVersion,
    scannedFile: { sourceUnavailableAt: null },
    ...(retainedHistoryList
      ? { isCurrent: false }
      : intent.wantsHistory ? {} : { isCurrent: true, scanSessionId: { in: latestSessionIds } }),
  } as const;
  const candidateScope = { ...scope, ...(intent.fileType ? {
    fileType: { contains: intent.fileType.replace(/s$/, ""), mode: "insensitive" as const },
  } : {}) };
  // Ask must not infer that an explicitly named entity is unique from the UI's
  // bounded candidate window. In that mode the database query is exhaustive,
  // but only the small ranked source window is ever sent to the answer model.
  const exhaustiveEntityCandidates = Boolean(options?.includeAllEntityMatches && intent.entityKind);
  const exhaustiveVersionCandidates = Boolean(options?.includeAllVersionMatches && intent.wantsHistory);
  const exhaustiveCandidates = exhaustiveEntityCandidates || exhaustiveVersionCandidates;
  const exact = await prisma.librarySearchEntry.findMany({
    take: 20,
    orderBy: [{ isCurrent: "desc" }, { indexedAt: "desc" },
      { connectedLibraryId: "asc" }, { relativePath: "asc" }, { id: "asc" }],
    where: { ...candidateScope, OR: [
      { fileName: { equals: intent.query, mode: "insensitive" } },
      { relativePath: { equals: intent.query, mode: "insensitive" } },
    ] },
  }).catch(() => []);
  // Reserve part of the bounded window for entries that satisfy every query
  // term. Without this pass, a common first term can consume the hasSome window
  // before an older, more specific identity seed is considered. A term may be
  // supported by source evidence, a reviewed correction, an indexed concept, or
  // the normalized path terms that ranking also treats as evidence.
  const specific = intent.terms.length ? await prisma.librarySearchEntry.findMany({
    ...(!exhaustiveCandidates ? {
      take: Math.min(searchSpecificCandidateLimit, searchCandidateLimit - exact.length),
    } : {}),
    orderBy: [{ isCurrent: "desc" }, { indexedAt: "desc" },
      { connectedLibraryId: "asc" }, { relativePath: "asc" }, { id: "asc" }],
    where: {
      ...candidateScope,
      AND: intent.terms.map((term) => ({ OR: [
        { sourceTerms: { has: term } },
        { reviewedTerms: { has: term } },
        { concepts: { has: term } },
        { relativePath: { contains: term, mode: "insensitive" } },
      ] })),
    },
  }).catch(() => []) : [];
  const reserved = [...new Map([...exact, ...specific].map((entry) => [entry.id, entry])).values()];
  const broader = await prisma.librarySearchEntry.findMany({
    ...(!exhaustiveCandidates ? {
      take: Math.max(0, searchCandidateLimit - reserved.length),
    } : {}),
    orderBy: [{ isCurrent: "desc" }, { indexedAt: "desc" },
      { connectedLibraryId: "asc" }, { relativePath: "asc" }, { id: "asc" }],
    where: {
      ...candidateScope,
      id: { notIn: reserved.map((entry) => entry.id) },
      OR: [
        { relativePath: { contains: intent.query, mode: "insensitive" } },
        ...intent.terms.length ? [{ sourceTerms: { hasSome: intent.terms } },
          { reviewedTerms: { hasSome: intent.terms } }] : [],
        ...intent.concepts.length ? [{ concepts: { hasSome: intent.concepts } }] : [],
      ],
    },
  }).catch(() => []);
  const historicalList = retainedHistoryList
    ? await prisma.librarySearchEntry.findMany({
      take: searchResultLimit,
      orderBy: [{ indexedAt: "desc" }, { connectedLibraryId: "asc" },
        { relativePath: "asc" }, { id: "asc" }],
      where: { ...candidateScope, isCurrent: false },
    }).catch(() => [])
    : [];
  const historyListIds = new Set(historicalList.map((entry) => entry.id));
  const initial = [...new Map([...reserved, ...broader, ...historicalList]
    .map((entry) => [entry.id, entry])).values()];

  // History eligibility must also include identities outside the bounded lexical
  // projection. These endpoints remain subject to the same retained-index scope.
  const historicalEntries = intent.entityKind && intent.wantsHistory
    ? await prisma.librarySearchEntry.findMany({
      select: { checksum: true, connectedLibraryId: true, fileKey: true, isCurrent: true },
      where: { ...scope, isCurrent: false },
    }) : [];
  // Resolved identity expansion uses only identities from scoped evidence.
  // Human SEPARATE decisions suppress only the rejected identity hash for that
  // exact file/checksum pair; independent matches and other identities remain valid.
  // Search entries intentionally retain every identity kind for general discovery.
  // Explicit entity searches must instead seed from the active, checksum-bound
  // effective signals of the requested kind; otherwise an organization or person
  // mentioned by a client file can pull unrelated material into the result set.
  const effectiveEntitySignals = intent.entityKind
    ? await getEffectiveDocumentSignals(rootIds, intent.wantsHistory ? {
      historicalEntries,
    } : undefined)
    : [];
  const effectiveEndpoints = new Set(effectiveEntitySignals.filter((signal) => signal.kind === intent.entityKind)
    .map((signal) => `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`));
  const rawEntitySignals = intent.entityKind && intent.entityName && effectiveEndpoints.size
    ? (await getEligibleDocumentSignals(rootIds, intent.wantsHistory ? {
      historicalEntries,
    } : undefined)).filter((signal) =>
      signal.kind === intent.entityKind || signal.kind === `UNRESOLVED_${intent.entityKind}`)
    : [];
  const signalObservations = rawEntitySignals.length ? await prisma.observationSession.findMany({
    select: { id: true, status: true, observerType: true, observations: true, humanDecisions: {
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { editedSuggestion: true }, take: 1,
      where: { decisionType: "MODIFY" },
    } },
    where: { id: { in: [...new Set(rawEntitySignals.map((signal) => signal.observationSessionId))] } },
  }) : [];
  const observationById = new Map(signalObservations.map((observation) => [observation.id, observation]));
  const resolutions = new Map<string, ReturnType<typeof resolveDocumentEvidence>>();
  const reviewedContextByResolution = new Map<string, string>();
  const humanReviewedEvidenceByEndpoint = new Map<string, string>();
  const entitySourceExcerptByEndpoint = new Map<string, SearchExcerpt>();
  const matchingRawHashesByEndpoint = new Map<string, Set<string>>();
  const rawSignalCountByEndpoint = new Map<string, number>();
  for (const signal of rawEntitySignals) {
    const endpoint = `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`;
    rawSignalCountByEndpoint.set(endpoint, (rawSignalCountByEndpoint.get(endpoint) ?? 0) + 1);
  }
  for (const signal of rawEntitySignals) {
    const endpoint = `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`;
    const observation = observationById.get(signal.observationSessionId);
    if (!observation || observation.status === "REJECTED") continue;
    const humanReviewed = observation.status === "MODIFIED";
    const resolutionKey = `${observation.id}\0${signal.connectedLibraryId}`;
    let resolution = resolutions.get(resolutionKey);
    if (!resolution) {
      const canonical = humanReviewed ? observation.humanDecisions[0]?.editedSuggestion ?? "" :
        observationSourceEvidenceText(observation);
      resolution = resolveDocumentEvidence(canonical, signal.connectedLibraryId, humanReviewed);
      resolutions.set(resolutionKey, resolution);
      if (humanReviewed) {
        // This projection is for answer context only, never for identity matching.
        const verified = verifiedSourceExcerpts(canonical);
        const text = verified.length ? verified.slice(0, 8).map((excerpt) => excerpt.text).join("\n") : canonical;
        reviewedContextByResolution.set(resolutionKey, text.slice(0, 240));
      }
    }
    if (humanReviewed && effectiveEndpoints.has(endpoint)) {
      humanReviewedEvidenceByEndpoint.set(endpoint, reviewedContextByResolution.get(resolutionKey)!);
    }
    if (!effectiveEndpoints.has(endpoint) || !signalEvidenceMatchesEntity(
      resolution,
      signal.sourceRanges, intent.entityKind!, intent.entityName!,
      rawSignalCountByEndpoint.get(endpoint) === 1 || humanReviewed,
      signal,
    )) continue;
    const hashes = matchingRawHashesByEndpoint.get(endpoint) ?? new Set<string>();
    hashes.add(signal.identityHash);
    matchingRawHashesByEndpoint.set(endpoint, hashes);
    // Semantic matching can inspect the full canonical window. Context receives
    // only the supporting field, never the entire observation or human edit.
    const labels = documentSignalEntityLabels(resolution, intent.entityKind!, signal.sourceRanges,
      rawSignalCountByEndpoint.get(endpoint) === 1 || humanReviewed, signal);
    const ranges = Array.isArray(signal.sourceRanges) ? signal.sourceRanges : [];
    const field = resolution.candidates.filter((candidate) =>
      [intent.entityKind!.toLowerCase(), `${intent.entityKind!.toLowerCase()} id`].includes(candidate.key) &&
      labels.includes(candidate.value) && matchesEntityPhrase(candidate.value, intent.entityName!) &&
      (humanReviewed || !ranges.length || ranges.some((range) => range && typeof range === "object" &&
        !Array.isArray(range) && typeof range.start === "number" && typeof range.end === "number" &&
        range.start <= candidate.range.start && range.end >= candidate.range.end)))
      .sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end)[0];
    if (field && humanReviewed) {
      humanReviewedEvidenceByEndpoint.set(endpoint, `${field.key}: ${field.value}`.slice(0, 240));
    } else if (field && ranges.length && !entitySourceExcerptByEndpoint.has(endpoint)) {
      const excerpt = verifiedSourceExcerpts(resolution.sourceEvidenceText).slice(0, 24).find((item) =>
        item.start <= field.range.start && item.end >= field.range.end);
      const text = excerpt?.text.slice(field.range.start - excerpt.start, field.range.end - excerpt.start);
      if (text && text.length <= 240) entitySourceExcerptByEndpoint.set(endpoint, { ...field.range, text });
    }
  }
  const effectiveHashesByEndpoint = new Map<string, Set<string>>();
  for (const signal of effectiveEntitySignals) {
    if (signal.kind !== intent.entityKind) continue;
    const endpoint = `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`;
    const matchingRawHashes = matchingRawHashesByEndpoint.get(endpoint);
    if (intent.entityName && (!matchingRawHashes?.size ||
        signal.generationVersion === documentSignalVersion && !matchingRawHashes.has(signal.identityHash))) continue;
    const hashes = effectiveHashesByEndpoint.get(endpoint) ?? new Set<string>();
    hashes.add(signal.identityHash);
    effectiveHashesByEndpoint.set(endpoint, hashes);
  }
  // A canonical match may have no lexical term in the first eight excerpts.
  // Fetch its exact indexed endpoint, in bounded query chunks, independently of
  // that projection. Ask retains all endpoints to detect distinct identities.
  const semanticFilters = [...effectiveHashesByEndpoint].map(([endpoint, hashes]) => {
    const [connectedLibraryId, fileKey, checksum] = endpoint.split("\0");
    return { connectedLibraryId, fileKey, checksum, entityHashes: { hasSome: [...hashes] } };
  });
  // A human-confirmed identity's name anchor may use another file format.
  // Discover that authority across formats, then bound only type-eligible results.
  const semanticById = new Map<string, typeof initial[number]>();
  for (let offset = 0; offset < semanticFilters.length; offset += 500) {
    const entries = await prisma.librarySearchEntry.findMany({
      ...(!exhaustiveEntityCandidates ? { take: searchCandidateLimit } : {}),
      orderBy: [{ isCurrent: "desc" }, { indexedAt: "desc" },
        { connectedLibraryId: "asc" }, { relativePath: "asc" }, { id: "asc" }],
      where: { ...scope, OR: semanticFilters.slice(offset, offset + 500) },
    });
    for (const entry of entries) semanticById.set(entry.id, entry);
    if (!exhaustiveEntityCandidates && semanticById.size > searchCandidateLimit) {
      const ordered = [...semanticById.values()].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) ||
        b.indexedAt.getTime() - a.indexedAt.getTime() || a.connectedLibraryId.localeCompare(b.connectedLibraryId) ||
        a.relativePath.localeCompare(b.relativePath) || a.id.localeCompare(b.id));
      semanticById.clear();
      for (const entry of ordered.slice(0, searchCandidateLimit)) semanticById.set(entry.id, entry);
    }
  }
  const directCandidates = [...new Map([...initial, ...semanticById.values()]
    .map((entry) => [entry.id, entry])).values()];
  const seedEntries = directCandidates.filter((entry) => intent.entityName
    ? (effectiveHashesByEndpoint.get(`${entry.connectedLibraryId}\0${entry.fileKey}\0${entry.checksum}`)?.size ?? 0) > 0
    : intent.terms.filter((term) => entry.sourceTerms.includes(term) ||
      workingKnowledgeTerms(entry.relativePath).includes(term)).length >= 2);
  const seedHashesByRoot = new Map<string, Set<string>>();
  for (const entry of seedEntries) {
    const hashes = seedHashesByRoot.get(entry.connectedLibraryId) ?? new Set<string>();
    const eligibleHashes = intent.entityKind
      ? effectiveHashesByEndpoint.get(`${entry.connectedLibraryId}\0${entry.fileKey}\0${entry.checksum}`) ?? []
      : entry.entityHashes;
    for (const hash of eligibleHashes) hashes.add(hash);
    seedHashesByRoot.set(entry.connectedLibraryId, hashes);
  }
  const allSeedPairs = [...seedHashesByRoot].flatMap(([connectedLibraryId, hashes]) =>
    [...hashes].map((hash) => ({ connectedLibraryId, hash })),
  );
  // Ordinary Search keeps identity expansion bounded for display work. Ask's
  // explicit-entity path must retain every request-bound root/hash seed so a
  // later distinct identity cannot disappear from the exhaustive ambiguity
  // assessment behind many byte-identical copies.
  const seedPairs = exhaustiveEntityCandidates ? allSeedPairs : allSeedPairs.slice(0, 24);
  const expansionHashesByRoot = new Map<string, string[]>();
  for (const { connectedLibraryId, hash } of seedPairs) {
    const hashes = expansionHashesByRoot.get(connectedLibraryId) ?? [];
    hashes.push(hash);
    expansionHashesByRoot.set(connectedLibraryId, hashes);
  }
  const relatedCandidates = seedPairs.length ? await prisma.librarySearchEntry.findMany({
    take: exhaustiveEntityCandidates ? undefined : 40,
    orderBy: [{ connectedLibraryId: "asc" }, { relativePath: "asc" }, { id: "asc" }],
    where: {
      ...candidateScope,
      OR: [...expansionHashesByRoot].map(([connectedLibraryId, hashes]) => ({
        connectedLibraryId,
        entityHashes: { hasSome: hashes },
      })),
    },
  }) : [];
  const identityCandidates = [...new Map([...directCandidates, ...relatedCandidates]
    .map((entry) => [entry.id, entry])).values()];
  const separatedIdentityPairs = identityCandidates.length && seedEntries.length
    ? await getSeparatedRelationshipPairIdentities(
      identityCandidates,
      ["SAME_CLIENT", "SAME_PROJECT"],
    )
    : new Map<string, Set<string>>();
  const seedIds = new Set(seedEntries.map((entry) => entry.id));
  const separatedFromSeedIds = new Set<string>();
  if (separatedIdentityPairs.size) {
    const endpointKey = (entry: typeof initial[number]) => `${entry.fileKey}\0${entry.checksum}`;
    const seedsByEndpoint = new Map<string, typeof seedEntries>();
    const candidatesByEndpoint = new Map<string, typeof identityCandidates>();
    for (const seed of seedEntries) {
      const key = endpointKey(seed);
      const values = seedsByEndpoint.get(key) ?? [];
      values.push(seed);
      seedsByEndpoint.set(key, values);
    }
    for (const candidate of identityCandidates) {
      const key = endpointKey(candidate);
      const values = candidatesByEndpoint.get(key) ?? [];
      values.push(candidate);
      candidatesByEndpoint.set(key, values);
    }
    const markSeparatedCandidates = (seedEndpoint: string, candidateEndpoint: string,
      separatedHashes: Set<string>) => {
      for (const seed of seedsByEndpoint.get(seedEndpoint) ?? []) {
        const seedHashes = seedHashesByRoot.get(seed.connectedLibraryId);
        if (!seedHashes) continue;
        for (const candidate of candidatesByEndpoint.get(candidateEndpoint) ?? []) {
          if (seed.id === candidate.id) continue;
          if ([...separatedHashes].some((hash) => seedHashes.has(hash) &&
              seed.entityHashes.includes(hash) && candidate.entityHashes.includes(hash))) {
            separatedFromSeedIds.add(candidate.id);
          }
        }
      }
    };
    for (const [pairKey, separatedHashes] of separatedIdentityPairs) {
      const [leftFileKey, leftChecksum, rightFileKey, rightChecksum] = pairKey.split("\0");
      const leftEndpoint = `${leftFileKey}\0${leftChecksum}`;
      const rightEndpoint = `${rightFileKey}\0${rightChecksum}`;
      markSeparatedCandidates(leftEndpoint, rightEndpoint, separatedHashes);
      markSeparatedCandidates(rightEndpoint, leftEndpoint, separatedHashes);
    }
  }
  // Direct entity matches remain authoritative seeds. Other lexical candidates are
  // expansion-dependent when they rely on a seeded identity hash, and must obey
  // the same checksum-bound human separation as candidates found by expansion.
  const filteredInitial = initial.filter((entry) =>
    seedIds.has(entry.id) || !separatedFromSeedIds.has(entry.id));
  const related = relatedCandidates.filter((entry) => !separatedFromSeedIds.has(entry.id));
  const exactIds = new Set(exact.map((entry) => entry.id));
  const boundedCandidates = [...new Map([
    ...filteredInitial.filter((entry) => exactIds.has(entry.id)),
    ...seedEntries,
    ...related,
    ...filteredInitial,
  ].map((entry) => [entry.id, entry])).values()]
    .filter((entry) => !intent.fileType || entry.fileType.toLowerCase().includes(intent.fileType.replace(/s$/, "")))
    .slice(0, exhaustiveCandidates ? undefined : searchCandidateLimit);
  const candidateById = new Map(boundedCandidates.map((entry) => [entry.id, entry]));
  const currentSourceIds = new Set((await prisma.scannedFile.findMany({
    select: { id: true }, where: { id: { in: [...candidateById.values()].map((entry) => entry.scannedFileId) },
      sourceUnavailableAt: null },
  })).map((file) => file.id));
  const [versions, separatedVersionPairs] = await Promise.all([
    getDocumentVersionSignals([...candidateById.values()], intent.wantsHistory),
    getSeparatedRelationshipPairIdentities([...candidateById.values()], ["PROBABLE_REVISION"]),
  ]);
  const versionState = buildVersionStateIndex(versions, separatedVersionPairs, knowledgeRelationshipPairKey, options?.work);
  const results: LibrarySearchResult[] = [];
  for (const entry of candidateById.values()) {
    const root = rootById.get(entry.connectedLibraryId);
    const rootSeedHashes = seedHashesByRoot.get(entry.connectedLibraryId) ?? new Set<string>();
    if (!root || !currentSourceIds.has(entry.scannedFileId) ||
        (!intent.wantsHistory && !root.scanSessions.some((session) => session.id === entry.scanSessionId))) continue;
    if (intent.entityName && !entry.entityHashes.some((hash) => rootSeedHashes.has(hash))) continue;
    if (intent.fileType && !entry.fileType.toLowerCase().includes(intent.fileType.replace(/s$/, ""))) continue;
    const ranked = rankSearchEntry(entry, intent, rootSeedHashes) ??
      (historyListIds.has(entry.id)
        ? { score: 1, reason: "Retained historical document", matchingExcerpt: null } : null);
    if (!ranked) continue;
    const category = mediaCategoryForFileType(entry.fileType);
    const supersededVersion = versionState.superseded.has(versionEndpoint(entry));
    const state = !entry.isCurrent ? "Historical scan" : supersededVersion ? "Earlier document version" :
      category === "AUDIO" || category === "VIDEO" || category === "IMAGE"
        ? "Media evidence; check the source" :
        entry.knowledgeState === "APPROVED" ? "Human reviewed" : "Provisional source evidence";
    const correctedEvidence = humanReviewedEvidenceByEndpoint.get(versionEndpoint(entry));
    const fieldExcerpt = entitySourceExcerptByEndpoint.get(versionEndpoint(entry));
    // Preserve existing answer context when it already contains this field.
    // This check chooses a quotation only; canonical matching is already done.
    const entityExcerpt = fieldExcerpt && !validExcerpts(entry.sourceExcerpts).some((item) =>
      item.start <= fieldExcerpt.start && item.end >= fieldExcerpt.end &&
      item.text.slice(fieldExcerpt.start - item.start, fieldExcerpt.end - item.start) === fieldExcerpt.text)
      ? fieldExcerpt : undefined;
    const excerpt = entityExcerpt ?? ranked.matchingExcerpt;
    results.push({
      kind: "FILE",
      humanReviewedEvidence: correctedEvidence,
      entitySourceExcerpt: entityExcerpt,
      excerpt: correctedEvidence ?? excerpt?.text ?? null,
      fileType: entry.fileType,
      href: entry.isCurrent
        ? getScannedFileExamineRoute(entry.scanSessionId, entry.scannedFileId)
        : getScanSessionRoute(entry.scanSessionId),
      id: entry.id,
      reason: ranked.reason,
      relativePath: entry.relativePath,
      rootName: root.displayName,
      score: ranked.score,
      matchedEntityHashes: options?.includeEntityMatches && intent.entityKind
        ? [...(effectiveHashesByEndpoint.get(
          `${entry.connectedLibraryId}\0${entry.fileKey}\0${entry.checksum}`,
        ) ?? entry.entityHashes)].filter((hash) => rootSeedHashes.has(hash)).sort()
        : undefined,
      sourceRange: !correctedEvidence && excerpt ? { start: excerpt.start, end: excerpt.end } : null,
      state,
    });
  }

  // Path-only metadata cannot bind a requested typed identity. Explicit entity
  // results must use the checksum-bound effective evidence checked above.
  // Ordinary metadata discovery still works before indexing.
  const fallback = intent.wantsHistory || intent.entityKind ? [] : await prisma.scannedFile.findMany({
    take: 40,
    orderBy: [{ scanSession: { connectedFolderId: "asc" } }, { relativePath: "asc" }, { id: "asc" }],
    select: { fileType: true, id: true, relativePath: true, sessionId: true,
      readingStatus: true, libraryDocument: { select: { observationSessions: {
        select: { id: true }, take: 1,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      } } },
      scanSession: { select: { connectedFolderId: true } } },
    where: { sessionId: { in: latestSessionIds }, sourceUnavailableAt: null,
      ...(intent.fileType ? { fileType: { contains: intent.fileType.replace(/s$/, ""), mode: "insensitive" as const } } : {}),
      OR: [
        { relativePath: { contains: intent.query, mode: "insensitive" } },
        ...intent.terms.slice(0, 4).map((term) => ({ relativePath: { contains: term, mode: "insensitive" as const } })),
      ] },
  });
  const indexedFileIds = new Set([...candidateById.values()].map((entry) => entry.scannedFileId));
  for (const file of fallback) {
    const root = rootById.get(file.scanSession.connectedFolderId);
    if (!root) continue;
    if (intent.entityName && !matchesEntityPhrase(file.relativePath, intent.entityName)) continue;
    const href = getScannedFileExamineRoute(file.sessionId, file.id);
    if (indexedFileIds.has(file.id)) continue;
    if (intent.fileType && !file.fileType.toLowerCase().includes(intent.fileType.replace(/s$/, ""))) continue;
    const category = mediaCategoryForFileType(file.fileType);
    results.push({
      kind: "FILE",
      excerpt: null, fileType: file.fileType, href: file.readingStatus === "READ" &&
        (file.libraryDocument?.observationSessions.length ?? 0) > 0
        ? href : getScanSessionRoute(file.sessionId),
      id: file.id, reason: "File name or path match", relativePath: file.relativePath,
      rootName: root.displayName, score: file.relativePath.toLowerCase() === intent.query.toLowerCase() ||
        path.posix.basename(file.relativePath.toLowerCase()) === intent.query.toLowerCase()
        ? 220 : 45, sourceRange: null,
      state: category === "AUDIO" || category === "VIDEO" || category === "IMAGE"
        ? "Metadata match; content may not be searchable" : "Not indexed; metadata match only",
    });
  }
  // Memory is a distinct human-approved result, never evidence that a file
  // contains the Memory wording. Every contributing root must remain readable.
  const memoryIds = retainedHistoryList ? [] : await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT memory.id FROM "MemoryEntry" memory WHERE ${eligibleMemorySql(rootIds)} AND (
      position(lower(${intent.query}) in lower(memory.title)) > 0 OR
      position(lower(${intent.query}) in lower(memory.description)) > 0 OR
      ${intent.terms.length ? Prisma.join(intent.terms.slice(0, 6).map((term) => Prisma.sql`position(lower(${term}) in lower(memory.title)) > 0`), " OR ") : Prisma.sql`false`}
    ) ORDER BY memory.title ASC, memory.id ASC LIMIT 60
  `);
  const memories = retainedHistoryList ? [] : await prisma.memoryEntry.findMany({
    take: 60,
    orderBy: [{ title: "asc" }, { id: "asc" }],
    select: { id: true, title: true, description: true, searchSourceCount: true, searchSources: {
      select: { connectedLibraryId: true, observationSession: { select: { status: true } } },
    } },
    where: { id: { in: memoryIds.map((row) => row.id) }, status: "ACTIVE", searchProvenanceComplete: true,
      searchSources: { some: {}, every: {
        connectedLibraryId: { in: rootIds },
        observationSession: { status: { in: ["APPROVED", "MODIFIED"] } },
      } },
      OR: [
        { title: { contains: intent.query, mode: "insensitive" } },
        { description: { contains: intent.query, mode: "insensitive" } },
        ...intent.terms.slice(0, 6).map((term) => ({ title: { contains: term, mode: "insensitive" as const } })),
      ] },
  });
  for (const memory of memories) {
    if (!memory.searchSources.length || memory.searchSources.length !== memory.searchSourceCount ||
      memory.searchSources.some((source) =>
      !rootById.has(source.connectedLibraryId) ||
      !["APPROVED", "MODIFIED"].includes(source.observationSession.status))) continue;
    const titleTerms = workingKnowledgeTerms(memory.title);
    const matchingTerms = intent.terms.filter((term) => titleTerms.includes(term));
    if (!matchingTerms.length && !memory.title.toLowerCase().includes(intent.query.toLowerCase()) &&
      !memory.description.toLowerCase().includes(intent.query.toLowerCase())) continue;
    const names = [...new Set(memory.searchSources.map((source) =>
      rootById.get(source.connectedLibraryId)!.displayName))];
    results.push({ id: memory.id, kind: "MEMORY", fileType: "APPROVED_MEMORY",
      href: "/admin/library/memory", rootName: names.join("; "), relativePath: memory.title,
      state: "Human-approved Memory", reason: "Matches a human-approved library memory, not a quotation from a file",
      excerpt: null, sourceRange: null, score: Math.min(45, 28 + matchingTerms.length * 6) });
  }
  const rankedResults = results.sort(compareSearchResults);
  return exhaustiveCandidates
    ? rankedResults
    : rankedResults.slice(0, searchResultLimit);
}
