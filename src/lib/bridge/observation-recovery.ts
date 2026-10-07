import { currentReadableRootWhere } from "./current-readable-root";
import { getPrismaClient } from "@/lib/db/prisma";
import { latestObservationOrder, observationLeaseMs, usableObservation } from "./observation-authority";
import { generateScanRecommendationBatchIfReady } from "./scan-recommendation-batch";

/** Restart-safe recovery also covers leases whose original command is already
 * terminal. No preview is substituted for full source text: missing observations
 * go back through the existing bounded native read queue. */
export async function recoverAbandonedObservationFilesForDevice(deviceId: string, now = new Date()) {
  const prisma = getPrismaClient();
  const stale = new Date(now.getTime() - observationLeaseMs);
  const files = await prisma.scannedFile.findMany({
    orderBy: [{ observationClaimedAt: "asc" }, { id: "asc" }], take: 50,
    include: { scanSession: { select: { connectedFolderId: true } } },
    where: { readStatus: "SUPPORTED", scanSession: { connectedFolder: {
      bridgeDeviceId: deviceId, bridgeRootId: { not: null }, ...currentReadableRootWhere,
    } }, OR: [
      { processingStage: { in: ["READ", "EXAMINING", "OBSERVING"] }, readingStatus: "READ",
        extractionStatus: "COMPLETED", OR: [{ observationClaimedAt: null }, { observationClaimedAt: { lte: stale } }] },
      { processingStage: "READING", observationClaimedAt: { not: null, lte: stale } },
    ] },
  });
  const settledSessions = new Set<string>();
  let recovered = 0;
  for (const file of files) {
    const outcome = await prisma.$transaction(async (tx) => {
      const owner = await tx.scannedFile.updateMany({
        data: { observationClaimedAt: file.observationClaimedAt },
        where: { id: file.id, observationClaimedAt: file.observationClaimedAt,
          processingStage: { in: ["READING", "READ", "EXAMINING", "OBSERVING"] } },
      });
      if (!owner.count) return null;
      const current = await tx.scannedFile.findUniqueOrThrow({
        select: { libraryDocument: { select: { observationSessions: {
          orderBy: [...latestObservationOrder], take: 1, select: { status: true },
        } } } }, where: { id: file.id },
      });
      const complete = usableObservation(current.libraryDocument?.observationSessions[0]);
      await tx.scannedFile.update({ data: {
        observationClaimedAt: null, processingErrorCategory: null,
        processingStage: complete ? "EXAMINED" : "DISCOVERED",
        processedAt: complete ? now : null, readingStatus: complete ? "READ" : "NOT_READ",
      }, where: { id: file.id } });
      await tx.bridgeCommand.updateMany({ data: {
        status: complete ? "COMPLETED" : "EXPIRED", completedAt: now,
        safeErrorCategory: complete ? null : "OBSERVATION_RECOVERY_REQUIRED",
        ...(complete ? { result: { observationPrepared: true, observationReused: true, scannedFileId: file.id } } : {}),
      }, where: { bridgeDeviceId: deviceId, connectedLibraryId: file.scanSession.connectedFolderId,
        commandType: "READ_FILE_TEMPORARILY", status: { in: ["PENDING", "ACKNOWLEDGED", "RUNNING"] },
        AND: [{ payload: { path: ["scannedFileId"], equals: file.id } },
          { payload: { path: ["scanSessionId"], equals: file.sessionId } }],
      } });
      if (!complete) await tx.scanSession.update({
        data: { status: "READING", completedAt: null }, where: { id: file.sessionId },
      });
      return complete;
    });
    if (outcome === null) continue;
    recovered++;
    if (outcome) settledSessions.add(file.sessionId);
  }
  for (const session of settledSessions) await generateScanRecommendationBatchIfReady(session);
  return recovered;
}
