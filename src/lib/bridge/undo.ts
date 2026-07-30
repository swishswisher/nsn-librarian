import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, rmdir, rename } from "node:fs/promises";
import path from "node:path";

import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import { recordUndoNotebookEntry } from "@/lib/library/notebook";

import { validateConnectedLibraryPath } from "./connected-libraries";
import { summarizeExecutionRun } from "./executor";
import {
  executeLocalBridgeUndoActions,
  previewLocalBridgeUndo,
  type LocalBridgeUndoActionInput,
} from "./local-bridge-client";
import type {
  BridgeExecutionIssue,
  BridgeExecutionIssueCategory,
  BridgeExecutionRunSummary,
  BridgeUndoActionType,
  BridgeUndoPreview,
  BridgeUndoPreviewAction,
  BridgeUndoRunSummary,
  UndoStatus,
} from "./types";

export class BridgeUndoError extends Error {
  preview?: BridgeUndoPreview;
  run?: BridgeUndoRunSummary;
  statusCode: number;

  constructor(
    message: string,
    statusCode = 400,
    preview?: BridgeUndoPreview,
    run?: BridgeUndoRunSummary,
  ) {
    super(message);
    this.name = "BridgeUndoError";
    this.statusCode = statusCode;
    this.preview = preview;
    this.run = run;
  }
}

class BridgeUndoActionError extends Error {
  category: BridgeExecutionIssueCategory;

  constructor(category: BridgeExecutionIssueCategory, message: string) {
    super(message);
    this.name = "BridgeUndoActionError";
    this.category = category;
  }
}

type StoredExecutionActionForUndo = {
  id: string;
  actionType: string;
  sourceRelativePath: string;
  destinationRelativePath: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  safeErrorCategory: string | null;
  sequence: number;
  createdFilesystemItem: boolean;
};

type StoredUndoActionForUndo = {
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

type StoredUndoRunForUndo = {
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
  actions: StoredUndoActionForUndo[];
};

type StoredExecutionRunForUndo = {
  id: string;
  organizationPlanId: string;
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
  actions: StoredExecutionActionForUndo[];
  undoRuns: StoredUndoRunForUndo[];
  organizationPlan: {
    scanSessionId: string;
    scanSession: {
      connectedFolder: {
        bridgeRootId: string | null;
        createFolderPermission: boolean;
        isEnabled: boolean;
        localPath: string;
        moveFilePermission: boolean;
        readPermission: boolean;
        renameFilePermission: boolean;
        status: string;
      };
      scannedFiles: {
        checksum: string | null;
        id: string;
        lastModified: Date | null;
        localPath: string;
        relativePath: string;
        sizeBytes: bigint | null;
      }[];
    };
  };
};

type UndoActionDraft = {
  actionType: BridgeUndoActionType;
  destinationPath: string;
  destinationRelativePath: string;
  originalAction: StoredExecutionActionForUndo;
  scannedFileChecksum: string | null;
  scannedFileLastModified: Date | null;
  scannedFileSizeBytes: bigint | null;
  sequence: number;
  sourcePath: string;
  sourceRelativePath: string;
};

const undoStatuses = new Set<UndoStatus>([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "BLOCKED",
]);
const removableExecutionActionTypes = new Set([
  "CREATE_FOLDER",
  "MOVE_FILE",
  "RENAME_FILE",
  "MOVE_AND_RENAME_FILE",
]);
const invalidPathCharacters = /[<>:"\\|?*\u0000]/;

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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
    value === "RENAME_FILE" ||
    value === "MOVE_AND_RENAME_FILE"
  ) {
    return value === "MOVE_AND_RENAME_FILE" ? "MOVE_FILE" : value;
  }

  return "MOVE_FILE";
}

