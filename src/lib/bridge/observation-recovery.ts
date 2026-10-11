import { currentReadableRootSql, isCurrentReadableRoot } from "./current-readable-root";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { latestObservationOrder, observationLeaseMs, usableObservation, deviceKeyFingerprint } from "./observation-authority";
import { assertInventoryAfterPhysicalOutcomes } from "./execution-reconciliation";
import { generateScanRecommendationBatchIfReady } from "./scan-recommendation-batch";

// A queued read owns its signed command before it owns an observation lease.
// Preserve even partial modern captures; missing authority must fail closed.
function capturedQueuedReadSql(deviceId: string | Prisma.Sql, rootId: string | Prisma.Sql,
  sessionId: string | Prisma.Sql, fileId: string | Prisma.Sql) {
  return Prisma.sql`SELECT 1 AS present FROM "BridgeCommand" modern
    WHERE modern."commandType" = 'READ_FILE_TEMPORARILY' AND modern.status IN ('PENDING', 'ACKNOWLEDGED', 'RUNNING')
      AND modern."bridgeDeviceId" = ${deviceId} AND modern."connectedLibraryId" = ${rootId}
      AND modern.payload->>'scanSessionId' = ${sessionId} AND modern.payload->>'scannedFileId' = ${fileId}
      AND (modern."authorizationContext"->>'rootConnectionRevision' IS NOT NULL
        OR modern."authorizationContext"->>'deviceKeyFingerprint' IS NOT NULL)`;
}

/** Migration admission is an invalidation obligation, never an old read grant.
 * Even an unexpired legacy owner cannot publish without its missing authority.
 * Reset it once, then let normal signed reads capture NEW authority and bytes. */
