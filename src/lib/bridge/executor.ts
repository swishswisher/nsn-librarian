import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, rename } from "node:fs/promises";
import path from "node:path";

import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import { recordExecutionNotebookEntry } from "@/lib/library/notebook";

import {
  executeLocalBridgeActions,
  previewLocalBridgeExecution,
  takeLocalBridgeWatcherEvents,
  type LocalBridgeExecutionActionInput,
} from "./local-bridge-client";
import { isCurrentRecommendationGeneration } from "./recommendation-generation";
import type {
  BridgeExecutionIssue,
  BridgeExecutionIssueCategory,
  BridgeExecutionPreview,
  BridgeExecutionPreviewAction,
  BridgeExecutionRunSummary,
  BridgeUndoActionType,
  BridgeUndoRunSummary,
  BridgeOrganizationPlan,
  BridgeOrganizationPlanAction,
  BridgeOrganizationPlanHistoryItem,
  BridgeOrganizationPlanSkippedItem,
  BridgeOrganizationPlanWarning,
  ExecutionStatus,
  OrganizationPlanActionType,
  OrganizationPlanStatus,
  UndoStatus,
} from "./types";

export class BridgeExecutorError extends Error {
  statusCode: number;
  preview?: BridgeExecutionPreview;

  constructor(
    message: string,
    statusCode = 400,
    preview?: BridgeExecutionPreview,
  ) {
    super(message);
    this.name = "BridgeExecutorError";
    this.statusCode = statusCode;
    this.preview = preview;
  }
}

class BridgeActionExecutionError extends Error {
  category: BridgeExecutionIssueCategory;

  constructor(category: BridgeExecutionIssueCategory, message: string) {
    super(message);
    this.name = "BridgeActionExecutionError";
    this.category = category;
  }
}

type StoredExecutionAction = {
  id: string;
  actionType: string;
  sourceRelativePath: string;
  destinationRelativePath: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  safeErrorCategory: string | null;
  sourceChecksumBefore: string | null;
  destinationChecksumAfter: string | null;
  sequence: number;
  createdFilesystemItem: boolean;
};

type StoredUndoAction = {
  id: string;
  originalExecutionActionId: string;
  actionType: string;
  sourceRelativePath: string;
  destinationRelativePath: string;
  sequence: number;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  safeErrorCategory: string | null;
};

type StoredUndoRun = {
  id: string;
  executionRunId: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  totalActions: number;
  completedActions: number;
  failedActions: number;
  durationMs: number | null;
  safeErrorCategory: string | null;
  actions: StoredUndoAction[];
};

type StoredExecutionRun = {
  id: string;
  organizationPlanId: string;
  connectedLibraryId: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  totalActions: number;
  completedActions: number;
  successfulActions: number;
  failedActions: number;
  durationMs: number | null;
  safeErrorCategory: string | null;
  errorCategory: string | null;
  bridgeRootId: string | null;
  permissionSnapshot: Prisma.JsonValue | null;
  reconciliationStatus: string;
  actions: StoredExecutionAction[];
  undoRuns?: StoredUndoRun[];
};

type StoredPlanForExecution = {
  id: string;
  scanSessionId: string;
  connectedLibraryId: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  status: string;
  totalActions: number;
  approvedActions: number;
  modifiedActions: number;
  rejectedActions: number;
  unchangedActions: number;
  actions: Prisma.JsonValue;
  warnings: Prisma.JsonValue;
  skippedItems: Prisma.JsonValue;
  history: Prisma.JsonValue;
  scanSession: {
    connectedFolder: {
      bridgeRootId: string | null;
      createFolderPermission: boolean;
      id: string;
      isEnabled: boolean;
      localPath: string;
      moveFilePermission: boolean;
      readPermission: boolean;
      renameFilePermission: boolean;
      status: string;
      watchPermission: boolean;
    };
    organizationSuggestions: {
      id: string;
      invalidatedAt: Date | null;
      recommendationGenerationId: string;
      recommendationGenerationVersion: string;
      scannedFile: StoredScannedFileForExecution;
    }[];
    scannedFiles: StoredScannedFileForExecution[];
  };
  executionRuns: StoredExecutionRun[];
};

type StoredScannedFileForExecution = {
  id: string;
  localPath: string;
  relativePath: string;
  checksum: string | null;
  sizeBytes: bigint | null;
  lastModified: Date | null;
};

type ExecutableAction = {
  action: BridgeOrganizationPlanAction;
  actionType:
    | "CREATE_FOLDER"
    | "MOVE_FILE"
    | "RENAME_FILE"
    | "MOVE_AND_RENAME_FILE";
  destinationRelativePath: string;
  scannedFile: StoredScannedFileForExecution | null;
  sequence: number;
  sourceRelativePath: string | null;
};

type ResolvedExecutableAction = ExecutableAction & {
  destinationPath: string;
  sourcePath: string | null;
};

const executionStatuses = new Set<ExecutionStatus>([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "BLOCKED",
]);
const undoStatuses = new Set<UndoStatus>([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "BLOCKED",
]);
const organizationPlanStatuses = new Set<OrganizationPlanStatus>([
  "DRAFT",
  "READY_FOR_EXECUTION",
  "EXECUTED",
  "CANCELLED",
]);
const supportedActionTypes = new Set<OrganizationPlanActionType>([
  "CREATE_FOLDER",
  "MOVE_FILE",
  "RENAME_FILE",
  "MOVE_AND_RENAME_FILE",
]);
const selectableFileActionTypes = new Set<OrganizationPlanActionType>([
  "MOVE_FILE",
  "RENAME_FILE",
  "MOVE_AND_RENAME_FILE",
]);
const executionOrder: Record<ExecutableAction["actionType"], number> = {
  CREATE_FOLDER: 10,
  MOVE_FILE: 30,
  RENAME_FILE: 40,
  MOVE_AND_RENAME_FILE: 50,
};
function pathKey(value: string) {
  const normalized = path.normalize(value);

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: Prisma.JsonValue): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asPlanActions(value: Prisma.JsonValue): BridgeOrganizationPlanAction[] {
  return asArray(value).filter(
    (item): item is BridgeOrganizationPlanAction =>
      isRecord(item) &&
      typeof item.id === "string" &&
      typeof item.order === "number" &&
      typeof item.actionType === "string",
  );
}

function asPlanWarnings(value: Prisma.JsonValue): BridgeOrganizationPlanWarning[] {
  return asArray(value).filter(
    (item): item is BridgeOrganizationPlanWarning =>
      isRecord(item) &&
      typeof item.id === "string" &&
      typeof item.warningType === "string" &&
      typeof item.title === "string",
  );
}

function asSkippedItems(
  value: Prisma.JsonValue,
): BridgeOrganizationPlanSkippedItem[] {
  return asArray(value).filter(
    (item): item is BridgeOrganizationPlanSkippedItem =>
      isRecord(item) &&
      typeof item.id === "string" &&
      typeof item.suggestionId === "string",
  );
}

function asHistoryItems(
  value: Prisma.JsonValue,
): BridgeOrganizationPlanHistoryItem[] {
  return asArray(value).filter(
    (item): item is BridgeOrganizationPlanHistoryItem =>
      isRecord(item) &&
      typeof item.id === "string" &&
      typeof item.at === "string" &&
      typeof item.label === "string",
  );
}

