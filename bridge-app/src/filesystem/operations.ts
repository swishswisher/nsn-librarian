import { hasPhysicalActionJournal, journaledMove, journaledCreateFolder, journaledRemoveFolder, recoverPhysicalAction, physicalActionBinding, PhysicalRecoveryRequired } from "./physical-journal";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readdir } from "node:fs/promises";
import path from "node:path";

import {
  BridgeAppError,
  type BridgeExecutionPlanAction,
  type BridgeUndoPlanAction,
} from "../types";
import { getRoot, requireExecutionPermissions, requireRootPermission, withRootAuthority } from "../main/registry";
import { resolveInsideRoot } from "./safety";

export type BridgeExecutionValidationIssue = {
  actionId: string | null;
  category: string;
  message: string;
};

export type BridgeExecutionActionResult = {
  actionId: string;
  actionType: BridgeExecutionPlanAction["actionType"];
  createdFilesystemItem: boolean;
  destinationChecksumAfter: string | null;
  destinationRelativePath: string;
  lastModified: string | null;
  safeErrorCategory: string | null;
  sizeBytes: string | null;
  sourceChecksumBefore: string | null;
  sourceRelativePath: string | null;
  status: "COMPLETED" | "FAILED" | "PENDING";
  physicalEffect?: "NONE" | "CHANGED" | "UNKNOWN";
};

export type BridgeUndoActionResult = {
  actionId: string;
  actionType: BridgeUndoPlanAction["actionType"];
  destinationChecksumAfter: string | null;
  destinationRelativePath: string;
  physicalEffect?: "NONE" | "CHANGED" | "UNKNOWN";
  lastModified: string | null;
  safeErrorCategory: string | null;
  sizeBytes: string | null;
  sourceChecksumBefore: string | null;
  sourceRelativePath: string;
  status: "COMPLETED" | "FAILED" | "PENDING";
};

async function checksumFile(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function metadataMatches(
  action: BridgeExecutionPlanAction,
  stats: Awaited<ReturnType<typeof lstat>>,
) {
  if (action.sourceSizeBytes && BigInt(action.sourceSizeBytes) !== BigInt(stats.size)) {
    return false;
  }

  if (!action.sourceLastModified) {
    return true;
  }

  const expectedModifiedAt = new Date(action.sourceLastModified).getTime();

  if (Number.isNaN(expectedModifiedAt)) {
    return true;
  }

  return Math.abs(stats.mtime.getTime() - expectedModifiedAt) <= 1000;
}

async function validateSourceIntegrity(
  sourcePath: string,
  action: BridgeExecutionPlanAction,
) {
  const stats = await lstat(sourcePath).catch(() => null);

  if (!stats) {
    throw new BridgeAppError(
      "The source file could not be found.",
      "MISSING_SOURCE",
      404,
    );
  }

  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new BridgeAppError(
      "The source item is not a regular file.",
      "SOURCE_NOT_FILE",
      422,
    );
  }

  if (!metadataMatches(action, stats)) {
    throw new BridgeAppError(
      "The source file changed after the plan was created.",
      "CHANGED_SOURCE",
      409,
    );
  }

  const sourceChecksumBefore = action.sourceChecksum
    ? await checksumFile(sourcePath)
    : null;

  if (
    action.sourceChecksum &&
    sourceChecksumBefore !== action.sourceChecksum
  ) {
    throw new BridgeAppError(
      "The source file changed after the plan was created.",
      "CHANGED_SOURCE",
      409,
    );
  }

  return {
    checksum: sourceChecksumBefore,
    stats,
  };
}

async function validateUndoSourceIntegrity(
  sourcePath: string,
  action: BridgeUndoPlanAction,
) {
  return validateSourceIntegrity(sourcePath, {
    actionType:
      action.actionType === "REMOVE_FOLDER" ? "CREATE_FOLDER" : action.actionType,
    destinationRelativePath: action.destinationRelativePath,
    id: action.id,
    sourceChecksum: action.sourceChecksum,
    sourceLastModified: action.sourceLastModified,
    sourceRelativePath: action.sourceRelativePath,
    sourceSizeBytes: action.sourceSizeBytes,
  });
}