async function repairLegacyObservationFilesForDevice(deviceId: string, now: Date) {
  const prisma = getPrismaClient();
  const candidates = await prisma.$queryRaw<Array<{ id: string; sessionId: string; rootId: string; observationClaimedAt: Date | null }>>(Prisma.sql`
    SELECT file.id, file."sessionId", scan."connectedFolderId" AS "rootId", file."observationClaimedAt"
    FROM "ScannedFile" file JOIN "ScanSession" scan ON scan.id = file."sessionId"
      JOIN "ConnectedFolder" root ON root.id = scan."connectedFolderId"
      JOIN "BridgeDevice" device ON device."bridgeDeviceId" = root."bridgeDeviceId"
    WHERE file."legacyObservationRecoveryPending" = true
      AND file."observationRootRevision" IS NULL AND file."observationDeviceKeyFingerprint" IS NULL
      AND file."processingStage" IN ('READING', 'READ', 'EXAMINING', 'OBSERVING')
      AND NOT (file."processingStage" = 'READING' AND file."readingStatus" = 'NOT_READ' AND file."observationClaimedAt" IS NULL
        AND EXISTS (${capturedQueuedReadSql(Prisma.sql`root."bridgeDeviceId"`, Prisma.sql`root.id`, Prisma.sql`scan.id`, Prisma.sql`file.id`)}))
      AND file."readStatus" = 'SUPPORTED' AND file."sourceUnavailableAt" IS NULL AND file.checksum ~ '^[a-fA-F0-9]{64}$'
      AND root."bridgeDeviceId" = ${deviceId} AND root."bridgeRootId" IS NOT NULL AND ${currentReadableRootSql}
      AND root."nativeConnectionRevision" = 0
      AND device.status <> 'REVOKED' AND device."revokedAt" IS NULL
      AND scan.status IN ('READING', 'EXAMINING') AND scan."inventoryGeneration" = root."physicalInventoryGeneration"
      AND NOT EXISTS (SELECT 1 FROM "ExecutionRun" run WHERE run."connectedLibraryId" = root.id AND run.status IN ('PENDING', 'RUNNING'))
      AND NOT EXISTS (SELECT 1 FROM "UndoRun" undo JOIN "ExecutionRun" run ON run.id = undo."executionRunId"
        WHERE run."connectedLibraryId" = root.id AND undo.status IN ('PENDING', 'RUNNING'))
      AND NOT EXISTS (SELECT 1 FROM "ScanSession" newer WHERE newer."connectedFolderId" = root.id
        AND newer.status <> 'FAILED' AND (newer."startedAt", newer.id) > (scan."startedAt", scan.id))
    ORDER BY file.id LIMIT 50`);
  let repaired = 0;
  for (const candidate of candidates) {
    const changed = await prisma.$transaction(async (tx) => {
      // Same ownership order as import/report/recovery; candidate selection
      // grants nothing and every mutable predicate is checked after these locks.
      await tx.$queryRaw`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${deviceId} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${candidate.rootId} FOR SHARE`;
      const root = await tx.connectedLibrary.findUniqueOrThrow({ where: { id: candidate.rootId }, include: { bridgeDevice: true } });
      if (!isCurrentReadableRoot(root) || root.nativeConnectionRevision !== 0 || root.bridgeDeviceId !== deviceId || !root.bridgeRootId ||
          !root.bridgeDevice || root.bridgeDevice.status === "REVOKED" || root.bridgeDevice.revokedAt) return false;
      await tx.$queryRaw`SELECT "commandId" FROM "BridgeCommand" WHERE "bridgeDeviceId" = ${deviceId}
        AND "connectedLibraryId" = ${root.id} AND "commandType" = 'READ_FILE_TEMPORARILY'
        AND payload->>'scanSessionId' = ${candidate.sessionId} AND payload->>'scannedFileId' = ${candidate.id}
        ORDER BY "commandId" FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "ScanSession" WHERE id = ${candidate.sessionId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "ScannedFile" WHERE id = ${candidate.id} FOR UPDATE`;
      const scan = await tx.scanSession.findUniqueOrThrow({ where: { id: candidate.sessionId } });
      const fresh = await tx.scannedFile.findUniqueOrThrow({ where: { id: candidate.id } });
      if (scan.connectedFolderId !== root.id || !["READING", "EXAMINING"].includes(scan.status) ||
          scan.inventoryGeneration !== root.physicalInventoryGeneration || !fresh.legacyObservationRecoveryPending ||
          fresh.observationRootRevision !== null || fresh.observationDeviceKeyFingerprint !== null ||
          fresh.observationClaimedAt?.getTime() !== candidate.observationClaimedAt?.getTime() ||
          !["READING", "READ", "EXAMINING", "OBSERVING"].includes(fresh.processingStage) ||
          fresh.readStatus !== "SUPPORTED" || fresh.sourceUnavailableAt || !fresh.checksum || !/^[a-fA-F0-9]{64}$/.test(fresh.checksum)) return false;
      if (fresh.processingStage === "READING" && fresh.readingStatus === "NOT_READ" && fresh.observationClaimedAt === null &&
          (await tx.$queryRaw<Array<{ present: number }>>(Prisma.sql`${capturedQueuedReadSql(deviceId, root.id, scan.id, fresh.id)} LIMIT 1`)).length) return false;
      if (await tx.scanSession.findFirst({ select: { id: true }, where: { connectedFolderId: root.id, status: { not: "FAILED" },
        OR: [{ startedAt: { gt: scan.startedAt } }, { startedAt: scan.startedAt, id: { gt: scan.id } }] } })) return false;
      try { await assertInventoryAfterPhysicalOutcomes(tx, root.id, scan.inventoryGeneration); } catch { return false; }
      // A newly admitted queued command must not be expired even if it arrives
      // after the ownership check. Its fresh report can still complete normally.
      const queued = fresh.processingStage === "READING" && fresh.readingStatus === "NOT_READ" && fresh.observationClaimedAt === null;
      const settledAt = now.toISOString();
      await tx.$executeRaw`UPDATE "BridgeCommand" SET status = 'EXPIRED', "completedAt" = ${settledAt}::timestamp,
        "safeErrorCategory" = 'LEGACY_OBSERVATION_REQUEUE_REQUIRED'
        WHERE "bridgeDeviceId" = ${deviceId} AND "connectedLibraryId" = ${root.id} AND "commandType" = 'READ_FILE_TEMPORARILY'
          AND status IN ('PENDING', 'ACKNOWLEDGED', 'RUNNING')
          AND payload->>'scanSessionId' = ${scan.id} AND payload->>'scannedFileId' = ${fresh.id}
          AND (${!queued} OR ("authorizationContext"->>'rootConnectionRevision' IS NULL
            AND "authorizationContext"->>'deviceKeyFingerprint' IS NULL))`;
      await tx.scannedFile.update({ where: { id: fresh.id }, data: {
        legacyObservationRecoveryPending: false, observationClaimedAt: null,
        processingStage: "DISCOVERED", readingStatus: "NOT_READ", extractionStatus: "PENDING",
        extractedAt: null, extractionErrorCategory: null, processedAt: null, processingErrorCategory: null,
        characterCount: null, previewText: null, scanError: null,
      } });
      await tx.scanSession.update({ where: { id: scan.id }, data: { status: "READING", completedAt: null } });
      return true;
    });
    if (changed) repaired++;
  }
  return repaired;
}

/** Restart-safe recovery also covers leases whose original command is already
 * terminal. No preview is substituted for full source text: missing observations
 * go back through the existing bounded native read queue. */