function normalizeExecutionStatus(value: string): ExecutionStatus {
  return executionStatuses.has(value as ExecutionStatus)
    ? (value as ExecutionStatus)
    : "FAILED";
}

function normalizeUndoStatus(value: string): UndoStatus {
  return undoStatuses.has(value as UndoStatus)
    ? (value as UndoStatus)
    : "FAILED";
}

function normalizeUndoActionType(value: string): BridgeUndoActionType {
  if (
    value === "REMOVE_FOLDER" ||
    value === "MOVE_FILE" ||
    value === "RENAME_FILE"
  ) {
    return value;
  }

  return "MOVE_FILE";
}

function normalizePlanStatus(value: string): OrganizationPlanStatus {
  return organizationPlanStatuses.has(value as OrganizationPlanStatus)
    ? (value as OrganizationPlanStatus)
    : "DRAFT";
}

function actionIsSelectableForExecution(action: BridgeOrganizationPlanAction) {
  return (
    selectableFileActionTypes.has(action.actionType) &&
    typeof action.sourceRelativePath === "string" &&
    action.sourceRelativePath.trim().length > 0 &&
    typeof action.plannedRelativePath === "string" &&
    action.plannedRelativePath.trim().length > 0 &&
    isCurrentRecommendationGeneration(
      action.recommendationGenerationVersion ?? "",
    )
  );
}

function actionIsSelectedFileAction(action: BridgeOrganizationPlanAction) {
  return actionIsSelectableForExecution(action) && action.selectedForExecution === true;
}

function actionIsRequiredDependency(action: BridgeOrganizationPlanAction) {
  return (
    action.actionType === "CREATE_FOLDER" &&
    action.requiredForSelectedActions === true &&
    isCurrentRecommendationGeneration(
      action.recommendationGenerationVersion ?? "",
    )
  );
}

function actionIsExecutableInSavedPlan(action: BridgeOrganizationPlanAction) {
  return actionIsSelectedFileAction(action) || actionIsRequiredDependency(action);
}

function actionIsReviewOnly(action: BridgeOrganizationPlanAction) {
  return (
    action.actionType === "WEBSITE_ACTION" ||
    action.actionType === "REVIEW_ONLY" ||
    (action.actionType === "CREATE_FOLDER" && !actionIsRequiredDependency(action)) ||
    !supportedActionTypes.has(action.actionType)
  );
}

function planSummary(
  actions: BridgeOrganizationPlanAction[],
  warnings: BridgeOrganizationPlanWarning[],
) {
  const selectedFileActions = actions.filter(actionIsSelectedFileAction);
  const executableActions = actions.filter(actionIsExecutableInSavedPlan);
  const reviewOnlyActions = actions.filter(actionIsReviewOnly);
  const selectableActions = actions.filter(actionIsSelectableForExecution);

  return {
    blockingWarnings: warnings.length,
    estimatedOperations: executableActions.length,
    filesAffected: new Set(
      selectedFileActions
        .map((action) => action.sourceRelativePath)
        .filter((value) => value.trim().length > 0),
    ).size,
    foldersAffected: new Set(
      executableActions
        .map((action) => action.plannedFolderPath)
        .filter((value): value is string => Boolean(value)),
    ).size,
    moves: selectedFileActions.filter(
      (action) =>
        action.actionType === "MOVE_FILE" ||
        action.actionType === "MOVE_AND_RENAME_FILE",
    ).length,
    newFolders: executableActions.filter(
      (action) => action.actionType === "CREATE_FOLDER",
    ).length,
    renames: selectedFileActions.filter(
      (action) =>
        action.actionType === "RENAME_FILE" ||
        action.actionType === "MOVE_AND_RENAME_FILE",
    ).length,
    requiredFolderCreations: executableActions.filter(
      (action) => action.actionType === "CREATE_FOLDER",
    ).length,
    reviewOnlyNotes: reviewOnlyActions.length,
    selectableFileActions: selectableActions.length,
    selectedFileActions: selectedFileActions.length,
    unselectedAlternatives:
      selectableActions.length - selectedFileActions.length,
    warnings: warnings.length,
  };
}

function summarizePlan(plan: StoredPlanForExecution): BridgeOrganizationPlan {
  const actions = asPlanActions(plan.actions);
  const warnings = asPlanWarnings(plan.warnings);

  return {
    actions,
    approvedActions: plan.approvedActions,
    connectedLibraryId: plan.connectedLibraryId,
    createdAt: plan.createdAt.toISOString(),
    createdBy: plan.createdBy,
    history: asHistoryItems(plan.history),
    id: plan.id,
    modifiedActions: plan.modifiedActions,
    rejectedActions: plan.rejectedActions,
    scanSessionId: plan.scanSessionId,
    skippedItems: asSkippedItems(plan.skippedItems),
    status: normalizePlanStatus(plan.status),
    summary: planSummary(actions, warnings),
    totalActions: plan.totalActions,
    unchangedActions: plan.unchangedActions,
    updatedAt: plan.updatedAt.toISOString(),
    warnings,
  };
}

export function summarizeExecutionRun(
  run: StoredExecutionRun,
): BridgeExecutionRunSummary {
  const completedActions =
    run.completedActions > 0 ? run.completedActions : run.successfulActions;
  const safeErrorCategory = run.safeErrorCategory ?? run.errorCategory;
  const undoRuns = (run.undoRuns ?? [])
    .map(summarizeUndoRunFromStored)
    .sort(
      (left, right) =>
        new Date(right.startedAt).getTime() -
        new Date(left.startedAt).getTime(),
    );

  return {
    actions: run.actions
      .map((action) => ({
        actionType: action.actionType,
        completedAt: action.completedAt?.toISOString() ?? null,
        createdFilesystemItem: action.createdFilesystemItem,
        destinationChecksumAfter: action.destinationChecksumAfter,
        destinationRelativePath: action.destinationRelativePath,
        id: action.id,
        safeErrorCategory: action.safeErrorCategory,
        sequence: action.sequence,
        sourceChecksumBefore: action.sourceChecksumBefore,
        sourceRelativePath: action.sourceRelativePath,
        startedAt: action.startedAt?.toISOString() ?? null,
        status: normalizeExecutionStatus(action.status),
      }))
      .sort((left, right) => left.sequence - right.sequence),
    completedAt: run.completedAt?.toISOString() ?? null,
    completedActions,
    durationMs: run.durationMs,
    errorCategory: run.errorCategory,
    failedActions: run.failedActions,
    bridgeRootId: run.bridgeRootId,
    connectedLibraryId: run.connectedLibraryId,
    id: run.id,
    organizationPlanId: run.organizationPlanId,
    permissionSnapshot: run.permissionSnapshot,
    reconciliationStatus: run.reconciliationStatus,
    safeErrorCategory,
    startedAt: run.startedAt.toISOString(),
    status: normalizeExecutionStatus(run.status),
    successfulActions: run.successfulActions,
    totalActions: run.totalActions,
    undoRuns,
    latestUndoRun: undoRuns[0] ?? null,
  };
}