export async function previewBridgeExecution(
  rootId: string,
  actions: BridgeExecutionPlanAction[],
) {
  await requireRootPermission(rootId, "readPermission", "verify files");
  await requireExecutionPermissions(rootId, actions);

  const root = await requireRootPermission(rootId, "readPermission", "verify files");
  const issues: BridgeExecutionValidationIssue[] = [];
  const destinations = new Map<string, string[]>();

  for (const action of actions) {
    try {
      const destination = await resolveInsideRoot(
        root.actualPath,
        action.destinationRelativePath,
      );

      destinations.set(destination.relativePath, [
        ...(destinations.get(destination.relativePath) ?? []),
        action.id,
      ]);

      if (action.actionType !== "CREATE_FOLDER") {
        const sourcePath = action.sourceRelativePath ?? "";
        const source = await resolveInsideRoot(root.actualPath, sourcePath);

        await access(source.resolvedPath, fsConstants.R_OK).catch(() => {
          issues.push({
            actionId: action.id,
            category: "MISSING_SOURCE",
            message: `${source.relativePath} could not be found.`,
          });
        });

        if (
          !issues.some(
            (issue) =>
              issue.actionId === action.id &&
              issue.category === "MISSING_SOURCE",
          )
        ) {
          await validateSourceIntegrity(source.resolvedPath, action).catch(
            (error) => {
              issues.push({
                actionId: action.id,
                category:
                  error instanceof BridgeAppError
                    ? error.code
                    : "VALIDATION_FAILED",
                message:
                  error instanceof Error
                    ? error.message
                    : "The Bridge could not verify the source file.",
              });
            },
          );
        }
      }

      await lstat(destination.resolvedPath)
        .then((stats) => {
          if (action.actionType === "CREATE_FOLDER" && stats.isDirectory()) {
            return;
          }

          issues.push({
            actionId: action.id,
            category: "DESTINATION_CONFLICT",
            message: `${destination.relativePath} already exists.`,
          });
        })
        .catch(() => undefined);
    } catch (error) {
      issues.push({
        actionId: action.id,
        category:
          error instanceof BridgeAppError ? error.code : "VALIDATION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "The Bridge could not validate this action.",
      });
    }
  }

  for (const [destination, actionIds] of destinations.entries()) {
    if (actionIds.length > 1) {
      for (const actionId of actionIds) {
        issues.push({
          actionId,
          category: "DUPLICATE_DESTINATION",
          message: `${destination} is used by more than one planned action.`,
        });
      }
    }
  }

  return {
    canExecute: issues.length === 0 && actions.length > 0,
    issues,
    rootId,
    totalActions: actions.length,
  };
}

export async function assertBridgeExecutionAllowed(
  rootId: string,
  actions: BridgeExecutionPlanAction[],
) {
  const preview = await previewBridgeExecution(rootId, actions);

  if (!preview.canExecute) {
    throw new BridgeAppError(
      "The Bridge found safety issues that must be resolved before execution.",
      "EXECUTION_BLOCKED",
      422,
    );
  }

  return preview;
}

function executionOrder(action: BridgeExecutionPlanAction) {
  if (action.actionType === "CREATE_FOLDER") {
    return 10;
  }

  if (action.actionType === "MOVE_FILE") {
    return 30;
  }

  if (action.actionType === "RENAME_FILE") {
    return 40;
  }

  return 50;
}

async function pathExists(filePath: string) {
  return lstat(filePath).catch(() => null);
}

