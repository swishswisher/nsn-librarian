import { Prisma } from "@prisma/client";
import { currentReadableRootWhere } from "./current-readable-root";
import { assertInventoryAfterPhysicalOutcomes } from "./execution-reconciliation";

export type RecommendationBatchOwner = { sessionId: string; generation: string };
export const recommendationLeaseMs = 10 * 60_000;

// Shared lock order: root, scan, file. No extraction or model request runs under
// these locks. A timeout or replaced generation cannot publish a late result.
export async function lockRecommendationBatch(tx: Prisma.TransactionClient,
  owner: RecommendationBatchOwner, signal?: AbortSignal, allowReadOnly = false) {
  const session = await tx.scanSession.findUniqueOrThrow({
    select: { connectedFolderId: true, inventoryGeneration: true }, where: { id: owner.sessionId },
  });
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder" WHERE id = ${session.connectedFolderId} FOR SHARE`);
  await assertInventoryAfterPhysicalOutcomes(tx, session.connectedFolderId, session.inventoryGeneration);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "ScanSession" WHERE id = ${owner.sessionId} FOR UPDATE`);
  if (signal?.aborted || !await tx.scanSession.count({ where: {
    id: owner.sessionId, status: "GENERATING_SUGGESTIONS",
    recommendationGeneration: owner.generation, recommendationLeaseUntil: { gt: new Date() },
    connectedFolder: { ...currentReadableRootWhere, ...(allowReadOnly ? {} : { recommendationPermission: true }) },
  } })) throw new Error("Recommendation batch ownership changed; retry with current information.");
}
