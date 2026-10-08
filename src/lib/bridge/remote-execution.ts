import { physicalResultIndex, physicalResultState, physicalResultChanged } from "./physical-result-authority";
import { requireExecutionReconciliation } from "./execution-reconciliation";
import { isCurrentReadableRoot } from "./current-readable-root";
import { claimPlanExecution } from "./plan-execution-authority";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { Prisma } from "@prisma/client";

import type {
  BridgeCommandReport,
  BridgeJson,
} from "../../../packages/bridge-protocol/src";
import { getPrismaClient } from "@/lib/db/prisma";

import {
  BridgeCloudError,
  createBridgeCloudCommand,
} from "./cloud-coordinator";
import {
  BridgeExecutorError,
  summarizeExecutionRun,
} from "./executor";
import { bridgeDeviceIsOnline } from "./effective-health";
import { getOrganizationPlanPageData } from "./planner";
import { isCurrentRecommendationGeneration } from "./recommendation-generation";
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
  sourceScannedFileId: string | null;
  sourceChecksum: string | null;
  sourceLastModified: string | null;
  sourceSizeBytes: string | null;
  destinationRelativePath: string;
  sequence: number;
};

type LoadedRemotePlan = {
  plan: {
    id: string;
    updatedAt: Date;
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
      organizationSuggestions: {
        id: string;
        invalidatedAt: Date | null;
        recommendationGenerationId: string;
        recommendationGenerationVersion: string;
        scannedFile: {
          checksum: string | null;
          id: string;
          lastModified: Date | null;
          relativePath: string;
          sizeBytes: bigint | null;
        };
      }[];
      scannedFiles: {
        checksum: string | null;
        id: string;
        lastModified: Date | null;
        relativePath: string;
        sizeBytes: bigint | null;
      }[];
    };
  };
  normalizedActions: RemotePlanAction[];
  preview: BridgeExecutionPreview;
};

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

function actionIsSelectableForExecution(action: BridgeOrganizationPlanAction) {
  return (
    (action.actionType === "MOVE_FILE" ||
      action.actionType === "RENAME_FILE" ||
      action.actionType === "MOVE_AND_RENAME_FILE") &&
    typeof action.sourceRelativePath === "string" &&
    action.sourceRelativePath.trim().length > 0 &&
    typeof action.plannedRelativePath === "string" &&
    action.plannedRelativePath.trim().length > 0 &&
    isCurrentRecommendationGeneration(
      action.recommendationGenerationVersion ?? "",
    )
  );
}

