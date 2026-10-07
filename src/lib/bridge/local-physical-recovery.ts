import path from "node:path";
import { Prisma, type ConnectedLibrary } from "@prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { isCurrentReadableRoot } from "./current-readable-root";
import { physicalResultIndex } from "./physical-result-authority";
import { executeLocalBridgeActions, executeLocalBridgeUndoActions, recoverLocalBridgePhysicalActions,
  type LocalBridgeExecutionActionInput, type LocalBridgeUndoActionInput } from "./local-bridge-client";
import { journaledMove, journaledCreateFolder, journaledRemoveFolder, recoverPhysicalAction, physicalActionBinding } from "../../../bridge-app/src/filesystem/physical-journal";
import { resolveInsideRoot } from "../../../bridge-app/src/filesystem/safety";
import { requireExecutionReconciliation } from "./execution-reconciliation";

type Action = { id: string; actionType: string; sourceRelativePath: string; destinationRelativePath: string;
  checksum: string | null; sourceId: string | null; originalId?: string };
type Result = { actionId: string; actionType: string; sourceRelativePath: string | null; destinationRelativePath: string;
  status: "COMPLETED" | "FAILED" | "PENDING"; safeErrorCategory: string | null; sourceChecksumBefore: string | null;
  destinationChecksumAfter: string | null; createdFilesystemItem: boolean; lastModified: string | null; sizeBytes: string | null };

export function localPhysicalPermission(root: ConnectedLibrary, actionType: string) {
  return isCurrentReadableRoot(root) && !root.bridgeDeviceId &&
    (actionType === "CREATE_FOLDER" || actionType === "REMOVE_FOLDER" ? root.createFolderPermission :
      actionType === "RENAME_FILE" ? root.renameFilePermission :
        actionType === "MOVE_AND_RENAME_FILE" ? root.moveFilePermission && root.renameFilePermission : root.moveFilePermission);
}
function inputFor(action: Action) {
  return { id: action.id, actionType: action.actionType, sourceRelativePath: action.sourceRelativePath || null,
    destinationRelativePath: action.destinationRelativePath, sourceChecksum: action.checksum,
    originalExecutionActionId: action.originalId };
}
async function outcome(root: ConnectedLibrary, action: Action, undo: boolean, allowed: boolean): Promise<Result> {
  const input = inputFor(action);
  const empty: Result = { actionId: action.id, actionType: action.actionType, sourceRelativePath: action.sourceRelativePath || null,
    destinationRelativePath: action.destinationRelativePath, status: "PENDING", safeErrorCategory: "COMMAND_RECOVERY_REQUIRED",
    sourceChecksumBefore: null, destinationChecksumAfter: null, createdFilesystemItem: false, lastModified: null, sizeBytes: null };
  if (root.bridgeRootId) {
    try {
      if (allowed) {
        const report = undo ? await executeLocalBridgeUndoActions(root.bridgeRootId, [input as LocalBridgeUndoActionInput], root.nativeConnectionRevision)
          : await executeLocalBridgeActions(root.bridgeRootId, [input as LocalBridgeExecutionActionInput], root.nativeConnectionRevision);
        return { ...empty, ...report.actions[0] };
      }
      const report = await recoverLocalBridgePhysicalActions(root.bridgeRootId,
        [input as LocalBridgeExecutionActionInput | LocalBridgeUndoActionInput], undo);
      return { ...empty, ...report.actions[0] };
    } catch {
      try {
        const report = await recoverLocalBridgePhysicalActions(root.bridgeRootId,
          [input as LocalBridgeExecutionActionInput | LocalBridgeUndoActionInput], undo);
        return { ...empty, ...report.actions[0] };
      } catch { return empty; } // A lost transport response cannot prove the operation failed.
    }
  }
  const owner = `${undo ? "undo" : "execution"}:${root.id}:${action.id}`;
  const binding = physicalActionBinding(root.localPath, input, action.originalId ? `execution:${root.id}:${action.originalId}` : undefined);
  try {
    let entry;
    try { entry = await recoverPhysicalAction(owner, binding); } catch { if (!allowed) return empty; }
    if (!entry && !allowed) return { ...empty, status: "FAILED", safeErrorCategory: "PERMISSION_DENIED" };
    if (entry?.state !== "COMPLETED" && allowed) {
      const destination = await resolveInsideRoot(root.localPath, action.destinationRelativePath);
      if (action.actionType === "CREATE_FOLDER") entry = await journaledCreateFolder(owner, destination.resolvedPath);
      else if (action.actionType === "REMOVE_FOLDER") entry = await journaledRemoveFolder(owner,
        `execution:${root.id}:${action.originalId}`, destination.resolvedPath);
      else {
        if (!action.checksum || !/^[a-f0-9]{64}$/u.test(action.checksum)) throw new Error("CHANGED_SOURCE");
        const source = await resolveInsideRoot(root.localPath, action.sourceRelativePath);
        entry = await journaledMove(owner, source.resolvedPath, destination.resolvedPath, action.checksum);
      }
    }
    if (entry?.state !== "COMPLETED") return empty;
    return { ...empty, status: "COMPLETED", safeErrorCategory: null, createdFilesystemItem: entry.created,
      sourceChecksumBefore: entry.kind === "MOVE" ? entry.identity!.checksum : null,
      destinationChecksumAfter: entry.kind === "MOVE" ? entry.identity!.checksum : null,
      lastModified: entry.modifiedAt ?? null, sizeBytes: entry.sizeBytes ?? null };
  } catch (error) {
    // Read back the journal before classifying an exception. Completed effects
    // survive publication failure; ambiguous effects remain recoverable.
    try {
      const entry = await recoverPhysicalAction(owner, binding);
      if (entry?.state === "COMPLETED") return { ...empty, status: "COMPLETED", safeErrorCategory: null,
        createdFilesystemItem: entry.created, sourceChecksumBefore: entry.kind === "MOVE" ? entry.identity!.checksum : null,
        destinationChecksumAfter: entry.kind === "MOVE" ? entry.identity!.checksum : null,
        lastModified: entry.modifiedAt ?? null, sizeBytes: entry.sizeBytes ?? null };
    } catch { return empty; }
    const category = (error as { code?: string }).code;
    return { ...empty, status: "FAILED", safeErrorCategory: category === "EEXIST" ? "DESTINATION_CONFLICT" :
      error instanceof Error && /checksum|changed|CHANGED_SOURCE/iu.test(error.message) ? "CHANGED_SOURCE" : "FILESYSTEM_OPERATION_FAILED" };
  }
}