function summarizeUndoRun(run: StoredUndoRunForUndo): BridgeUndoRunSummary {
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

function pathKey(value: string) {
  const normalized = path.normalize(value);

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hasDrivePrefix(value: string) {
  return /^[a-zA-Z]:/.test(value.trim());
}

function invalidPathSegment(segment: string) {
  return (
    !segment.trim() ||
    segment === "." ||
    segment === ".." ||
    invalidPathCharacters.test(segment)
  );
}

function normalizeRelativePath(value: string) {
  const trimmed = value.trim().replace(/\\/g, "/");

  if (
    !trimmed ||
    path.posix.isAbsolute(trimmed) ||
    hasDrivePrefix(trimmed)
  ) {
    throw new Error("Use a relative path inside the connected folder.");
  }

  const normalized = path.posix.normalize(trimmed);

  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error("Use a relative path inside the connected folder.");
  }

  if (normalized.split("/").some(invalidPathSegment)) {
    throw new Error("Use folder and file names that can be safely restored.");
  }

  return normalized;
}

function isInsideRoot(rootPath: string, filePath: string) {
  const relativePath = path.relative(rootPath, filePath);

  return (
    relativePath.length > 0 &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  );
}

function resolveInsideRoot(rootPath: string, relativePath: string) {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const resolvedPath = path.normalize(
    path.resolve(rootPath, ...normalizedRelativePath.split("/")),
  );

  if (!isInsideRoot(rootPath, resolvedPath)) {
    throw new Error("The path is outside the connected folder.");
  }

  return {
    relativePath: normalizedRelativePath,
    resolvedPath,
  };
}

async function pathExists(filePath: string) {
  try {
    return await lstat(filePath);
  } catch {
    return null;
  }
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
    id: `undo-${category.toLowerCase()}-${[title, ...affectedActionIds]
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}`,
    severity: "BLOCKING",
    title,
  };
}

function firstBlockingIssue(issues: BridgeExecutionIssue[]) {
  return issues.find((item) => item.severity === "BLOCKING") ?? issues[0] ?? null;
}

function classifyUndoIssues(issues: BridgeExecutionIssue[]) {
  const conflicts = issues.filter(
    (item) =>
      item.category === "DESTINATION_CONFLICT" ||
      item.category === "DUPLICATE_UNDO_DESTINATION" ||
      item.category === "FOLDER_NOT_EMPTY" ||
      item.category === "FOLDER_NOT_CREATED_BY_BRIDGE",
  );
  const missingFiles = issues.filter(
    (item) => item.category === "MISSING_SOURCE",
  );
  const changedFiles = issues.filter(
    (item) => item.category === "CHANGED_SOURCE",
  );
  const blockedActions = issues.filter(
    (item) =>
      item.category === "UNDO_NOT_AVAILABLE" ||
      item.category === "UNDO_ALREADY_COMPLETED" ||
      item.category === "UNDO_RUNNING" ||
      item.category === "VALIDATION_FAILED" ||
      item.category === "PATH_OUTSIDE_ROOT" ||
      item.category === "INVALID_PATH",
  );

  return {
    blockedActions,
    blockingIssues: issues.filter((item) => item.severity === "BLOCKING"),
    changedFiles,
    conflicts,
    missingFiles,
    warnings: issues.filter((item) => item.severity === "WARNING"),
  };
}

