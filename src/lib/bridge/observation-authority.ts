import { getPrismaClient } from "@/lib/db/prisma";
import { Prisma } from "@prisma/client";
import { currentReadableRootWhere } from "./current-readable-root";
import { createHash } from "node:crypto";
export function deviceKeyFingerprint(publicKey: string) { return createHash("sha256").update(publicKey).digest("hex"); }

export const latestObservationOrder = [{ createdAt: "desc" }, { id: "desc" }] as const;
export const observationLeaseMs = 10 * 60_000;

// Lock only the short database publication step, never an AI request. An expired
// worker must still own this exact timestamp before it can publish any changes.
export async function withOwnedObservationLease<T>(fileId: string, claimedAt: Date | null,
  run: (tx: Prisma.TransactionClient) => Promise<T>) {
  return getPrismaClient().$transaction(async (tx) => {
    const file = await tx.scannedFile.findUniqueOrThrow({ select: { sessionId: true, observationRootRevision: true, observationDeviceKeyFingerprint: true,
      scanSession: { select: { connectedFolderId: true, inventoryGeneration: true, connectedFolder: { select: { bridgeDeviceId: true } } } } }, where: { id: fileId } });
    const deviceId = file.scanSession.connectedFolder.bridgeDeviceId;
    if (deviceId) {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${deviceId} FOR SHARE`);
      const device = await tx.bridgeDevice.findFirst({ where: { bridgeDeviceId: deviceId, status: { not: "REVOKED" }, revokedAt: null } });
      if (!device || !file.observationDeviceKeyFingerprint || deviceKeyFingerprint(device.publicKey) !== file.observationDeviceKeyFingerprint)
        throw new Error("The Bridge device no longer authorizes observation work.");
    }
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder" WHERE id = ${file.scanSession.connectedFolderId} FOR SHARE`);
    await (await import("./execution-reconciliation")).assertInventoryAfterPhysicalOutcomes(tx, file.scanSession.connectedFolderId, file.scanSession.inventoryGeneration);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ScanSession" WHERE id = ${file.sessionId} FOR UPDATE`);
    const owner = await tx.scannedFile.updateMany({
      data: { observationClaimedAt: claimedAt }, where: { id: fileId, observationClaimedAt: claimedAt,
         scanSession: { connectedFolder: { ...currentReadableRootWhere, nativeConnectionRevision: file.observationRootRevision ?? -1 } }, sourceUnavailableAt: null },
    });
    if (!owner.count) throw new Error("Observation lease ownership changed; retry the report.");
    return run(tx);
  });
}

export async function claimObservationLease(fileId: string, expected?: { rootRevision?: number; deviceKeyFingerprint?: string }) {
  return getPrismaClient().$transaction(async (tx) => {
    const file = await tx.scannedFile.findUniqueOrThrow({ select: { sessionId: true,
      scanSession: { select: { connectedFolderId: true, inventoryGeneration: true, connectedFolder: { select: { bridgeDeviceId: true } } } } }, where: { id: fileId } });
    const deviceId = file.scanSession.connectedFolder.bridgeDeviceId;
    if (deviceId) await tx.$queryRaw(Prisma.sql`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${deviceId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder" WHERE id = ${file.scanSession.connectedFolderId} FOR SHARE`);
    await (await import("./execution-reconciliation")).assertInventoryAfterPhysicalOutcomes(tx, file.scanSession.connectedFolderId, file.scanSession.inventoryGeneration);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ScanSession" WHERE id = ${file.sessionId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ScannedFile" WHERE id = ${fileId} FOR UPDATE`);
    const root = await tx.connectedLibrary.findFirstOrThrow({ include: { bridgeDevice: true },
      where: { id: file.scanSession.connectedFolderId, ...currentReadableRootWhere } });
    const key = root.bridgeDevice ? deviceKeyFingerprint(root.bridgeDevice.publicKey) : null;
    if ((root.bridgeDevice && (root.bridgeDevice.status === "REVOKED" || root.bridgeDevice.revokedAt)) ||
        (expected?.rootRevision !== undefined && root.nativeConnectionRevision !== expected.rootRevision) ||
        (expected?.deviceKeyFingerprint !== undefined && key !== expected.deviceKeyFingerprint)) throw new Error("The read command belongs to older root or device authority.");
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS now`);
    const claimedAt = clock.now;
    const result = await tx.scannedFile.updateMany({ data: { observationClaimedAt: claimedAt,
      observationRootRevision: root.nativeConnectionRevision, observationDeviceKeyFingerprint: key }, where: {
      id: fileId, sourceUnavailableAt: null,
      scanSession: { status: { not: "GENERATING_SUGGESTIONS" }, connectedFolder: currentReadableRootWhere },
      OR: [{ observationClaimedAt: null }, { observationClaimedAt: { lte: new Date(claimedAt.getTime() - observationLeaseMs) } }],
    } });
    if (!result.count) throw new Error("File processing is already owned or the root is unavailable.");
    return claimedAt;
  });
}

export function usableObservation(session: { status: string } | null | undefined) {
  return Boolean(session && ["AWAITING_REVIEW", "APPROVED", "MODIFIED"].includes(session.status));
}

export async function latestScannedFileObservation(scannedFileId: string) {
  return getPrismaClient().scannedFile.findUnique({
    select: { id: true, sessionId: true, processingStage: true, readingStatus: true, extractionStatus: true, observationClaimedAt: true,
      libraryDocument: { select: { observationSessions: {
        orderBy: [...latestObservationOrder], take: 1, select: { id: true, status: true },
      } } } },
    where: { id: scannedFileId },
  });
}