export async function executeBridgePlanActions(
  rootId: string,
  actions: BridgeExecutionPlanAction[],
  expectedRootRevision?: number,
) {
  return withRootAuthority(rootId, async () => {
    const root = await requireRootPermission(rootId, "readPermission", "verify files");
    if (expectedRootRevision !== undefined && expectedRootRevision !== (root.connectionRevision ?? 0)) throw new BridgeAppError("This execution belongs to an older connection.", "ROOT_AUTHORITY_CHANGED", 409);
    return executeBridgePlanActionsOwned(rootId, actions);
  });
}
async function executeBridgePlanActionsOwned(rootId: string, actions: BridgeExecutionPlanAction[]) {
  const unstarted: BridgeExecutionPlanAction[] = [];
  for (const action of actions) if (!await hasPhysicalActionJournal(`execution:${rootId}:${action.id}`)) unstarted.push(action);
  if (unstarted.length) await assertBridgeExecutionAllowed(rootId, unstarted);

  const root = await requireRootPermission(rootId, "readPermission", "verify files");
  const orderedActions = [...actions].sort((left, right) => {
    const orderDifference = executionOrder(left) - executionOrder(right);

    return (
      orderDifference ||
      left.destinationRelativePath.localeCompare(right.destinationRelativePath) ||
      left.id.localeCompare(right.id)
    );
  });
  const results: BridgeExecutionActionResult[] = orderedActions.map((action) => ({
    actionId: action.id,
    actionType: action.actionType,
    createdFilesystemItem: false,
    destinationChecksumAfter: null,
    destinationRelativePath: action.destinationRelativePath,
    lastModified: null,
    safeErrorCategory: null,
    sizeBytes: null,
    sourceChecksumBefore: null,
    sourceRelativePath: action.sourceRelativePath ?? null,
    status: "PENDING",
    physicalEffect: "NONE",
  }));

  const resultById = new Map(results.map((item) => [item.actionId, item]));
  for (const action of orderedActions) {
    const result = resultById.get(action.id);

    if (!result) {
      continue;
    }

    try {
      await requireRootPermission(rootId, "readPermission", "verify files");
      await requireExecutionPermissions(rootId, [action]);

      const destination = await resolveInsideRoot(
        root.actualPath,
        action.destinationRelativePath,
      );

      const owner = `execution:${rootId}:${action.id}`;
      const hasJournal = await hasPhysicalActionJournal(owner);
      const destinationStats = await pathExists(destination.resolvedPath);

      if (
        !hasJournal && destinationStats &&
        !(action.actionType === "CREATE_FOLDER" && destinationStats.isDirectory())
      ) {
        throw new BridgeAppError(
          "The destination already exists.",
          "DESTINATION_CONFLICT",
          409,
        );
      }

      if (action.actionType === "CREATE_FOLDER") {
        const outcome = await journaledCreateFolder(owner, destination.resolvedPath);
        result.createdFilesystemItem = outcome.created;
      } else {
        const source = await resolveInsideRoot(root.actualPath, action.sourceRelativePath ?? "");
        if (!hasJournal) await validateSourceIntegrity(source.resolvedPath, action);
        const outcome = await journaledMove(owner, source.resolvedPath, destination.resolvedPath, action.sourceChecksum);
        result.sourceChecksumBefore = outcome.identity!.checksum;
        result.destinationChecksumAfter = outcome.identity!.checksum;
        result.lastModified = outcome.modifiedAt ?? null; result.sizeBytes = outcome.sizeBytes ?? null;
      }

      result.status = "COMPLETED";
      result.physicalEffect = action.actionType !== "CREATE_FOLDER" || result.createdFilesystemItem ? "CHANGED" : "NONE";
    } catch (error) {
      result.safeErrorCategory =
        error instanceof BridgeAppError
          ? error.code
          : "FILESYSTEM_OPERATION_FAILED";
      await settleFailedPhysicalAction(rootId, root.actualPath, action, result, false);
      break;
    }
  }

  const completedActions = results.filter(
    (result) => result.status === "COMPLETED",
  ).length;
  const failedActions = results.filter(
    (result) => result.status === "FAILED",
  ).length;

  return {
    actions: results,
    completedActions,
    failedActions,
    rootId,
    status:
      results.some((result) => result.safeErrorCategory === "COMMAND_RECOVERY_REQUIRED") ? "RECOVERY_REQUIRED" : failedActions > 0
        ? completedActions > 0
          ? "PARTIALLY_COMPLETED"
          : "FAILED"
        : "COMPLETED",
    totalActions: actions.length,
  };
}

