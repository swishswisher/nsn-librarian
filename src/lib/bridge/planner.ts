import path from "node:path";

import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import {
  recordOrganizationPlanDecisionNotebookEntry,
  recordOrganizationPlanNotebookEntry,
} from "@/lib/library/notebook";
import { getOrganizationPlanRoute } from "@/lib/library/routes";

import {
  ConnectedLibraryError,
  requireScanSessionPermission,
} from "./connected-libraries";
import {
  normalizeBridgeFileName,
  normalizeBridgeRelativePath,
  summarizeOrganizationSuggestion,
} from "./organization-suggestions";
import {
  currentRecommendationGenerationVersion,
  isCurrentRecommendationGeneration,
} from "./recommendation-generation";
import { recommendationSupportFromJson } from "./recommendation-reconciliation";
import {
  summarizeExecutionRun,
  validateOrganizationPlanForApproval,
} from "./executor";
import type {
  BridgeExecutionRunSummary,
  BridgeOrganizationPlan,
  BridgeOrganizationPlanAction,
  BridgeOrganizationPlanHistoryItem,
  BridgeOrganizationPlanPageData,
  BridgeOrganizationPlanSkippedItem,
  BridgeOrganizationPlanSummary,
  BridgeOrganizationPlanWarning,
  BridgeScanSessionSummary,
  OrganizationSuggestionCounts,
  OrganizationPlanActionType,
  OrganizationPlanStatus,
  OrganizationPlanWarningType,
  OrganizationSuggestionStatus,
  OrganizationSuggestionType,
} from "./types";

export class OrganizationPlanError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "OrganizationPlanError";
    this.statusCode = statusCode;
  }
}

async function requirePlanningPermission(scanSessionId: string) {
  try {
    await requireScanSessionPermission(
      scanSessionId,
      "organizationPlanPermission",
      "prepare Organization Plans",
    );
  } catch (error) {
    if (error instanceof ConnectedLibraryError) {
      throw new OrganizationPlanError(error.message, error.statusCode);
    }

    throw error;
  }
}

type StoredPlan = {
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
};

type StoredPlanWithExecutionRuns = StoredPlan & {
  executionRuns: Parameters<typeof summarizeExecutionRun>[0][];
};

type StoredSuggestion = {
  id: string;
  scannedFileId: string;
  scanSessionId: string;
  suggestionType: string;
  currentRelativePath: string;
  proposedRelativePath: string | null;
  proposedFileName: string | null;
  title: string;
  explanation: string;
  confidence: number;
  status: string;
  whySuggested: Prisma.JsonValue;
  supportingInformation: Prisma.JsonValue;
  recommendationGenerationId: string;
  recommendationGenerationVersion: string;
  invalidatedAt: Date | null;
  invalidatedReason: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
  scannedFile: {
    checksum: string | null;
    id: string;
    lastModified: Date | null;
    relativePath: string;
    sizeBytes: bigint | null;
  };
  revisions: {
    id: string;
    revisedRelativePath: string | null;
    revisedFileName: string | null;
    context: string | null;
    createdAt: Date;
  }[];
};

type ExistingScanFile = {
  id: string;
  relativePath: string;
};

type PlanBuildInput = {
  connectedLibraryId: string;
  scanSessionId: string;
  suggestions: StoredSuggestion[];
  scannedFiles: ExistingScanFile[];
  previousHistory: BridgeOrganizationPlanHistoryItem[];
};

const includedStatuses = new Set<OrganizationSuggestionStatus>([
  "APPROVED",
  "MODIFIED",
]);
const organizationPlanStatuses = new Set<OrganizationPlanStatus>([
  "DRAFT",
  "READY_FOR_EXECUTION",
  "EXECUTED",
  "CANCELLED",
]);
const actionOrder: Record<OrganizationPlanActionType, number> = {
  CREATE_FOLDER: 10,
  RENAME_FOLDER: 20,
  MOVE_FILE: 30,
  RENAME_FILE: 40,
  MOVE_AND_RENAME_FILE: 50,
  WEBSITE_ACTION: 60,
  REVIEW_ONLY: 70,
};
const selectableFileActionTypes = new Set<OrganizationPlanActionType>([
  "MOVE_FILE",
  "RENAME_FILE",
  "MOVE_AND_RENAME_FILE",
]);
const executableActionTypes = new Set<OrganizationPlanActionType>([
  "CREATE_FOLDER",
  ...selectableFileActionTypes,
]);
const reviewOnlyActionTypes = new Set<OrganizationPlanActionType>([
  "REVIEW_ONLY",
  "WEBSITE_ACTION",
]);
const blockingWarningTypes = new Set<OrganizationPlanWarningType>([
  "DUPLICATE_SOURCE",
  "DUPLICATE_DESTINATION",
  "FILENAME_CONFLICT",
  "FOLDER_CONFLICT",
  "INVALID_PATH",
  "MISSING_PARENT",
  "OUTSIDE_ROOT_DESTINATION",
]);

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: Prisma.JsonValue): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
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

function actionIsRequiredDependency(action: BridgeOrganizationPlanAction) {
  return (
    action.actionType === "CREATE_FOLDER" &&
    action.requiredForSelectedActions === true &&
    isCurrentRecommendationGeneration(
      action.recommendationGenerationVersion ?? "",
    )
  );
}

function actionIsSelectedFileAction(action: BridgeOrganizationPlanAction) {
  return actionIsSelectableForExecution(action) && action.selectedForExecution === true;
}

function actionIsExecutableInSavedPlan(action: BridgeOrganizationPlanAction) {
  return actionIsSelectedFileAction(action) || actionIsRequiredDependency(action);
}

function actionIsReviewOnly(action: BridgeOrganizationPlanAction) {
  return (
    reviewOnlyActionTypes.has(action.actionType) ||
    (action.actionType === "CREATE_FOLDER" && !actionIsRequiredDependency(action)) ||
    !executableActionTypes.has(action.actionType)
  );
}

