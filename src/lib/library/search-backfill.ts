import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import { loadScanWorkingKnowledge } from "@/lib/bridge/scan-working-knowledge";
import { publishScanDerivedKnowledge } from "@/lib/bridge/scan-publication";
import { withCurrentScanPublication } from "@/lib/bridge/scan-publication-lock";
import { indexScanKnowledge, librarySearchIndexVersion } from "./search-index";

export const searchBackfillBatchSize = 20;
const searchClaimLeaseMs = 5 * 60_000;

const eligible = {
  extractionStatus: "COMPLETED" as const,
  readingStatus: "READ" as const,
  checksum: { not: null },
};

export async function getSearchBackfillProgress(sessionId: string) {
  const prisma = getPrismaClient();
  const [total, rows] = await Promise.all([
    prisma.scannedFile.count({ where: { sessionId, ...eligible } }),
    prisma.librarySearchBackfillFile.groupBy({ by: ["status"], _count: { _all: true },
      where: { scanSessionId: sessionId, indexVersion: librarySearchIndexVersion } }),
  ]);
  const count = (status: string) => rows.find((row) => row.status === status)?._count._all ?? 0;
  const indexed = count("INDEXED");
  const reused = count("REUSED");
  const failed = count("FAILED");
  const completedFiles = indexed + reused + failed;
  const remaining = Math.max(0, total - completedFiles);
  return { total, indexed, reused, failed, completedFiles, remaining,
    completed: remaining === 0 && failed === 0 };
}

export async function indexOneFile(sessionId: string, fileId: string,
  stats: { reused: number; resolvedSignals?: number } = { reused: 0 }): Promise<"INDEXED" | "REUSED"> {
  const count = await withCurrentScanPublication(sessionId, async (tx) => indexScanKnowledge(
    await loadScanWorkingKnowledge(sessionId, [fileId], tx), [fileId], stats, tx,
  ));
  if (count !== 1) throw new Error("File could not be indexed");
  return stats.reused ? "REUSED" : "INDEXED";
}

async function claimSearchFile(sessionId: string, fileId: string, retryFailed: boolean) {
  const prisma = getPrismaClient();
  const where = { scanSessionId_scannedFileId_indexVersion: {
    scanSessionId: sessionId, scannedFileId: fileId, indexVersion: librarySearchIndexVersion,
  } };
  const existing = await prisma.librarySearchBackfillFile.findUnique({ where });
  if (!existing) {
    try {
      const claimed = await prisma.librarySearchBackfillFile.create({ data: {
        scanSessionId: sessionId, scannedFileId: fileId,
        indexVersion: librarySearchIndexVersion, status: "PROCESSING",
      } });
      return claimed.updatedAt;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
      throw error;
    }
  }
  if (["INDEXED", "REUSED"].includes(existing.status) ||
      (existing.status === "FAILED" && !retryFailed) ||
      (existing.status === "PROCESSING" &&
        existing.updatedAt.getTime() > Date.now() - searchClaimLeaseMs)) return null;
  const claimed = await prisma.librarySearchBackfillFile.updateMany({
    data: { status: "PROCESSING" },
    where: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt },
  });
  if (claimed.count !== 1) return null;
  const current = await prisma.librarySearchBackfillFile.findUnique({ where });
  return current?.updatedAt ?? null;
}

export async function prepareSearchBatch(
  sessionId: string,
  retryFailed = false,
  processFile: (sessionId: string, fileId: string) => Promise<"INDEXED" | "REUSED"> = indexOneFile,
) {
  const prisma = getPrismaClient();
  if (!await publishScanDerivedKnowledge(sessionId, "KNOWLEDGE")) {
    const progress = await getSearchBackfillProgress(sessionId);
    return { ...progress, completed: false, claimedFiles: 0, processedFiles: 0, waitingForClaims: true };
  }
  const started = await withCurrentScanPublication(sessionId, async (tx, current) => {
    if (current.knowledgePersistenceStatus !== "COMPLETED") return false;
    if (current.searchIndexStatus !== "COMPLETED") await tx.scanSession.update({
      data: { searchIndexStatus: "PREPARING" }, where: { id: sessionId },
    });
    return true;
  });
  if (!started) return { ...await getSearchBackfillProgress(sessionId), completed: false,
    claimedFiles: 0, processedFiles: 0, waitingForClaims: true };
  const files = await prisma.scannedFile.findMany({
    take: searchBackfillBatchSize * 3, orderBy: { id: "asc" }, select: { id: true },
    where: { sessionId, ...eligible, searchBackfillFiles: { none: {
      indexVersion: librarySearchIndexVersion, OR: [
        { status: { in: ["INDEXED", "REUSED", "FAILED"] } },
        { status: "PROCESSING", updatedAt: { gt: new Date(Date.now() - searchClaimLeaseMs) } },
      ],
    } } },
  });
  const retries = retryFailed ? await prisma.librarySearchBackfillFile.findMany({
    take: searchBackfillBatchSize * 3,
    orderBy: [{ updatedAt: "asc" }, { scannedFileId: "asc" }],
    select: { scannedFileId: true },
    where: { scanSessionId: sessionId, indexVersion: librarySearchIndexVersion, status: "FAILED",
      scannedFile: { sessionId, ...eligible } },
  }) : [];
  let claimedCount = 0;
  let processedCount = 0;
  for (const file of [...files, ...retries.map((row) => ({ id: row.scannedFileId }))]) {
    if (claimedCount >= searchBackfillBatchSize) break;
    const claimUpdatedAt = await claimSearchFile(sessionId, file.id, retryFailed);
    if (!claimUpdatedAt) continue;
    claimedCount += 1;
    let status = "FAILED";
    try {
      status = await processFile(sessionId, file.id);
    } catch {
      // A single unreadable or malformed file must not discard completed work.
    }
    const saved = await prisma.librarySearchBackfillFile.updateMany({
      data: { status },
      where: { scanSessionId: sessionId, scannedFileId: file.id,
        indexVersion: librarySearchIndexVersion, status: "PROCESSING",
        updatedAt: claimUpdatedAt },
    });
    processedCount += saved.count;
  }
  let progress = await getSearchBackfillProgress(sessionId);
  if (progress.remaining === 0) {
    const settled = await withCurrentScanPublication(sessionId, async (tx, current) => {
      if (current.knowledgePersistenceStatus !== "COMPLETED") return false;
      if (progress.completed) await tx.librarySearchEntry.updateMany({
        data: { isCurrent: false },
        where: { scanSessionId: { not: sessionId }, connectedLibraryId: current.connectedFolderId, isCurrent: true },
      });
      const status = progress.completed ? "COMPLETED" : "INCOMPLETE";
      // A completed full publication wins over partial/failed backfill bookkeeping.
      if (current.searchIndexStatus !== "COMPLETED") await tx.scanSession.update({
        data: { searchIndexStatus: status }, where: { id: sessionId },
      });
      return true;
    });
    if (!settled) progress = { ...progress, completed: false };
  }
  const activeClaims = progress.remaining > 0 && processedCount === 0
    ? await prisma.librarySearchBackfillFile.count({ where: {
        scanSessionId: sessionId, indexVersion: librarySearchIndexVersion, status: "PROCESSING",
        updatedAt: { gt: new Date(Date.now() - searchClaimLeaseMs) },
      } }) : 0;
  return { ...progress, claimedFiles: claimedCount, processedFiles: processedCount,
    waitingForClaims: activeClaims > 0 };
}