function undoPermissionAction(action: BridgeUndoPlanAction): BridgeExecutionPlanAction {
  if (action.actionType === "REMOVE_FOLDER") {
    return {
      actionType: "CREATE_FOLDER",
      destinationRelativePath: action.sourceRelativePath,
      id: action.id,
    };
  }

  return {
    actionType: action.actionType,
    destinationRelativePath: action.destinationRelativePath,
    id: action.id,
    sourceRelativePath: action.sourceRelativePath,
  };
}

export async function previewBridgeUndo(
  rootId: string,
  actions: BridgeUndoPlanAction[],
) {
  await requireRootPermission(rootId, "readPermission", "verify files");
  await requireExecutionPermissions(rootId, actions.map(undoPermissionAction));

  const root = await requireRootPermission(rootId, "readPermission", "verify files");
  const issues: BridgeExecutionValidationIssue[] = [];
  const destinations = new Map<string, string[]>();

  for (const [index, action] of actions.entries()) {
    try {
      const source = await resolveInsideRoot(root.actualPath, action.sourceRelativePath);

      if (action.actionType === "REMOVE_FOLDER") {
        const sourceStats = await lstat(source.resolvedPath).catch(() => null);

        if (!sourceStats?.isDirectory() || sourceStats.isSymbolicLink()) {
          issues.push({
            actionId: action.id,
            category: "MISSING_SOURCE",
            message: `${source.relativePath} could not be found as an empty folder.`,
          });
          continue;
        }

        const entries = await readdir(source.resolvedPath).catch(() => null);

        if (entries === null) {
          issues.push({
            actionId: action.id,
            category: "FOLDER_NOT_EMPTY",
            message: `${source.relativePath} is not empty.`,
          });
          continue;
        }

        const entriesClearedBeforeRemoval = new Set(
          actions
            .slice(0, index)
            .filter(
              (item) =>
                path.posix.dirname(item.sourceRelativePath) ===
                source.relativePath,
            )
            .map((item) => path.posix.basename(item.sourceRelativePath)),
        );

        if (
          entries.length > 0 &&
          !entries.every((entry) => entriesClearedBeforeRemoval.has(entry))
        ) {
          issues.push({
            actionId: action.id,
            category: "FOLDER_NOT_EMPTY",
            message: `${source.relativePath} is not empty.`,
          });
        }
        continue;
      }

      await validateUndoSourceIntegrity(source.resolvedPath, action).catch(
        (error) => {
          issues.push({
            actionId: action.id,
            category:
              error instanceof BridgeAppError ? error.code : "VALIDATION_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "The Bridge could not verify the file to restore.",
          });
        },
      );

      const destination = await resolveInsideRoot(
        root.actualPath,
        action.destinationRelativePath,
      );

      destinations.set(destination.relativePath, [
        ...(destinations.get(destination.relativePath) ?? []),
        action.id,
      ]);

      await access(destination.resolvedPath, fsConstants.F_OK)
        .then(() => {
          issues.push({
            actionId: action.id,
            category: "DESTINATION_CONFLICT",
            message: `${destination.relativePath} already exists.`,
          });
        })
        .catch(() => undefined);
    } catch (error) {
      issues.push({
        actionId: action.id,
        category:
          error instanceof BridgeAppError ? error.code : "VALIDATION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "The Bridge could not validate this undo action.",
      });
    }
  }

  for (const [destination, actionIds] of destinations.entries()) {
    if (actionIds.length > 1) {
      for (const actionId of actionIds) {
        issues.push({
          actionId,
          category: "DUPLICATE_UNDO_DESTINATION",
          message: `${destination} is used by more than one undo action.`,
        });
      }
    }
  }

  return {
    canUndo: issues.length === 0 && actions.length > 0,
    issues,
    rootId,
    totalActions: actions.length,
  };
}