function normalizePlanAction(
  action: BridgeOrganizationPlanAction,
): BridgeOrganizationPlanAction {
  const selectableForExecution = actionIsSelectableForExecution(action);
  const requiredForSelectedActions =
    action.actionType === "CREATE_FOLDER" &&
    action.requiredForSelectedActions === true;
  const selectedForExecution =
    selectableForExecution && action.selectedForExecution === true;
  const executionRole =
    requiredForSelectedActions
      ? "FOLDER_DEPENDENCY"
      : selectedForExecution
        ? "FILE_ACTION"
        : selectableForExecution
          ? "UNSELECTED_CANDIDATE"
          : "REVIEW_ONLY";

  return {
    ...action,
    executionRole,
    requiredFolderPaths: action.requiredFolderPaths ?? [],
    requiredForSelectedActions,
    selectableForExecution,
    selectedForExecution,
  };
}

function normalizePlanActions(actions: BridgeOrganizationPlanAction[]) {
  return actions.map(normalizePlanAction);
}

function storedCandidateActions(actions: BridgeOrganizationPlanAction[]) {
  return normalizePlanActions(actions).filter(
    (action) =>
      !(
        action.actionType === "CREATE_FOLDER" &&
        (action.requiredForSelectedActions || action.id.startsWith("action-folder-"))
      ),
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
      typeof item.suggestionId === "string" &&
      typeof item.reason === "string",
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

function normalizePlanStatus(value: string): OrganizationPlanStatus {
  return organizationPlanStatuses.has(value as OrganizationPlanStatus)
    ? (value as OrganizationPlanStatus)
    : "DRAFT";
}

function normalizeSuggestionStatus(value: string): OrganizationSuggestionStatus {
  if (
    value === "APPROVED" ||
    value === "MODIFIED" ||
    value === "REJECTED" ||
    value === "LEFT_UNCHANGED" ||
    value === "PENDING"
  ) {
    return value;
  }

  return "PENDING";
}

function normalizeSuggestionType(value: string): OrganizationSuggestionType {
  if (
    value === "MOVE_FILE" ||
    value === "RENAME_FILE" ||
    value === "CREATE_FOLDER" ||
    value === "GROUP_WITH_FILES" ||
    value === "POSSIBLE_DUPLICATE" ||
    value === "WEBSITE_CANDIDATE" ||
    value === "KEEP_UNCHANGED"
  ) {
    return value;
  }

  return "KEEP_UNCHANGED";
}

function organizationSuggestionCounts(
  suggestions: { status: string }[],
): OrganizationSuggestionCounts {
  const counts: OrganizationSuggestionCounts = {
    approved: 0,
    eligibleForPlanning: 0,
    leftUnchanged: 0,
    modified: 0,
    pending: 0,
    rejected: 0,
    total: 0,
  };

  for (const suggestion of suggestions) {
    counts.total += 1;

    const status = normalizeSuggestionStatus(suggestion.status);

    if (status === "APPROVED") {
      counts.approved += 1;
      counts.eligibleForPlanning += 1;
    } else if (status === "MODIFIED") {
      counts.modified += 1;
      counts.eligibleForPlanning += 1;
    } else if (status === "REJECTED") {
      counts.rejected += 1;
    } else if (status === "LEFT_UNCHANGED") {
      counts.leftUnchanged += 1;
    } else {
      counts.pending += 1;
    }
  }

  return counts;
}

function scanSessionSummary(session: {
  connectedFolderId: string;
  id: string;
  startedAt: Date;
  completedAt: Date | null;
  status: string;
  filesScanned: number;
  supportedFiles: number;
  unsupportedFiles: number;
  failedFiles: number;
  connectedFolder: {
    displayName: string;
  };
}): BridgeScanSessionSummary {
  return {
    completedAt: session.completedAt?.toISOString() ?? null,
    connectedLibraryId: session.connectedFolderId,
    failedFiles: session.failedFiles,
    folderDisplayName: session.connectedFolder.displayName,
    id: session.id,
    startedAt: session.startedAt.toISOString(),
    status:
      session.status === "PENDING" ||
      session.status === "SCANNING" ||
      session.status === "READING" ||
      session.status === "EXAMINING" ||
      session.status === "GENERATING_SUGGESTIONS" ||
      session.status === "COMPLETED" ||
      session.status === "COMPLETED_WITH_ERRORS" ||
      session.status === "FAILED"
        ? session.status
        : "FAILED",
    supportedFiles: session.supportedFiles,
    totalFiles: session.filesScanned,
    unsupportedFiles: session.unsupportedFiles,
  };
}

function stableId(prefix: string, parts: string[]) {
  return `${prefix}-${parts.join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function folderFromRelativePath(relativePath: string) {
  const directory = path.posix.dirname(relativePath);

  return directory === "." ? "" : directory;
}

function fileNameFromRelativePath(relativePath: string) {
  return path.posix.basename(relativePath);
}

function joinRelativePath(folder: string, fileName: string) {
  return normalizeBridgeRelativePath(
    folder ? path.posix.join(folder, fileName) : fileName,
  );
}

function destinationFromSuggestion(suggestion: StoredSuggestion) {
  const latestRevision = suggestion.revisions[0] ?? null;
  const currentRelativePath = normalizeBridgeRelativePath(
    suggestion.currentRelativePath,
  );
  const revisedRelativePath = latestRevision?.revisedRelativePath
    ? normalizeBridgeRelativePath(latestRevision.revisedRelativePath)
    : null;
  const revisedFileName = latestRevision?.revisedFileName
    ? normalizeBridgeFileName(latestRevision.revisedFileName)
    : null;
  const proposedRelativePath = suggestion.proposedRelativePath
    ? normalizeBridgeRelativePath(suggestion.proposedRelativePath)
    : null;
  const proposedFileName = suggestion.proposedFileName
    ? normalizeBridgeFileName(suggestion.proposedFileName)
    : null;

  if (revisedRelativePath) {
    return {
      plannedFileName:
        revisedFileName ?? fileNameFromRelativePath(revisedRelativePath),
      plannedRelativePath: revisedRelativePath,
    };
  }

  if (revisedFileName) {
    return {
      plannedFileName: revisedFileName,
      plannedRelativePath: joinRelativePath(
        folderFromRelativePath(proposedRelativePath ?? currentRelativePath),
        revisedFileName,
      ),
    };
  }

  if (proposedRelativePath) {
    return {
      plannedFileName:
        proposedFileName ?? fileNameFromRelativePath(proposedRelativePath),
      plannedRelativePath: proposedRelativePath,
    };
  }

  if (proposedFileName) {
    return {
      plannedFileName: proposedFileName,
      plannedRelativePath: joinRelativePath(
        folderFromRelativePath(currentRelativePath),
        proposedFileName,
      ),
    };
  }

  return {
    plannedFileName: fileNameFromRelativePath(currentRelativePath),
    plannedRelativePath: currentRelativePath,
  };
}

function preliminaryActionTypeForSuggestion(
  suggestionType: OrganizationSuggestionType,
): OrganizationPlanActionType {
  if (suggestionType === "CREATE_FOLDER") {
    return "CREATE_FOLDER";
  }

  if (suggestionType === "MOVE_FILE") {
    return "MOVE_FILE";
  }

  if (suggestionType === "RENAME_FILE") {
    return "RENAME_FILE";
  }

  if (suggestionType === "WEBSITE_CANDIDATE") {
    return "WEBSITE_ACTION";
  }

  return "REVIEW_ONLY";
}

function fileActionTypeForPaths(
  currentRelativePath: string,
  plannedRelativePath: string,
  fallbackType: OrganizationPlanActionType,
): OrganizationPlanActionType | null {
  const currentFolder = folderFromRelativePath(currentRelativePath);
  const plannedFolder = folderFromRelativePath(plannedRelativePath);
  const currentName = fileNameFromRelativePath(currentRelativePath);
  const plannedName = fileNameFromRelativePath(plannedRelativePath);
  const folderChanged = currentFolder !== plannedFolder;
  const nameChanged = currentName !== plannedName;

  if (!folderChanged && !nameChanged) {
    return fallbackType === "WEBSITE_ACTION" || fallbackType === "REVIEW_ONLY"
      ? fallbackType
      : null;
  }

  if (folderChanged && nameChanged) {
    return "MOVE_AND_RENAME_FILE";
  }

  if (folderChanged) {
    return "MOVE_FILE";
  }

  if (nameChanged) {
    return "RENAME_FILE";
  }

  return fallbackType;
}

function evidenceForSuggestion(suggestion: StoredSuggestion) {
  const supportingInformation = recommendationSupportFromJson(
    suggestion.supportingInformation,
  ).details;
  const whySuggested = asStringArray(suggestion.whySuggested);

  return {
    approvedMemory: supportingInformation.filter((item) =>
      item.startsWith("Approved Memory used:"),
    ),
    approvedObservation: supportingInformation.filter((item) =>
      item.startsWith("Reviewed observation used:"),
    ),
    humanModification: suggestion.revisions
      .map((revision) => revision.context)
      .filter((item): item is string => Boolean(item?.trim())),
    originatingSuggestion: [
      suggestion.title,
      suggestion.explanation,
      ...whySuggested,
    ].filter((item) => item.trim().length > 0),
  };
}

function actionFromSuggestion(
  suggestion: StoredSuggestion,
): BridgeOrganizationPlanAction | null {
  const suggestionType = normalizeSuggestionType(suggestion.suggestionType);

  if (suggestionType === "KEEP_UNCHANGED") {
    return null;
  }

  const currentRelativePath = normalizeBridgeRelativePath(
    suggestion.currentRelativePath,
  );
  const destination = destinationFromSuggestion(suggestion);
  const preliminaryActionType = preliminaryActionTypeForSuggestion(suggestionType);
  const actionType =
    preliminaryActionType === "CREATE_FOLDER" ||
    preliminaryActionType === "WEBSITE_ACTION" ||
    preliminaryActionType === "REVIEW_ONLY"
      ? preliminaryActionType
      : fileActionTypeForPaths(
          currentRelativePath,
          destination.plannedRelativePath,
          preliminaryActionType,
        );

  if (!actionType) {
    return null;
  }

  const plannedFolderPath =
    actionType === "CREATE_FOLDER"
      ? destination.plannedRelativePath
      : folderFromRelativePath(destination.plannedRelativePath);

  return {
    actionType,
    confidence: suggestion.confidence,
    evidence: evidenceForSuggestion(suggestion),
    executionRole: actionType === "WEBSITE_ACTION" || actionType === "REVIEW_ONLY"
      ? "REVIEW_ONLY"
      : actionType === "CREATE_FOLDER"
        ? "REVIEW_ONLY"
        : "UNSELECTED_CANDIDATE",
    humanEdits: suggestion.revisions.map((revision) => ({
      context: revision.context,
      createdAt: revision.createdAt.toISOString(),
      revisedFileName: revision.revisedFileName,
      revisedRelativePath: revision.revisedRelativePath,
    })),
    id: stableId("action", [suggestion.id]),
    order: 0,
    originatingSuggestion: {
      explanation: suggestion.explanation,
      status: normalizeSuggestionStatus(suggestion.status),
      title: suggestion.title,
    },
    plannedFileName:
      actionType === "CREATE_FOLDER" ? null : destination.plannedFileName,
    plannedFolderPath,
    plannedRelativePath:
      actionType === "CREATE_FOLDER"
        ? null
        : destination.plannedRelativePath,
    recommendationGenerationId: suggestion.recommendationGenerationId,
    recommendationGenerationVersion: suggestion.recommendationGenerationVersion,
    reason:
      suggestion.revisions[0]?.context?.trim() ||
      asStringArray(suggestion.whySuggested).find(
        (item) =>
          item.trim().length > 0 &&
          !/provisional|nothing (?:will|should) move|approval is required/i.test(
            item,
          ),
      ) ||
      suggestion.explanation ||
      "This destination matches the reviewed recommendation for this file.",
    requiredFolderPaths: [],
    requiredForSelectedActions: false,
    selectableForExecution:
      actionType === "MOVE_FILE" ||
      actionType === "RENAME_FILE" ||
      actionType === "MOVE_AND_RENAME_FILE",
    selectedForExecution: false,
    sourceSnapshot: {
      checksum: suggestion.scannedFile.checksum,
      lastModified: suggestion.scannedFile.lastModified?.toISOString() ?? null,
      relativePath: suggestion.scannedFile.relativePath,
      scannedFileId: suggestion.scannedFile.id,
      sizeBytes: suggestion.scannedFile.sizeBytes?.toString() ?? null,
    },
    sourceRelativePath: currentRelativePath,
    suggestionId: suggestion.id,
    suggestionType,
  };
}

function folderChain(folderPath: string) {
  const normalized = normalizeBridgeRelativePath(folderPath);

  if (!normalized) {
    return [];
  }

  const parts = normalized.split("/");

  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function generatedFolderActionFor(
  folderPath: string,
  sourceAction: BridgeOrganizationPlanAction,
): BridgeOrganizationPlanAction {
  return {
    actionType: "CREATE_FOLDER",
    confidence: sourceAction.confidence,
    evidence: sourceAction.evidence,
    executionRole: "FOLDER_DEPENDENCY",
    humanEdits: sourceAction.humanEdits,
    id: stableId("action-folder", [folderPath]),
    order: 0,
    originatingSuggestion: {
      explanation:
        "This folder is needed before the approved file organization can happen.",
      status: sourceAction.originatingSuggestion.status,
      title: "Create destination folder",
    },
    plannedFileName: null,
    plannedFolderPath: folderPath,
    plannedRelativePath: null,
    recommendationGenerationId: sourceAction.recommendationGenerationId,
    recommendationGenerationVersion: sourceAction.recommendationGenerationVersion,
    reason:
      "This destination folder is needed for one or more approved organization recommendations.",
    requiredFolderPaths: [],
    requiredForSelectedActions: true,
    selectableForExecution: false,
    selectedForExecution: true,
    sourceSnapshot: sourceAction.sourceSnapshot,
    sourceRelativePath: sourceAction.sourceRelativePath,
    suggestionId: sourceAction.suggestionId,
    suggestionType: "CREATE_FOLDER",
  };
}

function withGeneratedFolderActionsForSelection(
  actions: BridgeOrganizationPlanAction[],
  scannedFiles: ExistingScanFile[],
) {
  const existingFolders = collectExistingFolders(scannedFiles);
  const generatedFolderActions = new Map<string, BridgeOrganizationPlanAction>();
  const candidates = withRequiredFolderPaths(
    storedCandidateActions(actions),
    scannedFiles,
  );
  const selectedFileActions = candidates.filter(actionIsSelectedFileAction);

  for (const action of selectedFileActions) {
    if (!action.plannedFolderPath) {
      continue;
    }

    for (const folderPath of
      action.requiredFolderPaths ?? folderChain(action.plannedFolderPath)) {
      if (
        existingFolders.has(folderPath) ||
        generatedFolderActions.has(folderPath)
      ) {
        continue;
      }

      generatedFolderActions.set(
        folderPath,
        generatedFolderActionFor(folderPath, action),
      );
    }
  }

  return [...generatedFolderActions.values(), ...candidates];
}

function skippedItemFor(
  suggestion: StoredSuggestion,
): BridgeOrganizationPlanSkippedItem {
  const status = normalizeSuggestionStatus(suggestion.status);
  const reason =
    suggestion.invalidatedAt
      ? suggestion.invalidatedReason ??
        "This recommendation was replaced by newer review information."
      : !isCurrentRecommendationGeneration(
            suggestion.recommendationGenerationVersion,
          )
        ? "This recommendation came from an older recommendation pass and must be regenerated before it can enter a new plan."
        : status === "REJECTED"
          ? "Deanne rejected this suggestion."
          : status === "LEFT_UNCHANGED"
            ? "Deanne chose to leave this item unchanged."
            : "This suggestion is still waiting for review.";

  return {
    currentRelativePath: suggestion.currentRelativePath,
    id: stableId("skipped", [suggestion.id]),
    reason,
    status,
    suggestionId: suggestion.id,
    title: suggestion.title,
  };
}

function suggestionBelongsToCurrentGeneration(suggestion: StoredSuggestion) {
  return (
    !suggestion.invalidatedAt &&
    isCurrentRecommendationGeneration(
      suggestion.recommendationGenerationVersion,
    )
  );
}

function skippedItemForReason(
  suggestion: StoredSuggestion,
  reason: string,
): BridgeOrganizationPlanSkippedItem {
  return {
    currentRelativePath: suggestion.currentRelativePath,
    id: stableId("skipped", [suggestion.id, reason]),
    reason,
    status: normalizeSuggestionStatus(suggestion.status),
    suggestionId: suggestion.id,
    title: suggestion.title,
  };
}

function uniqueFolders(actions: BridgeOrganizationPlanAction[]) {
  const folders = new Set<string>();

  for (const action of actions) {
    if (action.plannedFolderPath) {
      folders.add(action.plannedFolderPath);
    }
  }

  return folders;
}

function blockingWarningCount(warnings: BridgeOrganizationPlanWarning[]) {
  return warnings.filter((warning) =>
    blockingWarningTypes.has(warning.warningType),
  ).length;
}

function planSummary(
  actions: BridgeOrganizationPlanAction[],
  warnings: BridgeOrganizationPlanWarning[],
): BridgeOrganizationPlanSummary {
  const normalizedActions = normalizePlanActions(actions);
  const selectedFileActions = normalizedActions.filter(actionIsSelectedFileAction);
  const executableActions = normalizedActions.filter(actionIsExecutableInSavedPlan);
  const reviewOnlyActions = normalizedActions.filter(actionIsReviewOnly);
  const selectableActions = normalizedActions.filter(actionIsSelectableForExecution);

  return {
    blockingWarnings: blockingWarningCount(warnings),
    estimatedOperations: executableActions.length,
    filesAffected: new Set(
      selectedFileActions
        .map((action) => action.sourceRelativePath)
        .filter((value) => value.trim().length > 0),
    ).size,
    foldersAffected: uniqueFolders(executableActions).size,
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

function addWarning(
  warnings: BridgeOrganizationPlanWarning[],
  warningType: OrganizationPlanWarningType,
  title: string,
  description: string,
  affectedActions: string[],
) {
  warnings.push({
    affectedActions,
    description,
    id: stableId("warning", [warningType, title, ...affectedActions]),
    title,
    warningType,
  });
}

function collectExistingFolders(scannedFiles: ExistingScanFile[]) {
  const folders = new Set<string>();

  for (const file of scannedFiles) {
    const normalized = normalizeBridgeRelativePath(file.relativePath);
    const parts = normalized.split("/");

    for (let index = 1; index < parts.length; index += 1) {
      folders.add(parts.slice(0, index).join("/"));
    }
  }

  return folders;
}

function withRequiredFolderPaths(
  actions: BridgeOrganizationPlanAction[],
  scannedFiles: ExistingScanFile[],
) {
  const existingFolders = collectExistingFolders(scannedFiles);

  return actions.map((action) => {
    if (!actionIsSelectableForExecution(action) || !action.plannedFolderPath) {
      return {
        ...action,
        requiredFolderPaths: [],
      };
    }

    return {
      ...action,
      requiredFolderPaths: folderChain(action.plannedFolderPath).filter(
        (folderPath) => !existingFolders.has(folderPath),
      ),
    };
  });
}

function validatePlanActions(
  actions: BridgeOrganizationPlanAction[],
  scannedFiles: ExistingScanFile[],
  options: { selectedOnly?: boolean } = {},
) {
  const warnings: BridgeOrganizationPlanWarning[] = [];
  const existingFilePaths = new Map(
    scannedFiles.map((file) => [
      normalizeBridgeRelativePath(file.relativePath),
      file.id,
    ]),
  );
  const existingFolders = collectExistingFolders(scannedFiles);
  const createFolderActions = new Set(
    actions
      .filter((action) => action.actionType === "CREATE_FOLDER")
      .map((action) => action.plannedFolderPath)
      .filter((value): value is string => Boolean(value)),
  );
  const destinations = new Map<string, string[]>();
  const sources = new Map<string, Array<{ id: string; destination: string }>>();
  const normalizedActions = normalizePlanActions(actions);
  const validationActions = options.selectedOnly
    ? normalizedActions.filter(actionIsExecutableInSavedPlan)
    : normalizedActions.filter(
        (action) =>
          actionIsSelectableForExecution(action) ||
          actionIsRequiredDependency(action),
      );

  for (const action of validationActions) {
    try {
      if (action.plannedRelativePath) {
        const normalized = normalizeBridgeRelativePath(action.plannedRelativePath);
        destinations.set(normalized, [
          ...(destinations.get(normalized) ?? []),
          action.id,
        ]);

        if (actionIsSelectableForExecution(action)) {
          const source = normalizeBridgeRelativePath(action.sourceRelativePath);
          sources.set(source, [
            ...(sources.get(source) ?? []),
            {
              destination: normalized,
              id: action.id,
            },
          ]);
        }

        if (
          existingFilePaths.has(normalized) &&
          normalizeBridgeRelativePath(action.sourceRelativePath) !== normalized
        ) {
          addWarning(
            warnings,
            "FILENAME_CONFLICT",
            "A planned destination already exists",
            `${normalized} already exists in the scanned folder metadata. The plan reports this instead of changing it.`,
            [action.id],
          );
        }
      }

      if (action.plannedFolderPath) {
        const normalizedFolder = normalizeBridgeRelativePath(
          action.plannedFolderPath,
        );

        if (existingFilePaths.has(normalizedFolder)) {
          addWarning(
            warnings,
            "FOLDER_CONFLICT",
            "A planned folder conflicts with a file",
            `${normalizedFolder} is recorded as a file path, so it cannot safely be treated as a folder.`,
            [action.id],
          );
        }

        const parentFolder = folderFromRelativePath(normalizedFolder);

        if (
          parentFolder &&
          !existingFolders.has(parentFolder) &&
          !createFolderActions.has(parentFolder)
        ) {
          addWarning(
            warnings,
            "MISSING_PARENT",
            "A parent folder is not present in the folder scan record",
            `${parentFolder} is not present in this scan session and is not created by this plan.`,
            [action.id],
          );
        }
      }
    } catch (error) {
      const description =
        error instanceof Error
          ? error.message
          : "One planned destination could not be validated.";

      addWarning(
        warnings,
        description.includes("inside the connected folder")
          ? "OUTSIDE_ROOT_DESTINATION"
          : "INVALID_PATH",
        "A planned path needs review",
        description,
        [action.id],
      );
    }
  }

  for (const [destination, actionIds] of destinations.entries()) {
    if (actionIds.length > 1) {
      addWarning(
        warnings,
        "DUPLICATE_DESTINATION",
        "Multiple actions share the same destination",
        `${destination} is proposed by more than one action.`,
        actionIds,
      );
    }
  }

  for (const [source, entries] of sources.entries()) {
    const distinctDestinations = [
      ...new Set(entries.map((entry) => entry.destination)),
    ];

    if (distinctDestinations.length > 1) {
      addWarning(
        warnings,
        "DUPLICATE_SOURCE",
        "One file has more than one proposed destination",
        `${source} is proposed for more than one destination: ${distinctDestinations.join(
          ", ",
        )}. Choose one before approving the plan.`,
        entries.map((entry) => entry.id),
      );
    }
  }

  return warnings;
}

function orderedActions(actions: BridgeOrganizationPlanAction[]) {
  return [...actions]
    .sort((left, right) => {
      const orderDifference =
        actionOrder[left.actionType] - actionOrder[right.actionType];

      if (orderDifference !== 0) {
        return orderDifference;
      }

      return (
        (left.plannedRelativePath ?? left.plannedFolderPath ?? left.sourceRelativePath)
          .localeCompare(
            right.plannedRelativePath ??
              right.plannedFolderPath ??
              right.sourceRelativePath,
          ) || left.id.localeCompare(right.id)
      );
    })
    .map((action, index) => ({
      ...action,
      order: index + 1,
    }));
}

function buildPlanSnapshot(input: PlanBuildInput) {
  const includedSuggestions = input.suggestions.filter((suggestion) =>
    suggestionBelongsToCurrentGeneration(suggestion) &&
    includedStatuses.has(normalizeSuggestionStatus(suggestion.status)),
  );
  const skippedItems = input.suggestions
    .filter(
      (suggestion) =>
        !suggestionBelongsToCurrentGeneration(suggestion) ||
        !includedStatuses.has(normalizeSuggestionStatus(suggestion.status)),
    )
    .map(skippedItemFor);
  const suggestedActions: BridgeOrganizationPlanAction[] = [];

  for (const suggestion of includedSuggestions) {
    try {
      const action = actionFromSuggestion(suggestion);

      if (action) {
        suggestedActions.push(action);
      } else {
        skippedItems.push(
          skippedItemForReason(
            suggestion,
            "The approved recommendation does not change this file's location or name.",
          ),
        );
      }
    } catch {
      skippedItems.push(
        skippedItemForReason(
          suggestion,
          "The suggested destination is not a safe relative path inside this connected library.",
        ),
      );
    }
  }
  const actions = orderedActions(
    withRequiredFolderPaths(
      storedCandidateActions(suggestedActions),
      input.scannedFiles,
    ),
  );
  const warnings = validatePlanActions(actions, input.scannedFiles);
  const now = new Date().toISOString();
  const history: BridgeOrganizationPlanHistoryItem[] = [
    ...input.previousHistory,
    {
      at: now,
      detail:
        "The Librarian rebuilt the plan from reviewed organization recommendations only. No filesystem action was allowed.",
      id: stableId("history", ["generated", now]),
      label: "Plan generated",
    },
  ].slice(-20);

  const currentSuggestions = input.suggestions.filter(
    suggestionBelongsToCurrentGeneration,
  );

  return {
    actions,
    approvedActions: currentSuggestions.filter(
      (suggestion) => normalizeSuggestionStatus(suggestion.status) === "APPROVED",
    ).length,
    history,
    modifiedActions: currentSuggestions.filter(
      (suggestion) => normalizeSuggestionStatus(suggestion.status) === "MODIFIED",
    ).length,
    rejectedActions: currentSuggestions.filter(
      (suggestion) => normalizeSuggestionStatus(suggestion.status) === "REJECTED",
    ).length,
    skippedItems,
    summary: planSummary(actions, warnings),
    totalActions: actions.length,
    unchangedActions: currentSuggestions.filter(
      (suggestion) =>
        normalizeSuggestionStatus(suggestion.status) === "LEFT_UNCHANGED",
    ).length,
    warnings,
  };
}

function summarizePlan(
  plan: StoredPlan,
  scannedFiles?: ExistingScanFile[],
): BridgeOrganizationPlan {
  const storedActions = normalizePlanActions(asPlanActions(plan.actions));
  const actions = scannedFiles
    ? withRequiredFolderPaths(storedActions, scannedFiles)
    : storedActions;
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

async function planById(planId: string) {
  const prisma = getPrismaClient();

  return prisma.organizationPlan.findUnique({
    where: {
      id: planId,
    },
  });
}

async function currentPlanForScanSession(scanSessionId: string) {
  const prisma = getPrismaClient();

  return prisma.organizationPlan.findFirst({
    orderBy: {
      updatedAt: "desc",
    },
    where: {
      scanSessionId,
      status: {
        in: ["DRAFT", "READY_FOR_EXECUTION"],
      },
      scanSession: {
        organizationSuggestions: {
          some: {
            invalidatedAt: null,
            recommendationGenerationVersion:
              currentRecommendationGenerationVersion,
            status: {
              in: ["APPROVED", "MODIFIED"],
            },
          },
        },
      },
    },
  });
}

async function latestDisplayPlanForScanSession(scanSessionId: string) {
  const prisma = getPrismaClient();

  return prisma.organizationPlan.findFirst({
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
    },
    orderBy: {
      updatedAt: "desc",
    },
    where: {
      scanSessionId,
      status: {
        in: ["DRAFT", "READY_FOR_EXECUTION", "EXECUTED"],
      },
      totalActions: {
        gt: 0,
      },
    },
  });
}

async function scanSessionForPlan(scanSessionId: string) {
  const prisma = getPrismaClient();

  return prisma.scanSession.findUnique({
    include: {
      connectedFolder: {
        select: {
          displayName: true,
        },
      },
      organizationSuggestions: {
        include: {
          revisions: {
            orderBy: {
              createdAt: "desc",
            },
          },
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
        orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      },
      scannedFiles: {
        select: {
          id: true,
          relativePath: true,
        },
      },
    },
    where: {
      id: scanSessionId,
    },
  });
}

export async function generateOrganizationPlanForScanSession(
  scanSessionId: string,
) {
  const prisma = getPrismaClient();
  const session = await scanSessionForPlan(scanSessionId);

  if (!session) {
    throw new OrganizationPlanError(
      "The Librarian could not find that scan session.",
      404,
    );
  }

  await requirePlanningPermission(scanSessionId);

  const previousPlan = await currentPlanForScanSession(scanSessionId);
  const previousHistory = previousPlan
    ? asHistoryItems(previousPlan.history)
    : [];
  const snapshot = buildPlanSnapshot({
    connectedLibraryId: session.connectedFolderId,
    previousHistory,
    scanSessionId,
    scannedFiles: session.scannedFiles,
    suggestions: session.organizationSuggestions,
  });

  if (snapshot.totalActions === 0) {
    throw new OrganizationPlanError(
      "No reviewed recommendations are ready for planning.",
      422,
    );
  }

  const data = {
    actions: toJsonInput(snapshot.actions),
    approvedActions: snapshot.approvedActions,
    connectedLibraryId: session.connectedFolderId,
    createdBy: "NSN Librarian",
    history: toJsonInput(snapshot.history),
    modifiedActions: snapshot.modifiedActions,
    rejectedActions: snapshot.rejectedActions,
    scanSessionId,
    skippedItems: toJsonInput(snapshot.skippedItems),
    status: "DRAFT" as const,
    totalActions: snapshot.totalActions,
    unchangedActions: snapshot.unchangedActions,
    warnings: toJsonInput(snapshot.warnings),
  };

  const savedPlan =
    previousPlan && previousPlan.status !== "CANCELLED"
      ? await prisma.organizationPlan.update({
          data,
          where: {
            id: previousPlan.id,
          },
        })
      : await prisma.organizationPlan.create({
          data,
        });

  try {
    await recordOrganizationPlanNotebookEntry(savedPlan.id);
  } catch {
    // Notebook reflections should never block plan generation.
  }

  return summarizePlan(savedPlan);
}

export async function getOrganizationPlanPageData(
  scanSessionId: string,
): Promise<BridgeOrganizationPlanPageData | null> {
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findUnique({
    include: {
      connectedFolder: {
        select: {
          displayName: true,
        },
      },
      organizationSuggestions: {
        select: {
          status: true,
        },
        where: {
          invalidatedAt: null,
          recommendationGenerationVersion: currentRecommendationGenerationVersion,
        },
      },
      scannedFiles: {
        select: {
          id: true,
          relativePath: true,
        },
      },
    },
    where: {
      id: scanSessionId,
    },
  });

  if (!session) {
    return null;
  }

  const plan = await latestDisplayPlanForScanSession(scanSessionId);
  const latestExecution: BridgeExecutionRunSummary | null =
    plan?.executionRuns[0]
      ? summarizeExecutionRun(plan.executionRuns[0])
      : null;

  return {
    latestExecution,
    plan: plan
      ? summarizePlan(
          plan as StoredPlanWithExecutionRuns,
          session.scannedFiles,
        )
      : null,
    planningEligibility: organizationSuggestionCounts(
      session.organizationSuggestions,
    ),
    session: scanSessionSummary(session),
  };
}

export async function getCurrentOrganizationPlanForHomepage() {
  const prisma = getPrismaClient();
  const plan = await prisma.organizationPlan.findFirst({
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
        take: 1,
      },
      scanSession: {
        include: {
          connectedFolder: {
            select: {
              displayName: true,
            },
          },
        },
      },
    },
    orderBy: {
      updatedAt: "desc",
    },
    where: {
      totalActions: {
        gt: 0,
      },
      status: {
        in: ["DRAFT", "READY_FOR_EXECUTION", "EXECUTED"],
      },
    },
  });

  if (!plan) {
    return null;
  }

  return {
    folderDisplayName: plan.scanSession.connectedFolder.displayName,
    href: getOrganizationPlanRoute(plan.scanSessionId),
    latestExecution: plan.executionRuns[0]
      ? summarizeExecutionRun(plan.executionRuns[0])
      : null,
    plan: summarizePlan(plan),
  };
}

function appendPlanHistory(
  plan: StoredPlan,
  label: string,
  detail: string,
): BridgeOrganizationPlanHistoryItem[] {
  const now = new Date().toISOString();

  return [
    ...asHistoryItems(plan.history),
    {
      at: now,
      detail,
      id: stableId("history", [label, now]),
      label,
    },
  ].slice(-20);
}

function validateSelectedActionIds(
  candidateActions: BridgeOrganizationPlanAction[],
  selectedActionIds: string[],
) {
  const candidatesById = new Map(candidateActions.map((action) => [action.id, action]));
  const uniqueSelectedIds = [...new Set(selectedActionIds.map((id) => id.trim()))]
    .filter(Boolean);
  const unknownIds = uniqueSelectedIds.filter((id) => !candidatesById.has(id));

  if (uniqueSelectedIds.length === 0) {
    throw new OrganizationPlanError(
      "Select at least one file action before saving the plan selection.",
      422,
    );
  }

  if (unknownIds.length > 0) {
    throw new OrganizationPlanError(
      "The plan selection included an action the Librarian could not verify.",
      422,
    );
  }

  const invalidAction = uniqueSelectedIds
    .map((id) => candidatesById.get(id))
    .find((action) => action && !actionIsSelectableForExecution(action));

  if (invalidAction) {
    throw new OrganizationPlanError(
      "Only move and rename file recommendations can be selected for filesystem organization.",
      422,
    );
  }

  return uniqueSelectedIds;
}

function applyActionSelection(
  actions: BridgeOrganizationPlanAction[],
  selectedActionIds: string[],
  scannedFiles: ExistingScanFile[],
) {
  const candidateActions = storedCandidateActions(actions);
  const validatedSelectedIds = validateSelectedActionIds(
    candidateActions,
    selectedActionIds,
  );
  const selectedIdSet = new Set(validatedSelectedIds);
  const updatedCandidates = candidateActions.map((action) =>
    normalizePlanAction({
      ...action,
      requiredForSelectedActions: false,
      selectedForExecution: selectedIdSet.has(action.id),
    }),
  );

  return orderedActions(
    withGeneratedFolderActionsForSelection(updatedCandidates, scannedFiles),
  );
}

async function assertSelectedActionsMatchCurrentRecommendations(
  scanSessionId: string,
  actions: BridgeOrganizationPlanAction[],
) {
  const selectedActions = normalizePlanActions(actions).filter(
    actionIsSelectedFileAction,
  );

  if (selectedActions.length === 0) {
    return;
  }

  const prisma = getPrismaClient();
  const suggestions = await prisma.organizationSuggestion.findMany({
    select: {
      id: true,
      invalidatedAt: true,
      recommendationGenerationId: true,
      recommendationGenerationVersion: true,
      scanSessionId: true,
      scannedFile: {
        select: {
          checksum: true,
          id: true,
          lastModified: true,
          relativePath: true,
          sizeBytes: true,
        },
      },
      status: true,
    },
    where: {
      id: {
        in: selectedActions.map((action) => action.suggestionId),
      },
      scanSessionId,
    },
  });
  const suggestionsById = new Map(
    suggestions.map((suggestion) => [suggestion.id, suggestion]),
  );

  for (const action of selectedActions) {
    const suggestion = suggestionsById.get(action.suggestionId);

    if (!suggestion) {
      throw new OrganizationPlanError(
        "The selected action no longer matches a reviewable recommendation.",
        422,
      );
    }

    if (
      suggestion.invalidatedAt ||
      !isCurrentRecommendationGeneration(
        suggestion.recommendationGenerationVersion,
      )
    ) {
      throw new OrganizationPlanError(
        "Regenerate recommendations and rebuild the Organization Plan before selecting this action.",
        422,
      );
    }

    if (
      !includedStatuses.has(normalizeSuggestionStatus(suggestion.status)) ||
      action.recommendationGenerationId !==
        suggestion.recommendationGenerationId ||
      action.recommendationGenerationVersion !==
        suggestion.recommendationGenerationVersion
    ) {
      throw new OrganizationPlanError(
        "The selected action does not match the current reviewed recommendation.",
        422,
      );
    }

    const sourceSnapshot = action.sourceSnapshot;
    const scannedFile = suggestion.scannedFile;

    if (
      action.sourceRelativePath !== scannedFile.relativePath ||
      !sourceSnapshot ||
      sourceSnapshot.scannedFileId !== scannedFile.id ||
      sourceSnapshot.relativePath !== scannedFile.relativePath
    ) {
      throw new OrganizationPlanError(
        "The selected action no longer matches the scanned file record.",
        422,
      );
    }

    if (
      sourceSnapshot.checksum !== scannedFile.checksum ||
      sourceSnapshot.sizeBytes !== (scannedFile.sizeBytes?.toString() ?? null) ||
      sourceSnapshot.lastModified !==
        (scannedFile.lastModified?.toISOString() ?? null)
    ) {
      throw new OrganizationPlanError(
        "The source file changed after this plan was built. Regenerate the plan before selecting it.",
        422,
      );
    }
  }
}

function clearActionSelection(actions: BridgeOrganizationPlanAction[]) {
  return orderedActions(
    storedCandidateActions(actions).map((action) =>
      normalizePlanAction({
        ...action,
        requiredForSelectedActions: false,
        selectedForExecution: false,
      }),
    ),
  );
}

function assertNoBlockingWarnings(warnings: BridgeOrganizationPlanWarning[]) {
  const blockingWarning = warnings.find((warning) =>
    blockingWarningTypes.has(warning.warningType),
  );

  if (blockingWarning) {
    throw new OrganizationPlanError(blockingWarning.description, 422);
  }
}

async function planScannedFiles(plan: StoredPlan) {
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findUnique({
    select: {
      scannedFiles: {
        select: {
          id: true,
          relativePath: true,
        },
      },
    },
    where: {
      id: plan.scanSessionId,
    },
  });

  if (!session) {
    throw new OrganizationPlanError(
      "The Librarian could not find that plan's scan session.",
      404,
    );
  }

  return session.scannedFiles;
}

export async function saveOrganizationPlanSelection(
  planId: string,
  selectedActionIds: string[],
) {
  const prisma = getPrismaClient();
  const existing = await planById(planId);

  if (!existing) {
    throw new OrganizationPlanError(
      "The Librarian could not find that organization plan.",
      404,
    );
  }

  if (normalizePlanStatus(existing.status) !== "DRAFT") {
    throw new OrganizationPlanError(
      "Only a draft Organization Plan can have its selected actions changed.",
      409,
    );
  }

  await requirePlanningPermission(existing.scanSessionId);

  const scannedFiles = await planScannedFiles(existing);
  const actions = applyActionSelection(
    asPlanActions(existing.actions),
    selectedActionIds,
    scannedFiles,
  );
  const warnings = validatePlanActions(actions, scannedFiles, {
    selectedOnly: true,
  });
  const summary = planSummary(actions, warnings);

  assertNoBlockingWarnings(warnings);
  await assertSelectedActionsMatchCurrentRecommendations(
    existing.scanSessionId,
    actions,
  );

  const updated = await prisma.organizationPlan.update({
    data: {
      actions: toJsonInput(actions),
      history: toJsonInput(
        appendPlanHistory(
          existing,
          "Selected actions saved",
          `${summary.selectedFileActions} file action${
            summary.selectedFileActions === 1 ? "" : "s"
          } selected for later approval. No filesystem action occurred.`,
        ),
      ),
      totalActions: actions.length,
      warnings: toJsonInput(warnings),
    },
    where: {
      id: existing.id,
    },
  });

  return summarizePlan(updated);
}

export async function clearOrganizationPlanSelection(planId: string) {
  const prisma = getPrismaClient();
  const existing = await planById(planId);

  if (!existing) {
    throw new OrganizationPlanError(
      "The Librarian could not find that organization plan.",
      404,
    );
  }

  if (normalizePlanStatus(existing.status) !== "DRAFT") {
    throw new OrganizationPlanError(
      "Only a draft Organization Plan can have its selected actions changed.",
      409,
    );
  }

  await requirePlanningPermission(existing.scanSessionId);

  const scannedFiles = await planScannedFiles(existing);
  const actions = clearActionSelection(asPlanActions(existing.actions));
  const warnings = validatePlanActions(actions, scannedFiles);
  const updated = await prisma.organizationPlan.update({
    data: {
      actions: toJsonInput(actions),
      history: toJsonInput(
        appendPlanHistory(
          existing,
          "Selection cleared",
          "Deanne cleared the selected file actions. No filesystem action occurred.",
        ),
      ),
      totalActions: actions.length,
      warnings: toJsonInput(warnings),
    },
    where: {
      id: existing.id,
    },
  });

  return summarizePlan(updated);
}

export async function approveOrganizationPlan(planId: string) {
  const prisma = getPrismaClient();
  const existing = await planById(planId);

  if (!existing) {
    throw new OrganizationPlanError(
      "The Librarian could not find that organization plan.",
      404,
    );
  }

  const actions = normalizePlanActions(asPlanActions(existing.actions));

  if (actions.filter(actionIsSelectedFileAction).length === 0) {
    throw new OrganizationPlanError(
      "Select and save at least one file action before approving the Organization Plan.",
      422,
    );
  }

  await requirePlanningPermission(existing.scanSessionId);

  const executionPreview = await validateOrganizationPlanForApproval(existing.id);

  if (!executionPreview.canExecute) {
    const firstIssue = executionPreview.blockingIssues[0];

    throw new OrganizationPlanError(
      firstIssue?.description ??
        "The Bridge found safety issues that must be resolved before this plan can be approved.",
      422,
    );
  }

  const updated = await prisma.organizationPlan.update({
    data: {
      history: toJsonInput(
        appendPlanHistory(
          existing,
          "Plan approved",
          "Deanne marked the plan ready for future execution. No filesystem action occurred.",
        ),
      ),
      status: "READY_FOR_EXECUTION",
    },
    where: {
      id: existing.id,
    },
  });

  try {
    await recordOrganizationPlanDecisionNotebookEntry(updated.id, "APPROVE");
  } catch {
    // Notebook reflections should never block plan approval.
  }

  return summarizePlan(updated);
}

export async function cancelOrganizationPlan(planId: string) {
  const prisma = getPrismaClient();
  const existing = await planById(planId);

  if (!existing) {
    throw new OrganizationPlanError(
      "The Librarian could not find that organization plan.",
      404,
    );
  }

  const updated = await prisma.organizationPlan.update({
    data: {
      history: toJsonInput(
        appendPlanHistory(
          existing,
          "Plan cancelled",
          "Deanne cancelled this plan. No filesystem action occurred.",
        ),
      ),
      status: "CANCELLED",
    },
    where: {
      id: existing.id,
    },
  });

  try {
    await recordOrganizationPlanDecisionNotebookEntry(updated.id, "CANCEL");
  } catch {
    // Notebook reflections should never block plan cancellation.
  }

  return summarizePlan(updated);
}

export { summarizeOrganizationSuggestion };
export { organizationPlanDownload } from "./organization-plan-review";