function summarizeUndoRunFromStored(run: StoredUndoRun): BridgeUndoRunSummary {
  return {
    actions: run.actions
      .map((action) => ({
        actionType: normalizeUndoActionType(action.actionType),
        completedAt: action.completedAt?.toISOString() ?? null,
        destinationRelativePath: action.destinationRelativePath,
        id: action.id,
        originalExecutionActionId: action.originalExecutionActionId,
        safeErrorCategory: action.safeErrorCategory,
        sequence: action.sequence,
        sourceRelativePath: action.sourceRelativePath,
        startedAt: action.startedAt?.toISOString() ?? null,
        status: normalizeUndoStatus(action.status),
      }))
      .sort((left, right) => left.sequence - right.sequence),
    completedActions: run.completedActions,
    completedAt: run.completedAt?.toISOString() ?? null,
    durationMs: run.durationMs,
    executionRunId: run.executionRunId,
    failedActions: run.failedActions,
    id: run.id,
    safeErrorCategory: run.safeErrorCategory,
    startedAt: run.startedAt.toISOString(),
    status: normalizeUndoStatus(run.status),
    totalActions: run.totalActions,
  };
}

function folderFromRelativePath(relativePath: string) {
  const directory = path.posix.dirname(relativePath);

  return directory === "." ? "" : directory;
}

function isInsideRoot(rootPath: string, filePath: string) {
  const relativePath = path.relative(rootPath, filePath);

  return (
    relativePath.length > 0 &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  );
}

function issue(
  category: BridgeExecutionIssueCategory,
  title: string,
  description: string,
  affectedActionIds: string[] = [],
): BridgeExecutionIssue {
  return {
    affectedActionIds,
    category,
    description,
    id: `execution-${category.toLowerCase()}-${[
      title,
      ...affectedActionIds,
    ]
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}`,
    severity: "BLOCKING",
    title,
  };
}

function executableActionsFor(
  plan: StoredPlanForExecution,
  issues: BridgeExecutionIssue[],
) {
  const suggestionsById = new Map(
    plan.scanSession.organizationSuggestions.map((suggestion) => [
      suggestion.id,
      suggestion,
    ]),
  );
  const actions = asPlanActions(plan.actions);
  const selectedActions = actions.filter(actionIsExecutableInSavedPlan);

  for (const action of actions) {
    if (
      action.selectedForExecution === true &&
      !actionIsSelectableForExecution(action) &&
      !actionIsRequiredDependency(action)
    ) {
      issues.push(
        issue(
          "UNSUPPORTED_ACTION",
          "This action cannot be selected for execution",
          "Only move and rename file recommendations can be selected for filesystem organization.",
          [action.id],
        ),
      );
    }
  }

  return selectedActions
    .map((action): ExecutableAction | null => {
      if (!supportedActionTypes.has(action.actionType)) {
        issues.push(
          issue(
            "UNSUPPORTED_ACTION",
            "This action is not executable yet",
            "Only create folder, move file, rename file, and move-and-rename file actions can execute in this milestone.",
            [action.id],
          ),
        );
        return null;
      }

      if (action.actionType === "CREATE_FOLDER") {
        if (!action.plannedFolderPath) {
          issues.push(
            issue(
              "INVALID_PATH",
              "A folder action is missing its destination",
              "The Bridge needs a relative folder path before it can create a folder.",
              [action.id],
            ),
          );
          return null;
        }

        return {
          action,
          actionType: "CREATE_FOLDER",
          destinationRelativePath: action.plannedFolderPath,
          scannedFile: null,
          sequence: 0,
          sourceRelativePath: null,
        };
      }

      if (!action.plannedRelativePath) {
        issues.push(
          issue(
            "INVALID_PATH",
            "A file action is missing its destination",
            "The Bridge needs a relative destination path before it can move or rename a file.",
            [action.id],
          ),
        );
        return null;
      }

      if (
        action.actionType !== "MOVE_FILE" &&
        action.actionType !== "RENAME_FILE" &&
        action.actionType !== "MOVE_AND_RENAME_FILE"
      ) {
        issues.push(
          issue(
            "UNSUPPORTED_ACTION",
            "This action is not executable yet",
            "Only create folder, move file, rename file, and move-and-rename file actions can execute in this milestone.",
            [action.id],
          ),
        );
        return null;
      }

      const suggestion = suggestionsById.get(action.suggestionId) ?? null;

      if (!suggestion) {
        issues.push(
          issue(
            "VALIDATION_FAILED",
            "The source recommendation could not be verified",
            "The Bridge could not match this planned action to its reviewed recommendation.",
            [action.id],
          ),
        );
        return null;
      }

      if (
        suggestion.invalidatedAt ||
        !isCurrentRecommendationGeneration(
          suggestion.recommendationGenerationVersion,
        )
      ) {
        issues.push(
          issue(
            "VALIDATION_FAILED",
            "The source recommendation is no longer current",
            "Regenerate recommendations and rebuild the Organization Plan before executing this action.",
            [action.id],
          ),
        );
        return null;
      }

      if (
        action.recommendationGenerationId !==
          suggestion.recommendationGenerationId ||
        action.recommendationGenerationVersion !==
          suggestion.recommendationGenerationVersion
      ) {
        issues.push(
          issue(
            "VALIDATION_FAILED",
            "The plan does not match the current recommendation pass",
            "The Bridge refused a planned action whose recommendation generation no longer matches the reviewed recommendation.",
            [action.id],
          ),
        );
        return null;
      }

      const snapshot = action.sourceSnapshot;
      const scannedFile = suggestion.scannedFile;

      if (action.sourceRelativePath !== scannedFile.relativePath) {
        issues.push(
          issue(
            "VALIDATION_FAILED",
            "The planned source does not match the scanned file record",
            "The Bridge refused a planned action whose source path no longer matches the reviewed recommendation.",
            [action.id],
          ),
        );
        return null;
      }

      if (
        !snapshot ||
        snapshot.scannedFileId !== scannedFile.id ||
        snapshot.relativePath !== scannedFile.relativePath
      ) {
        issues.push(
          issue(
            "VALIDATION_FAILED",
            "The plan source does not match the scanned file record",
            "The Bridge refused a planned action whose source identity changed after the plan was built.",
            [action.id],
          ),
        );
        return null;
      }

      if (
        snapshot.checksum !== scannedFile.checksum ||
        snapshot.sizeBytes !== (scannedFile.sizeBytes?.toString() ?? null) ||
        snapshot.lastModified !==
          (scannedFile.lastModified?.toISOString() ?? null)
      ) {
        issues.push(
          issue(
            "CHANGED_SOURCE",
            "A source file changed after the plan was built",
            `${action.sourceRelativePath} no longer matches the source snapshot used to build this plan.`,
            [action.id],
          ),
        );
        return null;
      }

      return {
        action,
        actionType: action.actionType,
        destinationRelativePath: action.plannedRelativePath,
        scannedFile,
        sequence: 0,
        sourceRelativePath: action.sourceRelativePath,
      };
    })
    .filter((action): action is ExecutableAction => action !== null)
    .sort((left, right) => {
      const orderDifference =
        executionOrder[left.actionType] - executionOrder[right.actionType];

      if (orderDifference !== 0) {
        return orderDifference;
      }

      return (
        left.destinationRelativePath.localeCompare(
          right.destinationRelativePath,
        ) || left.action.id.localeCompare(right.action.id)
      );
    })
    .map((action, index) => ({
      ...action,
      sequence: index + 1,
    }));
}