export async function executeBridgeUndoActions(
  rootId: string,
  actions: BridgeUndoPlanAction[],
  expectedRootRevision?: number,
) {
  return withRootAuthority(rootId, async () => {
    const root = await requireRootPermission(rootId, "readPermission", "verify files");
    if (expectedRootRevision !== undefined && expectedRootRevision !== (root.connectionRevision ?? 0)) throw new BridgeAppError("This Undo belongs to an older connection.", "ROOT_AUTHORITY_CHANGED", 409);
    return executeBridgeUndoActionsOwned(rootId, actions);
  });
}
async function executeBridgeUndoActionsOwned(rootId: string, actions: BridgeUndoPlanAction[]) {
  const unstarted: BridgeUndoPlanAction[] = [];
  for (const action of actions) if (!await hasPhysicalActionJournal(`undo:${rootId}:${action.id}`)) unstarted.push(action);
  const preview = unstarted.length ? await previewBridgeUndo(rootId, unstarted) : { canUndo: true };

  if (!preview.canUndo) {
    throw new BridgeAppError(
      "The Bridge found safety issues that must be resolved before undo.",
      "EXECUTION_BLOCKED",
      422,
    );
  }

  const root = await requireRootPermission(rootId, "readPermission", "verify files");
  const results: BridgeUndoActionResult[] = actions.map((action) => ({
    actionId: action.id,
    actionType: action.actionType,
    destinationChecksumAfter: null,
    destinationRelativePath: action.destinationRelativePath,
    lastModified: null,
    safeErrorCategory: null,
    sizeBytes: null,
    sourceChecksumBefore: null,
    sourceRelativePath: action.sourceRelativePath,
    status: "PENDING",
    physicalEffect: "NONE",
  }));

  const resultById = new Map(results.map((item) => [item.actionId, item]));
  for (const action of actions) {
    const result = resultById.get(action.id);

    if (!result) {
      continue;
    }

    try {
      await requireRootPermission(rootId, "readPermission", "verify files");
      await requireExecutionPermissions(rootId, [undoPermissionAction(action)]);

      const source = await resolveInsideRoot(root.actualPath, action.sourceRelativePath);

      const owner = `undo:${rootId}:${action.id}`;
      if (action.actionType === "REMOVE_FOLDER") {
        if (!action.originalExecutionActionId) throw new PhysicalRecoveryRequired("Undo is missing its created-folder owner.");
        await journaledRemoveFolder(owner, `execution:${rootId}:${action.originalExecutionActionId}`, source.resolvedPath);
      } else {
        if (!await hasPhysicalActionJournal(owner)) await validateUndoSourceIntegrity(source.resolvedPath, action);
        const destination = await resolveInsideRoot(root.actualPath, action.destinationRelativePath);
        const outcome = await journaledMove(owner, source.resolvedPath, destination.resolvedPath, action.sourceChecksum);
        result.sourceChecksumBefore = outcome.identity!.checksum; result.destinationChecksumAfter = outcome.identity!.checksum;
        result.lastModified = outcome.modifiedAt ?? null; result.sizeBytes = outcome.sizeBytes ?? null;
      }

      result.status = "COMPLETED";
      result.physicalEffect = "CHANGED";
    } catch (error) {
      result.safeErrorCategory =
        error instanceof BridgeAppError
          ? error.code
          : "FILESYSTEM_OPERATION_FAILED";
      await settleFailedPhysicalAction(rootId, root.actualPath, action, result, true);
      break;
    }
  }

  const completedActions = results.filter(
    (result) => result.status === "COMPLETED",
  ).length;
  const failedActions = results.filter(
    (result) => result.status === "FAILED",
  ).length;

  return {
    actions: results,
    completedActions,
    failedActions,
    rootId,
    status:
      results.some((result) => result.safeErrorCategory === "COMMAND_RECOVERY_REQUIRED") ? "RECOVERY_REQUIRED" : failedActions > 0
        ? completedActions > 0
          ? "PARTIALLY_COMPLETED"
          : "FAILED"
        : "COMPLETED",
    totalActions: actions.length,
  };
}

