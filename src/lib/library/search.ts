import path from "node:path";

import { getPrismaClient } from "@/lib/db/prisma";
import { compareDocumentVersions } from "@/lib/bridge/document-signals";
import {
  getDocumentVersionSignals,
  getSeparatedRelationshipPairIdentities,
  knowledgeRelationshipPairKey,
  usableScanSnapshotWhere,
} from "@/lib/bridge/persistent-knowledge";
import { mediaCategoryForFileType } from "@/lib/bridge/media-kind";
import { searchTopicIds, workingKnowledgeTerms } from "@/lib/bridge/scan-working-knowledge";
import { getScannedFileExamineRoute, getScanSessionRoute } from "@/lib/library/routes";
import { librarySearchIndexVersion, type SearchExcerpt } from "./search-index";

export const searchCandidateLimit = 120;
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
};

export type SearchIntent = {
  query: string;
  terms: string[];
  concepts: string[];
  wantsHistory: boolean;
  fileType: string | null;
  entityName: string | null;
};

export function parseSearchIntent(value: string): SearchIntent {
  const query = value.trim().slice(0, 120);
  const normalized = query.toLowerCase();
  const fileType = /\b(pdf|docx?|html?|markdown|images?|audio|video)\b/i.exec(query)?.[1]?.toLowerCase() ?? null;
  const entityPhrase = /\b(?:client|project)\s+(?:named\s+)?([\p{L}\p{N}][\p{L}\p{N} .'-]{0,70})/iu.exec(query)?.[1];
  const entityName = entityPhrase?.split(/\b(?:and|with|about|have|in|on|for|from|documents?|files?|invoices?|versions?|pdf|docx?|html?|markdown|images?|audio|video|older|earlier|previous|history)\b/iu)[0]?.trim().toLowerCase() || null;
  return {
    query,
    terms: workingKnowledgeTerms(query).slice(0, 12),
    concepts: searchTopicIds(query),
    wantsHistory: /\b(older|earlier|previous|versions?|history|historical)\b/.test(normalized),
    fileType,
    entityName,
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

export async function searchLibrary(value: string, permittedRootIds?: string[]): Promise<LibrarySearchResult[]> {
  const intent = parseSearchIntent(value);
  if (intent.query.length < 2) return [];
  const prisma = getPrismaClient();
  // This is a single-human installation today. Root grants remain an explicit
  // database predicate; there is no per-user library ownership model to infer.
  const roots = await prisma.connectedLibrary.findMany({
    select: { id: true, displayName: true, scanSessions: {
      orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { id: true }, take: 1,
      where: usableScanSnapshotWhere,
    } },
    where: { isEnabled: true, readPermission: true, status: "CONNECTED",
      ...(permittedRootIds ? { id: { in: permittedRootIds } } : {}),
      disconnectedAt: null, hiddenFromActiveListAt: null, mergedAt: null,
      canonicalConnectedLibraryId: null },
  });
  const rootById = new Map(roots.map((root) => [root.id, root]));
  const rootIds = roots.map((root) => root.id);
  const latestSessionIds = roots.flatMap((root) => root.scanSessions.map((session) => session.id));
  if (rootIds.length === 0 || latestSessionIds.length === 0) return [];

  const scope = {
    connectedLibraryId: { in: rootIds },
    indexVersion: librarySearchIndexVersion,
    ...(intent.wantsHistory ? {} : { isCurrent: true, scanSessionId: { in: latestSessionIds } }),
  } as const;
  const exact = await prisma.librarySearchEntry.findMany({
    take: 20,
    orderBy: [{ isCurrent: "desc" }, { indexedAt: "desc" }],
    where: { ...scope, OR: [
      { fileName: { equals: intent.query, mode: "insensitive" } },
      { relativePath: { equals: intent.query, mode: "insensitive" } },
    ] },
  }).catch(() => []);
  const broader = await prisma.librarySearchEntry.findMany({
    take: searchCandidateLimit - exact.length,
    orderBy: [{ isCurrent: "desc" }, { indexedAt: "desc" }],
    where: {
      ...scope,
      OR: [
        { relativePath: { contains: intent.query, mode: "insensitive" } },
        ...intent.terms.length ? [{ sourceTerms: { hasSome: intent.terms } },
          { reviewedTerms: { hasSome: intent.terms } }] : [],
        ...intent.concepts.length ? [{ concepts: { hasSome: intent.concepts } }] : [],
      ],
    },
  }).catch(() => []);
  const initial = [...new Map([...exact, ...broader].map((entry) => [entry.id, entry])).values()];

  // Resolved identity expansion uses only identities from already scoped matches.
  // Human SEPARATE decisions suppress only the rejected identity hash for that
  // exact file/checksum pair; independent matches and other identities remain valid.
  const seedEntries = initial.filter((entry) =>
    intent.entityName
      ? validExcerpts(entry.sourceExcerpts).some((excerpt) => matchesEntityPhrase(excerpt.text, intent.entityName!)) ||
        matchesEntityPhrase(entry.relativePath, intent.entityName)
      : intent.terms.filter((term) => entry.sourceTerms.includes(term) ||
          workingKnowledgeTerms(entry.relativePath).includes(term)).length >= 2,
  );
  const seedHashesByRoot = new Map<string, Set<string>>();
  for (const entry of seedEntries) {
    const hashes = seedHashesByRoot.get(entry.connectedLibraryId) ?? new Set<string>();
    for (const hash of entry.entityHashes) hashes.add(hash);
    seedHashesByRoot.set(entry.connectedLibraryId, hashes);
  }
  const seedPairs = [...seedHashesByRoot].flatMap(([connectedLibraryId, hashes]) =>
    [...hashes].map((hash) => ({ connectedLibraryId, hash })),
  ).slice(0, 24);
  const seedHashes = [...new Set(seedPairs.map(({ hash }) => hash))];
  const expansionHashesByRoot = new Map<string, string[]>();
  for (const { connectedLibraryId, hash } of seedPairs) {
    const hashes = expansionHashesByRoot.get(connectedLibraryId) ?? [];
    hashes.push(hash);
    expansionHashesByRoot.set(connectedLibraryId, hashes);
  }
  const relatedCandidates = seedPairs.length ? await prisma.librarySearchEntry.findMany({
    take: Math.min(40, searchCandidateLimit - initial.length),
    where: {
      ...scope,
      OR: [...expansionHashesByRoot].map(([connectedLibraryId, hashes]) => ({
        connectedLibraryId,
        entityHashes: { hasSome: hashes },
      })),
    },
  }) : [];
  const separatedIdentityPairs = relatedCandidates.length && seedEntries.length
    ? await getSeparatedRelationshipPairIdentities(
      [...seedEntries, ...relatedCandidates],
      ["SAME_CLIENT", "SAME_PROJECT"],
    )
    : new Map<string, Set<string>>();
  const related = relatedCandidates.filter((entry) => !seedEntries.some((seed) => {
    if (seed.id === entry.id) return false;
    const separatedHashes = separatedIdentityPairs.get(knowledgeRelationshipPairKey(seed, entry));
    return Boolean(separatedHashes && [...separatedHashes].some((hash) =>
      seedHashes.includes(hash) && seed.entityHashes.includes(hash) && entry.entityHashes.includes(hash),
    ));
  }));
  const candidateById = new Map([...initial, ...related].map((entry) => [entry.id, entry]));
  const currentSourceIds = new Set((await prisma.scannedFile.findMany({
    select: { id: true }, where: { id: { in: [...candidateById.values()].map((entry) => entry.scannedFileId) },
      sourceUnavailableAt: null },
  })).map((file) => file.id));
  const [versions, separatedVersionPairs] = await Promise.all([
    getDocumentVersionSignals([...candidateById.values()], intent.wantsHistory),
    getSeparatedRelationshipPairIdentities([...candidateById.values()], ["PROBABLE_REVISION"]),
  ]);
  const results: LibrarySearchResult[] = [];
  for (const entry of candidateById.values()) {
    const root = rootById.get(entry.connectedLibraryId);
    if (!root || !currentSourceIds.has(entry.scannedFileId) ||
        (!intent.wantsHistory && !root.scanSessions.some((session) => session.id === entry.scanSessionId))) continue;
    if (intent.entityName && !entry.entityHashes.some((hash) => seedHashes.includes(hash)) &&
        !matchesEntityPhrase(entry.relativePath, intent.entityName) &&
        !validExcerpts(entry.sourceExcerpts).some((excerpt) => matchesEntityPhrase(excerpt.text, intent.entityName!))) continue;
    if (intent.fileType && !entry.fileType.toLowerCase().includes(intent.fileType.replace(/s$/, ""))) continue;
    const ranked = rankSearchEntry(entry, intent, new Set(seedHashes));
    if (!ranked) continue;
    const category = mediaCategoryForFileType(entry.fileType);
    const member = versions.find((signal) => signal.connectedLibraryId === entry.connectedLibraryId &&
      signal.fileKey === entry.fileKey && signal.checksum === entry.checksum);
    const supersededVersion = member && versions.some((other) =>
      other.connectedLibraryId === member.connectedLibraryId &&
      other.identityHash === member.identityHash &&
      (other.fileKey !== member.fileKey || other.checksum !== member.checksum) &&
      !separatedVersionPairs.has(knowledgeRelationshipPairKey(member, other)) &&
      compareDocumentVersions(other, member) === 1,
    );
    const state = !entry.isCurrent ? "Historical scan" : supersededVersion ? "Earlier document version" :
      category === "AUDIO" || category === "VIDEO" || category === "IMAGE"
        ? "Media evidence; check the source" :
        entry.knowledgeState === "APPROVED" ? "Human reviewed" : "Provisional source evidence";
    results.push({
      kind: "FILE",
      excerpt: ranked.matchingExcerpt?.text ?? null,
      fileType: entry.fileType,
      href: entry.isCurrent
        ? getScannedFileExamineRoute(entry.scanSessionId, entry.scannedFileId)
        : getScanSessionRoute(entry.scanSessionId),
      id: entry.id,
      reason: ranked.reason,
      relativePath: entry.relativePath,
      rootName: root.displayName,
      score: ranked.score,
      sourceRange: ranked.matchingExcerpt
        ? { start: ranked.matchingExcerpt.start, end: ranked.matchingExcerpt.end } : null,
      state,
    });
  }

  // Metadata fallback works before indexing and for incomplete/unsupported files.
  const fallback = await prisma.scannedFile.findMany({
    take: 40,
    select: { fileType: true, id: true, relativePath: true, sessionId: true,
      readingStatus: true, libraryDocument: { select: { observationSessions: {
        select: { id: true }, take: 1,
      } } },
      scanSession: { select: { connectedFolderId: true } } },
    where: { sessionId: { in: latestSessionIds }, sourceUnavailableAt: null,
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
  const memories = await prisma.memoryEntry.findMany({
    take: 60,
    select: { id: true, title: true, description: true, searchSourceCount: true, searchSources: {
      select: { connectedLibraryId: true, observationSession: { select: { status: true } } },
    } },
    where: { status: "ACTIVE", searchProvenanceComplete: true,
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
  return results.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, searchResultLimit);
}