function validateExecutableActionSet(
  actions: ExecutableAction[],
  issues: BridgeExecutionIssue[],
) {
  const sources = new Map<string, Array<{ id: string; destination: string }>>();
  const destinations = new Map<string, string[]>();

  for (const action of actions) {
    destinations.set(action.destinationRelativePath, [
      ...(destinations.get(action.destinationRelativePath) ?? []),
      action.action.id,
    ]);

    if (action.sourceRelativePath) {
      sources.set(action.sourceRelativePath, [
        ...(sources.get(action.sourceRelativePath) ?? []),
        {
          destination: action.destinationRelativePath,
          id: action.action.id,
        },
      ]);
    }
  }

  for (const [source, entries] of sources.entries()) {
    const destinationsForSource = [
      ...new Set(entries.map((entry) => entry.destination)),
    ];

    if (destinationsForSource.length > 1) {
      issues.push(
        issue(
          "DUPLICATE_SOURCE",
          "One source file has more than one destination",
          `${source} is selected for more than one destination. Choose one destination before approval or execution.`,
          entries.map((entry) => entry.id),
        ),
      );
    }
  }

  for (const [destination, actionIds] of destinations.entries()) {
    if (actionIds.length > 1) {
      issues.push(
        issue(
          "DUPLICATE_DESTINATION",
          "Multiple actions share one destination",
          `${destination} is used by more than one selected action.`,
          actionIds,
        ),
      );
    }
  }
}

function previewActionFor(
  action: ExecutableAction,
): BridgeExecutionPreviewAction {
  return {
    actionType: action.actionType,
    description:
      action.actionType === "CREATE_FOLDER"
        ? "Create folder"
        : action.actionType === "MOVE_FILE"
          ? "Move file"
          : action.actionType === "RENAME_FILE"
            ? "Rename file"
            : "Move and rename file",
    destinationRelativePath: action.destinationRelativePath,
    id: action.action.id,
    sequence: action.sequence,
    sourceRelativePath: action.sourceRelativePath,
  };
}

function localBridgeActionFor(
  action: ExecutableAction,
): LocalBridgeExecutionActionInput {
  return {
    actionType: action.actionType,
    destinationRelativePath: action.destinationRelativePath,
    id: action.action.id,
    sourceChecksum: action.scannedFile?.checksum ?? null,
    sourceLastModified: action.scannedFile?.lastModified?.toISOString() ?? null,
    sourceRelativePath: action.sourceRelativePath,
    sourceSizeBytes: action.scannedFile?.sizeBytes?.toString() ?? null,
  };
}

function localBridgeIssue(
  issueInput: {
    actionId: string | null;
    category: string;
    message: string;
  },
): BridgeExecutionIssue {
  const category = bridgeExecutionIssueCategory(issueInput.category);
  const affectedActionIds = issueInput.actionId ? [issueInput.actionId] : [];

  return issue(
    category,
    "The local Bridge blocked this action",
    issueInput.message,
    affectedActionIds,
  );
}

function bridgeExecutionIssueCategory(
  value: string,
): BridgeExecutionIssueCategory {
  const knownCategories = new Set<BridgeExecutionIssueCategory>([
    "PLAN_NOT_READY",
    "PLAN_EMPTY",
    "PLAN_ALREADY_EXECUTED",
    "UNSUPPORTED_ACTION",
    "PATH_OUTSIDE_ROOT",
    "INVALID_PATH",
    "DUPLICATE_SOURCE",
    "DUPLICATE_DESTINATION",
    "DESTINATION_CONFLICT",
    "MISSING_PARENT",
    "MISSING_SOURCE",
    "CHANGED_SOURCE",
    "SOURCE_NOT_FILE",
    "ROOT_MISMATCH",
    "VALIDATION_FAILED",
    "FILESYSTEM_OPERATION_FAILED",
    "UNDO_ALREADY_COMPLETED",
    "UNDO_RUNNING",
    "UNDO_NOT_AVAILABLE",
    "FOLDER_NOT_EMPTY",
    "FOLDER_NOT_CREATED_BY_BRIDGE",
    "DUPLICATE_UNDO_DESTINATION",
    "PERMISSION_DENIED",
    "BRIDGE_UNAVAILABLE",
    "EXECUTION_BLOCKED",
  ]);

  return knownCategories.has(value as BridgeExecutionIssueCategory)
    ? (value as BridgeExecutionIssueCategory)
    : "VALIDATION_FAILED";
}

