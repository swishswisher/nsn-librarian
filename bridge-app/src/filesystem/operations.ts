import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readdir, rename, rmdir } from "node:fs/promises";
import path from "node:path";

import {
  BridgeAppError,
  type BridgeExecutionPlanAction,
  type BridgeUndoPlanAction,
} from "../types";
import { requireExecutionPermissions, requireRootPermission } from "../main/registry";
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
};

export type BridgeUndoActionResult = {
  actionId: string;
  actionType: BridgeUndoPlanAction["actionType"];
  destinationChecksumAfter: string | null;
  destinationRelativePath: string;
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
) {
  await assertBridgeExecutionAllowed(rootId, actions);

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
  }));

  for (const action of orderedActions) {
    const result = results.find((item) => item.actionId === action.id);

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

      const destinationStats = await pathExists(destination.resolvedPath);

      if (
        destinationStats &&
        !(action.actionType === "CREATE_FOLDER" && destinationStats.isDirectory())
      ) {
        throw new BridgeAppError(
          "The destination already exists.",
          "DESTINATION_CONFLICT",
          409,
        );
      }

      if (action.actionType === "CREATE_FOLDER") {
        if (!destinationStats) {
          await mkdir(destination.resolvedPath, { recursive: false });
          result.createdFilesystemItem = true;
        }
      } else {
        const source = await resolveInsideRoot(
          root.actualPath,
          action.sourceRelativePath ?? "",
        );
        const sourceIntegrity = await validateSourceIntegrity(
          source.resolvedPath,
          action,
        );

        result.sourceChecksumBefore = sourceIntegrity.checksum;
        await rename(source.resolvedPath, destination.resolvedPath);
      }

      const stats = await lstat(destination.resolvedPath).catch(() => null);

      result.lastModified = stats?.mtime.toISOString() ?? null;
      result.sizeBytes = stats ? BigInt(stats.size).toString() : null;
      result.destinationChecksumAfter =
        stats?.isFile() === true ? await checksumFile(destination.resolvedPath) : null;
      result.status = "COMPLETED";
    } catch (error) {
      result.safeErrorCategory =
        error instanceof BridgeAppError
          ? error.code
          : "FILESYSTEM_OPERATION_FAILED";
      result.status = "FAILED";
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
      failedActions > 0
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
) {
  const preview = await previewBridgeUndo(rootId, actions);

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
  }));

  for (const action of actions) {
    const result = results.find((item) => item.actionId === action.id);

    if (!result) {
      continue;
    }

    try {
      await requireRootPermission(rootId, "readPermission", "verify files");
      await requireExecutionPermissions(rootId, [undoPermissionAction(action)]);

      const source = await resolveInsideRoot(root.actualPath, action.sourceRelativePath);

      if (action.actionType === "REMOVE_FOLDER") {
        await rmdir(source.resolvedPath);
      } else {
        const integrity = await validateUndoSourceIntegrity(
          source.resolvedPath,
          action,
        );
        const destination = await resolveInsideRoot(
          root.actualPath,
          action.destinationRelativePath,
        );

        if (await pathExists(destination.resolvedPath)) {
          throw new BridgeAppError(
            "The destination already exists.",
            "DESTINATION_CONFLICT",
            409,
          );
        }

        result.sourceChecksumBefore = integrity.checksum;
        await rename(source.resolvedPath, destination.resolvedPath);

        const stats = await lstat(destination.resolvedPath).catch(() => null);

        result.destinationChecksumAfter =
          stats?.isFile() === true ? await checksumFile(destination.resolvedPath) : null;
        result.lastModified = stats?.mtime.toISOString() ?? null;
        result.sizeBytes = stats ? BigInt(stats.size).toString() : null;
      }

      result.status = "COMPLETED";
    } catch (error) {
      result.safeErrorCategory =
        error instanceof BridgeAppError
          ? error.code
          : "FILESYSTEM_OPERATION_FAILED";
      result.status = "FAILED";
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
      failedActions > 0
        ? completedActions > 0
          ? "PARTIALLY_COMPLETED"
          : "FAILED"
        : "COMPLETED",
    totalActions: actions.length,
  };
}
