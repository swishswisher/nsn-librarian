import { createHash } from "node:crypto";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { verifiedSourceExcerpts } from "@/lib/ai/source-evidence";

import { getPrismaClient } from "@/lib/db/prisma";
import { workingKnowledgeTerms, type ScanWorkingKnowledgeIndex } from "@/lib/bridge/scan-working-knowledge";
import { fileKeyAfterKnownMoves, getEffectiveDocumentSignals, getIdentityCorrectionComponent, knownExecutedMoves, usableScanSnapshotWhere } from "@/lib/bridge/persistent-knowledge";
import { versionEndpoint } from "@/lib/bridge/document-version-index";
import { countKnowledgeWork, type KnowledgeWork } from "@/lib/bridge/knowledge-work";
import { loadScanWorkingKnowledge } from "@/lib/bridge/scan-working-knowledge";

export const librarySearchIndexVersion = "library-search-v1";
export const searchEvidenceLimit = 8;
export const searchExcerptLimit = 240;

export type SearchExcerpt = { end: number; start: number; text: string };

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function boundedSourceExcerpts(value: string): SearchExcerpt[] {
  return verifiedSourceExcerpts(value).slice(0, searchEvidenceLimit);
}

export function searchEntryFingerprint(input: {
  checksum: string;
  knowledgeState: string;
  excerpts: SearchExcerpt[];
  reviewedText: string;
  concepts: string[];
  entityHashes: string[];
}) {
  return digest(JSON.stringify([librarySearchIndexVersion, input.checksum, input.knowledgeState, input.excerpts,
    input.reviewedText, input.concepts, input.entityHashes]));
}

