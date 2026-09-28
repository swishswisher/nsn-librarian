import { createHash } from "node:crypto";
import path from "node:path";

import { getPrismaClient } from "@/lib/db/prisma";
import { workingKnowledgeTerms, type ScanWorkingKnowledgeIndex } from "@/lib/bridge/scan-working-knowledge";
import { getEffectiveDocumentSignals, humanIdentityCorrectionVersion, persistentFileKey, usableScanSnapshotWhere } from "@/lib/bridge/persistent-knowledge";
import { loadScanWorkingKnowledge } from "@/lib/bridge/scan-working-knowledge";

export const librarySearchIndexVersion = "library-search-v1";
export const searchEvidenceLimit = 8;
export const searchExcerptLimit = 240;

export type SearchExcerpt = { end: number; start: number; text: string };

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function boundedSourceExcerpts(value: string): SearchExcerpt[] {
  return [...value.matchAll(/Source characters (\d+)-(\d+): "([^"\n]{1,240})"/g)]
    .flatMap((match) => {
      const start = Number(match[1]);
      const end = Number(match[2]);
      const text = match[3];
      return end - start === text.length ? [{ end, start, text }] : [];
    })
    .slice(0, searchEvidenceLimit);
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

export async function indexScanKnowledge(index: ScanWorkingKnowledgeIndex, onlyFileIds?: string[], stats?: { reused: number }) {
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
          orderBy: { createdAt: "desc" },
          select: { id: true, status: true, humanDecisions: {
            where: { decisionType: "MODIFY" },
            orderBy: { createdAt: "desc" }, select: { decisionType: true, editedSuggestion: true }, take: 1,
          } }, take: 1,
        } },
      },
      readingStatus: true, relativePath: true,
    },
    where: { sessionId: index.scanSessionId, ...(onlyFileIds ? { id: { in: onlyFileIds } } : {}) },
  });
  const workingById = new Map(index.files.map((file) => [file.id, file]));
  const effectiveSignals = await getEffectiveDocumentSignals([session.connectedFolderId]);
  let indexed = 0;
  for (const file of files) {
    const working = workingById.get(file.id);
    if (!file.checksum || file.extractionStatus !== "COMPLETED" ||
        file.readingStatus !== "READ" || !working) continue;

    const fileKey = persistentFileKey(session.connectedFolderId, file.relativePath);
    const entryKey = digest([librarySearchIndexVersion, fileKey, file.checksum].join("\0"));
    const observation = file.libraryDocument?.observationSessions[0];
    const reviewedText = observation?.status === "MODIFIED"
      ? observation.humanDecisions.find((decision) => decision.decisionType === "MODIFY")?.editedSuggestion?.slice(0, searchExcerptLimit) ?? ""
      : "";
    const excerpts = boundedSourceExcerpts(working.sourceEvidenceText);
    const entityHashes = [...new Set(effectiveSignals.filter((signal) =>
      signal.fileKey === fileKey && signal.checksum === file.checksum && signal.kind !== "FILE_ANCHOR")
      .map((signal) => signal.identityHash))];
    const concepts = working.supportingTopics.slice(0, 8);
    const knowledgeState = observation?.status === "APPROVED" || observation?.status === "MODIFIED"
      ? "APPROVED" : "PROVISIONAL";
    const fingerprint = searchEntryFingerprint({ checksum: file.checksum,
      concepts, entityHashes, excerpts, reviewedText, knowledgeState });
    const existing = await prisma.librarySearchEntry.findUnique({
      select: { fingerprint: true, isCurrent: true, scannedFileId: true, scanSessionId: true }, where: { entryKey },
    });
    await prisma.librarySearchEntry.updateMany({
      data: { isCurrent: false },
      where: { fileKey, isCurrent: true, entryKey: { not: entryKey } },
    });
    if (existing?.fingerprint === fingerprint) {
      if (stats) stats.reused += 1;
      if (!existing.isCurrent || existing.scannedFileId !== file.id ||
          existing.scanSessionId !== index.scanSessionId) {
        await prisma.librarySearchEntry.update({
          data: { isCurrent: true, scannedFileId: file.id, scanSessionId: index.scanSessionId,
            relativePath: file.relativePath }, where: { entryKey },
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
          concepts, entityHashes, fingerprint, indexedAt: new Date(), isCurrent: true,
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
    select: { libraryDocument: { select: { scannedFiles: {
      orderBy: { createdAt: "desc" }, select: { id: true, sessionId: true }, take: 1,
    } } } },
    where: { id: observationSessionId },
  });
  const file = observation?.libraryDocument.scannedFiles[0];
  if (!file) return;
  await indexScanKnowledge(await loadScanWorkingKnowledge(file.sessionId), [file.id]);
}

export async function refreshSearchForIdentityRelationship(relationshipId: string) {
  const prisma = getPrismaClient();
  const relationship = await prisma.knowledgeConnection.findUnique({ where: { id: relationshipId } });
  if (!relationship) return;
  // Superseding a join can also retract the identity assigned to its former target.
  const relatedCorrections = relationship.sourceFileKey ? await prisma.knowledgeConnection.findMany({
    select: { targetFileKey: true },
    where: { generationVersion: humanIdentityCorrectionVersion, sourceFileKey: relationship.sourceFileKey },
  }) : [];
  const entries = await prisma.librarySearchEntry.findMany({
    select: { id: true, connectedLibraryId: true, fileKey: true, checksum: true },
    where: { isCurrent: true, fileKey: { in: [relationship.sourceFileKey, relationship.targetFileKey,
      ...relatedCorrections.map((correction) => correction.targetFileKey)]
      .filter((key): key is string => Boolean(key)) } },
  });
  const signals = await getEffectiveDocumentSignals([...new Set(entries.map((entry) => entry.connectedLibraryId))]);
  for (const entry of entries) {
    const entityHashes = [...new Set(signals.filter((signal) => signal.fileKey === entry.fileKey &&
      signal.checksum === entry.checksum && signal.kind !== "FILE_ANCHOR").map((signal) => signal.identityHash))];
    await prisma.librarySearchEntry.update({ where: { id: entry.id },
      // Force normal indexing to recompute its fingerprint after this targeted derived-field refresh.
      data: { entityHashes, fingerprint: "", indexedAt: new Date() } });
  }
}