// Historical recovery never admits another filesystem operation. The result
// identifies verified completed effects and keeps uncertain effects pending.
export async function recoverBridgePhysicalActions(rootId: string, actions: Array<BridgeExecutionPlanAction | BridgeUndoPlanAction>, undo = false, neverStarted = false) {
  const root = await getRoot(rootId);
  const results: BridgeExecutionActionResult[] = [];
  for (const action of actions) {
    const result: BridgeExecutionActionResult = { actionId: action.id, actionType: action.actionType as BridgeExecutionPlanAction["actionType"],
      createdFilesystemItem: false, destinationChecksumAfter: null, destinationRelativePath: action.destinationRelativePath,
      lastModified: null, sizeBytes: null, safeErrorCategory: "COMMAND_INTERRUPTED", sourceChecksumBefore: null,
      sourceRelativePath: action.sourceRelativePath ?? null, status: "PENDING", physicalEffect: "UNKNOWN" };
    try {
      const entry = await recoverPhysicalAction(`${undo ? "undo" : "execution"}:${rootId}:${action.id}`,
        physicalActionBinding(root.actualPath, action, action.actionType === "REMOVE_FOLDER" && "originalExecutionActionId" in action ? `execution:${rootId}:${action.originalExecutionActionId}` : undefined));
      if (entry?.state === "COMPLETED") {
        result.status = "COMPLETED"; result.safeErrorCategory = null; result.createdFilesystemItem = entry.created;
        result.physicalEffect = entry.kind === "CREATE_FOLDER" && !entry.created ? "NONE" : "CHANGED";
        result.sourceChecksumBefore = entry.kind === "MOVE" ? entry.identity!.checksum : null;
        result.destinationChecksumAfter = result.sourceChecksumBefore;
        result.lastModified = entry.modifiedAt ?? null; result.sizeBytes = entry.sizeBytes ?? null;
      } else if (!entry && neverStarted) {
        result.status = "FAILED"; result.physicalEffect = "NONE";
      }
    } catch {
      result.status = "PENDING"; result.safeErrorCategory = "COMMAND_RECOVERY_REQUIRED";
    }
    results.push(result);
  }
  const completedActions = results.filter((result) => result.status === "COMPLETED").length;
  const failedActions = results.filter((result) => result.status === "FAILED").length;
  return { actions: results, completedActions, failedActions, totalActions: results.length, rootId,
    status: results.some((result) => result.status === "PENDING") ? "RECOVERY_REQUIRED"
      : completedActions === results.length ? "COMPLETED" : completedActions ? "PARTIALLY_COMPLETED" : "FAILED" };
}

async function settleFailedPhysicalAction(rootId: string, rootPath: string, action: BridgeExecutionPlanAction | BridgeUndoPlanAction,
  result: BridgeExecutionActionResult | BridgeUndoActionResult, undo: boolean) {
  try {
    const owner = `${undo ? "undo" : "execution"}:${rootId}:${action.id}`;
    // In a live journal-first attempt, no journal proves no effect was admitted.
    // Historical recovery without that live attempt remains UNKNOWN instead.
    if (!await hasPhysicalActionJournal(owner)) { result.status = "FAILED"; result.physicalEffect = "NONE"; return; }
    const entry = await recoverPhysicalAction(owner, physicalActionBinding(rootPath, action,
      action.actionType === "REMOVE_FOLDER" && "originalExecutionActionId" in action ? `execution:${rootId}:${action.originalExecutionActionId}` : undefined));
    if (!entry) {
      // An existing journal with no verified outcome can follow a physical
      // effect whose destination was removed. It does not establish no effect.
      result.status = "PENDING"; result.physicalEffect = "UNKNOWN"; result.safeErrorCategory = "COMMAND_RECOVERY_REQUIRED"; return;
    }
    result.status = "COMPLETED"; result.safeErrorCategory = null;
    result.physicalEffect = entry.kind === "CREATE_FOLDER" && !entry.created ? "NONE" : "CHANGED";
    if ("createdFilesystemItem" in result) result.createdFilesystemItem = entry.created;
    result.sourceChecksumBefore = entry.kind === "MOVE" ? entry.identity!.checksum : null;
    result.destinationChecksumAfter = result.sourceChecksumBefore;
    result.lastModified = entry.modifiedAt ?? null; result.sizeBytes = entry.sizeBytes ?? null;
  } catch {
    result.status = "PENDING"; result.physicalEffect = "UNKNOWN"; result.safeErrorCategory = "COMMAND_RECOVERY_REQUIRED";
  }
}
