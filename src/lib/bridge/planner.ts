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
  summarizeExecutionRun,
  validateOrganizationPlanForApproval,
} from "./executor";
import type {
  BridgeExecutionRunSummary,
  BridgeOrganizationPlan,
  BridgeOrganizationPlanAction,
  BridgeOrganizationPlanDownload,
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
  createdAt: Date;
  reviewedAt: Date | null;
  scannedFile: {
    relativePath: string;
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

  if (suggestionType === "MOVE_FILE" || suggestionType === "GROUP_WITH_FILES") {
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
  const supportingInformation = asStringArray(suggestion.supportingInformation);
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
    reason:
      suggestion.revisions[0]?.context ??
      suggestion.explanation ??
      "Deanne reviewed this organization suggestion.",
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
    reason:
      "This destination folder is needed for one or more approved organization recommendations.",
    sourceRelativePath: sourceAction.sourceRelativePath,
    suggestionId: sourceAction.suggestionId,
    suggestionType: "CREATE_FOLDER",
  };
}

function withGeneratedFolderActions(
  actions: BridgeOrganizationPlanAction[],
  scannedFiles: ExistingScanFile[],
) {
  const existingFolders = collectExistingFolders(scannedFiles);
  const plannedFolderActions = new Map<string, BridgeOrganizationPlanAction>();
  const generatedFolderActions = new Map<string, BridgeOrganizationPlanAction>();

  for (const action of actions) {
    if (action.actionType === "CREATE_FOLDER" && action.plannedFolderPath) {
      plannedFolderActions.set(
        normalizeBridgeRelativePath(action.plannedFolderPath),
        action,
      );
    }
  }

  for (const action of actions) {
    if (action.actionType === "CREATE_FOLDER" || !action.plannedFolderPath) {
      continue;
    }

    for (const folderPath of folderChain(action.plannedFolderPath)) {
      if (
        existingFolders.has(folderPath) ||
        plannedFolderActions.has(folderPath) ||
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

  return [...generatedFolderActions.values(), ...actions];
}

function skippedItemFor(
  suggestion: StoredSuggestion,
): BridgeOrganizationPlanSkippedItem {
  const status = normalizeSuggestionStatus(suggestion.status);

  return {
    currentRelativePath: suggestion.currentRelativePath,
    id: stableId("skipped", [suggestion.id]),
    reason:
      status === "REJECTED"
        ? "Deanne rejected this suggestion."
        : status === "LEFT_UNCHANGED"
          ? "Deanne chose to leave this item unchanged."
          : "This suggestion is still waiting for review.",
    status,
    suggestionId: suggestion.id,
    title: suggestion.title,
  };
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

function planSummary(
  actions: BridgeOrganizationPlanAction[],
  warnings: BridgeOrganizationPlanWarning[],
): BridgeOrganizationPlanSummary {
  return {
    estimatedOperations: actions.length,
    filesAffected: new Set(
      actions
        .filter((action) => action.actionType !== "CREATE_FOLDER")
        .map((action) => action.sourceRelativePath)
        .filter((value) => value.trim().length > 0),
    ).size,
    foldersAffected: uniqueFolders(actions).size,
    moves: actions.filter(
      (action) =>
        action.actionType === "MOVE_FILE" ||
        action.actionType === "MOVE_AND_RENAME_FILE",
    ).length,
    newFolders: actions.filter(
      (action) => action.actionType === "CREATE_FOLDER",
    ).length,
    renames: actions.filter(
      (action) =>
        action.actionType === "RENAME_FILE" ||
        action.actionType === "MOVE_AND_RENAME_FILE",
    ).length,
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

function validatePlanActions(
  actions: BridgeOrganizationPlanAction[],
  scannedFiles: ExistingScanFile[],
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
  const folderDestinations = new Map<string, string[]>();

  for (const action of actions) {
    try {
      if (action.plannedRelativePath) {
        const normalized = normalizeBridgeRelativePath(action.plannedRelativePath);
        destinations.set(normalized, [
          ...(destinations.get(normalized) ?? []),
          action.id,
        ]);

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
        if (action.actionType === "CREATE_FOLDER") {
          folderDestinations.set(normalizedFolder, [
            ...(folderDestinations.get(normalizedFolder) ?? []),
            action.id,
          ]);
        }

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

    if (
      action.actionType === "WEBSITE_ACTION" ||
      action.actionType === "REVIEW_ONLY"
    ) {
      addWarning(
        warnings,
        "REVIEW_ONLY_ACTION",
        "A future action is listed for review only",
        "This action is part of the plan for visibility, but this milestone cannot publish website content or execute review-only changes.",
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

  for (const [destination, actionIds] of folderDestinations.entries()) {
    if (actionIds.length > 1) {
      addWarning(
        warnings,
        "DUPLICATE_DESTINATION",
        "Multiple actions point to the same folder",
        `${destination} is proposed by more than one action.`,
        actionIds,
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
    includedStatuses.has(normalizeSuggestionStatus(suggestion.status)),
  );
  const skippedItems = input.suggestions
    .filter(
      (suggestion) =>
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
    withGeneratedFolderActions(suggestedActions, input.scannedFiles),
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

  return {
    actions,
    approvedActions: input.suggestions.filter(
      (suggestion) => normalizeSuggestionStatus(suggestion.status) === "APPROVED",
    ).length,
    history,
    modifiedActions: input.suggestions.filter(
      (suggestion) => normalizeSuggestionStatus(suggestion.status) === "MODIFIED",
    ).length,
    rejectedActions: input.suggestions.filter(
      (suggestion) => normalizeSuggestionStatus(suggestion.status) === "REJECTED",
    ).length,
    skippedItems,
    summary: planSummary(actions, warnings),
    totalActions: actions.length,
    unchangedActions: input.suggestions.filter(
      (suggestion) =>
        normalizeSuggestionStatus(suggestion.status) === "LEFT_UNCHANGED",
    ).length,
    warnings,
  };
}

function summarizePlan(plan: StoredPlan): BridgeOrganizationPlan {
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
              relativePath: true,
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
    plan: plan ? summarizePlan(plan as StoredPlanWithExecutionRuns) : null,
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

export async function approveOrganizationPlan(planId: string) {
  const prisma = getPrismaClient();
  const existing = await planById(planId);

  if (!existing) {
    throw new OrganizationPlanError(
      "The Librarian could not find that organization plan.",
      404,
    );
  }

  if (existing.totalActions === 0 || asPlanActions(existing.actions).length === 0) {
    throw new OrganizationPlanError(
      "No reviewed recommendations are ready for planning.",
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

export function organizationPlanDownload(
  plan: BridgeOrganizationPlan,
): BridgeOrganizationPlanDownload {
  return {
    exportedAt: new Date().toISOString(),
    plan,
    safety: {
      executionAllowed: false,
      note: "This JSON is an organization plan only. It does not authorize moving, renaming, creating, deleting, copying, or publishing files.",
    },
  };
}

export { summarizeOrganizationSuggestion };
