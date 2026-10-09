import { Prisma } from "@prisma/client";

const authorityTables = ["ObservationSession", "KnowledgeObject", "KnowledgeRelationship",
  "NotebookEntry", "ExecutionRun", "BridgeDevice", "BridgePairingCode", "ConnectedFolder"] as const;
type AuthorityTable = typeof authorityTables[number];

/** Acquire before reading prior human/device authority. Callers locking several
 * owners must use a stable table/id order and keep external work outside the tx. */
export async function lockAuthorityOwner(tx: Prisma.TransactionClient, table: AuthorityTable, id: string) {
  if (!authorityTables.includes(table)) throw new Error("Unsupported authority owner.");
  return tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id} FOR UPDATE
  `);
}

/** PostgreSQL's default now() is transaction-start time, possibly before a lock
 * wait. Persist millisecond monotonic ordering after acquiring the owner lock. */
export async function nextAuthorityTime(tx: Prisma.TransactionClient, latest?: Date | null) {
  const [row] = await tx.$queryRaw<Array<{ current: Date }>>`SELECT clock_timestamp() AS current`;
  return new Date(Math.max(row.current.getTime(), (latest?.getTime() ?? -1) + 1));
}

export function isAuthorityConflict(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const failure = error as { code: unknown; meta?: { code?: unknown } };
  return failure.code === "P2034" || (failure.code === "P2010" &&
    (failure.meta?.code === "40001" || failure.meta?.code === "40P01"));
}
