import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { currentReadableRootWhere } from "./current-readable-root";

export const scanPublicationTransactionOptions = {
  isolationLevel: "Serializable" as const,
  timeout: 30 * 60_000,
  maxWait: 5_000,
};

/** All scan-derived currentness writers acquire this same root lock before
 * checking latestness, and retain it through the actual mutation commit. */
export async function lockCurrentScanPublication(tx: Prisma.TransactionClient, sessionId: string) {
  const session = await tx.scanSession.findUnique({ where: { id: sessionId },
    select: { connectedFolderId: true } });
  if (!session) return null;
  const [lock] = await tx.$queryRaw<Array<{ owned: boolean }>>(Prisma.sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${`scan-publication:${session.connectedFolderId}`}, 0)) AS owned
  `);
  if (!lock?.owned) return null;
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder"
    WHERE id = ${session.connectedFolderId} FOR SHARE`);
  const root = await tx.connectedLibrary.findUniqueOrThrow({ where: { id: session.connectedFolderId } });
  try {
    await (await import("./execution-reconciliation")).assertInventoryAfterPhysicalOutcomes(tx, root.id, root.physicalInventoryGeneration);
  } catch { return null; }
  const latest = await tx.scanSession.findFirst({
    where: { connectedFolderId: session.connectedFolderId,
      status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] }, inventoryGeneration: root.physicalInventoryGeneration,
      connectedFolder: currentReadableRootWhere },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { id: true, connectedFolderId: true, knowledgePersistenceStatus: true, searchIndexStatus: true },
  });
  return latest?.id === sessionId ? latest : null;
}

export async function withCurrentScanPublication<T>(sessionId: string,
  run: (tx: Prisma.TransactionClient, current: NonNullable<Awaited<ReturnType<typeof lockCurrentScanPublication>>>) => Promise<T>) {
  return getPrismaClient().$transaction(async (tx) => {
    const current = await lockCurrentScanPublication(tx, sessionId);
    return current ? run(tx, current) : undefined;
  }, scanPublicationTransactionOptions);
}