async function checksumFile(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function fileMetadataMatches(
  scannedFile: StoredScannedFileForExecution,
  stats: Awaited<ReturnType<typeof lstat>>,
) {
  if (scannedFile.sizeBytes !== null && BigInt(stats.size) !== scannedFile.sizeBytes) {
    return false;
  }

  if (!scannedFile.lastModified) {
    return scannedFile.sizeBytes !== null;
  }

  return Math.abs(stats.mtime.getTime() - scannedFile.lastModified.getTime()) <= 1000;
}

async function validateSourceFile(
  rootPath: string,
  action: ResolvedExecutableAction,
  issues: BridgeExecutionIssue[],
) {
  if (!action.sourceRelativePath || !action.sourcePath) {
    issues.push(
      issue(
        "INVALID_PATH",
        "A source path is missing",
        "The Bridge needs a relative source path before it can move or rename a file.",
        [action.action.id],
      ),
    );
    return;
  }

  const scannedFile = action.scannedFile;

  if (!scannedFile) {
    issues.push(
      issue(
        "VALIDATION_FAILED",
        "A source file could not be matched to the folder scan record",
        "The Bridge could not verify this file against the scan session.",
        [action.action.id],
      ),
    );
    return;
  }

  if (pathKey(action.sourcePath) !== pathKey(scannedFile.localPath)) {
    issues.push(
      issue(
        "VALIDATION_FAILED",
        "The source file no longer matches the folder scan record",
        "The recorded scan path does not match the planned source path.",
        [action.action.id],
      ),
    );
    return;
  }

  let stats: Awaited<ReturnType<typeof lstat>>;

  try {
    stats = await lstat(action.sourcePath);
  } catch {
    issues.push(
      issue(
        "MISSING_SOURCE",
        "A source file is missing",
        `${action.sourceRelativePath} could not be found.`,
        [action.action.id],
      ),
    );
    return;
  }

  if (!stats.isFile() || stats.isSymbolicLink()) {
    issues.push(
      issue(
        "SOURCE_NOT_FILE",
        "A source item is not a regular file",
        `${action.sourceRelativePath} is not a regular file the Bridge can move or rename.`,
        [action.action.id],
      ),
    );
    return;
  }

  if (scannedFile.checksum) {
    const currentChecksum = await checksumFile(action.sourcePath);

    if (currentChecksum !== scannedFile.checksum) {
      issues.push(
        issue(
          "CHANGED_SOURCE",
          "A source file changed after scanning",
          `${action.sourceRelativePath} no longer matches its scanned checksum.`,
          [action.action.id],
        ),
      );
    }
    return;
  }

  if (!fileMetadataMatches(scannedFile, stats)) {
    issues.push(
      issue(
        "CHANGED_SOURCE",
        "A source file changed after scanning",
        `${action.sourceRelativePath} no longer matches its scanned file metadata.`,
        [action.action.id],
      ),
    );
  }

  if (!isInsideRoot(rootPath, action.sourcePath)) {
    issues.push(
      issue(
        "PATH_OUTSIDE_ROOT",
        "A source path is outside the connected folder",
        "The Bridge refused a source path that is not inside the connected folder.",
        [action.action.id],
      ),
    );
  }
}

async function pathExists(filePath: string) {
  try {
    return await lstat(filePath);
  } catch {
    return null;
  }
}

function folderIsCoveredByCreateAction(
  parentFolder: string,
  createFolders: Set<string>,
) {
  if (!parentFolder) {
    return true;
  }

  for (const folder of createFolders) {
    if (folder === parentFolder || folder.startsWith(`${parentFolder}/`)) {
      return true;
    }
  }

  return false;
}

async function validateDestination(
  rootPath: string,
  action: ResolvedExecutableAction,
  createFolders: Set<string>,
  issues: BridgeExecutionIssue[],
) {
  const destinationStats = await pathExists(action.destinationPath);

  if (action.actionType === "CREATE_FOLDER") {
    if (destinationStats && !destinationStats.isDirectory()) {
      issues.push(
        issue(
          "DESTINATION_CONFLICT",
          "A planned folder conflicts with an existing file",
          `${action.destinationRelativePath} already exists as a file.`,
          [action.action.id],
        ),
      );
    }
    return;
  }

  if (destinationStats) {
    issues.push(
      issue(
        "DESTINATION_CONFLICT",
        "A destination already exists",
        `${action.destinationRelativePath} already exists. The Bridge will not overwrite files.`,
        [action.action.id],
      ),
    );
    return;
  }

  const parentFolder = folderFromRelativePath(action.destinationRelativePath);

  if (!parentFolder) {
    return;
  }

  const parentPath = path.dirname(action.destinationPath);
  const parentStats = await pathExists(parentPath);

  if (parentStats?.isDirectory()) {
    return;
  }

  if (folderIsCoveredByCreateAction(parentFolder, createFolders)) {
    return;
  }

  issues.push(
    issue(
      "MISSING_PARENT",
      "A destination folder is missing",
      `${parentFolder} is not present and is not created by this plan.`,
      [action.action.id],
    ),
  );
}

function classifyIssues(issues: BridgeExecutionIssue[]) {
  const conflicts = issues.filter(
    (item) =>
      item.category === "DESTINATION_CONFLICT" ||
      item.category === "DUPLICATE_DESTINATION" ||
      item.category === "DUPLICATE_SOURCE" ||
      item.category === "MISSING_PARENT",
  );
  const missingFiles = issues.filter(
    (item) => item.category === "MISSING_SOURCE",
  );
  const changedFiles = issues.filter(
    (item) => item.category === "CHANGED_SOURCE",
  );

  return {
    blockingIssues: issues.filter((item) => item.severity === "BLOCKING"),
    changedFiles,
    conflicts,
    missingFiles,
    warnings: issues.filter((item) => item.severity === "WARNING"),
  };
}

function firstBlockingIssue(issues: BridgeExecutionIssue[]) {
  return issues.find((item) => item.severity === "BLOCKING") ?? issues[0] ?? null;
}

async function assertActionStillSafe(
  rootPath: string,
  action: ResolvedExecutableAction,
  allActions: ResolvedExecutableAction[],
) {
  const issues: BridgeExecutionIssue[] = [];
  const createFolders = new Set(
    allActions
      .filter((item) => item.actionType === "CREATE_FOLDER")
      .map((item) => item.destinationRelativePath),
  );

  if (action.actionType !== "CREATE_FOLDER") {
    await validateSourceFile(rootPath, action, issues);
  }

  await validateDestination(rootPath, action, createFolders, issues);

  const blockingIssue = firstBlockingIssue(issues);

  if (blockingIssue) {
    throw new BridgeActionExecutionError(
      blockingIssue.category,
      blockingIssue.description,
    );
  }
}

async function loadPlanForExecution(planId: string) {
  const prisma = getPrismaClient();

  return prisma.organizationPlan.findUnique({
    include: {
      executionRuns: {
        include: {
          actions: {
            orderBy: {
              sequence: "asc",
            },
          },
          undoRuns: {
            include: {
              actions: {
                orderBy: {
                  sequence: "asc",
                },
              },
            },
            orderBy: {
              startedAt: "desc",
            },
          },
        },
        orderBy: {
          startedAt: "desc",
        },
      },
      scanSession: {
        select: {
          connectedFolder: {
            select: {
              bridgeDeviceId: true,
              createFolderPermission: true,
              bridgeRootId: true,
              id: true,
              isEnabled: true,
              localPath: true,
              moveFilePermission: true,
              readPermission: true,
              renameFilePermission: true,
              status: true,
              watchPermission: true,
            },
          },
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
                  localPath: true,
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
              localPath: true,
              relativePath: true,
              sizeBytes: true,
            },
          },
        },
      },
    },
    where: {
      id: planId,
    },
  });
}

function validateExecutionPermissions(
  plan: StoredPlanForExecution,
  actions: ExecutableAction[],
  issues: BridgeExecutionIssue[],
) {
  const library = plan.scanSession.connectedFolder;
  const affectedActionIds = (actionType: ExecutableAction["actionType"]) =>
    actions
      .filter((action) => action.actionType === actionType)
      .map((action) => action.action.id);

  const createFolderActionIds = affectedActionIds("CREATE_FOLDER");
  const moveFileActionIds = affectedActionIds("MOVE_FILE");
  const renameFileActionIds = affectedActionIds("RENAME_FILE");
  const moveAndRenameActionIds = affectedActionIds("MOVE_AND_RENAME_FILE");
  const allActionIds = actions.map((action) => action.action.id);

  if (!library.readPermission && allActionIds.length > 0) {
    issues.push(
      issue(
        "PERMISSION_DENIED",
        "Read permission is off",
        "Deanne has not given the Bridge permission to verify files in this connected library.",
        allActionIds,
      ),
    );
  }

  if (!library.createFolderPermission && createFolderActionIds.length > 0) {
    issues.push(
      issue(
        "PERMISSION_DENIED",
        "Create folder permission is off",
        "Deanne has not given the Bridge permission to create folders in this connected library.",
        createFolderActionIds,
      ),
    );
  }

  if (
    !library.moveFilePermission &&
    (moveFileActionIds.length > 0 || moveAndRenameActionIds.length > 0)
  ) {
    issues.push(
      issue(
        "PERMISSION_DENIED",
        "Move file permission is off",
        "Deanne has not given the Bridge permission to move files in this connected library.",
        [...moveFileActionIds, ...moveAndRenameActionIds],
      ),
    );
  }

  if (
    !library.renameFilePermission &&
    (renameFileActionIds.length > 0 || moveAndRenameActionIds.length > 0)
  ) {
    issues.push(
      issue(
        "PERMISSION_DENIED",
        "Rename file permission is off",
        "Deanne has not given the Bridge permission to rename files in this connected library.",
        [...renameFileActionIds, ...moveAndRenameActionIds],
      ),
    );
  }
}

function priorExecutionBlocks(plan: StoredPlanForExecution) {
  return plan.executionRuns.find(
    (run) =>
      run.status === "RUNNING" ||
      run.status === "COMPLETED" ||
      run.status === "PARTIALLY_COMPLETED",
  );
}