function bridgeUndoIssueCategory(value: string): BridgeExecutionIssueCategory {
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

function localBridgeUndoIssue(input: {
  actionId: string | null;
  category: string;
  message: string;
}) {
  return issue(
    bridgeUndoIssueCategory(input.category),
    "The local Bridge blocked this undo action",
    input.message,
    input.actionId ? [input.actionId] : [],
  );
}

function localBridgeUndoActionFor(
  action: UndoActionDraft,
): LocalBridgeUndoActionInput {
  return {
    actionType: action.actionType,
    destinationRelativePath: action.destinationRelativePath,
    id: action.originalAction.id,
    sourceChecksum: action.scannedFileChecksum,
    sourceLastModified: action.scannedFileLastModified?.toISOString() ?? null,
    sourceRelativePath: action.sourceRelativePath,
    sourceSizeBytes: action.scannedFileSizeBytes?.toString() ?? null,
  };
}

function undoActionDescription(actionType: BridgeUndoActionType) {
  if (actionType === "REMOVE_FOLDER") {
    return "Remove folder created by the Bridge";
  }

  if (actionType === "RENAME_FILE") {
    return "Restore original file name";
  }

  return "Move file back to its original location";
}

function previewActionFor(action: UndoActionDraft): BridgeUndoPreviewAction {
  return {
    actionType: action.actionType,
    description: undoActionDescription(action.actionType),
    destinationRelativePath: action.destinationRelativePath,
    id: `undo-${action.originalAction.id}`,
    originalExecutionActionId: action.originalAction.id,
    sequence: action.sequence,
    sourceRelativePath: action.sourceRelativePath,
  };
}

function executionIsUndoable(run: StoredExecutionRunForUndo) {
  return run.status === "COMPLETED" || run.status === "PARTIALLY_COMPLETED";
}

function existingCompletedUndo(run: StoredExecutionRunForUndo) {
  return run.undoRuns.find((undoRun) => undoRun.status === "COMPLETED") ?? null;
}

function existingRunningUndo(run: StoredExecutionRunForUndo) {
  return run.undoRuns.find((undoRun) => undoRun.status === "RUNNING") ?? null;
}

function completedExecutionActions(run: StoredExecutionRunForUndo) {
  const undoneActionIds = new Set(
    run.undoRuns
      .flatMap((undoRun) => undoRun.actions)
      .filter((action) => action.status === "COMPLETED")
      .map((action) => action.originalExecutionActionId),
  );

  return run.actions
    .filter(
      (action) =>
        action.status === "COMPLETED" &&
        removableExecutionActionTypes.has(action.actionType) &&
        !undoneActionIds.has(action.id),
    )
    .sort((left, right) => right.sequence - left.sequence);
}

function undoActionForExecutionAction(
  rootPath: string,
  action: StoredExecutionActionForUndo,
  sequence: number,
  issues: BridgeExecutionIssue[],
): UndoActionDraft | null {
  if (action.status !== "COMPLETED") {
    issues.push(
      issue(
        "UNDO_NOT_AVAILABLE",
        "This action was not completed",
        "The Bridge can only undo actions that completed during execution.",
        [action.id],
      ),
    );
    return null;
  }

  try {
    if (action.actionType === "CREATE_FOLDER") {
      const folder = resolveInsideRoot(rootPath, action.destinationRelativePath);

      return {
        actionType: "REMOVE_FOLDER",
        destinationPath: folder.resolvedPath,
        destinationRelativePath: folder.relativePath,
        originalAction: action,
        scannedFileChecksum: null,
        scannedFileLastModified: null,
        scannedFileSizeBytes: null,
        sequence,
        sourcePath: folder.resolvedPath,
        sourceRelativePath: folder.relativePath,
      };
    }

    const source = resolveInsideRoot(rootPath, action.destinationRelativePath);
    const destination = resolveInsideRoot(rootPath, action.sourceRelativePath);

    return {
      actionType:
        action.actionType === "RENAME_FILE" ? "RENAME_FILE" : "MOVE_FILE",
      destinationPath: destination.resolvedPath,
      destinationRelativePath: destination.relativePath,
      originalAction: action,
      scannedFileChecksum: null,
      scannedFileLastModified: null,
      scannedFileSizeBytes: null,
      sequence,
      sourcePath: source.resolvedPath,
      sourceRelativePath: source.relativePath,
    };
  } catch (error) {
    issues.push(
      issue(
        error instanceof Error &&
          error.message.includes("outside the connected folder")
          ? "PATH_OUTSIDE_ROOT"
          : "INVALID_PATH",
        "An undo path cannot be restored safely",
        error instanceof Error
          ? error.message
          : "The Bridge could not validate one undo path.",
        [action.id],
      ),
    );
    return null;
  }
}

function undoActionForBridgeExecutionAction(
  run: StoredExecutionRunForUndo,
  action: StoredExecutionActionForUndo,
  sequence: number,
  issues: BridgeExecutionIssue[],
): UndoActionDraft | null {
  if (action.status !== "COMPLETED") {
    issues.push(
      issue(
        "UNDO_NOT_AVAILABLE",
        "This action was not completed",
        "The Bridge can only undo actions that completed during execution.",
        [action.id],
      ),
    );
    return null;
  }

  const scannedFile = scannedFileForAction(run, action);

  if (action.actionType === "CREATE_FOLDER") {
    return {
      actionType: "REMOVE_FOLDER",
      destinationPath: action.destinationRelativePath,
      destinationRelativePath: action.destinationRelativePath,
      originalAction: action,
      scannedFileChecksum: null,
      scannedFileLastModified: null,
      scannedFileSizeBytes: null,
      sequence,
      sourcePath: action.destinationRelativePath,
      sourceRelativePath: action.destinationRelativePath,
    };
  }

  return {
    actionType: action.actionType === "RENAME_FILE" ? "RENAME_FILE" : "MOVE_FILE",
    destinationPath: action.sourceRelativePath,
    destinationRelativePath: action.sourceRelativePath,
    originalAction: action,
    scannedFileChecksum: scannedFile?.checksum ?? null,
    scannedFileLastModified: scannedFile?.lastModified ?? null,
    scannedFileSizeBytes: scannedFile?.sizeBytes ?? null,
    sequence,
    sourcePath: action.destinationRelativePath,
    sourceRelativePath: action.destinationRelativePath,
  };
}

function scannedFileForAction(
  run: StoredExecutionRunForUndo,
  action: StoredExecutionActionForUndo,
) {
  return run.organizationPlan.scanSession.scannedFiles.find(
    (file) =>
      pathKey(file.relativePath) === pathKey(action.destinationRelativePath) ||
      pathKey(file.localPath) ===
        pathKey(path.resolve(run.organizationPlan.scanSession.connectedFolder.localPath, ...action.destinationRelativePath.split("/"))),
  );
}

function fileMetadataMatches(
  scannedFile: NonNullable<
    ReturnType<typeof scannedFileForAction>
  >,
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

async function validateFileUndoAction(
  rootPath: string,
  run: StoredExecutionRunForUndo,
  action: UndoActionDraft,
  issues: BridgeExecutionIssue[],
) {
  const sourceStats = await pathExists(action.sourcePath);

  if (!sourceStats) {
    issues.push(
      issue(
        "MISSING_SOURCE",
        "A file to restore is missing",
        `${action.sourceRelativePath} could not be found.`,
        [action.originalAction.id],
      ),
    );
    return;
  }

  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    issues.push(
      issue(
        "SOURCE_NOT_FILE",
        "An item to restore is not a regular file",
        `${action.sourceRelativePath} is not a regular file the Bridge can restore.`,
        [action.originalAction.id],
      ),
    );
    return;
  }

  if (!isInsideRoot(rootPath, action.sourcePath)) {
    issues.push(
      issue(
        "PATH_OUTSIDE_ROOT",
        "A restore source is outside the connected folder",
        "The Bridge refused an undo source path that is not inside the connected folder.",
        [action.originalAction.id],
      ),
    );
    return;
  }

  if (await pathExists(action.destinationPath)) {
    issues.push(
      issue(
        "DESTINATION_CONFLICT",
        "The original location is occupied",
        `${action.destinationRelativePath} already exists. The Bridge will not overwrite files.`,
        [action.originalAction.id],
      ),
    );
  }

  const scannedFile = scannedFileForAction(run, action.originalAction);

  if (!scannedFile) {
    issues.push(
      issue(
        "VALIDATION_FAILED",
        "The file cannot be matched to the folder scan record",
        "The Bridge could not verify this file against the scan session before undoing it.",
        [action.originalAction.id],
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
          "A restored file changed after execution",
          `${action.sourceRelativePath} no longer matches the file checksum recorded after execution.`,
          [action.originalAction.id],
        ),
      );
    }
    return;
  }

  if (!fileMetadataMatches(scannedFile, sourceStats)) {
    issues.push(
      issue(
        "CHANGED_SOURCE",
        "A restored file changed after execution",
        `${action.sourceRelativePath} no longer matches the file metadata recorded after execution.`,
        [action.originalAction.id],
      ),
    );
  }
}

