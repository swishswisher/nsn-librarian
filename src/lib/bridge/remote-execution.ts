import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Prisma } from "@prisma/client";

import type {
  BridgeCommandReport,
  BridgeJson,
} from "../../../packages/bridge-protocol/src";
import { getPrismaClient } from "@/lib/db/prisma";
import { recordExecutionNotebookEntry } from "@/lib/library/notebook";

import {
  BridgeCloudError,
  createBridgeCloudCommand,
} from "./cloud-coordinator";
import {
  BridgeExecutorError,
  summarizeExecutionRun,
} from "./executor";
import { getOrganizationPlanPageData } from "./planner";
import type {
  BridgeExecutionIssue,
  BridgeExecutionPreview,
  BridgeOrganizationPlanAction,
  ExecutionStatus,
} from "./types";

type RemotePlanAction = {
  id: string;
  actionType:
    | "CREATE_FOLDER"
    | "MOVE_FILE"
    | "RENAME_FILE"
    | "MOVE_AND_RENAME_FILE";
  sourceRelativePath: string | null;
  sourceChecksum: string | null;
  sourceLastModified: string | null;
  sourceSizeBytes: string | null;
  destinationRelativePath: string;
  sequence: number;
};

type LoadedRemotePlan = {
  plan: {
    id: string;
    scanSessionId: string;
    connectedLibraryId: string;
    status: string;
    actions: Prisma.JsonValue;
    totalActions: number;
    connectedLibrary: {
      bridgeDeviceId: string | null;
      bridgeRootId: string | null;
      createFolderPermission: boolean;
      moveFilePermission: boolean;
      renameFilePermission: boolean;
      readPermission: boolean;
      isEnabled: boolean;
      status: string;
      bridgeDevice: {
        lastSeenAt: Date | null;
        status: string;
      } | null;
    };
    scanSession: {
      scannedFiles: {
        checksum: string | null;
        lastModified: Date | null;
        relativePath: string;
        sizeBytes: bigint | null;
      }[];
    };
  };
  normalizedActions: RemotePlanAction[];
  preview: BridgeExecutionPreview;
};

const onlineWindowMs = 90_000;

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function objectValue(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function planActions(value: Prisma.JsonValue): BridgeOrganizationPlanAction[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is BridgeOrganizationPlanAction =>
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item) &&
          typeof item.id === "string" &&
          typeof item.actionType === "string" &&
          typeof item.sourceRelativePath === "string",
      )
    : [];
}

function safeRelativePath(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const raw = value.replace(/\\/gu, "/").trim();

  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw)) {
    return null;
  }

  const normalized = path.posix.normalize(raw).replace(/^\.\//u, "");

  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return null;
  }

  return normalized;
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

function deviceIsOnline(device: { lastSeenAt: Date | null; status: string } | null) {
  const lastSeenAt = device?.lastSeenAt?.getTime() ?? Number.NaN;

  return (
    device?.status === "ONLINE" &&
    Number.isFinite(lastSeenAt) &&
    Date.now() - lastSeenAt <= onlineWindowMs
  );
}

function requiresPermission(
  actionType: RemotePlanAction["actionType"],
  library: LoadedRemotePlan["plan"]["connectedLibrary"],
) {
  if (!library.readPermission) {
    return "Read permission is off for this connected folder.";
  }

  if (actionType === "CREATE_FOLDER" && !library.createFolderPermission) {
    return "Create-folder permission is off for this connected folder.";
  }

  if (actionType === "MOVE_FILE" && !library.moveFilePermission) {
    return "Move permission is off for this connected folder.";
  }

  if (actionType === "RENAME_FILE" && !library.renameFilePermission) {
    return "Rename permission is off for this connected folder.";
  }

  if (
    actionType === "MOVE_AND_RENAME_FILE" &&
    (!library.moveFilePermission || !library.renameFilePermission)
  ) {
    return "Move and Rename permissions are both required for this action.";
  }

  return null;
}

