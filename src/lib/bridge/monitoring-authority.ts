import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { currentReadableRootWhere } from "./current-readable-root";

export type MonitoringOwner = { batchId: string; generation: string };
export const monitoringLeaseMs = 10 * 60_000;
export async function lockMonitoringBatch(tx: Prisma.TransactionClient, owner: MonitoringOwner) {
  const binding = await tx.monitoringBatch.findUniqueOrThrow({ where: { id: owner.batchId } });
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder" WHERE id = ${binding.connectedFolderId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "MonitoringBatch" WHERE id = ${owner.batchId} FOR UPDATE`);
  const batch = await tx.monitoringBatch.findFirst({ where: { id: owner.batchId, status: "PROCESSING",
    processingGeneration: owner.generation, processingLeaseUntil: { gt: new Date() },
    connectedFolder: { ...currentReadableRootWhere, watchPermission: true, monitoringState: "WATCHING",
      nativeConnectionRevision: binding.rootConnectionRevision ?? 0 },
  } });
  if (!batch) throw new Error("Monitoring ownership or current root authority changed.");
  return batch;
}
export async function renewMonitoringBatch(owner: MonitoringOwner) {
  return getPrismaClient().$transaction(async (tx) => {
    await lockMonitoringBatch(tx, owner);
    await tx.monitoringBatch.update({ where: { id: owner.batchId }, data: { processingLeaseUntil: new Date(Date.now() + monitoringLeaseMs) } });
  });
}