function permissionSnapshotFor(plan: StoredPlanForExecution) {
  const library = plan.scanSession.connectedFolder;

  return {
    capturedAt: new Date().toISOString(),
    connectedLibraryId: plan.connectedLibraryId,
    bridgeRootId: library.bridgeRootId,
    readPermission: library.readPermission,
    createFolderPermission: library.createFolderPermission,
    moveFilePermission: library.moveFilePermission,
    renameFilePermission: library.renameFilePermission,
  };
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function blockingIssueForAction(
  preview: BridgeExecutionPreview,
  actionId: string,
) {
  return (
    preview.blockingIssues.find((item) =>
      item.affectedActionIds.includes(actionId),
    ) ?? preview.blockingIssues[0] ?? null
  );
}

async function recordBlockedExecutionRun(
  plan: StoredPlanForExecution,
  preview: BridgeExecutionPreview,
) {
  const prisma = getPrismaClient();
  const now = new Date();
  const firstIssue = preview.blockingIssues[0] ?? null;
  const safeErrorCategory = firstIssue?.category ?? "EXECUTION_BLOCKED";

  return prisma.executionRun.create({
    data: {
      actions: {
        create: preview.actions.map((action) => {
          const actionIssue = blockingIssueForAction(preview, action.id);

          return {
            actionType: action.actionType,
            completedAt: now,
            destinationRelativePath: action.destinationRelativePath,
            safeErrorCategory:
              actionIssue?.category ?? safeErrorCategory,
            sequence: action.sequence,
            sourceRelativePath: action.sourceRelativePath ?? "",
            startedAt: now,
            status: "BLOCKED",
          };
        }),
      },
      bridgeRootId: plan.scanSession.connectedFolder.bridgeRootId,
      completedAt: now,
      connectedLibraryId: plan.connectedLibraryId,
      durationMs: 0,
      errorCategory: safeErrorCategory,
      failedActions: preview.actions.length,
      organizationPlanId: plan.id,
      permissionSnapshot: jsonInput(permissionSnapshotFor(plan)),
      reconciliationStatus: "BLOCKED",
      safeErrorCategory,
      startedAt: now,
      status: "BLOCKED",
      totalActions: preview.actions.length,
    },
    include: {
      actions: {
        orderBy: {
          sequence: "asc",
        },
      },
    },
  });
}

async function buildExecutionPreview(
  plan: StoredPlanForExecution,
  options: { allowDraft?: boolean } = {},
): Promise<{
  preview: BridgeExecutionPreview;
  resolvedActions: ResolvedExecutableAction[];
  rootPath: string;
}> {
  const issues: BridgeExecutionIssue[] = [];
  const planActions = asPlanActions(plan.actions);
  const priorBlockingRun = priorExecutionBlocks(plan);

  if (plan.status === "EXECUTED" || priorBlockingRun) {
    issues.push(
      issue(
        "PLAN_ALREADY_EXECUTED",
        "This plan has already been executed",
        "The Bridge will not execute the same approved plan more than once.",
      ),
    );
  } else if (
    plan.status !== "READY_FOR_EXECUTION" &&
    !(options.allowDraft && plan.status === "DRAFT")
  ) {
    issues.push(
      issue(
        "PLAN_NOT_READY",
        "This plan is not approved for execution",
        "Only plans marked ready for future execution can be executed.",
      ),
    );
  }

  if (planActions.filter(actionIsSelectedFileAction).length === 0) {
    issues.push(
      issue(
        "PLAN_EMPTY",
        "No planned actions are ready to execute",
        "Select and save at least one file action before approving or organizing files.",
      ),
    );
  }

  if (plan.connectedLibraryId !== plan.scanSession.connectedFolder.id) {
    issues.push(
      issue(
        "ROOT_MISMATCH",
        "This plan does not match its connected library",
        "The Bridge refused a plan whose scan session and connected library do not match.",
      ),
    );
  }

  const executableActions = executableActionsFor(plan, issues);
  validateExecutableActionSet(executableActions, issues);
  validateExecutionPermissions(plan, executableActions, issues);

  if (!plan.scanSession.connectedFolder.bridgeRootId) {
    issues.push(
      issue(
        "BRIDGE_UNAVAILABLE",
        "The local Bridge is not connected",
        "Reconnect this library with the NSN Bridge before organizing files.",
      ),
    );
  } else {
    try {
      const bridgePreview = await previewLocalBridgeExecution(
        plan.scanSession.connectedFolder.bridgeRootId,
        executableActions.map(localBridgeActionFor),
      );

      issues.push(...bridgePreview.issues.map(localBridgeIssue));
    } catch (error) {
      issues.push(
        issue(
          "ROOT_MISMATCH",
          "The local Bridge is unavailable",
          error instanceof Error
            ? error.message
            : "Open the NSN Bridge before previewing or executing this plan.",
        ),
      );
    }
  }

  const classified = classifyIssues(issues);
  const previewActions = executableActions.map(previewActionFor);
  const bridgeRootId = plan.scanSession.connectedFolder.bridgeRootId;

  return {
    preview: {
      actions: previewActions,
      canExecute:
        classified.blockingIssues.length === 0 && previewActions.length > 0,
      estimatedOperations: previewActions.length,
      organizationPlanId: plan.id,
      ...classified,
    },
    resolvedActions: executableActions.map((action) => ({
      ...action,
      destinationPath: action.destinationRelativePath,
      sourcePath: action.sourceRelativePath,
    })),
    rootPath: bridgeRootId ? `bridge://${bridgeRootId}` : "bridge://unavailable",
  };
}

export async function previewOrganizationPlanExecution(planId: string) {
  const plan = await loadPlanForExecution(planId);

  if (!plan) {
    throw new BridgeExecutorError(
      "The Librarian could not find that organization plan.",
      404,
    );
  }

  return (await buildExecutionPreview(plan)).preview;
}

export async function validateOrganizationPlanForApproval(planId: string) {
  const plan = await loadPlanForExecution(planId);

  if (!plan) {
    throw new BridgeExecutorError(
      "The Librarian could not find that organization plan.",
      404,
    );
  }

  return (await buildExecutionPreview(plan, { allowDraft: true })).preview;
}

function safeErrorCategory(error: unknown) {
  if (error instanceof BridgeActionExecutionError) {
    return error.category;
  }

  if (error instanceof BridgeExecutorError) {
    return "VALIDATION_FAILED";
  }

  if (error instanceof Error && error.message.includes("already exists")) {
    return "DESTINATION_CONFLICT";
  }

  return "FILESYSTEM_OPERATION_FAILED";
}

async function executeFileAction(action: ResolvedExecutableAction) {
  if (!action.sourcePath) {
    throw new BridgeActionExecutionError(
      "INVALID_PATH",
      "A source path is missing.",
    );
  }

  if (await pathExists(action.destinationPath)) {
    throw new BridgeActionExecutionError(
      "DESTINATION_CONFLICT",
      "The destination already exists.",
    );
  }

  await rename(action.sourcePath, action.destinationPath);
}

async function updateScannedFileAfterAction(action: ResolvedExecutableAction) {
  if (action.actionType === "CREATE_FOLDER" || !action.scannedFile) {
    return null;
  }

  const prisma = getPrismaClient();
  const stats = await lstat(action.destinationPath);
  const checksum = await checksumFile(action.destinationPath);

  await prisma.scannedFile.update({
    data: {
      checksum,
      lastModified: stats.mtime,
      localPath: action.destinationPath,
      relativePath: action.destinationRelativePath,
      sizeBytes: BigInt(stats.size),
    },
    where: {
      id: action.scannedFile.id,
    },
  });

  return checksum;
}

async function appendPlanExecutedHistory(plan: StoredPlanForExecution) {
  const now = new Date().toISOString();

  return [
    ...asHistoryItems(plan.history),
    {
      at: now,
      detail:
        "The Bridge executed the approved organization plan. No files were deleted or overwritten.",
      id: `history-executed-${now.replace(/[^a-z0-9]+/gi, "-")}`,
      label: "Plan executed",
    },
  ].slice(-20);
}

function monitoringPathFieldsFor(
  eventType: string,
  relativePath: string,
  executedPaths: Set<string>,
) {
  if (eventType === "FILE_DELETED" || eventType === "FOLDER_DELETED") {
    return {
      currentRelativePath: null,
      previousRelativePath: relativePath,
      wasExecutionEvent: executedPaths.has(relativePath),
    };
  }

  return {
    currentRelativePath: relativePath,
    previousRelativePath: null,
    wasExecutionEvent: executedPaths.has(relativePath),
  };
}

async function correlateBridgeWatcherEventsForExecution(
  plan: StoredPlanForExecution,
  executionRunId: string,
  actions: ResolvedExecutableAction[],
) {
  const bridgeRootId = plan.scanSession.connectedFolder.bridgeRootId;

  if (!bridgeRootId) {
    return "NOT_REQUESTED";
  }

  if (!plan.scanSession.connectedFolder.watchPermission) {
    return "COMPLETED";
  }

  const executedPaths = new Set<string>();

  for (const action of actions) {
    if (action.sourceRelativePath) {
      executedPaths.add(action.sourceRelativePath);
    }
    executedPaths.add(action.destinationRelativePath);
  }

  try {
    const events = await takeLocalBridgeWatcherEvents(bridgeRootId);
    const prisma = getPrismaClient();

    for (const event of events) {
      const pathFields = monitoringPathFieldsFor(
        event.eventType,
        event.relativePath,
        executedPaths,
      );
      const executionRunMatch = pathFields.wasExecutionEvent
        ? executionRunId
        : null;
      const eventKey = [
        plan.connectedLibraryId,
        event.eventType,
        pathFields.previousRelativePath ?? "",
        pathFields.currentRelativePath ?? "",
        executionRunMatch ?? event.id,
      ].join("\u001f");

      await prisma.monitoringEvent.upsert({
        create: {
          connectedFolderId: plan.connectedLibraryId,
          currentRelativePath: pathFields.currentRelativePath,
          detectedAt: new Date(event.detectedAt),
          eventKey,
          eventType: event.eventType,
          executionRunId: executionRunMatch,
          previousRelativePath: pathFields.previousRelativePath,
          processingStatus: executionRunMatch ? "SKIPPED" : "QUEUED",
          safeErrorCategory: executionRunMatch
            ? "NSN_EXECUTION_CORRELATED"
            : null,
          scanSessionId: plan.scanSessionId,
          stabilizedAt: new Date(event.detectedAt),
        },
        update: {
          detectedAt: new Date(event.detectedAt),
          executionRunId: executionRunMatch,
          processingStatus: executionRunMatch ? "SKIPPED" : "QUEUED",
          safeErrorCategory: executionRunMatch
            ? "NSN_EXECUTION_CORRELATED"
            : null,
          stabilizedAt: new Date(event.detectedAt),
        },
        where: {
          eventKey,
        },
      });
    }

    return "COMPLETED";
  } catch {
    return "WATCHER_UNAVAILABLE";
  }
}

export async function executeOrganizationPlan(
  planId: string,
  confirmation: string,
) {
  if (confirmation !== "EXECUTE") {
    throw new BridgeExecutorError(
      "Type EXECUTE before the Bridge can execute this plan.",
      400,
    );
  }

  const prisma = getPrismaClient();
  const plan = await loadPlanForExecution(planId);

  if (!plan) {
    throw new BridgeExecutorError(
      "The Librarian could not find that organization plan.",
      404,
    );
  }

  const { preview, resolvedActions, rootPath } = await buildExecutionPreview(plan);

  if (!preview.canExecute) {
    await recordBlockedExecutionRun(plan, preview);
    throw new BridgeExecutorError(
      "The Bridge found safety issues that must be resolved before execution.",
      422,
      preview,
    );
  }

  const executionStartedAt = new Date();
  const executionRun = await prisma.executionRun.create({
    data: {
      actions: {
        create: resolvedActions.map((action) => ({
          actionType: action.actionType,
          destinationRelativePath: action.destinationRelativePath,
          sequence: action.sequence,
          sourceChecksumBefore: action.scannedFile?.checksum ?? null,
          sourceRelativePath: action.sourceRelativePath ?? "",
          status: "PENDING",
        })),
      },
      bridgeRootId: plan.scanSession.connectedFolder.bridgeRootId,
      bridgeDeviceId: plan.scanSession.connectedFolder.bridgeDeviceId,
      connectedLibraryId: plan.connectedLibraryId,
      organizationPlanId: plan.id,
      permissionSnapshot: jsonInput(permissionSnapshotFor(plan)),
      reconciliationStatus: "PENDING",
      startedAt: executionStartedAt,
      status: "RUNNING",
      totalActions: resolvedActions.length,
    },
    include: {
      actions: {
        orderBy: {
          sequence: "asc",
        },
      },
    },
  });
  const actionRecordsBySequence = new Map(
    executionRun.actions.map((action) => [action.sequence, action]),
  );
  let completedActions = 0;
  let failedActions = 0;
  let safeRunErrorCategory: string | null = null;

  if (plan.scanSession.connectedFolder.bridgeRootId) {
    try {
      const bridgeExecution = await executeLocalBridgeActions(
        plan.scanSession.connectedFolder.bridgeRootId,
        resolvedActions.map(localBridgeActionFor),
      );
      const resultByActionId = new Map(
        bridgeExecution.actions.map((action) => [action.actionId, action]),
      );

      for (const action of resolvedActions) {
        const actionRecord = actionRecordsBySequence.get(action.sequence);
        const result = resultByActionId.get(action.action.id);

        if (!actionRecord || !result) {
          continue;
        }

        if (result.status === "PENDING") {
          continue;
        }

        await prisma.executionAction.update({
          data: {
            completedAt: new Date(),
            createdFilesystemItem:
              result.status === "COMPLETED" && result.createdFilesystemItem,
            destinationChecksumAfter: result.destinationChecksumAfter,
            safeErrorCategory: result.safeErrorCategory,
            sourceChecksumBefore:
              result.sourceChecksumBefore ?? action.scannedFile?.checksum ?? null,
            startedAt: new Date(),
            status: result.status,
          },
          where: {
            id: actionRecord.id,
          },
        });

        if (
          result.status === "COMPLETED" &&
          action.actionType !== "CREATE_FOLDER" &&
          action.scannedFile
        ) {
          await prisma.scannedFile.update({
            data: {
              lastModified: result.lastModified
                ? new Date(result.lastModified)
                : action.scannedFile.lastModified,
              localPath: `bridge://${plan.scanSession.connectedFolder.bridgeRootId}/${result.destinationRelativePath}`,
              relativePath: result.destinationRelativePath,
              checksum: result.destinationChecksumAfter ?? action.scannedFile.checksum,
              sizeBytes:
                result.sizeBytes === null
                  ? action.scannedFile.sizeBytes
                  : BigInt(result.sizeBytes),
            },
            where: {
              id: action.scannedFile.id,
            },
          });
        }
      }

      completedActions = bridgeExecution.completedActions;
      failedActions = bridgeExecution.failedActions;
      safeRunErrorCategory =
        bridgeExecution.actions.find((action) => action.safeErrorCategory)
          ?.safeErrorCategory ?? null;
    } catch (error) {
      failedActions = resolvedActions.length;
      safeRunErrorCategory = "FILESYSTEM_OPERATION_FAILED";

      await prisma.executionAction.updateMany({
        data: {
          completedAt: new Date(),
          safeErrorCategory: safeRunErrorCategory,
          startedAt: new Date(),
          status: "FAILED",
        },
        where: {
          executionRunId: executionRun.id,
        },
      });

      if (error instanceof Error) {
        safeRunErrorCategory = "VALIDATION_FAILED";
      }
    }

    const finalStatus: ExecutionStatus =
      failedActions > 0
        ? completedActions > 0
          ? "PARTIALLY_COMPLETED"
          : "FAILED"
        : "COMPLETED";
    const executionCompletedAt = new Date();
    const durationMs = Math.max(
      0,
      executionCompletedAt.getTime() - executionStartedAt.getTime(),
    );
    const watcherReconciliationStatus =
      completedActions > 0
        ? await correlateBridgeWatcherEventsForExecution(
            plan,
            executionRun.id,
            resolvedActions,
          )
        : "NOT_STARTED";
    const updatedRun = await prisma.executionRun.update({
      data: {
        completedActions,
        completedAt: executionCompletedAt,
        durationMs,
        errorCategory: safeRunErrorCategory,
        failedActions,
        reconciliationStatus:
          watcherReconciliationStatus === "COMPLETED"
            ? finalStatus === "COMPLETED"
              ? "COMPLETED"
              : "PARTIAL"
            : watcherReconciliationStatus,
        safeErrorCategory: safeRunErrorCategory,
        status: finalStatus,
        successfulActions: completedActions,
      },
      include: {
        actions: {
          orderBy: {
            sequence: "asc",
          },
        },
      },
      where: {
        id: executionRun.id,
      },
    });

    await prisma.organizationPlan.update({
      data:
        finalStatus === "COMPLETED"
          ? {
              history: JSON.parse(
                JSON.stringify(await appendPlanExecutedHistory(plan)),
              ) as Prisma.InputJsonValue,
              status: "EXECUTED",
            }
          : {},
      where: {
        id: plan.id,
      },
    });

    const updatedPlan = await loadPlanForExecution(plan.id);

    if (!updatedPlan) {
      throw new BridgeExecutorError(
        "The Librarian could not reload that organization plan.",
        404,
      );
    }

    try {
      await recordExecutionNotebookEntry(updatedRun.id);
    } catch {
      // Notebook reflections should never block execution results.
    }

    return {
      plan: summarizePlan(updatedPlan),
      preview,
      run: summarizeExecutionRun(updatedRun),
    };
  }

  for (const action of resolvedActions) {
    const actionRecord = actionRecordsBySequence.get(action.sequence);

    if (!actionRecord) {
      continue;
    }

    await prisma.executionAction.update({
      data: {
        startedAt: new Date(),
        status: "RUNNING",
      },
      where: {
        id: actionRecord.id,
      },
    });

    try {
      await assertActionStillSafe(rootPath, action, resolvedActions);
      let createdFilesystemItem = false;
      let destinationChecksumAfter: string | null = null;

      if (action.actionType === "CREATE_FOLDER") {
        const folderAlreadyExisted = Boolean(await pathExists(action.destinationPath));

        await mkdir(action.destinationPath, { recursive: true });
        createdFilesystemItem = !folderAlreadyExisted;
      } else {
        await executeFileAction(action);
        destinationChecksumAfter = await updateScannedFileAfterAction(action);
      }

      completedActions += 1;
      await prisma.executionAction.update({
        data: {
          completedAt: new Date(),
          createdFilesystemItem,
          destinationChecksumAfter,
          sourceChecksumBefore: action.scannedFile?.checksum ?? null,
          status: "COMPLETED",
        },
        where: {
          id: actionRecord.id,
        },
      });
    } catch (error) {
      failedActions += 1;
      safeRunErrorCategory = safeErrorCategory(error);
      await prisma.executionAction.update({
        data: {
          completedAt: new Date(),
          safeErrorCategory: safeRunErrorCategory,
          status: "FAILED",
        },
        where: {
          id: actionRecord.id,
        },
      });
      break;
    }
  }

  const finalStatus: ExecutionStatus =
    failedActions > 0
      ? completedActions > 0
        ? "PARTIALLY_COMPLETED"
        : "FAILED"
      : "COMPLETED";
  const executionCompletedAt = new Date();
  const durationMs = Math.max(
    0,
    executionCompletedAt.getTime() - executionStartedAt.getTime(),
  );
  const [updatedRun, updatedPlan] = await prisma.$transaction([
    prisma.executionRun.update({
      data: {
        completedActions,
        completedAt: executionCompletedAt,
        durationMs,
        errorCategory: safeRunErrorCategory,
        failedActions,
        reconciliationStatus:
          finalStatus === "COMPLETED"
            ? "COMPLETED"
            : completedActions > 0
              ? "PARTIAL"
              : "NOT_STARTED",
        safeErrorCategory: safeRunErrorCategory,
        status: finalStatus,
        successfulActions: completedActions,
      },
      include: {
        actions: {
          orderBy: {
            sequence: "asc",
          },
        },
      },
      where: {
        id: executionRun.id,
      },
    }),
    prisma.organizationPlan.update({
      data:
        finalStatus === "COMPLETED"
          ? {
              history: JSON.parse(
                JSON.stringify(await appendPlanExecutedHistory(plan)),
              ) as Prisma.InputJsonValue,
              status: "EXECUTED",
            }
          : {},
      include: {
        executionRuns: {
          include: {
            actions: {
              orderBy: {
                sequence: "asc",
              },
            },
            undoRuns: {
              include: {
                actions: {
                  orderBy: {
                    sequence: "asc",
                  },
                },
              },
              orderBy: {
                startedAt: "desc",
              },
            },
          },
          orderBy: {
            startedAt: "desc",
          },
        },
        scanSession: {
          select: {
            connectedFolder: {
              select: {
                bridgeRootId: true,
                createFolderPermission: true,
                id: true,
                isEnabled: true,
                localPath: true,
                    moveFilePermission: true,
                    readPermission: true,
                    renameFilePermission: true,
                    status: true,
                    watchPermission: true,
              },
            },
            organizationSuggestions: {
              select: {
                id: true,
                scannedFile: {
                  select: {
                    checksum: true,
                    id: true,
                    lastModified: true,
                    localPath: true,
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
                localPath: true,
                relativePath: true,
                sizeBytes: true,
              },
            },
          },
        },
      },
      where: {
        id: plan.id,
      },
    }),
  ]);

  try {
    await recordExecutionNotebookEntry(updatedRun.id);
  } catch {
    // Notebook reflections should never block execution results.
  }

  return {
    plan: summarizePlan(updatedPlan),
    preview,
    run: summarizeExecutionRun(updatedRun),
  };
}