export async function recoverAbandonedObservationFilesForDevice(deviceId: string, now = new Date()) {
  const prisma = getPrismaClient();
  const stale = new Date(now.getTime() - observationLeaseMs);
  const device = await prisma.bridgeDevice.findUnique({ where: { bridgeDeviceId: deviceId } });
  if (!device || device.status === "REVOKED" || device.revokedAt) return 0;
  const legacyRepaired = await repairLegacyObservationFilesForDevice(deviceId, now);
  const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT file.id FROM "ScannedFile" file JOIN "ScanSession" scan ON scan.id = file."sessionId"
      JOIN "ConnectedFolder" root ON root.id = scan."connectedFolderId"
    WHERE root."bridgeDeviceId" = ${deviceId} AND root."bridgeRootId" IS NOT NULL AND ${currentReadableRootSql}
      AND scan.status IN ('READING', 'EXAMINING') AND scan."inventoryGeneration" = root."physicalInventoryGeneration"
      AND file."observationRootRevision" = root."nativeConnectionRevision"
      AND file."observationDeviceKeyFingerprint" = ${deviceKeyFingerprint(device.publicKey)}
      AND file."sourceUnavailableAt" IS NULL AND file."readStatus" = 'SUPPORTED'
      AND ((file."processingStage" IN ('READ', 'EXAMINING', 'OBSERVING') AND file."readingStatus" = 'READ'
        AND file."extractionStatus" = 'COMPLETED' AND (file."observationClaimedAt" IS NULL OR file."observationClaimedAt" <= ${stale}))
        OR (file."processingStage" = 'READING' AND file."observationClaimedAt" <= ${stale}))
    ORDER BY file."observationClaimedAt" ASC, file.id ASC LIMIT ${50 - legacyRepaired}`);
  const files = await prisma.scannedFile.findMany({
    where: { id: { in: ids.map((row) => row.id) } },
    orderBy: [{ observationClaimedAt: "asc" }, { id: "asc" }],
    include: { scanSession: { select: { connectedFolderId: true } } },
  });
  const settledSessions = new Set<string>();
  let recovered = 0;
  for (const file of files) {
    const outcome = await prisma.$transaction(async (tx) => {
      // Candidate selection is only a work window. Device -> root -> command ->
      // scan -> file matches report/import authority and serializes retirement.
      await tx.$queryRaw`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${deviceId} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${file.scanSession.connectedFolderId} FOR SHARE`;
      const root = await tx.connectedLibrary.findUniqueOrThrow({ where: { id: file.scanSession.connectedFolderId }, include: { bridgeDevice: true } });
      if (!isCurrentReadableRoot(root) || root.bridgeDeviceId !== deviceId || !root.bridgeRootId ||
          !root.bridgeDevice || root.bridgeDevice.status === "REVOKED" || root.bridgeDevice.revokedAt) return null;
      await tx.$queryRaw`SELECT "commandId" FROM "BridgeCommand" WHERE "bridgeDeviceId" = ${deviceId}
        AND "connectedLibraryId" = ${root.id} AND "commandType" = 'READ_FILE_TEMPORARILY'
        AND payload->>'scannedFileId' = ${file.id} AND status IN ('PENDING', 'ACKNOWLEDGED', 'RUNNING') ORDER BY "commandId" FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "ScanSession" WHERE id = ${file.sessionId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "ScannedFile" WHERE id = ${file.id} FOR UPDATE`;
      const scan = await tx.scanSession.findUniqueOrThrow({ where: { id: file.sessionId } });
      const fresh = await tx.scannedFile.findUniqueOrThrow({ where: { id: file.id } });
      const expired = !fresh.observationClaimedAt || fresh.observationClaimedAt <= stale;
      const abandoned = fresh.readStatus === "SUPPORTED" && expired &&
        ((["READ", "EXAMINING", "OBSERVING"].includes(fresh.processingStage) && fresh.readingStatus === "READ" && fresh.extractionStatus === "COMPLETED") ||
          (fresh.processingStage === "READING" && fresh.observationClaimedAt !== null));
      if (scan.connectedFolderId !== root.id || !["READING", "EXAMINING"].includes(scan.status) ||
          scan.inventoryGeneration !== root.physicalInventoryGeneration || !abandoned || fresh.sourceUnavailableAt ||
          fresh.observationRootRevision !== root.nativeConnectionRevision ||
          fresh.observationDeviceKeyFingerprint !== deviceKeyFingerprint(root.bridgeDevice.publicKey) ||
          fresh.observationClaimedAt?.getTime() !== file.observationClaimedAt?.getTime() ||
          (fresh.observationClaimedAt && fresh.observationClaimedAt > stale)) return null;
      try { await assertInventoryAfterPhysicalOutcomes(tx, root.id, scan.inventoryGeneration); } catch { return null; }
      const owner = await tx.scannedFile.updateMany({
        data: { observationClaimedAt: file.observationClaimedAt },
        where: { id: file.id, observationClaimedAt: file.observationClaimedAt,
          processingStage: { in: ["READING", "READ", "EXAMINING", "OBSERVING"] } },
      });
      if (!owner.count) return null;
      const current = await tx.scannedFile.findUniqueOrThrow({
        select: { libraryDocument: { select: { checksum: true, observationSessions: {
          orderBy: [...latestObservationOrder], take: 1, select: { status: true },
        } } } }, where: { id: file.id },
      });
      // Lease recovery does not invent successful extraction from an observation
      // attached under older bytes. Modern source publication already binds it.
      const complete = fresh.readingStatus === "READ" && fresh.extractionStatus === "COMPLETED" && fresh.checksum !== null
        && (current.libraryDocument?.checksum === null || current.libraryDocument?.checksum === fresh.checksum)
        && usableObservation(current.libraryDocument?.observationSessions[0]);
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
  return recovered + legacyRepaired;
}