export async function indexScanKnowledge(index: ScanWorkingKnowledgeIndex, onlyFileIds?: string[], stats?: {
  reused: number;
  resolvedSignals?: number;
}) {
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findUnique({
    select: {
      connectedFolderId: true,
      connectedFolder: { select: { isEnabled: true, readPermission: true, status: true } },
    },
    where: { id: index.scanSessionId },
  });
  if (!session || !session.connectedFolder.isEnabled || !session.connectedFolder.readPermission ||
      session.connectedFolder.status !== "CONNECTED") return 0;
  const latestSession = await prisma.scanSession.findFirst({
    orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { id: true },
    where: { ...usableScanSnapshotWhere, connectedFolderId: session.connectedFolderId },
  });
  if (latestSession?.id !== index.scanSessionId) return 0;

  const files = await prisma.scannedFile.findMany({
    select: {
      checksum: true, extractionStatus: true, fileType: true, id: true, libraryDocument: {
        select: { observationSessions: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, status: true, humanDecisions: {
            where: { decisionType: "MODIFY" },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { decisionType: true, editedSuggestion: true }, take: 1,
          } }, take: 1,
        } },
      },
      readingStatus: true, relativePath: true,
    },
    where: { sessionId: index.scanSessionId, ...(onlyFileIds ? { id: { in: onlyFileIds } } : {}) },
  });
  const workingById = new Map(index.files.map((file) => [file.id, file]));
  const moves = await knownExecutedMoves(session.connectedFolderId);
  const signalScope = files.flatMap((file) => file.checksum ? [{
    checksum: file.checksum,
    connectedLibraryId: session.connectedFolderId,
    fileKey: fileKeyAfterKnownMoves(session.connectedFolderId, file.relativePath, file.checksum, moves),
    isCurrent: true,
  }] : []);
  // A full scan intentionally resolves the root once. Expressing all 20,000
  // endpoints as one Prisma OR would exceed PostgreSQL's bind-parameter limit;
  // targeted/backfill indexing keeps the exact endpoint scope.
  const effectiveSignals = await getEffectiveDocumentSignals([session.connectedFolderId],
    onlyFileIds ? { historicalEntries: [], scopedEntries: signalScope } : undefined);
  if (stats) stats.resolvedSignals = effectiveSignals.length;
  const entityHashesByEndpoint = new Map<string, Set<string>>();
  for (const signal of effectiveSignals) {
    if (signal.kind === "FILE_ANCHOR") continue;
    const key = `${signal.fileKey}\0${signal.checksum}`;
    const hashes = entityHashesByEndpoint.get(key) ?? new Set<string>();
    hashes.add(signal.identityHash);
    entityHashesByEndpoint.set(key, hashes);
  }
  let indexed = 0;
  for (const file of files) {
    const working = workingById.get(file.id);
    if (!file.checksum || file.extractionStatus !== "COMPLETED" ||
        file.readingStatus !== "READ" || !working) continue;

    const fileKey = fileKeyAfterKnownMoves(session.connectedFolderId, file.relativePath, file.checksum, moves);
    const entryKey = digest([librarySearchIndexVersion, fileKey, file.checksum].join("\0"));
    const observation = file.libraryDocument?.observationSessions[0];
    const reviewedText = observation?.status === "MODIFIED"
      ? observation.humanDecisions.find((decision) => decision.decisionType === "MODIFY")?.editedSuggestion?.slice(0, searchExcerptLimit) ?? ""
      : "";
    const excerpts = observation?.status === "REJECTED" ? [] : boundedSourceExcerpts(working.sourceEvidenceText);
    const entityHashes = [...(entityHashesByEndpoint.get(`${fileKey}\0${file.checksum}`) ?? [])].sort();
    const concepts = observation?.status === "REJECTED" ? [] : working.supportingTopics.slice(0, 8);
    const knowledgeState = observation?.status === "APPROVED" || observation?.status === "MODIFIED"
      ? "APPROVED" : "PROVISIONAL";
    const fingerprint = searchEntryFingerprint({ checksum: file.checksum,
      concepts, entityHashes, excerpts, reviewedText, knowledgeState });
    const existing = await prisma.librarySearchEntry.findUnique({
      select: { fingerprint: true, isCurrent: true, scannedFileId: true, scanSessionId: true,
        fileType: true, relativePath: true, fileName: true }, where: { entryKey },
    });
    await prisma.librarySearchEntry.updateMany({
      data: { isCurrent: false },
      where: { isCurrent: true, entryKey: { not: entryKey },
        OR: [{ fileKey }, { scannedFileId: file.id }] },
    });
    if (existing?.fingerprint === fingerprint) {
      if (stats) stats.reused += 1;
      if (!existing.isCurrent || existing.scannedFileId !== file.id ||
          existing.scanSessionId !== index.scanSessionId || existing.fileType !== file.fileType ||
          existing.relativePath !== file.relativePath || existing.fileName !== path.posix.basename(file.relativePath.replaceAll("\\", "/"))) {
        await prisma.librarySearchEntry.update({
          data: { isCurrent: true, scannedFileId: file.id, scanSessionId: index.scanSessionId,
            relativePath: file.relativePath, fileType: file.fileType,
            fileName: path.posix.basename(file.relativePath.replaceAll("\\", "/")) }, where: { entryKey },
        });
      }
    } else {
      await prisma.librarySearchEntry.upsert({
        create: {
          checksum: file.checksum, connectedLibraryId: session.connectedFolderId,
          concepts, entityHashes, entryKey, fileKey, fileType: file.fileType,
          fileName: path.posix.basename(file.relativePath.replaceAll("\\", "/")),
          fingerprint, indexVersion: librarySearchIndexVersion, isCurrent: true,
          knowledgeState,
          relativePath: file.relativePath, reviewedTerms: workingKnowledgeTerms(reviewedText).slice(0, 40),
          scannedFileId: file.id, scanSessionId: index.scanSessionId,
          sourceExcerpts: excerpts, sourceTerms: workingKnowledgeTerms(excerpts.map((excerpt) => excerpt.text).join(" ")).slice(0, 80),
        },
        update: {
          concepts, entityHashes, fingerprint, indexedAt: new Date(), isCurrent: true, fileType: file.fileType,
          knowledgeState,
          fileName: path.posix.basename(file.relativePath.replaceAll("\\", "/")),
          relativePath: file.relativePath, reviewedTerms: workingKnowledgeTerms(reviewedText).slice(0, 40),
          scannedFileId: file.id, scanSessionId: index.scanSessionId,
          sourceExcerpts: excerpts, sourceTerms: workingKnowledgeTerms(excerpts.map((excerpt) => excerpt.text).join(" ")).slice(0, 80),
        },
        where: { entryKey },
      });
    }
    indexed += 1;
  }
  // Entries absent from the latest snapshot remain historical, never active search evidence.
  if (!onlyFileIds) await prisma.librarySearchEntry.updateMany({
    data: { isCurrent: false },
    where: { connectedLibraryId: session.connectedFolderId, isCurrent: true,
      scanSessionId: { not: index.scanSessionId } },
  });
  return indexed;
}

export async function refreshSearchForObservation(observationSessionId: string) {
  const prisma = getPrismaClient();
  const observation = await prisma.observationSession.findUnique({
    select: { libraryDocumentId: true },
    where: { id: observationSessionId },
  });
  if (!observation) return;
  const files = await prisma.scannedFile.findMany({
    select: { id: true, sessionId: true, scanSession: { select: { connectedFolderId: true } } },
    where: { libraryDocumentId: observation.libraryDocumentId,
      scanSession: { ...usableScanSnapshotWhere,
        connectedFolder: { isEnabled: true, readPermission: true, status: "CONNECTED" } } },
    orderBy: [{ scanSession: { startedAt: "desc" } }, { scanSession: { id: "desc" } },
      { createdAt: "desc" }, { id: "desc" }],
  });
  for (const file of files) {
    const latest = await prisma.scanSession.findFirst({
      select: { id: true }, orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      where: { ...usableScanSnapshotWhere, connectedFolderId: file.scanSession.connectedFolderId },
    });
    if (latest?.id !== file.sessionId) continue;
    await indexScanKnowledge(await loadScanWorkingKnowledge(file.sessionId), [file.id]);
    return;
  }
}

