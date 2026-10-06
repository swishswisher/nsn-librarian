import { getPrismaClient } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";

export const latestObservationOrder = [{ createdAt: "desc" }, { id: "desc" }] as const;
export const observationLeaseMs = 10 * 60_000;

// Lock only the short database publication step, never an AI request. An expired
// worker must still own this exact timestamp before it can publish any changes.
export async function withOwnedObservationLease<T>(fileId: string, claimedAt: Date | null,
  run: (tx: Prisma.TransactionClient) => Promise<T>) {
  return getPrismaClient().$transaction(async (tx) => {
    const owner = await tx.scannedFile.updateMany({
      data: { observationClaimedAt: claimedAt }, where: { id: fileId, observationClaimedAt: claimedAt },
    });
    if (!owner.count) throw new Error("Observation lease ownership changed; retry the report.");
    return run(tx);
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
