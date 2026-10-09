import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { extractDocumentSignals, documentSignalVersion } from "../../src/lib/bridge/document-signals";
import { persistentFileKey } from "../../src/lib/bridge/persistent-knowledge";

/** Real local database rows, with bounded bulk fixture writes only. Production
 * persistence, correction replay, and Search are never replaced by test helpers.
 */
export async function knowledgeScaleFixture(prisma: PrismaClient, name: string, count: number,
  textFor: (index: number) => string) {
  const root = await prisma.connectedLibrary.create({ data: { bridgeRootId: randomUUID(), displayName: name,
    localPath: `bridge://scale/${randomUUID()}`, platform: "MACOS" } });
  const scan = await prisma.scanSession.create({ data: { connectedFolderId: root.id, status: "COMPLETED", searchIndexStatus: "COMPLETED" } });
  const batch = await prisma.libraryBatch.create({ data: { name } });
  const rows = Array.from({ length: count }, (_, index) => {
    const relativePath = `records/${String(index).padStart(5, "0")}.txt`;
    const text = textFor(index);
    return { id: randomUUID(), documentId: randomUUID(), observationId: randomUUID(), relativePath,
      fileKey: persistentFileKey(root.id, relativePath), checksum: `checksum-${index}`,
      text, evidence: `Source characters 0-${text.length}: ${JSON.stringify(text)}` };
  });
  for (let offset = 0; offset < rows.length; offset += 500) {
    const chunk = rows.slice(offset, offset + 500);
    await prisma.libraryDocument.createMany({ data: chunk.map((row) => ({ id: row.documentId, batchId: batch.id,
      normalizedFileName: row.relativePath, originalFileName: row.relativePath })) });
    await prisma.observationSession.createMany({ data: chunk.map((row) => ({ id: row.observationId,
      libraryDocumentId: row.documentId, observerType: "DETERMINISTIC", observations: [], interpretations: [],
      explanation: [], planSuggestions: [], warnings: [] })) });
    await prisma.scannedFile.createMany({ data: chunk.map((row) => ({ id: row.id, sessionId: scan.id,
      libraryDocumentId: row.documentId, relativePath: row.relativePath, localPath: `bridge://${root.id}/${row.relativePath}`,
      checksum: row.checksum, fileType: "TEXT", readStatus: "SUPPORTED", readingStatus: "READ", extractionStatus: "COMPLETED" })) });
  }
  const index = { scanSessionId: scan.id, clusters: [], relationships: [], files: rows.map((row) => ({
    id: row.id, relativePath: row.relativePath, connectedLibraryId: root.id,
    fileName: row.relativePath.split("/").at(-1)!, fileType: "TEXT", normalizedIdentity: `${root.id}/${row.relativePath}`,
    semanticPreview: "", semanticTerms: [], supportingTopics: [], sourceEvidenceText: row.evidence,
    approvedMemoryEvidence: [], provisionalWorkingEvidence: [], trustedObservationEvidence: [],
  })) };
  return { root, scan, rows, index, async dispose() {
    await prisma.knowledgeConnection.deleteMany({ where: { sourceObservationSessionId: { in: rows.map((row) => row.observationId) } } });
    await prisma.knowledgeDocumentSignal.deleteMany({ where: { connectedLibraryId: root.id } });
    await prisma.connectedLibrary.delete({ where: { id: root.id } });
    await prisma.libraryDocument.deleteMany({ where: { batchId: batch.id } });
    await prisma.libraryBatch.delete({ where: { id: batch.id } });
  }, async seedSignals() {
    for (let offset = 0; offset < rows.length; offset += 500) {
      await prisma.knowledgeDocumentSignal.createMany({ data: rows.slice(offset, offset + 500).flatMap((row) =>
        extractDocumentSignals(row.evidence, root.id).map((signal) => ({ ...signal, signalKey: randomUUID(),
          connectedLibraryId: root.id, fileKey: row.fileKey, relativePath: row.relativePath,
          checksum: row.checksum, observationSessionId: row.observationId, generationVersion: documentSignalVersion }))) });
    }
  } };
}