export async function refreshSearchForIdentityRelationship(relationshipId: string, work?: KnowledgeWork) {
  const prisma = getPrismaClient();
  const relationship = await prisma.knowledgeConnection.findUnique({ where: { id: relationshipId } });
  if (!relationship) return;
  const evidence = relationship.sourceEvidence;
  const connectedLibraryId = evidence && !Array.isArray(evidence) && typeof evidence === "object" &&
    typeof evidence.connectedLibraryId === "string" ? evidence.connectedLibraryId : null;
  if (!connectedLibraryId) return;
  const affected = await getIdentityCorrectionComponent([
    { fileKey: relationship.sourceFileKey, checksum: relationship.sourceChecksum },
    { fileKey: relationship.targetFileKey, checksum: relationship.targetChecksum },
  ].flatMap((entry) => entry.fileKey && entry.checksum ? [{ ...entry,
    fileKey: entry.fileKey, checksum: entry.checksum, connectedLibraryId, isCurrent: true }] : []), work);
  const entries = [];
  for (let offset = 0; offset < affected.length; offset += 500) {
    countKnowledgeWork(work, "searchRefreshQueries");
    entries.push(...await prisma.librarySearchEntry.findMany({
    orderBy: { id: "asc" },
    select: { id: true, connectedLibraryId: true, fileKey: true, checksum: true, entityHashes: true, fingerprint: true },
    where: { isCurrent: true, connectedLibraryId,
      connectedLibrary: { isEnabled: true, readPermission: true, status: "CONNECTED",
        disconnectedAt: null, hiddenFromActiveListAt: null, mergedAt: null, canonicalConnectedLibraryId: null },
      OR: affected.slice(offset, offset + 500).map(({ fileKey, checksum }) => ({ fileKey, checksum })) },
    }));
  }
  if (!entries.length) return;
  const signals = await getEffectiveDocumentSignals([...new Set(entries.map((entry) => entry.connectedLibraryId))]);
  const hashesByEndpoint = new Map<string, Set<string>>();
  for (const signal of signals) {
    countKnowledgeWork(work, "searchRefreshSignals");
    if (signal.kind === "FILE_ANCHOR") continue;
    const key = versionEndpoint(signal);
    const hashes = hashesByEndpoint.get(key) ?? new Set<string>();
    hashes.add(signal.identityHash); hashesByEndpoint.set(key, hashes);
  }
  const changedEntries = [];
  for (const entry of entries) {
    countKnowledgeWork(work, "searchRefreshEntries");
    const entityHashes = [...(hashesByEndpoint.get(versionEndpoint(entry)) ?? [])].sort();
    if (entry.fingerprint === "" && JSON.stringify(entry.entityHashes) === JSON.stringify(entityHashes)) continue;
    countKnowledgeWork(work, "searchRefreshUpdates");
    changedEntries.push({ ...entry, entityHashes });
  }
  const indexedAt = new Date();
  for (let offset = 0; offset < changedEntries.length; offset += 500) {
    countKnowledgeWork(work, "searchRefreshUpdateQueries");
    const values = Prisma.join(changedEntries.slice(offset, offset + 500).map((entry) =>
      Prisma.sql`(${entry.id}, ${entry.fileKey}, ${entry.checksum},
        ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(entry.entityHashes)}::jsonb)))`));
    // Parameterized bulk projection avoids one write query per endpoint. Recheck
    // root authority and exact current bytes on every bounded write as well.
    // Empty fingerprint makes normal indexing recompute the derived fields.
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "LibrarySearchEntry" AS entry
      SET "entityHashes" = projection.hashes, "fingerprint" = '', "indexedAt" = ${indexedAt}
      FROM (VALUES ${values}) AS projection(id, "fileKey", checksum, hashes)
      WHERE entry.id = projection.id AND entry."isCurrent" = true
        AND entry."connectedLibraryId" = ${connectedLibraryId}
        AND entry."fileKey" = projection."fileKey" AND entry.checksum = projection.checksum
        AND EXISTS (SELECT 1 FROM "ConnectedFolder" AS root
          WHERE root.id = entry."connectedLibraryId" AND root.enabled = true
            AND root."readPermission" = true AND root.status = 'CONNECTED'
            AND root."disconnectedAt" IS NULL AND root."hiddenFromActiveListAt" IS NULL
            AND root."mergedAt" IS NULL AND root."canonicalConnectedLibraryId" IS NULL)
    `);
  }
}
