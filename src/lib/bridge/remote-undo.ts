import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import type {
  BridgeCommandReport,
  BridgeJson,
} from "../../../packages/bridge-protocol/src";
import { getPrismaClient } from "@/lib/db/prisma";
import { recordUndoNotebookEntry } from "@/lib/library/notebook";

import {
  BridgeCloudError,
  createBridgeCloudCommand,
} from "./cloud-coordinator";
import { summarizeExecutionRun } from "./executor";
import type {
  BridgeExecutionIssue,
  BridgeUndoActionType,
  BridgeUndoPreview,
  UndoStatus,
} from "./types";
import { BridgeUndoError } from "./undo";

type RemoteUndoAction = {
  actionType: BridgeUndoActionType;
  destinationRelativePath: string;
  id: string;
  originalExecutionActionId: string;
  sequence: number;
  sourceChecksum: string | null;
  sourceLastModified: string | null;
  sourceRelativePath: string;
  sourceSizeBytes: string | null;
};

const onlineWindowMs = 90_000;

function objectValue(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function issue(input: {
  actionIds?: string[];
  category: BridgeExecutionIssue["category"];
  description: string;
  id: string;
  severity?: BridgeExecutionIssue["severity"];
  title: string;
}): BridgeExecutionIssue {
  return {
    affectedActionIds: input.actionIds ?? [],
    category: input.category,
    description: input.description,
    id: input.id,
    severity: input.severity ?? "BLOCKING",
    title: input.title,
  };
}

function undoStatus(value: unknown): UndoStatus {
  return value === "COMPLETED" ||
    value === "PARTIALLY_COMPLETED" ||
    value === "FAILED" ||
    value === "BLOCKED"
    ? value
    : "FAILED";
}

function deviceIsOnline(device: { lastSeenAt: Date | null; status: string } | null) {
  const lastSeenAt = device?.lastSeenAt?.getTime() ?? Number.NaN;

  return (
    device?.status === "ONLINE" &&
    Number.isFinite(lastSeenAt) &&
    Date.now() - lastSeenAt <= onlineWindowMs
  );
}

async function loadRemoteUndo(executionRunId: string) {
  const prisma = getPrismaClient();
  const run = await prisma.executionRun.findUnique({
    include: {
      actions: { orderBy: { sequence: "desc" } },
      connectedLibrary: {
        include: {
          bridgeDevice: {
            select: { lastSeenAt: true, status: true },
          },
        },
      },
      organizationPlan: {
        include: {
          scanSession: {
            include: {
              scannedFiles: {
                select: {
                  checksum: true,
                  lastModified: true,
                  relativePath: true,
                  sizeBytes: true,
                },
              },
            },
          },
        },
      },
      undoRuns: {
        include: { actions: true },
        orderBy: { startedAt: "desc" },
      },
    },
    where: { id: executionRunId },
  });

  if (!run) {
    throw new BridgeUndoError(
      "The Librarian could not find that execution run.",
      404,
    );
  }

  if (!run.bridgeDeviceId) {
    return null;
  }

  const blockingIssues: BridgeExecutionIssue[] = [];
  const warnings: BridgeExecutionIssue[] = [];
  const completedActions = run.actions.filter(
    (action) => action.status === "COMPLETED",
  );
  const scannedByPath = new Map(
    run.organizationPlan.scanSession.scannedFiles.map((file) => [
      file.relativePath,
      file,
    ]),
  );
  const actions: RemoteUndoAction[] = [];

  if (run.status !== "COMPLETED" && run.status !== "PARTIALLY_COMPLETED") {
    blockingIssues.push(
      issue({
        category: "UNDO_NOT_AVAILABLE",
        description: "Only completed local changes can be restored.",
        id: `undo-status-${run.id}`,
        title: "Undo is not available for this execution",
      }),
    );
  }

  if (run.undoRuns.some((undoRun) => undoRun.status === "COMPLETED")) {
    blockingIssues.push(
      issue({
        category: "UNDO_ALREADY_COMPLETED",
        description: "This execution has already been restored.",
        id: `undo-completed-${run.id}`,
        title: "Undo already completed",
      }),
    );
  }

  if (
    run.undoRuns.some(
      (undoRun) => undoRun.status === "RUNNING" || undoRun.status === "PENDING",
    )
  ) {
    blockingIssues.push(
      issue({
        category: "UNDO_RUNNING",
        description: "Wait for the current Undo command to finish.",
        id: `undo-running-${run.id}`,
        title: "Undo is already active",
      }),
    );
  }

  if (!run.bridgeRootId || !deviceIsOnline(run.connectedLibrary.bridgeDevice)) {
    blockingIssues.push(
      issue({
        category: "BRIDGE_UNAVAILABLE",
        description: "Open NSN Bridge on the paired Mac before previewing or restoring these changes.",
        id: `undo-bridge-offline-${run.id}`,
        title: "Mac Bridge is offline",
      }),
    );
  }

  for (const [index, action] of completedActions.entries()) {
    const sourceRelativePath = action.destinationRelativePath;
    const currentFile = scannedByPath.get(sourceRelativePath);
    let actionType: BridgeUndoActionType;
    let destinationRelativePath: string;

    if (action.actionType === "CREATE_FOLDER") {
      if (!action.createdFilesystemItem) {
        continue;
      }
      actionType = "REMOVE_FOLDER";
      destinationRelativePath = action.destinationRelativePath;
    } else if (action.actionType === "RENAME_FILE") {
      actionType = "RENAME_FILE";
      destinationRelativePath = action.sourceRelativePath;
    } else {
      actionType = "MOVE_FILE";
      destinationRelativePath = action.sourceRelativePath;
    }

    if (!sourceRelativePath || !destinationRelativePath) {
      blockingIssues.push(
        issue({
          actionIds: [action.id],
          category: "INVALID_PATH",
          description: "The execution history is missing a safe source or original destination path.",
          id: `undo-invalid-path-${action.id}`,
          title: "Undo path is incomplete",
        }),
      );
      continue;
    }

    if (actionType === "REMOVE_FOLDER" && !run.connectedLibrary.createFolderPermission) {
      blockingIssues.push(
        issue({
          actionIds: [action.id],
          category: "PERMISSION_DENIED",
          description: "Create-folder permission is required to remove a folder that the Bridge created.",
          id: `undo-permission-${action.id}`,
          title: "Required permission is off",
        }),
      );
    }

    if (actionType === "MOVE_FILE" && !run.connectedLibrary.moveFilePermission) {
      blockingIssues.push(
        issue({
          actionIds: [action.id],
          category: "PERMISSION_DENIED",
          description: "Move permission is required to restore this file.",
          id: `undo-permission-${action.id}`,
          title: "Required permission is off",
        }),
      );
    }

    if (actionType === "RENAME_FILE" && !run.connectedLibrary.renameFilePermission) {
      blockingIssues.push(
        issue({
          actionIds: [action.id],
          category: "PERMISSION_DENIED",
          description: "Rename permission is required to restore this file name.",
          id: `undo-permission-${action.id}`,
          title: "Required permission is off",
        }),
      );
    }

    actions.push({
      actionType,
      destinationRelativePath,
      id: action.id,
      originalExecutionActionId: action.id,
      sequence: index + 1,
      sourceChecksum:
        currentFile?.checksum ?? action.destinationChecksumAfter ?? null,
      sourceLastModified: currentFile?.lastModified?.toISOString() ?? null,
      sourceRelativePath,
      sourceSizeBytes: currentFile?.sizeBytes?.toString() ?? null,
    });
  }

  if (actions.length === 0) {
    blockingIssues.push(
      issue({
        category: "UNDO_NOT_AVAILABLE",
        description: "No completed move, rename, or Bridge-created folder can be restored.",
        id: `undo-empty-${run.id}`,
        title: "There are no reversible actions",
      }),
    );
  }

  warnings.push(
    issue({
      category: "VALIDATION_FAILED",
      description:
        "The installed Mac Bridge will verify that every current source still matches its checksum, that original destinations are free, and that Bridge-created folders are empty before restoring anything.",
      id: `undo-final-local-check-${run.id}`,
      severity: "WARNING",
      title: "Final Undo safety check happens on the Mac",
    }),
  );

  const preview: BridgeUndoPreview = {
    actions: actions.map((action) => ({
      actionType: action.actionType,
      description:
        action.actionType === "REMOVE_FOLDER"
          ? `Remove the empty folder created by the Bridge at ${action.sourceRelativePath}.`
          : `Restore ${action.sourceRelativePath} to ${action.destinationRelativePath}.`,
      destinationRelativePath: action.destinationRelativePath,
      id: action.id,
      originalExecutionActionId: action.originalExecutionActionId,
      sequence: action.sequence,
      sourceRelativePath: action.sourceRelativePath,
    })),
    blockedActions: blockingIssues.filter((item) =>
      item.category === "UNDO_NOT_AVAILABLE" ||
      item.category === "UNDO_ALREADY_COMPLETED" ||
      item.category === "UNDO_RUNNING" ||
      item.category === "INVALID_PATH" ||
      item.category === "PERMISSION_DENIED",
    ),
    blockingIssues,
    canUndo: blockingIssues.length === 0 && actions.length > 0,
    changedFiles: [],
    conflicts: [],
    estimatedOperations: actions.length,
    executionRunId: run.id,
    missingFiles: [],
    organizationPlanId: run.organizationPlanId,
    warnings,
  };

  return { actions, preview, run };
}

export async function previewRemoteExecutionUndo(executionRunId: string) {
  const loaded = await loadRemoteUndo(executionRunId);
  return loaded?.preview ?? null;
}

export async function queueRemoteExecutionUndo(
  executionRunId: string,
  confirmation: unknown,
) {
  if (confirmation !== "UNDO") {
    throw new BridgeUndoError(
      "Type UNDO before the Bridge can restore these changes.",
      400,
    );
  }

  const loaded = await loadRemoteUndo(executionRunId);

  if (!loaded) {
    return null;
  }

  if (!loaded.preview.canUndo) {
    throw new BridgeUndoError(
      "The Bridge found safety issues that must be resolved before undo.",
      422,
      loaded.preview,
    );
  }

  const prisma = getPrismaClient();
  const undoActionIds = loaded.actions.map(() =>
    `undo_action_${randomUUID()}`,
  );
  const undoRun = await prisma.undoRun.create({
    data: {
      executionRunId,
      status: "PENDING",
      totalActions: loaded.actions.length,
      actions: {
        create: loaded.actions.map((action, index) => ({
          actionType: action.actionType,
          destinationRelativePath: action.destinationRelativePath,
          id: undoActionIds[index],
          originalExecutionActionId: action.originalExecutionActionId,
          sequence: action.sequence,
          sourceRelativePath: action.sourceRelativePath,
          status: "PENDING",
        })),
      },
    },
  });
  const commandActions = loaded.actions.map((action, index) => ({
    ...action,
    id: undoActionIds[index],
  }));

  try {
    const command = await createBridgeCloudCommand({
      authorizationContext: {
        confirmation: "UNDO",
        initiatedBy: "Deanne",
        purpose: "Restore only the completed changes from this execution run.",
        undoRunId: undoRun.id,
      },
      bridgeDeviceId: loaded.run.bridgeDeviceId as string,
      bridgeRootId: loaded.run.bridgeRootId,
      commandType: "EXECUTE_UNDO",
      connectedLibraryId: loaded.run.connectedLibraryId,
      idempotencyKey: `execute-undo:${executionRunId}:${undoRun.id}`,
      payload: {
        actions: commandActions,
        executionRunId,
        organizationPlanId: loaded.run.organizationPlanId,
        scanSessionId: loaded.run.organizationPlan.scanSessionId,
        undoRunId: undoRun.id,
      },
    });
    const stored = await prisma.executionRun.findUnique({
      include: {
        actions: { orderBy: { sequence: "asc" } },
        undoRuns: {
          include: { actions: { orderBy: { sequence: "asc" } } },
          orderBy: { startedAt: "desc" },
        },
      },
      where: { id: executionRunId },
    });

    if (!stored) {
      throw new BridgeCloudError(
        "The Librarian could not refresh the queued Undo run.",
        500,
      );
    }

    const executionRun = summarizeExecutionRun(stored);

    if (!executionRun.latestUndoRun) {
      throw new BridgeCloudError(
        "The Librarian could not refresh the queued Undo run.",
        500,
      );
    }

    return {
      command,
      executionRun,
      preview: loaded.preview,
      queuedUndo: true,
      run: executionRun.latestUndoRun,
      scanSessionId: loaded.run.organizationPlan.scanSessionId,
    };
  } catch (error) {
    await prisma.undoRun.update({
      data: {
        completedAt: new Date(),
        failedActions: loaded.actions.length,
        safeErrorCategory: "BRIDGE_UNAVAILABLE",
        status: "BLOCKED",
      },
      where: { id: undoRun.id },
    });
    throw error;
  }
}

export async function applyRemoteUndoReport(input: {
  commandPayload: unknown;
  report: BridgeCommandReport;
}) {
  const payload = objectValue(input.commandPayload);
  const undoRunId = typeof payload?.undoRunId === "string" ? payload.undoRunId : null;

  if (!undoRunId) {
    throw new BridgeCloudError(
      "The Undo command is missing its history reference.",
      422,
    );
  }

  const prisma = getPrismaClient();
  const undoRun = await prisma.undoRun.findUnique({
    include: {
      actions: true,
      executionRun: {
        include: {
          organizationPlan: true,
        },
      },
    },
    where: { id: undoRunId },
  });

  if (!undoRun) {
    throw new BridgeCloudError(
      "The Librarian could not find the queued Undo history.",
      404,
    );
  }

  const result = objectValue(input.report.result);
  const resultActions = Array.isArray(result?.actions)
    ? result.actions.map(objectValue).filter(Boolean)
    : [];
  const completedAt = new Date();
  let completedActions = 0;
  let failedActions = 0;

  for (const action of undoRun.actions) {
    const resultAction = resultActions.find(
      (item) => item?.actionId === action.id,
    );
    const actionStatus =
      resultAction?.status === "COMPLETED" ? "COMPLETED" : "FAILED";

    if (actionStatus === "COMPLETED") {
      completedActions += 1;
    } else {
      failedActions += 1;
    }

    await prisma.undoAction.update({
      data: {
        completedAt,
        safeErrorCategory:
          typeof resultAction?.safeErrorCategory === "string"
            ? resultAction.safeErrorCategory
            : actionStatus === "COMPLETED"
              ? null
              : input.report.safeErrorCategory ?? "EXECUTION_BLOCKED",
        startedAt: action.startedAt ?? undoRun.startedAt,
        status: actionStatus,
      },
      where: { id: action.id },
    });

    if (actionStatus === "COMPLETED" && action.actionType !== "REMOVE_FOLDER") {
      await prisma.scannedFile.updateMany({
        data: {
          checksum:
            typeof resultAction?.destinationChecksumAfter === "string"
              ? resultAction.destinationChecksumAfter
              : undefined,
          lastModified:
            typeof resultAction?.lastModified === "string"
              ? new Date(resultAction.lastModified)
              : undefined,
          localPath: `bridge://${undoRun.executionRun.bridgeRootId}/${action.destinationRelativePath}`,
          relativePath: action.destinationRelativePath,
          sizeBytes:
            typeof resultAction?.sizeBytes === "string"
              ? BigInt(resultAction.sizeBytes)
              : undefined,
        },
        where: {
          relativePath: action.sourceRelativePath,
          sessionId: undoRun.executionRun.organizationPlan.scanSessionId,
        },
      });
    }
  }

  const innerStatus = undoStatus(result?.status);
  const status: UndoStatus =
    input.report.status === "COMPLETED"
      ? innerStatus
      : completedActions > 0
        ? "PARTIALLY_COMPLETED"
        : "FAILED";
  const durationMs = Math.max(
    0,
    completedAt.getTime() - undoRun.startedAt.getTime(),
  );

  await prisma.undoRun.update({
    data: {
      completedActions,
      completedAt,
      durationMs,
      failedActions,
      safeErrorCategory:
        status === "COMPLETED"
          ? null
          : input.report.safeErrorCategory ?? "EXECUTION_BLOCKED",
      status,
    },
    where: { id: undoRun.id },
  });
  await recordUndoNotebookEntry(undoRun.id);
  const stored = await prisma.executionRun.findUnique({
    include: {
      actions: { orderBy: { sequence: "asc" } },
      undoRuns: {
        include: { actions: { orderBy: { sequence: "asc" } } },
        orderBy: { startedAt: "desc" },
      },
    },
    where: { id: undoRun.executionRunId },
  });

  if (!stored) {
    throw new BridgeCloudError(
      "The Librarian could not refresh Undo history.",
      500,
    );
  }

  const executionRun = summarizeExecutionRun(stored);

  return {
    executionRun,
    run: executionRun.latestUndoRun,
    scanSessionId: undoRun.executionRun.organizationPlan.scanSessionId,
  } as unknown as BridgeJson;
}