function actionIsExecutableInSavedPlan(action: BridgeOrganizationPlanAction) {
  return (
    (actionIsSelectableForExecution(action) &&
      action.selectedForExecution === true) ||
    (action.actionType === "CREATE_FOLDER" &&
      action.requiredForSelectedActions === true &&
      isCurrentRecommendationGeneration(
        action.recommendationGenerationVersion ?? "",
      ))
  );
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

function sourceSnapshotMatches(
  action: BridgeOrganizationPlanAction,
  scannedFile: {
    checksum: string | null;
    id: string;
    lastModified: Date | null;
    relativePath: string;
    sizeBytes: bigint | null;
  },
) {
  const snapshot = action.sourceSnapshot;

  return (
    Boolean(snapshot) &&
    snapshot?.scannedFileId === scannedFile.id &&
    snapshot.relativePath === scannedFile.relativePath &&
    snapshot.checksum === scannedFile.checksum &&
    snapshot.sizeBytes === (scannedFile.sizeBytes?.toString() ?? null) &&
    snapshot.lastModified === (scannedFile.lastModified?.toISOString() ?? null)
  );
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
  return bridgeDeviceIsOnline(device);
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

async function loadRemotePlan(planId: string, transaction?: Prisma.TransactionClient): Promise<LoadedRemotePlan | null> {
  const prisma = transaction ?? getPrismaClient();
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
          organizationSuggestions: {
            select: {
              id: true,
              invalidatedAt: true,
              recommendationGenerationId: true,
              recommendationGenerationVersion: true,
              scannedFile: {
                select: {
                  checksum: true,
                  id: true,
                  lastModified: true,
                  relativePath: true,
                  sizeBytes: true,
                },
              },
            },
          },
          scannedFiles: {
            select: {
              checksum: true,
              id: true,
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

  const suggestionsById = new Map(
    plan.scanSession.organizationSuggestions.map((suggestion) => [
      suggestion.id,
      suggestion,
    ]),
  );
  const actions = planActions(plan.actions);
  const selectedActions = actions.filter(actionIsExecutableInSavedPlan);
  const blockingIssues: BridgeExecutionIssue[] = [];
  const warnings: BridgeExecutionIssue[] = [];
  const normalizedActions: RemotePlanAction[] = [];
  const previewActions: BridgeExecutionPreview["actions"] = [];
  const destinations = new Map<string, string[]>();
  const sources = new Map<string, Array<{ id: string; destination: string }>>();

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

  if (!isCurrentReadableRoot(plan.connectedLibrary)) {
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

  for (const action of actions) {
    if (
      action.selectedForExecution === true &&
      !actionIsSelectableForExecution(action) &&
      !(
        action.actionType === "CREATE_FOLDER" &&
        action.requiredForSelectedActions === true
      )
    ) {
      blockingIssues.push(
        issue({
          actionIds: [action.id],
          category: "UNSUPPORTED_ACTION",
          description:
            "Only move and rename file recommendations can be selected for filesystem organization.",
          id: `unsupported-selection-${action.id}`,
          title: "Unsupported selected action",
        }),
      );
    }
  }

  for (const [index, action] of selectedActions.entries()) {
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

    if (action.actionType !== "CREATE_FOLDER") {
      const suggestion = suggestionsById.get(action.suggestionId) ?? null;

      if (!suggestion) {
        blockingIssues.push(
          issue({
            actionIds: [action.id],
            category: "VALIDATION_FAILED",
            description:
              "The Bridge could not match this planned action to its reviewed recommendation.",
            id: `recommendation-missing-${action.id}`,
            title: "The source recommendation could not be verified",
          }),
        );
        continue;
      }

      if (
        suggestion.invalidatedAt ||
        !isCurrentRecommendationGeneration(
          suggestion.recommendationGenerationVersion,
        )
      ) {
        blockingIssues.push(
          issue({
            actionIds: [action.id],
            category: "VALIDATION_FAILED",
            description:
              "Regenerate recommendations and rebuild the Organization Plan before executing this action.",
            id: `recommendation-stale-${action.id}`,
            title: "The source recommendation is no longer current",
          }),
        );
        continue;
      }

      if (
        action.recommendationGenerationId !==
          suggestion.recommendationGenerationId ||
        action.recommendationGenerationVersion !==
          suggestion.recommendationGenerationVersion
      ) {
        blockingIssues.push(
          issue({
            actionIds: [action.id],
            category: "VALIDATION_FAILED",
            description:
              "The Bridge refused a planned action whose recommendation generation no longer matches the reviewed recommendation.",
            id: `recommendation-generation-mismatch-${action.id}`,
            title: "The plan does not match the current recommendation pass",
          }),
        );
        continue;
      }

      if (sourceRelativePath !== suggestion.scannedFile.relativePath) {
        blockingIssues.push(
          issue({
            actionIds: [action.id],
            category: "VALIDATION_FAILED",
            description:
              "The Bridge refused a planned action whose source path no longer matches the reviewed recommendation.",
            id: `source-record-mismatch-${action.id}`,
            title: "The planned source does not match the scanned file record",
          }),
        );
        continue;
      }

      if (!sourceSnapshotMatches(action, suggestion.scannedFile)) {
        blockingIssues.push(
          issue({
            actionIds: [action.id],
            category: "CHANGED_SOURCE",
            description: `${action.sourceRelativePath} no longer matches the source snapshot used to build this plan.`,
            id: `source-snapshot-changed-${action.id}`,
            title: "A source file changed after the plan was built",
          }),
        );
        continue;
      }
    }

    const file =
      action.actionType === "CREATE_FOLDER"
        ? null
        : suggestionsById.get(action.suggestionId)?.scannedFile ?? null;
    const normalized: RemotePlanAction = {
      actionType: action.actionType,
      destinationRelativePath,
      id: action.id,
      sequence: index + 1,
      sourceScannedFileId: file?.id ?? null,
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

    if (sourceRelativePath) {
      sources.set(sourceRelativePath, [
        ...(sources.get(sourceRelativePath) ?? []),
        {
          destination: destinationRelativePath,
          id: action.id,
        },
      ]);
    }
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

  for (const [source, entries] of sources.entries()) {
    const sourceDestinations = [
      ...new Set(entries.map((entry) => entry.destination)),
    ];

    if (sourceDestinations.length > 1) {
      blockingIssues.push(
        issue({
          actionIds: entries.map((entry) => entry.id),
          category: "DUPLICATE_SOURCE",
          description: `${source} is selected for more than one destination. Choose one destination before execution.`,
          id: `duplicate-source-${source}`,
          title: "Duplicate source",
        }),
      );
    }
  }

  if (normalizedActions.length === 0) {
    blockingIssues.push(
      issue({
        category: "PLAN_EMPTY",
        description:
          "Select and save at least one file action before executing an Organization Plan.",
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

  const prisma = getPrismaClient();
  const admitted = await prisma.$transaction(async (tx) => {
    const binding = await tx.organizationPlan.findUnique({ include: { connectedLibrary: true }, where: { id: planId } });
    if (!binding?.connectedLibrary.bridgeDeviceId) return null;
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${binding.connectedLibrary.bridgeDeviceId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder" WHERE id = ${binding.connectedLibraryId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ScanSession" WHERE id = ${binding.scanSessionId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "OrganizationPlan" WHERE id = ${planId} FOR UPDATE`);
    const loaded = await loadRemotePlan(planId, tx);
    if (!loaded) return null;
    if (!loaded.preview.canExecute) throw new BridgeExecutorError("The Bridge found safety issues that must be resolved before execution.", 422, loaded.preview);
    if (!await claimPlanExecution(tx, loaded.plan)) {
      throw new BridgeExecutorError("This plan changed, execution already started, or its current authorization is unavailable.", 409, loaded.preview);
    }
    const commandActions = loaded.normalizedActions.map((action) => ({ ...action, id: `execution_action_${randomUUID()}` }));
    const run = await tx.executionRun.create({ data: {
      bridgeDeviceId: loaded.plan.connectedLibrary.bridgeDeviceId, bridgeRootId: loaded.plan.connectedLibrary.bridgeRootId,
      connectedLibraryId: loaded.plan.connectedLibraryId, organizationPlanId: loaded.plan.id,
      permissionSnapshot: jsonInput({ createFolderPermission: loaded.plan.connectedLibrary.createFolderPermission,
        moveFilePermission: loaded.plan.connectedLibrary.moveFilePermission, readPermission: loaded.plan.connectedLibrary.readPermission,
        renameFilePermission: loaded.plan.connectedLibrary.renameFilePermission }), status: "PENDING", totalActions: commandActions.length,
      actions: { create: commandActions.map((action) => ({ actionType: action.actionType, destinationRelativePath: action.destinationRelativePath,
        id: action.id, sequence: action.sequence, sourceScannedFileId: action.sourceScannedFileId, sourceChecksumBefore: action.sourceChecksum, sourceRelativePath: action.sourceRelativePath ?? "", status: "PENDING" })) },
    } });
    const command = await createBridgeCloudCommand({ authorizationContext: { approvedBy: "Deanne", confirmation: "EXECUTE", executionRunId: run.id,
        purpose: "Execute only the approved Organization Plan on the paired Mac." },
      bridgeDeviceId: loaded.plan.connectedLibrary.bridgeDeviceId!, bridgeRootId: loaded.plan.connectedLibrary.bridgeRootId,
      commandType: "EXECUTE_PLAN", connectedLibraryId: loaded.plan.connectedLibraryId, idempotencyKey: `execute-plan:${loaded.plan.id}:${run.id}`,
      payload: { actions: commandActions, executionRunId: run.id, organizationPlanId: loaded.plan.id, scanSessionId: loaded.plan.scanSessionId },
    }, tx);
    return { loaded, command };
  }, { isolationLevel: "Serializable", timeout: 120_000 });
  if (!admitted) return null;
  // Presentation failure cannot relinquish a committed physical command.
  const pageData = await getOrganizationPlanPageData(admitted.loaded.plan.scanSessionId);
  if (!pageData?.plan || !pageData.latestExecution) throw new BridgeCloudError("Execution was queued; refresh its history.", 503);
  return { command: admitted.command, plan: pageData.plan, preview: admitted.loaded.preview, queuedExecution: true, run: pageData.latestExecution };
}

export async function applyRemoteExecutionReport(input: {
  commandPayload: unknown;
  report: BridgeCommandReport;
}, transaction?: Prisma.TransactionClient): Promise<BridgeJson> {
  if (!transaction) return getPrismaClient().$transaction((tx) => applyRemoteExecutionReport(input, tx), { timeout: 120_000 });
  const payload = objectValue(input.commandPayload);
  const executionRunId =
    typeof payload?.executionRunId === "string" ? payload.executionRunId : null;

  if (!executionRunId) {
    throw new BridgeCloudError(
      "The execution command is missing its history reference.",
      422,
    );
  }

  const prisma = transaction;
  const binding = await prisma.executionRun.findUniqueOrThrow({ where: { id: executionRunId }, include: { connectedLibrary: true } });
  if (binding.connectedLibrary.bridgeDeviceId) await prisma.$queryRaw`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${binding.connectedLibrary.bridgeDeviceId} FOR SHARE`;
  await prisma.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${binding.connectedLibraryId} FOR UPDATE`;
  await prisma.$queryRaw(Prisma.sql`SELECT id FROM "ExecutionRun" WHERE id = ${executionRunId} FOR UPDATE`);
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

  if (!["PENDING", "RUNNING"].includes(run.status)) {
    const stored = await prisma.executionRun.findUniqueOrThrow({ include: { actions: true, undoRuns: { include: { actions: true } } }, where: { id: run.id } });
    return summarizeExecutionRun(stored) as unknown as BridgeJson;
  }
  const result = objectValue(input.report.result);
  const resultActions = physicalResultIndex(result?.actions, run.actions.map((action) => ({ ...action,
    sourceRelativePath: action.sourceRelativePath || null, checksum: action.sourceChecksumBefore })));
  const completedAt = new Date();
  let completedActions = 0;
  let failedActions = 0;
  let pendingActions = 0;

  for (const action of run.actions) {
    const resultAction: Record<string, unknown> | undefined = action.status === "COMPLETED" ? { actionId: action.id, status: "COMPLETED",
      sourceChecksumBefore: action.sourceChecksumBefore, destinationChecksumAfter: action.destinationChecksumAfter,
      safeErrorCategory: action.safeErrorCategory, createdFilesystemItem: action.createdFilesystemItem } : resultActions.get(action.id);
    const actionStatus = physicalResultState(resultAction);

    if (actionStatus === "COMPLETED") {
      completedActions += 1;
    } else if (actionStatus === "PENDING") {
      pendingActions += 1;
    } else {
      failedActions += 1;
    }

    if (action.status === "COMPLETED") continue;

    await prisma.executionAction.update({
      data: {
        completedAt: actionStatus === "PENDING" ? null : completedAt,
        createdFilesystemItem: actionStatus === "COMPLETED" && resultAction?.createdFilesystemItem === true,
        destinationChecksumAfter:
          actionStatus === "COMPLETED" && typeof resultAction?.destinationChecksumAfter === "string"
            ? resultAction.destinationChecksumAfter
            : null,
        safeErrorCategory:
          actionStatus === "PENDING" ? "COMMAND_RECOVERY_REQUIRED" : typeof resultAction?.safeErrorCategory === "string"
            ? resultAction.safeErrorCategory
            : actionStatus === "COMPLETED"
              ? null
              : input.report.safeErrorCategory ?? "EXECUTION_BLOCKED",
        sourceChecksumBefore: action.sourceChecksumBefore,
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
          ...(action.sourceScannedFileId ? { id: action.sourceScannedFileId } : {}),
          checksum: action.sourceChecksumBefore, relativePath: action.sourceRelativePath,
          sessionId: run.organizationPlan.scanSessionId,
        },
      });
    }
  }

  const changed = run.actions.some((action) => action.status !== "COMPLETED" && physicalResultChanged(action.actionType, resultActions.get(action.id)));
  if (changed) await requireExecutionReconciliation(prisma, run.id);
  else if (pendingActions && !["REQUIRED", "IN_PROGRESS"].includes(run.reconciliationStatus)) await prisma.executionRun.update({ where: { id: run.id }, data: { reconciliationStatus: "INSPECTION_REQUIRED" } });
  else if (!pendingActions && run.reconciliationStatus === "INSPECTION_REQUIRED") await prisma.executionRun.update({ where: { id: run.id }, data: { reconciliationStatus: "NOT_REQUESTED" } });
  const status: ExecutionStatus = pendingActions > 0 ? "RUNNING" : completedActions === run.totalActions && failedActions === 0 && run.totalActions > 0
    ? "COMPLETED" : completedActions > 0 ? "PARTIALLY_COMPLETED" : "FAILED";
  const durationMs = Math.max(0, completedAt.getTime() - run.startedAt.getTime());

  await prisma.executionRun.update({
      data: {
        completedActions: completedActions + failedActions,
        completedAt: pendingActions ? null : completedAt,
        durationMs,
        errorCategory:
          status === "COMPLETED" ? null : "REMOTE_EXECUTION_INCOMPLETE",
        failedActions,
        safeErrorCategory:
          pendingActions ? "COMMAND_RECOVERY_REQUIRED" : status === "COMPLETED"
            ? null
            : input.report.safeErrorCategory ??
              (typeof result?.safeErrorCategory === "string"
                ? result.safeErrorCategory
                : "EXECUTION_BLOCKED"),
        status,
        successfulActions: completedActions,
      },
      where: { id: run.id },
    });
  await prisma.organizationPlan.update({
      data: {
        status:
          completedActions > 0 || status === "COMPLETED"
            ? "EXECUTED"
            : run.organizationPlan.status,
      },
      where: { id: run.organizationPlanId },
    });
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