async function validateRemoveFolderAction(
  rootPath: string,
  action: UndoActionDraft,
  allActions: UndoActionDraft[],
  issues: BridgeExecutionIssue[],
) {
  if (!action.originalAction.createdFilesystemItem) {
    issues.push(
      issue(
        "FOLDER_NOT_CREATED_BY_BRIDGE",
        "A folder was not created by this execution",
        "The Bridge will only remove empty folders it created during the original execution.",
        [action.originalAction.id],
      ),
    );
    return;
  }

  const folderStats = await pathExists(action.sourcePath);

  if (!folderStats) {
    issues.push(
      issue(
        "MISSING_SOURCE",
        "A folder to remove is missing",
        `${action.sourceRelativePath} could not be found.`,
        [action.originalAction.id],
      ),
    );
    return;
  }

  if (!folderStats.isDirectory() || folderStats.isSymbolicLink()) {
    issues.push(
      issue(
        "DESTINATION_CONFLICT",
        "A folder path is no longer a folder",
        `${action.sourceRelativePath} is not an empty folder the Bridge can remove.`,
        [action.originalAction.id],
      ),
    );
    return;
  }

  if (!isInsideRoot(rootPath, action.sourcePath)) {
    issues.push(
      issue(
        "PATH_OUTSIDE_ROOT",
        "A folder to remove is outside the connected folder",
        "The Bridge refused an undo folder path that is not inside the connected folder.",
        [action.originalAction.id],
      ),
    );
    return;
  }

  try {
    const entries = await readdir(action.sourcePath);

    if (entries.length === 0) {
      return;
    }

    const entriesClearedBeforeRemoval = new Set(
      allActions
        .filter(
          (item) =>
            item.sequence < action.sequence &&
            path.dirname(item.sourcePath) === action.sourcePath,
        )
        .map((item) => path.basename(item.sourcePath)),
    );

    if (entries.every((entry) => entriesClearedBeforeRemoval.has(entry))) {
      return;
    }

    issues.push(
      issue(
        "FOLDER_NOT_EMPTY",
        "A folder is not empty",
        `${action.sourceRelativePath} still contains files or folders, so the Bridge will not remove it.`,
        [action.originalAction.id],
      ),
    );
  } catch {
    issues.push(
      issue(
        "FOLDER_NOT_EMPTY",
        "A folder could not be inspected",
        `${action.sourceRelativePath} could not be verified as empty.`,
        [action.originalAction.id],
      ),
    );
  }
}