// The root grant and immutable run owner stay locked across each physical
// action and its database publication. Process death releases the lock while
// the local fsynced journal preserves the outcome. No process-local busy flag,
// timeout-based ownership guess, or independently terminal parent is used.
export async function executeLocalPhysicalRun(runId: string, undo = false,
  options: { afterPhysical?: (actionId: string) => Promise<void> } = {}) {
  const prisma = getPrismaClient();
  const binding = undo ? await prisma.undoRun.findUniqueOrThrow({ where: { id: runId }, include: { executionRun: true } }) : null;
  const executionId = binding?.executionRunId ?? runId;
  const execution = await prisma.executionRun.findUniqueOrThrow({ where: { id: executionId } });
  if (execution.bridgeDeviceId) throw new Error("Remote execution belongs to its signed command owner.");
  const actionIds = undo ? await prisma.undoAction.findMany({ where: { undoRunId: runId }, orderBy: [{ sequence: "asc" }, { id: "asc" }], select: { id: true } })
    : await prisma.executionAction.findMany({ where: { executionRunId: runId }, orderBy: [{ sequence: "asc" }, { id: "asc" }], select: { id: true } });
  let stop = false;
  for (const { id } of actionIds) {
    const state = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder" WHERE id = ${execution.connectedLibraryId} FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "ExecutionRun" WHERE id = ${executionId} FOR UPDATE`);
      if (undo) await tx.$queryRaw(Prisma.sql`SELECT id FROM "UndoRun" WHERE id = ${runId} FOR UPDATE`);
      const root = await tx.connectedLibrary.findUniqueOrThrow({ where: { id: execution.connectedLibraryId } });
      const run = undo ? await tx.undoRun.findUniqueOrThrow({ where: { id: runId } }) : await tx.executionRun.findUniqueOrThrow({ where: { id: runId } });
      if (run.status !== "RUNNING") return "TERMINAL";
      const stored = undo ? await tx.undoAction.findUniqueOrThrow({ where: { id }, include: { originalExecutionAction: true } })
        : await tx.executionAction.findUniqueOrThrow({ where: { id } });
      if (!["PENDING", "RUNNING"].includes(stored.status)) return stored.status;
      const original = "originalExecutionAction" in stored ? stored.originalExecutionAction : stored;
      const action: Action = { ...stored, checksum: undo ? original.destinationChecksumAfter ?? original.sourceChecksumBefore : original.sourceChecksumBefore,
        sourceId: original.sourceScannedFileId, originalId: undo ? original.id : undefined };
      const allowed = !stop && run.physicalRootRevision !== null && run.physicalRootRevision === root.nativeConnectionRevision && localPhysicalPermission(root, action.actionType);
      const result = await outcome(root, action, undo, allowed);
      // Pre-journal deployments did not persist this authority revision. Missing
      // local proof cannot establish that an interrupted legacy effect failed.
      // Retain uncertainty without authorizing a new operation on its snapshot.
      if (run.physicalRootRevision === null && result.status === "FAILED") {
        result.status = "PENDING"; result.safeErrorCategory = "COMMAND_RECOVERY_REQUIRED";
      }
      physicalResultIndex([result], [{ ...action, sourceRelativePath: action.sourceRelativePath || null }]);
      await options.afterPhysical?.(id);
      if (result.status === "COMPLETED") await requireExecutionReconciliation(tx, executionId);
      const data = { status: result.status, startedAt: stored.startedAt ?? new Date(),
        completedAt: result.status === "PENDING" ? null : new Date(), safeErrorCategory: result.safeErrorCategory };
      if (undo) await tx.undoAction.update({ where: { id }, data });
      else await tx.executionAction.update({ where: { id }, data: { ...data,
        createdFilesystemItem: result.status === "COMPLETED" && result.createdFilesystemItem,
        destinationChecksumAfter: result.status === "COMPLETED" ? result.destinationChecksumAfter : null } });
      if (result.status === "COMPLETED" && action.sourceRelativePath && action.actionType !== "REMOVE_FOLDER") {
        await tx.scannedFile.updateMany({ where: { ...(action.sourceId ? { id: action.sourceId } : {}),
          sessionId: (await tx.organizationPlan.findUniqueOrThrow({ where: { id: execution.organizationPlanId } })).scanSessionId,
          relativePath: action.sourceRelativePath, checksum: action.checksum }, data: {
            relativePath: action.destinationRelativePath,
            localPath: root.bridgeRootId ? `bridge://${root.bridgeRootId}/${action.destinationRelativePath}` : path.resolve(root.localPath, ...action.destinationRelativePath.split("/")),
            lastModified: result.lastModified ? new Date(result.lastModified) : undefined,
            sizeBytes: result.sizeBytes ? BigInt(result.sizeBytes) : undefined,
        } });
      }
      return result.status;
    }, { timeout: 120_000 });
    if (state === "TERMINAL" || state === "PENDING") break;
    if (state !== "COMPLETED") stop = true;
  }
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ExecutionRun" WHERE id = ${executionId} FOR UPDATE`);
    if (undo) await tx.$queryRaw(Prisma.sql`SELECT id FROM "UndoRun" WHERE id = ${runId} FOR UPDATE`);
    const run = undo ? await tx.undoRun.findUniqueOrThrow({ where: { id: runId } }) : await tx.executionRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== "RUNNING") return;
    const actions = undo ? await tx.undoAction.findMany({ where: { undoRunId: runId } }) : await tx.executionAction.findMany({ where: { executionRunId: runId } });
    const success = actions.filter((action) => action.status === "COMPLETED").length;
    const failed = actions.filter((action) => ["FAILED", "BLOCKED"].includes(action.status)).length;
    const pending = actions.length - success - failed;
    const status: "RUNNING" | "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED" = pending ? "RUNNING" : success === run.totalActions && run.totalActions > 0 ? "COMPLETED" : success ? "PARTIALLY_COMPLETED" : "FAILED";
    const now = new Date();
    const data = { status, completedAt: pending ? null : now, durationMs: Math.max(0, now.getTime() - run.startedAt.getTime()),
      failedActions: failed, safeErrorCategory: pending ? "COMMAND_RECOVERY_REQUIRED" : actions.find((action) => action.safeErrorCategory)?.safeErrorCategory ?? null,
      physicalRecoveryAttemptedAt: now };
    if (undo) await tx.undoRun.update({ where: { id: runId }, data: { ...data, completedActions: success } });
    else {
      await tx.executionRun.update({ where: { id: runId }, data: { ...data, completedActions: success + failed, successfulActions: success,
        ...(success ? {} : { reconciliationStatus: "NOT_STARTED" }) } });
      if (success) await tx.organizationPlan.update({ where: { id: execution.organizationPlanId }, data: { status: "EXECUTED" } });
    }
  }, { timeout: 120_000 });
}

export async function recoverLocalPhysicalRunsForSession(scanSessionId: string) {
  const prisma = getPrismaClient();
  const where = { bridgeDeviceId: null, organizationPlan: { scanSessionId } };
  const executions = await prisma.executionRun.findMany({ where: { ...where, status: "RUNNING" },
    orderBy: [{ physicalRecoveryAttemptedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }], take: 2, select: { id: true } });
  const undos = await prisma.undoRun.findMany({ where: { status: "RUNNING", executionRun: where },
    orderBy: [{ physicalRecoveryAttemptedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }], take: 2, select: { id: true } });
  for (const item of [...executions.map((run) => ({ ...run, undo: false })), ...undos.map((run) => ({ ...run, undo: true }))]) {
    try { await executeLocalPhysicalRun(item.id, item.undo); }
    catch {
      const data = { physicalRecoveryAttemptedAt: new Date() };
      if (item.undo) await prisma.undoRun.updateMany({ where: { id: item.id, status: "RUNNING" }, data });
      else await prisma.executionRun.updateMany({ where: { id: item.id, status: "RUNNING" }, data });
    }
  }
}