async function loadRemotePlan(planId: string): Promise<LoadedRemotePlan | null> {
  const prisma = getPrismaClient();
  const plan = await prisma.organizationPlan.findUnique({
    include: {
      connectedLibrary: {
        include: {
          bridgeDevice: {
            select: {
              lastSeenAt: true,
              status: true,
            },
          },
        },
      },
      scanSession: {
        select: {
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
    where: { id: planId },
  });

  if (!plan) {
    throw new BridgeExecutorError(
      "The Librarian could not find that Organization Plan.",
      404,
    );
  }

  if (!plan.connectedLibrary.bridgeDeviceId) {
    return null;
  }

  const storedFiles = new Map(
    plan.scanSession.scannedFiles.map((file) => [file.relativePath, file]),
  );
  const actions = planActions(plan.actions);
  const blockingIssues: BridgeExecutionIssue[] = [];
  const warnings: BridgeExecutionIssue[] = [];
  const normalizedActions: RemotePlanAction[] = [];
  const previewActions: BridgeExecutionPreview["actions"] = [];
  const destinations = new Map<string, string[]>();

  if (plan.status !== "READY_FOR_EXECUTION") {
    blockingIssues.push(
      issue({
        category: "PLAN_NOT_READY",
        description: "Approve the Organization Plan before asking the Mac Bridge to execute it.",
        id: `plan-not-ready-${plan.id}`,
        title: "Plan is not approved",
      }),
    );
  }

  if (!plan.connectedLibrary.isEnabled || plan.connectedLibrary.status === "DISCONNECTED") {
    blockingIssues.push(
      issue({
        category: "BRIDGE_UNAVAILABLE",
        description: "Reconnect this folder before executing its Organization Plan.",
        id: `library-disconnected-${plan.connectedLibraryId}`,
        title: "Connected folder is unavailable",
      }),
    );
  }

  if (!plan.connectedLibrary.bridgeRootId || !deviceIsOnline(plan.connectedLibrary.bridgeDevice)) {
    blockingIssues.push(
      issue({
        category: "BRIDGE_UNAVAILABLE",
        description: "Open NSN Bridge on the paired Mac and wait for it to report online.",
        id: `bridge-offline-${plan.connectedLibraryId}`,
        title: "Mac Bridge is offline",
      }),
    );
  }

  for (const [index, action] of actions.entries()) {
    if (
      action.actionType !== "CREATE_FOLDER" &&
      action.actionType !== "MOVE_FILE" &&
      action.actionType !== "RENAME_FILE" &&
      action.actionType !== "MOVE_AND_RENAME_FILE"
    ) {
      blockingIssues.push(
        issue({
          actionIds: [action.id],
          category: "UNSUPPORTED_ACTION",
          description: `${action.actionType} is review-only and cannot change the local filesystem.`,
          id: `unsupported-${action.id}`,
          title: "Unsupported filesystem action",
        }),
      );
      continue;
    }

    const sourceRelativePath =
      action.actionType === "CREATE_FOLDER"
        ? null
        : safeRelativePath(action.sourceRelativePath);
    const destinationRelativePath = safeRelativePath(
      action.actionType === "CREATE_FOLDER"
        ? action.plannedFolderPath ?? action.plannedRelativePath
        : action.plannedRelativePath,
    );

    if (!destinationRelativePath || (action.actionType !== "CREATE_FOLDER" && !sourceRelativePath)) {
      blockingIssues.push(
        issue({
          actionIds: [action.id],
          category: "INVALID_PATH",
          description: "The source or destination path is missing, absolute, or leaves the connected folder.",
          id: `invalid-path-${action.id}`,
          title: "Invalid action path",
        }),
      );
      continue;
    }

    const permissionError = requiresPermission(action.actionType, plan.connectedLibrary);

    if (permissionError) {
      blockingIssues.push(
        issue({
          actionIds: [action.id],
          category: "PERMISSION_DENIED",
          description: permissionError,
          id: `permission-${action.id}`,
          title: "Required permission is off",
        }),
      );
    }

    const file = sourceRelativePath ? storedFiles.get(sourceRelativePath) : null;
    const normalized: RemotePlanAction = {
      actionType: action.actionType,
      destinationRelativePath,
      id: action.id,
      sequence: index + 1,
      sourceChecksum: file?.checksum ?? null,
      sourceLastModified: file?.lastModified?.toISOString() ?? null,
      sourceRelativePath,
      sourceSizeBytes: file?.sizeBytes?.toString() ?? null,
    };

    normalizedActions.push(normalized);
    previewActions.push({
      actionType: action.actionType,
      description: action.reason,
      destinationRelativePath,
      id: action.id,
      sequence: index + 1,
      sourceRelativePath,
    });
    destinations.set(destinationRelativePath, [
      ...(destinations.get(destinationRelativePath) ?? []),
      action.id,
    ]);
  }

  for (const [destination, actionIds] of destinations.entries()) {
    if (actionIds.length > 1) {
      blockingIssues.push(
        issue({
          actionIds,
          category: "DUPLICATE_DESTINATION",
          description: `${destination} is used by more than one planned action.`,
          id: `duplicate-destination-${destination}`,
          title: "Duplicate destination",
        }),
      );
    }
  }

  if (normalizedActions.length === 0) {
    blockingIssues.push(
      issue({
        category: "PLAN_EMPTY",
        description: "No supported file or folder actions are ready to execute.",
        id: `plan-empty-${plan.id}`,
        title: "No executable actions",
      }),
    );
  }

  warnings.push(
    issue({
      category: "VALIDATION_FAILED",
      description:
        "This web preview checks the approved plan and permissions. The installed Mac Bridge will independently re-check every source file, checksum, destination conflict, and path immediately before changing anything.",
      id: `final-local-check-${plan.id}`,
      severity: "WARNING",
      title: "Final local safety check happens on the Mac",
    }),
  );

  const preview: BridgeExecutionPreview = {
    actions: previewActions,
    blockingIssues,
    canExecute: blockingIssues.length === 0 && normalizedActions.length > 0,
    changedFiles: [],
    conflicts: blockingIssues.filter((item) =>
      item.category === "DUPLICATE_DESTINATION" ||
      item.category === "DESTINATION_CONFLICT",
    ),
    estimatedOperations: normalizedActions.length,
    missingFiles: blockingIssues.filter((item) => item.category === "MISSING_SOURCE"),
    organizationPlanId: plan.id,
    warnings,
  };

  return {
    normalizedActions,
    plan,
    preview,
  };
}

export async function previewRemoteOrganizationPlanExecution(planId: string) {
  const loaded = await loadRemotePlan(planId);
  return loaded?.preview ?? null;
}

export async function queueRemoteOrganizationPlanExecution(
  planId: string,
  confirmation: unknown,
) {
  if (confirmation !== "EXECUTE") {
    throw new BridgeExecutorError(
      "Type EXECUTE before the Bridge can execute this plan.",
      400,
    );
  }

  const loaded = await loadRemotePlan(planId);

  if (!loaded) {
    return null;
  }

  if (!loaded.preview.canExecute) {
    throw new BridgeExecutorError(
      "The Bridge found safety issues that must be resolved before execution.",
      422,
      loaded.preview,
    );
  }

  const prisma = getPrismaClient();
  const executionActionIds = loaded.normalizedActions.map(() =>
    `execution_action_${randomUUID()}`,
  );
  const permissionSnapshot = {
    createFolderPermission: loaded.plan.connectedLibrary.createFolderPermission,
    moveFilePermission: loaded.plan.connectedLibrary.moveFilePermission,
    readPermission: loaded.plan.connectedLibrary.readPermission,
    renameFilePermission: loaded.plan.connectedLibrary.renameFilePermission,
  };
  const run = await prisma.executionRun.create({
    data: {
      bridgeDeviceId: loaded.plan.connectedLibrary.bridgeDeviceId,
      bridgeRootId: loaded.plan.connectedLibrary.bridgeRootId,
      connectedLibraryId: loaded.plan.connectedLibraryId,
      organizationPlanId: loaded.plan.id,
      permissionSnapshot: jsonInput(permissionSnapshot),
      status: "PENDING",
      totalActions: loaded.normalizedActions.length,
      actions: {
        create: loaded.normalizedActions.map((action, index) => ({
          actionType: action.actionType,
          destinationRelativePath: action.destinationRelativePath,
          id: executionActionIds[index],
          sequence: action.sequence,
          sourceChecksumBefore: action.sourceChecksum,
          sourceRelativePath: action.sourceRelativePath ?? "",
          status: "PENDING",
        })),
      },
    },
  });
  const commandActions = loaded.normalizedActions.map((action, index) => ({
    ...action,
    id: executionActionIds[index],
  }));

  try {
    const command = await createBridgeCloudCommand({
      authorizationContext: {
        approvedBy: "Deanne",
        confirmation: "EXECUTE",
        executionRunId: run.id,
        purpose: "Execute only the approved Organization Plan on the paired Mac.",
      },
      bridgeDeviceId: loaded.plan.connectedLibrary.bridgeDeviceId as string,
      bridgeRootId: loaded.plan.connectedLibrary.bridgeRootId,
      commandType: "EXECUTE_PLAN",
      connectedLibraryId: loaded.plan.connectedLibraryId,
      idempotencyKey: `execute-plan:${loaded.plan.id}:${run.id}`,
      payload: {
        actions: commandActions,
        executionRunId: run.id,
        organizationPlanId: loaded.plan.id,
        scanSessionId: loaded.plan.scanSessionId,
      },
    });
    const pageData = await getOrganizationPlanPageData(loaded.plan.scanSessionId);

    if (!pageData?.plan || !pageData.latestExecution) {
      throw new BridgeCloudError(
        "The Librarian could not refresh the queued execution.",
        500,
      );
    }

    return {
      command,
      plan: pageData.plan,
      preview: loaded.preview,
      queuedExecution: true,
      run: pageData.latestExecution,
    };
  } catch (error) {
    await prisma.executionRun.update({
      data: {
        completedAt: new Date(),
        errorCategory: "COMMAND_QUEUE_FAILED",
        failedActions: loaded.normalizedActions.length,
        safeErrorCategory: "BRIDGE_UNAVAILABLE",
        status: "BLOCKED",
      },
      where: { id: run.id },
    });
    throw error;
  }
}

function executionStatus(value: unknown): ExecutionStatus {
  return value === "COMPLETED" ||
    value === "PARTIALLY_COMPLETED" ||
    value === "FAILED" ||
    value === "BLOCKED"
    ? value
    : "FAILED";
}

export async function applyRemoteExecutionReport(input: {
  commandPayload: unknown;
  report: BridgeCommandReport;
}) {
  const payload = objectValue(input.commandPayload);
  const executionRunId =
    typeof payload?.executionRunId === "string" ? payload.executionRunId : null;

  if (!executionRunId) {
    throw new BridgeCloudError(
      "The execution command is missing its history reference.",
      422,
    );
  }

  const prisma = getPrismaClient();
  const run = await prisma.executionRun.findUnique({
    include: {
      actions: true,
      organizationPlan: true,
    },
    where: { id: executionRunId },
  });

  if (!run) {
    throw new BridgeCloudError(
      "The Librarian could not find the queued execution history.",
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

  for (const action of run.actions) {
    const resultAction = resultActions.find(
      (item) => item?.actionId === action.id,
    );
    const actionStatus =
      resultAction?.status === "COMPLETED"
        ? "COMPLETED"
        : resultAction?.status === "FAILED"
          ? "FAILED"
          : input.report.status === "COMPLETED"
            ? "BLOCKED"
            : "FAILED";

    if (actionStatus === "COMPLETED") {
      completedActions += 1;
    } else {
      failedActions += 1;
    }

    await prisma.executionAction.update({
      data: {
        completedAt,
        createdFilesystemItem: resultAction?.createdFilesystemItem === true,
        destinationChecksumAfter:
          typeof resultAction?.destinationChecksumAfter === "string"
            ? resultAction.destinationChecksumAfter
            : null,
        safeErrorCategory:
          typeof resultAction?.safeErrorCategory === "string"
            ? resultAction.safeErrorCategory
            : actionStatus === "COMPLETED"
              ? null
              : input.report.safeErrorCategory ?? "EXECUTION_BLOCKED",
        sourceChecksumBefore:
          typeof resultAction?.sourceChecksumBefore === "string"
            ? resultAction.sourceChecksumBefore
            : action.sourceChecksumBefore,
        startedAt: action.startedAt ?? run.startedAt,
        status: actionStatus,
      },
      where: { id: action.id },
    });

    if (actionStatus === "COMPLETED" && action.sourceRelativePath) {
      await prisma.scannedFile.updateMany({
        data: {
          localPath: `bridge://${run.bridgeRootId}/${action.destinationRelativePath}`,
          relativePath: action.destinationRelativePath,
        },
        where: {
          relativePath: action.sourceRelativePath,
          sessionId: run.organizationPlan.scanSessionId,
        },
      });
    }
  }

  const innerStatus = executionStatus(result?.status);
  const status: ExecutionStatus =
    input.report.status === "COMPLETED"
      ? innerStatus
      : completedActions > 0
        ? "PARTIALLY_COMPLETED"
        : "FAILED";
  const durationMs = Math.max(0, completedAt.getTime() - run.startedAt.getTime());

  await prisma.$transaction([
    prisma.executionRun.update({
      data: {
        completedActions: completedActions + failedActions,
        completedAt,
        durationMs,
        errorCategory:
          status === "COMPLETED" ? null : "REMOTE_EXECUTION_INCOMPLETE",
        failedActions,
        reconciliationStatus: "REQUIRED",
        safeErrorCategory:
          status === "COMPLETED"
            ? null
            : input.report.safeErrorCategory ??
              (typeof result?.safeErrorCategory === "string"
                ? result.safeErrorCategory
                : "EXECUTION_BLOCKED"),
        status,
        successfulActions: completedActions,
      },
      where: { id: run.id },
    }),
    prisma.organizationPlan.update({
      data: {
        status:
          completedActions > 0 || status === "COMPLETED"
            ? "EXECUTED"
            : run.organizationPlan.status,
      },
      where: { id: run.organizationPlanId },
    }),
  ]);
  await recordExecutionNotebookEntry(run.id);
  const stored = await prisma.executionRun.findUnique({
    include: {
      actions: { orderBy: { sequence: "asc" } },
      undoRuns: {
        include: { actions: { orderBy: { sequence: "asc" } } },
        orderBy: { startedAt: "desc" },
      },
    },
    where: { id: run.id },
  });

  if (!stored) {
    throw new BridgeCloudError(
      "The Librarian could not refresh execution history.",
      500,
    );
  }

  return summarizeExecutionRun(stored) as unknown as BridgeJson;
}