async function validateUndoActions(
  rootPath: string,
  run: StoredExecutionRunForUndo,
  actions: UndoActionDraft[],
  issues: BridgeExecutionIssue[],
) {
  const destinationMap = new Map<string, string[]>();

  for (const action of actions) {
    destinationMap.set(action.destinationRelativePath, [
      ...(destinationMap.get(action.destinationRelativePath) ?? []),
      action.originalAction.id,
    ]);
  }

  for (const [destination, actionIds] of destinationMap.entries()) {
    if (actionIds.length > 1) {
      issues.push(
        issue(
          "DUPLICATE_UNDO_DESTINATION",
          "Multiple undo actions restore to the same place",
          `${destination} is restored by more than one undo action.`,
          actionIds,
        ),
      );
    }
  }

  for (const action of actions) {
    if (action.actionType === "REMOVE_FOLDER") {
      await validateRemoveFolderAction(rootPath, action, actions, issues);
    } else {
      await validateFileUndoAction(rootPath, run, action, issues);
    }
  }
}

async function loadExecutionRunForUndo(executionRunId: string) {
  const prisma = getPrismaClient();

  return prisma.executionRun.findUnique({
    include: {
      actions: {
        orderBy: {
          sequence: "asc",
        },
      },
      organizationPlan: {
        include: {
          scanSession: {
            include: {
              connectedFolder: {
                select: {
                  bridgeRootId: true,
                  createFolderPermission: true,
                  isEnabled: true,
                  localPath: true,
                  moveFilePermission: true,
                  readPermission: true,
                  renameFilePermission: true,
                  status: true,
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
    where: {
      id: executionRunId,
    },
  });
}

async function undoRootFor(
  run: StoredExecutionRunForUndo,
  issues: BridgeExecutionIssue[],
) {
  const library = run.organizationPlan.scanSession.connectedFolder;

  if (!library.isEnabled || library.status === "DISCONNECTED") {
    issues.push(
      issue(
        "VALIDATION_FAILED",
        "The connected library is disconnected",
        "Reconnect this library before previewing or undoing changes.",
      ),
    );
  } else if (library.status === "PAUSED") {
    issues.push(
      issue(
        "VALIDATION_FAILED",
        "The connected library is paused",
        "Resume this library before previewing or undoing changes.",
      ),
    );
  }

  try {
    return await validateConnectedLibraryPath(library.localPath);
  } catch {
    issues.push(
      issue(
        "ROOT_MISMATCH",
        "The connected folder could not be verified",
        "Reconnect this library before previewing or undoing execution.",
      ),
    );
    return path.normalize(run.organizationPlan.scanSession.connectedFolder.localPath);
  }
}

async function buildUndoPreview(
  run: StoredExecutionRunForUndo,
): Promise<{
  actions: UndoActionDraft[];
  preview: BridgeUndoPreview;
  rootPath: string;
}> {
  const issues: BridgeExecutionIssue[] = [];

  if (!executionIsUndoable(run)) {
    issues.push(
      issue(
        "UNDO_NOT_AVAILABLE",
        "This execution cannot be undone",
        "Only completed or partially completed execution runs can be restored.",
      ),
    );
  }

  if (existingCompletedUndo(run)) {
    issues.push(
      issue(
        "UNDO_ALREADY_COMPLETED",
        "These changes were already undone",
        "The Bridge will not repeat an undo run that already completed.",
      ),
    );
  }

  if (existingRunningUndo(run)) {
    issues.push(
      issue(
        "UNDO_RUNNING",
        "Undo is already running",
        "Wait for the active undo run to finish before starting another one.",
      ),
    );
  }

  const completedActions = completedExecutionActions(run);

  if (completedActions.length === 0) {
    issues.push(
      issue(
        "UNDO_NOT_AVAILABLE",
        "There are no completed actions to undo",
        "The Bridge found no completed file or folder changes from this execution.",
      ),
    );
  }

  const bridgeRootId = run.organizationPlan.scanSession.connectedFolder.bridgeRootId;
  const rootPath = bridgeRootId
    ? `bridge://${bridgeRootId}`
    : await undoRootFor(run, issues);
  const actions = completedActions
    .map((action, index) =>
      bridgeRootId
        ? undoActionForBridgeExecutionAction(run, action, index + 1, issues)
        : undoActionForExecutionAction(rootPath, action, index + 1, issues),
    )
    .filter((action): action is UndoActionDraft => action !== null);

  if (bridgeRootId) {
    try {
      const bridgePreview = await previewLocalBridgeUndo(
        bridgeRootId,
        actions.map(localBridgeUndoActionFor),
      );

      issues.push(...bridgePreview.issues.map(localBridgeUndoIssue));
    } catch (error) {
      issues.push(
        issue(
          "BRIDGE_UNAVAILABLE",
          "The local Bridge is unavailable",
          error instanceof Error
            ? error.message
            : "Open the NSN Bridge before previewing or undoing changes.",
        ),
      );
    }
  } else {
    await validateUndoActions(rootPath, run, actions, issues);
  }

  const classified = classifyUndoIssues(issues);
  const previewActions = actions.map(previewActionFor);

  return {
    actions,
    preview: {
      actions: previewActions,
      canUndo:
        classified.blockingIssues.length === 0 && previewActions.length > 0,
      estimatedOperations: previewActions.length,
      executionRunId: run.id,
      organizationPlanId: run.organizationPlanId,
      ...classified,
    },
    rootPath,
  };
}

export async function previewExecutionUndo(executionRunId: string) {
  const run = await loadExecutionRunForUndo(executionRunId);

  if (!run) {
    throw new BridgeUndoError(
      "The Librarian could not find that execution run.",
      404,
    );
  }

  return (await buildUndoPreview(run)).preview;
}

function safeUndoErrorCategory(error: unknown): BridgeExecutionIssueCategory {
  if (error instanceof BridgeUndoActionError) {
    return error.category;
  }

  if (error instanceof BridgeUndoError) {
    return "VALIDATION_FAILED";
  }

  if (error instanceof Error && error.message.includes("not empty")) {
    return "FOLDER_NOT_EMPTY";
  }

  return "FILESYSTEM_OPERATION_FAILED";
}

async function assertUndoActionStillSafe(
  rootPath: string,
  run: StoredExecutionRunForUndo,
  action: UndoActionDraft,
) {
  const issues: BridgeExecutionIssue[] = [];

  await validateUndoActions(rootPath, run, [action], issues);

  const blockingIssue = firstBlockingIssue(issues);

  if (blockingIssue) {
    throw new BridgeUndoActionError(
      blockingIssue.category,
      blockingIssue.description,
    );
  }
}

async function executeUndoAction(action: UndoActionDraft) {
  if (action.actionType === "REMOVE_FOLDER") {
    await rmdir(action.sourcePath);
    return;
  }

  if (await pathExists(action.destinationPath)) {
    throw new BridgeUndoActionError(
      "DESTINATION_CONFLICT",
      "The original location is occupied.",
    );
  }

  await rename(action.sourcePath, action.destinationPath);
}

async function updateScannedFileAfterUndo(
  run: StoredExecutionRunForUndo,
  action: UndoActionDraft,
) {
  if (action.actionType === "REMOVE_FOLDER") {
    return;
  }

  const scannedFile = scannedFileForAction(run, action.originalAction);

  if (!scannedFile) {
    return;
  }

  const prisma = getPrismaClient();
  const stats = await lstat(action.destinationPath);
  const checksum = scannedFile.checksum
    ? await checksumFile(action.destinationPath)
    : scannedFile.checksum;

  await prisma.scannedFile.update({
    data: {
      checksum,
      lastModified: stats.mtime,
      localPath: action.destinationPath,
      relativePath: action.destinationRelativePath,
      sizeBytes: BigInt(stats.size),
    },
    where: {
      id: scannedFile.id,
    },
  });
}

async function updateScannedFileAfterBridgeUndo(
  run: StoredExecutionRunForUndo,
  action: UndoActionDraft,
  result: {
    destinationChecksumAfter: string | null;
    lastModified: string | null;
    sizeBytes: string | null;
  },
  bridgeRootId: string,
) {
  if (action.actionType === "REMOVE_FOLDER") {
    return;
  }

  const scannedFile = scannedFileForAction(run, action.originalAction);

  if (!scannedFile) {
    return;
  }

  const prisma = getPrismaClient();

  await prisma.scannedFile.update({
    data: {
      checksum: result.destinationChecksumAfter ?? scannedFile.checksum,
      lastModified: result.lastModified
        ? new Date(result.lastModified)
        : scannedFile.lastModified,
      localPath: `bridge://${bridgeRootId}/${action.destinationRelativePath}`,
      relativePath: action.destinationRelativePath,
      sizeBytes:
        result.sizeBytes === null ? scannedFile.sizeBytes : BigInt(result.sizeBytes),
    },
    where: {
      id: scannedFile.id,
    },
  });
}

function finalUndoStatus(completedActions: number, failedActions: number) {
  if (failedActions === 0) {
    return "COMPLETED" as const;
  }

  return completedActions > 0 ? "PARTIALLY_COMPLETED" : "FAILED";
}

async function appendUndoHistory(
  executionRunId: string,
  status: UndoStatus,
) {
  const prisma = getPrismaClient();
  const plan = await prisma.organizationPlan.findFirst({
    select: {
      history: true,
      id: true,
    },
    where: {
      executionRuns: {
        some: {
          id: executionRunId,
        },
      },
    },
  });

  if (!plan) {
    return;
  }

  const now = new Date().toISOString();
  const existing = Array.isArray(plan.history) ? plan.history : [];

  await prisma.organizationPlan.update({
    data: {
      history: toJsonInput(
        [
          ...existing,
          {
            at: now,
            detail:
              status === "COMPLETED"
                ? "The Bridge restored the completed file and folder changes from an execution run."
                : "The Bridge attempted to restore execution changes and stopped safely before completing every action.",
            id: `history-undo-${now.replace(/[^a-z0-9]+/gi, "-")}`,
            label: status === "COMPLETED" ? "Execution undone" : "Undo stopped",
          },
        ].slice(-20),
      ),
    },
    where: {
      id: plan.id,
    },
  });
}

export async function executeExecutionUndo(
  executionRunId: string,
  confirmation: string,
) {
  if (confirmation !== "UNDO") {
    throw new BridgeUndoError(
      "Type UNDO before the Bridge can restore these changes.",
      400,
    );
  }

  const prisma = getPrismaClient();
  const existingRun = await loadExecutionRunForUndo(executionRunId);

  if (!existingRun) {
    throw new BridgeUndoError(
      "The Librarian could not find that execution run.",
      404,
    );
  }

  const { actions, preview, rootPath } = await buildUndoPreview(existingRun);

  if (!preview.canUndo) {
    throw new BridgeUndoError(
      "The Bridge found safety issues that must be resolved before undo.",
      422,
      preview,
    );
  }

  const undoStartedAt = new Date();
  const undoRun = await prisma.$transaction(
    async (transaction) => {
      const existingUndo = await transaction.undoRun.findFirst({
        where: {
          executionRunId,
          status: {
            in: ["RUNNING", "COMPLETED"],
          },
        },
      });

      if (existingUndo?.status === "COMPLETED") {
        throw new BridgeUndoError(
          "The Bridge has already restored these completed changes.",
          409,
          preview,
        );
      }

      if (existingUndo?.status === "RUNNING") {
        throw new BridgeUndoError(
          "An undo run is already active for this execution.",
          409,
          preview,
        );
      }

      return transaction.undoRun.create({
        data: {
          actions: {
            create: actions.map((action) => ({
              actionType: action.actionType,
              destinationRelativePath: action.destinationRelativePath,
              originalExecutionActionId: action.originalAction.id,
              sequence: action.sequence,
              sourceRelativePath: action.sourceRelativePath,
              status: "PENDING",
            })),
          },
          executionRunId,
          startedAt: undoStartedAt,
          status: "RUNNING",
          totalActions: actions.length,
        },
        include: {
          actions: {
            orderBy: {
              sequence: "asc",
            },
          },
        },
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  );
  const undoRecordsBySequence = new Map(
    undoRun.actions.map((action) => [action.sequence, action]),
  );
  let completedActions = 0;
  let failedActions = 0;
  let safeRunErrorCategory: BridgeExecutionIssueCategory | null = null;
  const bridgeRootId = existingRun.organizationPlan.scanSession.connectedFolder.bridgeRootId;

  if (bridgeRootId) {
    try {
      const bridgeUndo = await executeLocalBridgeUndoActions(
        bridgeRootId,
        actions.map(localBridgeUndoActionFor),
      );
      const resultByActionId = new Map(
        bridgeUndo.actions.map((action) => [action.actionId, action]),
      );

      for (const action of actions) {
        const actionRecord = undoRecordsBySequence.get(action.sequence);
        const result = resultByActionId.get(action.originalAction.id);

        if (!actionRecord || !result || result.status === "PENDING") {
          continue;
        }

        await prisma.undoAction.update({
          data: {
            completedAt: new Date(),
            safeErrorCategory: result.safeErrorCategory,
            startedAt: new Date(),
            status: result.status,
          },
          where: {
            id: actionRecord.id,
          },
        });

        if (result.status === "COMPLETED") {
          await updateScannedFileAfterBridgeUndo(
            existingRun,
            action,
            result,
            bridgeRootId,
          );
        }
      }

      completedActions = bridgeUndo.completedActions;
      failedActions = bridgeUndo.failedActions;
      safeRunErrorCategory =
        (bridgeUndo.actions.find((action) => action.safeErrorCategory)
          ?.safeErrorCategory as BridgeExecutionIssueCategory | undefined) ??
        null;
    } catch {
      failedActions = actions.length;
      safeRunErrorCategory = "FILESYSTEM_OPERATION_FAILED";

      await prisma.undoAction.updateMany({
        data: {
          completedAt: new Date(),
          safeErrorCategory: safeRunErrorCategory,
          startedAt: new Date(),
          status: "FAILED",
        },
        where: {
          undoRunId: undoRun.id,
        },
      });
    }

    const completedAt = new Date();
    const status = finalUndoStatus(completedActions, failedActions);
    const durationMs = Math.max(
      0,
      completedAt.getTime() - undoStartedAt.getTime(),
    );
    const [updatedUndoRun, updatedExecutionRun] = await prisma.$transaction([
      prisma.undoRun.update({
        data: {
          completedActions,
          completedAt,
          durationMs,
          failedActions,
          safeErrorCategory: safeRunErrorCategory,
          status,
        },
        include: {
          actions: {
            orderBy: {
              sequence: "asc",
            },
          },
        },
        where: {
          id: undoRun.id,
        },
      }),
      prisma.executionRun.findUniqueOrThrow({
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
        where: {
          id: executionRunId,
        },
      }),
    ]);

    await appendUndoHistory(executionRunId, status);

    try {
      await recordUndoNotebookEntry(updatedUndoRun.id);
    } catch {
      // Notebook reflections should never block undo results.
    }

    const executionRun: BridgeExecutionRunSummary =
      summarizeExecutionRun(updatedExecutionRun);

    return {
      executionRun,
      preview,
      run: summarizeUndoRun(updatedUndoRun),
      scanSessionId: existingRun.organizationPlan.scanSessionId,
    };
  }

  for (const action of actions) {
    const actionRecord = undoRecordsBySequence.get(action.sequence);

    if (!actionRecord) {
      continue;
    }

    await prisma.undoAction.update({
      data: {
        startedAt: new Date(),
        status: "RUNNING",
      },
      where: {
        id: actionRecord.id,
      },
    });

    try {
      await assertUndoActionStillSafe(rootPath, existingRun, action);
      await executeUndoAction(action);
      await updateScannedFileAfterUndo(existingRun, action);

      completedActions += 1;
      await prisma.undoAction.update({
        data: {
          completedAt: new Date(),
          status: "COMPLETED",
        },
        where: {
          id: actionRecord.id,
        },
      });
    } catch (error) {
      failedActions += 1;
      safeRunErrorCategory = safeUndoErrorCategory(error);
      await prisma.undoAction.update({
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

  const completedAt = new Date();
  const status = finalUndoStatus(completedActions, failedActions);
  const durationMs = Math.max(0, completedAt.getTime() - undoStartedAt.getTime());
  const [updatedUndoRun, updatedExecutionRun] = await prisma.$transaction([
    prisma.undoRun.update({
      data: {
        completedActions,
        completedAt,
        durationMs,
        failedActions,
        safeErrorCategory: safeRunErrorCategory,
        status,
      },
      include: {
        actions: {
          orderBy: {
            sequence: "asc",
          },
        },
      },
      where: {
        id: undoRun.id,
      },
    }),
    prisma.executionRun.findUniqueOrThrow({
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
      where: {
        id: executionRunId,
      },
    }),
  ]);

  await appendUndoHistory(executionRunId, status);

  try {
    await recordUndoNotebookEntry(updatedUndoRun.id);
  } catch {
    // Notebook reflections should never block undo results.
  }

  const executionRun: BridgeExecutionRunSummary =
    summarizeExecutionRun(updatedExecutionRun);

  return {
    executionRun,
    preview,
    run: summarizeUndoRun(updatedUndoRun),
    scanSessionId: existingRun.organizationPlan.scanSessionId,
  };
}
