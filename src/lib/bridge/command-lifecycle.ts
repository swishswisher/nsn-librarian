import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";

// Only PENDING means that no native operation was admitted. Acknowledged
// physical work retains its command/history until its durable local journal
// reports an outcome, even after expiry or revocation.
export async function settleUnstartedCommands(tx: Prisma.TransactionClient,
  where: Prisma.BridgeCommandWhereInput, status: "EXPIRED" | "CANCELLED", category: string) {
  const rows = await tx.bridgeCommand.findMany({ select: { commandId: true, payload: true, commandType: true },
    where: { AND: [where, { status: "PENDING" }] }, orderBy: { commandId: "asc" } });
  for (const row of rows) {
    const changed = await tx.bridgeCommand.updateMany({ data: { status, completedAt: new Date(), safeErrorCategory: category },
      where: { commandId: row.commandId, status: "PENDING" } });
    if (!changed.count) continue;
    const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
    if ((row.commandType === "SCAN_LIBRARY" || row.commandType === "RECONCILE_LIBRARY") && typeof payload.scanSessionId === "string") {
      await tx.scanSession.updateMany({ where: { id: payload.scanSessionId, status: { in: ["PENDING", "SCANNING"] } },
        data: { status: "FAILED", completedAt: new Date() } });
    }
    if (row.commandType === "EXECUTE_PLAN" && typeof payload.executionRunId === "string") {
      const run = await tx.executionRun.findUnique({ where: { id: payload.executionRunId } });
      if (run?.status === "PENDING") {
        await tx.executionAction.updateMany({ where: { executionRunId: run.id, status: "PENDING" },
          data: { status: "BLOCKED", completedAt: new Date(), safeErrorCategory: category } });
        await tx.executionRun.update({ where: { id: run.id }, data: { status: "BLOCKED", completedAt: new Date(),
          completedActions: run.totalActions, failedActions: run.totalActions, safeErrorCategory: category } });
      }
    }
    if (row.commandType === "EXECUTE_UNDO" && typeof payload.undoRunId === "string") {
      const run = await tx.undoRun.findUnique({ where: { id: payload.undoRunId } });
      if (run?.status === "PENDING") {
        await tx.undoAction.updateMany({ where: { undoRunId: run.id, status: "PENDING" },
          data: { status: "BLOCKED", completedAt: new Date(), safeErrorCategory: category } });
        await tx.undoRun.update({ where: { id: run.id }, data: { status: "BLOCKED", completedAt: new Date(),
          failedActions: run.totalActions, safeErrorCategory: category } });
      }
    }
  }
}

export async function expireUnstartedCommands(now = new Date(), bridgeDeviceId?: string) {
  await getPrismaClient().$transaction((tx) => settleUnstartedCommands(tx, {
    ...(bridgeDeviceId ? { bridgeDeviceId } : {}), commandType: { not: "READ_FILE_TEMPORARILY" }, expiresAt: { lte: now },
  }, "EXPIRED", "COMMAND_EXPIRED"), { timeout: 120_000 });
  const rows = await getPrismaClient().bridgeCommand.findMany({ select: { commandId: true, connectedLibraryId: true }, take: 100,
    orderBy: [{ expiresAt: "asc" }, { commandId: "asc" }], where: { bridgeDeviceId,
      commandType: { notIn: ["EXECUTE_PLAN", "EXECUTE_UNDO", "READ_FILE_TEMPORARILY"] },
      status: { in: ["ACKNOWLEDGED", "RUNNING"] }, expiresAt: { lte: now } } });
  for (const row of rows) await getPrismaClient().$transaction(async (tx) => {
    if (row.connectedLibraryId) await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${row.connectedLibraryId} FOR SHARE`;
    await tx.$queryRaw`SELECT "commandId" FROM "BridgeCommand" WHERE "commandId" = ${row.commandId} FOR UPDATE`;
    const current = await tx.bridgeCommand.findUniqueOrThrow({ where: { commandId: row.commandId } });
    if (!["ACKNOWLEDGED", "RUNNING"].includes(current.status) || current.expiresAt > now) return;
    const payload = current.payload && typeof current.payload === "object" && !Array.isArray(current.payload) ? current.payload : {};
    if (["SCAN_LIBRARY", "RECONCILE_LIBRARY"].includes(current.commandType) && typeof payload.scanSessionId === "string")
      await tx.scanSession.updateMany({ where: { id: payload.scanSessionId, status: { in: ["PENDING", "SCANNING"] } }, data: { status: "FAILED", completedAt: now } });
    await tx.bridgeCommand.update({ where: { commandId: row.commandId }, data: { status: "EXPIRED", safeErrorCategory: "COMMAND_EXPIRED", completedAt: now } });
  });
}

/** Read/control work cannot regain authority across a native reconnection or
 * a human root denial. Physical acknowledged history remains recoverable. */
export async function retireRootReadWork(tx: Prisma.TransactionClient, rootId: string) {
  await tx.scanSession.updateMany({ where: { connectedFolderId: rootId, status: { in: ["PENDING", "SCANNING", "READING", "EXAMINING", "GENERATING_SUGGESTIONS"] } },
    data: { status: "FAILED", completedAt: new Date(), recommendationGeneration: null, recommendationLeaseUntil: null } });
  await tx.bridgeCommand.updateMany({ where: { connectedLibraryId: rootId, commandType: { notIn: ["EXECUTE_PLAN", "EXECUTE_UNDO", "REVOKE_ROOT_ACCESS"] },
    status: { in: ["PENDING", "ACKNOWLEDGED", "RUNNING"] } }, data: { status: "CANCELLED", completedAt: new Date(), safeErrorCategory: "ROOT_AUTHORITY_CHANGED" } });
}
