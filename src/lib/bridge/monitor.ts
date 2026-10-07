import { currentReadableRootWhere } from "./current-readable-root";
import { lockMonitoringBatch, monitoringLeaseMs, renewMonitoringBatch, type MonitoringOwner } from "./monitoring-authority";
import { createBridgeCloudCommand } from "./cloud-coordinator";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants as fsConstants, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { access, lstat } from "node:fs/promises";
import path from "node:path";

import { Prisma, type MonitoringEvent } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import { ensureKnowledgeGraphBackfill } from "@/lib/knowledge/queries";
import { recordMonitoringBatchNotebookEntry } from "@/lib/library/notebook";

import { processBridgeScanSession } from "./processing-pipeline";
import { createBridgeScanSessionFromScan } from "./scan-sessions";
import {
  ConnectedLibraryError,
  ensureDeveloperFallbackConnectedLibrary,
  requireConnectedLibraryPermission,
  validateConnectedLibraryPath,
} from "./connected-libraries";
import { extractAudioMetadata } from "./audio-metadata";
import { extractVideoMetadata } from "./video-metadata";
import { classifyBridgeFileType } from "./file-classifier";
import {
  getConfiguredBridgeTestFolder,
  isDevelopmentBridgeScannerEnabled,
} from "./scanner";
import {
  LocalBridgeClientError,
  pauseLocalBridgeWatcher,
  resolveLocalBridgeFile,
  resumeLocalBridgeWatcher,
  scanLocalBridgeRoot,
  startLocalBridgeWatcher,
  stopLocalBridgeWatcher,
  takeLocalBridgeWatcherEvents,
} from "./local-bridge-client";
import type { LocalBridgeChangeEvent } from "./local-bridge-client";
import type {
  BridgeMonitoringBatchStatus,
  BridgeMonitoringDashboard,
  BridgeMonitoringEventSummary,
  BridgeMonitoringEventType,
  BridgeMonitoringFolderSummary,
  BridgeMonitoringProcessingStatus,
  BridgeMonitoringState,
  BridgeScannedFileDraft,
} from "./types";

type WatchHandle = {
  generation: number;
  rootPath: string;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  watcher: FSWatcher;
};

type StablePathSnapshot =
  | {
      exists: false;
      kind: "missing";
    }
  | {
      checksum: string | null;
      fileType: string;
      kind: "file";
      audioMetadata?: BridgeScannedFileDraft["audioMetadata"];
      videoMetadata?: BridgeScannedFileDraft["videoMetadata"];
      lastModified: Date;
      localPath: string;
      readStatus: BridgeScannedFileDraft["readStatus"];
      relativePath: string;
      sourceCreatedAt: Date;
      sizeBytes: bigint;
    }
  | {
      kind: "directory";
      lastModified: Date;
      relativePath: string;
      sizeBytes: bigint;
    };

type BaselineFile = {
  checksum: string | null;
  fileType: string;
  id: string;
  lastModified: Date | null;
  libraryDocumentId: string | null;
  localPath: string;
  relativePath: string;
  sizeBytes: bigint | null;
};

type MonitoringEventInput = {
  expectedRootRevision?: number;
  checksumAfter?: string | null;
  checksumBefore?: string | null;
  connectedFolderId: string;
  currentRelativePath?: string | null;
  detectedAt?: Date;
  eventKey?: string | null;
  eventType: BridgeMonitoringEventType;
  modifiedAtAfter?: Date | null;
  modifiedAtBefore?: Date | null;
  previousRelativePath?: string | null;
  processingStatus?: BridgeMonitoringProcessingStatus;
  renameMoveConfidence?: number | null;
  safeErrorCategory?: string | null;
  sizeAfter?: bigint | null;
  sizeBefore?: bigint | null;
};

const globalForBridgeMonitor = globalThis as unknown as {
  nsnBridgeMonitorWatchers?: Map<string, WatchHandle>;
};

const watcherRegistry =
  globalForBridgeMonitor.nsnBridgeMonitorWatchers ??
  new Map<string, WatchHandle>();

globalForBridgeMonitor.nsnBridgeMonitorWatchers = watcherRegistry;

const staleProcessingThresholdMs = 5 * 60 * 1000;
const ignoredFolderNames = new Set([
  "$recycle.bin",
  "system volume information",
  ".fseventsd",
  ".spotlight-v100",
  ".trashes",
  ".git",
  ".hg",
  ".svn",
]);
const ignoredSystemFileNames = new Set([
  ".ds_store",
  "desktop.ini",
  "thumbs.db",
]);
const stabilizationDelayMs = 700;
const watchDebounceMs = 900;
const monitoringQueueLimit = 25;

export class BridgeMonitoringError extends Error {
  statusCode: number;
  category: string;

  constructor(message: string, statusCode = 400, category = "MONITORING_ERROR") {
    super(message);
    this.name = "BridgeMonitoringError";
    this.statusCode = statusCode;
    this.category = category;
  }
}

function bridgeRootUri(rootId: string, relativePath = "") {
  const base = `bridge://${rootId}`;
  const normalizedRelativePath = normalizeIncomingRelativePath(relativePath);

  return normalizedRelativePath ? `${base}/${normalizedRelativePath}` : base;
}

function safeMonitoringMessageForCategory(category: string) {
  if (category === "BRIDGE_UNAVAILABLE") {
    return "The NSN Bridge is not currently available.";
  }

  if (
    category === "ROOT_NOT_REGISTERED" ||
    category === "ROOT_NOT_FOUND" ||
    category === "ROOT_DISCONNECTED" ||
    category === "ROOT_PAUSED"
  ) {
    return "This folder needs to be reconnected before watching can begin.";
  }

  if (category === "READ_PERMISSION_REQUIRED") {
    return "Reading permission is required before this folder can be watched.";
  }

  if (category === "WATCH_PERMISSION_REQUIRED") {
    return "Watching permission is not enabled for this folder.";
  }

  if (category === "ROOT_UNAVAILABLE") {
    return "The selected folder is not currently available.";
  }

  return "The Librarian could not begin watching this folder.";
}

function localBridgeMonitoringError(error: unknown, fallbackCategory: string) {
  const category =
    error instanceof LocalBridgeClientError
      ? error.code
      : fallbackCategory;

  return new BridgeMonitoringError(
    safeMonitoringMessageForCategory(category),
    error instanceof LocalBridgeClientError ? error.statusCode : 503,
    category,
  );
}

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}



function displayNameForFolder(folderPath: string) {
  return path.basename(folderPath) || folderPath;
}

function monitoringPermissionError(error: ConnectedLibraryError) {
  const message = error.message.toLowerCase();
  let category = "MONITORING_PERMISSION_DENIED";

  if (message.includes("read files")) {
    category = "READ_PERMISSION_REQUIRED";
  } else if (message.includes("watch")) {
    category = "WATCH_PERMISSION_REQUIRED";
  } else if (message.includes("reconnect")) {
    category = "ROOT_NOT_REGISTERED";
  }

  return new BridgeMonitoringError(
    safeMonitoringMessageForCategory(category),
    error.statusCode,
    category,
  );
}

async function connectedLibraryForMonitoring(
  connectedFolderId: string,
  actionLabel: string,
) {
  try {
    await requireConnectedLibraryPermission(
      connectedFolderId,
      "readPermission",
      "read files before watching changes",
    );
    const folder = await requireConnectedLibraryPermission(
      connectedFolderId,
      "watchPermission",
      actionLabel,
    );
    const rootPath = await validateConnectedLibraryPath(folder.localPath);

    return {
      folder,
      rootPath,
    };
  } catch (error) {
    if (error instanceof ConnectedLibraryError) {
      throw monitoringPermissionError(error);
    }

    throw error;
  }
}

async function monitoringContextForFolder(
  connectedFolderId: string,
  actionLabel: string,
) {
  try {
    await requireConnectedLibraryPermission(
      connectedFolderId,
      "readPermission",
      "read files before watching changes",
    );
    const folder = await requireConnectedLibraryPermission(
      connectedFolderId,
      "watchPermission",
      actionLabel,
    );

    if (folder.bridgeRootId) {
      return {
        folder,
        rootPath: bridgeRootUri(folder.bridgeRootId),
      };
    }

    const rootPath = await validateConnectedLibraryPath(folder.localPath);

    return {
      folder,
      rootPath,
    };
  } catch (error) {
    if (error instanceof ConnectedLibraryError) {
      throw monitoringPermissionError(error);
    }

    throw error;
  }
}

function relativePathFor(rootPath: string, localPath: string) {
  const relativePath = path.relative(rootPath, localPath);

  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new BridgeMonitoringError(
      "The Bridge only watches files inside the connected folder.",
      403,
    );
  }

  return relativePath.split(path.sep).join(path.posix.sep);
}

function normalizeIncomingRelativePath(value: string) {
  return value
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function shouldIgnorePath(relativePath: string) {
  const parts = normalizeIncomingRelativePath(relativePath).split("/");
  const fileName = parts.at(-1) ?? "";

  if (ignoredSystemFileNames.has(fileName.toLowerCase())) {
    return true;
  }

  return parts.some((part) => {
    const normalized = part.toLowerCase();

    return part.startsWith(".") || ignoredFolderNames.has(normalized);
  });
}

function safeResolveRelativePath(rootPath: string, relativePath: string) {
  const normalizedRelativePath = normalizeIncomingRelativePath(relativePath);

  if (!normalizedRelativePath) {
    throw new BridgeMonitoringError(
      "The Bridge could not identify the changed path safely.",
      400,
    );
  }

  if (path.isAbsolute(normalizedRelativePath)) {
    throw new BridgeMonitoringError(
      "The Bridge only watches relative paths inside the connected folder.",
      403,
    );
  }

  const resolvedPath = path.normalize(
    path.resolve(rootPath, normalizedRelativePath),
  );
  const relativeToRoot = path.relative(rootPath, resolvedPath);

  if (
    !relativeToRoot ||
    relativeToRoot.startsWith("..") ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new BridgeMonitoringError(
      "The Bridge only watches files inside the connected folder.",
      403,
    );
  }

  return resolvedPath;
}

function classifyFileType(relativePath: string) {
  return classifyBridgeFileType(relativePath);
}

function readStatusForFileType(fileType: string) {
  return fileType === "UNSUPPORTED" ? "UNSUPPORTED" : "SUPPORTED";
}

function checksumFile(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function sleep(delayMs: number) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function stablePathSnapshot(
  rootPath: string,
  relativePath: string,
): Promise<StablePathSnapshot> {
  const localPath = safeResolveRelativePath(rootPath, relativePath);
  let firstStats;

  try {
    firstStats = await lstat(localPath);
  } catch {
    return {
      exists: false,
      kind: "missing",
    };
  }

  await sleep(stabilizationDelayMs);

  let secondStats;

  try {
    secondStats = await lstat(localPath);
  } catch {
    return {
      exists: false,
      kind: "missing",
    };
  }

  if (
    firstStats.size !== secondStats.size ||
    firstStats.mtimeMs !== secondStats.mtimeMs
  ) {
    await sleep(stabilizationDelayMs);
    secondStats = await lstat(localPath);
  }

  const normalizedRelativePath = relativePathFor(rootPath, localPath);

  if (secondStats.isDirectory()) {
    return {
      kind: "directory",
      lastModified: secondStats.mtime,
      relativePath: normalizedRelativePath,
      sizeBytes: BigInt(secondStats.size),
    };
  }

  if (!secondStats.isFile() || secondStats.isSymbolicLink()) {
    return {
      checksum: null,
      fileType: "UNSUPPORTED",
      kind: "file",
      lastModified: secondStats.mtime,
      localPath,
      readStatus: "UNSUPPORTED",
      relativePath: normalizedRelativePath,
      sourceCreatedAt: secondStats.birthtime,
      sizeBytes: BigInt(secondStats.size),
    };
  }

  const fileType = classifyFileType(normalizedRelativePath);
  const readStatus = readStatusForFileType(fileType);

  if (readStatus === "UNSUPPORTED") {
    return {
      checksum: null,
      fileType,
      kind: "file",
      lastModified: secondStats.mtime,
      localPath,
      readStatus,
      relativePath: normalizedRelativePath,
      sourceCreatedAt: secondStats.birthtime,
      sizeBytes: BigInt(secondStats.size),
    };
  }

  try {
    await access(localPath, fsConstants.R_OK);
    const audioMetadata = fileType.startsWith("AUDIO_")
      ? await extractAudioMetadata(localPath, normalizedRelativePath, secondStats)
      : null;
    const videoMetadata = fileType.startsWith("VIDEO_")
      ? await extractVideoMetadata(localPath, normalizedRelativePath, secondStats)
      : null;

    return {
      audioMetadata,
      checksum: await checksumFile(localPath),
      fileType,
      kind: "file",
      lastModified: secondStats.mtime,
      localPath,
      readStatus,
      relativePath: normalizedRelativePath,
      sourceCreatedAt: secondStats.birthtime,
      sizeBytes: BigInt(secondStats.size),
      videoMetadata,
    };
  } catch {
    return {
      checksum: null,
      fileType,
      kind: "file",
      lastModified: secondStats.mtime,
      localPath,
      readStatus: "FAILED",
      relativePath: normalizedRelativePath,
      sourceCreatedAt: secondStats.birthtime,
      sizeBytes: BigInt(secondStats.size),
    };
  }
}

async function connectedFolderForConfiguredRoot() {
  const prisma = getPrismaClient();
  const rootPath = await getConfiguredBridgeTestFolder();
  const fallbackLibrary = await ensureDeveloperFallbackConnectedLibrary();

  if (fallbackLibrary) {
    return prisma.connectedLibrary.findUniqueOrThrow({
      where: {
        id: fallbackLibrary.id,
      },
    });
  }

  return prisma.connectedLibrary.upsert({
    create: {
      displayName: displayNameForFolder(rootPath),
      isEnabled: true,
      localPath: rootPath,
    },
    update: {
      displayName: displayNameForFolder(rootPath),
      isEnabled: true,
    },
    where: {
      localPath: rootPath,
    },
  });
}

function monitoringStateLabel(state: BridgeMonitoringState) {
  if (state === "WATCHING") {
    return "Watching for changes";
  }

  if (state === "PAUSED") {
    return "Paused";
  }

  if (state === "NEEDS_ATTENTION") {
    return "Needs attention";
  }

  if (state === "STOPPED") {
    return "Stopped";
  }

  return "Not connected";
}

function monitoringEventType(value: string): BridgeMonitoringEventType {
  return [
    "FILE_ADDED",
    "FILE_MODIFIED",
    "FILE_RENAMED",
    "FILE_MOVED",
    "FILE_DELETED",
    "FOLDER_ADDED",
    "FOLDER_RENAMED",
    "FOLDER_MOVED",
    "FOLDER_DELETED",
  ].includes(value)
    ? (value as BridgeMonitoringEventType)
    : "FILE_MODIFIED";
}

function monitoringProcessingStatus(
  value: string,
): BridgeMonitoringProcessingStatus {
  return [
    "QUEUED",
    "STABILIZING",
    "PROCESSING",
    "COMPLETED",
    "NEEDS_ATTENTION",
    "SKIPPED",
    "FAILED",
  ].includes(value)
    ? (value as BridgeMonitoringProcessingStatus)
    : "NEEDS_ATTENTION";
}

function monitoringBatchStatus(value: string): BridgeMonitoringBatchStatus {
  return [
    "OPEN",
    "PROCESSING",
    "READY_FOR_REVIEW",
    "COMPLETED",
    "COMPLETED_WITH_ERRORS",
    "FAILED",
  ].includes(value)
    ? (value as BridgeMonitoringBatchStatus)
    : "FAILED";
}

function monitoringState(value: string): BridgeMonitoringState {
  return [
    "NOT_CONNECTED",
    "WATCHING",
    "PAUSED",
    "NEEDS_ATTENTION",
    "STOPPED",
  ].includes(value)
    ? (value as BridgeMonitoringState)
    : "NEEDS_ATTENTION";
}

function toEventSummary(event: {
  currentRelativePath: string | null;
  detectedAt: Date;
  eventType: string;
  id: string;
  modifiedAtAfter: Date | null;
  modifiedAtBefore: Date | null;
  previousRelativePath: string | null;
  processingStatus: string;
  renameMoveConfidence: number | null;
  safeErrorCategory: string | null;
  scanSessionId: string | null;
  sizeAfter: bigint | null;
  sizeBefore: bigint | null;
  stabilizedAt: Date | null;
}): BridgeMonitoringEventSummary {
  return {
    currentRelativePath: event.currentRelativePath,
    detectedAt: event.detectedAt.toISOString(),
    eventType: monitoringEventType(event.eventType),
    id: event.id,
    modifiedAtAfter: event.modifiedAtAfter?.toISOString() ?? null,
    modifiedAtBefore: event.modifiedAtBefore?.toISOString() ?? null,
    previousRelativePath: event.previousRelativePath,
    processingStatus: monitoringProcessingStatus(event.processingStatus),
    renameMoveConfidence: event.renameMoveConfidence,
    safeErrorCategory: event.safeErrorCategory,
    scanSessionId: event.scanSessionId,
    sizeAfter: event.sizeAfter?.toString() ?? null,
    sizeBefore: event.sizeBefore?.toString() ?? null,
    stabilizedAt: event.stabilizedAt?.toISOString() ?? null,
  };
}

function toBatchSummary(batch: {
  completedAt: Date | null;
  connectedFolderId: string;
  failedEvents: number;
  fileEvents: number;
  folderEvents: number;
  id: string;
  notebookEntryId: string | null;
  notificationSummary: string | null;
  notificationTitle: string | null;
  scanSessionId: string | null;
  startedAt: Date;
  status: string;
  supportedFileEvents: number;
  totalEvents: number;
  unsupportedFileEvents: number;
}) {
  return {
    completedAt: batch.completedAt?.toISOString() ?? null,
    connectedFolderId: batch.connectedFolderId,
    failedEvents: batch.failedEvents,
    fileEvents: batch.fileEvents,
    folderEvents: batch.folderEvents,
    id: batch.id,
    notebookEntryId: batch.notebookEntryId,
    notificationSummary: batch.notificationSummary,
    notificationTitle: batch.notificationTitle,
    scanSessionId: batch.scanSessionId,
    startedAt: batch.startedAt.toISOString(),
    status: monitoringBatchStatus(batch.status),
    supportedFileEvents: batch.supportedFileEvents,
    totalEvents: batch.totalEvents,
    unsupportedFileEvents: batch.unsupportedFileEvents,
  };
}

async function latestBaselineFiles(connectedFolderId: string, relativePath?: string) {
  const prisma = getPrismaClient();
  const scan = await prisma.scanSession.findFirst({ select: { id: true },
    where: { connectedFolderId, status: { in: ["READING", "EXAMINING", "GENERATING_SUGGESTIONS", "COMPLETED", "COMPLETED_WITH_ERRORS"] } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
  if (!scan) return [];
  const files = await prisma.scannedFile.findMany({
    orderBy: {
      createdAt: "desc",
    },
    select: {
      checksum: true,
      fileType: true,
      id: true,
      lastModified: true,
      libraryDocumentId: true,
      localPath: true,
      relativePath: true,
      sizeBytes: true,
      sourceUnavailableAt: true,
    },
    where: {
      sessionId: scan.id, relativePath, sourceUnavailableAt: null,
    },
  });
  const byPath = new Map<string, BaselineFile>();

  for (const file of files) {
    if (file.sourceUnavailableAt || byPath.has(file.relativePath)) {
      continue;
    }

    byPath.set(file.relativePath, {
      checksum: file.checksum,
      fileType: file.fileType,
      id: file.id,
      lastModified: file.lastModified,
      libraryDocumentId: file.libraryDocumentId,
      localPath: file.localPath,
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
    });
  }

  return [...byPath.values()];
}

function sameMetadata(
  baseline: Pick<BaselineFile, "checksum" | "lastModified" | "sizeBytes">,
  snapshot: Pick<
    Extract<StablePathSnapshot, { kind: "file" }>,
    "checksum" | "lastModified" | "sizeBytes"
  >,
) {
  if (baseline.checksum && snapshot.checksum) {
    return baseline.checksum === snapshot.checksum;
  }

  return (
    baseline.sizeBytes === snapshot.sizeBytes &&
    baseline.lastModified?.getTime() === snapshot.lastModified.getTime()
  );
}

function renameOrMoveType(previousPath: string, currentPath: string) {
  const previousFolder = path.posix.dirname(previousPath);
  const currentFolder = path.posix.dirname(currentPath);
  const previousName = path.posix.basename(previousPath);
  const currentName = path.posix.basename(currentPath);

  if (previousFolder !== currentFolder && previousName === currentName) {
    return "FILE_MOVED" as const;
  }

  if (previousFolder === currentFolder && previousName !== currentName) {
    return "FILE_RENAMED" as const;
  }

  return "FILE_MOVED" as const;
}

function eventIdentityKey(input: MonitoringEventInput) {
  if (input.eventKey) {
    return input.eventKey;
  }

  const contentKey =
    input.checksumAfter ??
    input.checksumBefore ??
    [
      input.sizeAfter?.toString() ?? input.sizeBefore?.toString() ?? "",
      input.modifiedAtAfter?.getTime().toString() ??
        input.modifiedAtBefore?.getTime().toString() ??
        "",
    ].join(":");

  return [
    input.connectedFolderId,
    input.eventType,
    input.previousRelativePath ?? "",
    input.currentRelativePath ?? "",
    contentKey,
  ].join("\u001f");
}

async function enqueueMonitoringEvent(input: MonitoringEventInput, client?: Prisma.TransactionClient): Promise<MonitoringEvent> {
  if (!client) return getPrismaClient().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${input.connectedFolderId} FOR SHARE`;
    if (!await tx.connectedLibrary.count({ where: { id: input.connectedFolderId, ...currentReadableRootWhere,
      watchPermission: true, nativeConnectionRevision: input.expectedRootRevision } }))
      throw new BridgeMonitoringError("The root no longer authorizes this watcher.", 409, "WATCH_AUTHORITY_CHANGED");
    return enqueueMonitoringEvent(input, tx);
  });
  const prisma = client;
  const eventKey = eventIdentityKey(input);

    return prisma.monitoringEvent.upsert({
      create: {
        checksumAfter: input.checksumAfter ?? null,
        checksumBefore: input.checksumBefore ?? null,
        connectedFolderId: input.connectedFolderId,
        currentRelativePath: input.currentRelativePath ?? null,
        detectedAt: input.detectedAt ?? new Date(),
        eventKey,
        eventType: input.eventType,
        modifiedAtAfter: input.modifiedAtAfter ?? null,
        modifiedAtBefore: input.modifiedAtBefore ?? null,
        previousRelativePath: input.previousRelativePath ?? null,
        processingStatus: input.processingStatus ?? "QUEUED",
        renameMoveConfidence: input.renameMoveConfidence ?? null,
        safeErrorCategory: input.safeErrorCategory ?? null,
        sizeAfter: input.sizeAfter ?? null,
        sizeBefore: input.sizeBefore ?? null,
        stabilizedAt: new Date(),
      },
      update: {
        detectedAt: input.detectedAt ?? new Date(),
        safeErrorCategory: input.safeErrorCategory ?? null,
        stabilizedAt: new Date(),
      },
      where: {
        eventKey,
      },
    });
}

function eventFromSnapshot(
  connectedFolderId: string,
  snapshot: Extract<StablePathSnapshot, { kind: "file" }>,
  baselineFiles: BaselineFile[],
  lookup?: { paths: Map<string, BaselineFile>; checksums: Map<string, BaselineFile> },
): MonitoringEventInput | null {
  const samePath = lookup ? lookup.paths.get(snapshot.relativePath) : baselineFiles.find((file) => file.relativePath === snapshot.relativePath);

  if (samePath) {
    if (sameMetadata(samePath, snapshot)) {
      return null;
    }

    return {
      checksumAfter: snapshot.checksum,
      checksumBefore: samePath.checksum,
      connectedFolderId,
      currentRelativePath: snapshot.relativePath,
      eventType: "FILE_MODIFIED",
      modifiedAtAfter: snapshot.lastModified,
      modifiedAtBefore: samePath.lastModified,
      previousRelativePath: samePath.relativePath,
      sizeAfter: snapshot.sizeBytes,
      sizeBefore: samePath.sizeBytes,
    };
  }

  const checksumMatch = snapshot.checksum
    ? (lookup ? lookup.checksums.get(snapshot.checksum) : baselineFiles.find((file) => file.checksum === snapshot.checksum))
    : null;

  if (checksumMatch) {
    return {
      checksumAfter: snapshot.checksum,
      checksumBefore: checksumMatch.checksum,
      connectedFolderId,
      currentRelativePath: snapshot.relativePath,
      eventType: renameOrMoveType(checksumMatch.relativePath, snapshot.relativePath),
      modifiedAtAfter: snapshot.lastModified,
      modifiedAtBefore: checksumMatch.lastModified,
      previousRelativePath: checksumMatch.relativePath,
      renameMoveConfidence: 0.88,
      sizeAfter: snapshot.sizeBytes,
      sizeBefore: checksumMatch.sizeBytes,
    };
  }

  return {
    checksumAfter: snapshot.checksum,
    connectedFolderId,
    currentRelativePath: snapshot.relativePath,
    eventType: "FILE_ADDED",
    modifiedAtAfter: snapshot.lastModified,
    sizeAfter: snapshot.sizeBytes,
  };
}

function safeEventDate(value: string) {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function localBridgeEventErrorCategory(error: unknown) {
  if (error instanceof LocalBridgeClientError) {
    if (error.code === "BRIDGE_UNAVAILABLE") {
      return "BRIDGE_UNAVAILABLE";
    }

    if (
      error.code === "ROOT_NOT_FOUND" ||
      error.code === "ROOT_DISCONNECTED" ||
      error.code === "ROOT_PAUSED"
    ) {
      return "ROOT_NOT_REGISTERED";
    }

    if (error.code === "PERMISSION_DENIED") {
      return "WATCH_PERMISSION_REQUIRED";
    }

    if (
      error.code === "SOURCE_FILE_MISSING" ||
      error.code === "ROOT_UNAVAILABLE"
    ) {
      return "ROOT_UNAVAILABLE";
    }

    return error.code;
  }

  return "WATCH_EVENT_FAILED";
}

async function localBridgeSnapshot(
  bridgeRootId: string,
  relativePath: string,
): Promise<Extract<StablePathSnapshot, { kind: "file" }>> {
  const resolved = await resolveLocalBridgeFile(bridgeRootId, relativePath);
  const normalizedRelativePath = normalizeIncomingRelativePath(
    resolved.relativePath,
  );
  const fileType = classifyFileType(normalizedRelativePath);
  const readStatus = readStatusForFileType(fileType);

  return {
    checksum:
      readStatus === "SUPPORTED"
        ? await checksumFile(resolved.localPath).catch(() => null)
        : null,
    fileType,
    kind: "file",
    lastModified: resolved.lastModified,
    localPath: bridgeRootUri(bridgeRootId, normalizedRelativePath),
    readStatus,
    relativePath: normalizedRelativePath,
    sourceCreatedAt: resolved.sourceCreatedAt ?? resolved.lastModified,
    sizeBytes: resolved.sizeBytes,
  };
}

async function enqueueLocalBridgeChange(
  folder: {
    bridgeRootId: string | null;
    id: string;
    nativeConnectionRevision: number;
  },
  event: LocalBridgeChangeEvent,
  baselineFiles: BaselineFile[],
  lookup: { paths: Map<string, BaselineFile>; checksums: Map<string, BaselineFile> },
) {
  if (!folder.bridgeRootId || event.rootId !== folder.bridgeRootId) {
    return;
  }

  const relativePath = normalizeIncomingRelativePath(event.relativePath);

  if (!relativePath || shouldIgnorePath(relativePath)) {
    return;
  }

  if (event.eventType.startsWith("FOLDER_")) {
    await enqueueMonitoringEvent({
      connectedFolderId: folder.id, expectedRootRevision: folder.nativeConnectionRevision,
      currentRelativePath:
        event.eventType === "FOLDER_DELETED" ? null : relativePath,
      eventType: monitoringEventType(event.eventType),
      modifiedAtAfter:
        event.eventType === "FOLDER_DELETED"
          ? null
          : safeEventDate(event.detectedAt),
      modifiedAtBefore:
        event.eventType === "FOLDER_DELETED"
          ? safeEventDate(event.detectedAt)
          : null,
      previousRelativePath:
        event.eventType === "FOLDER_DELETED" ? relativePath : null,
    });
    return;
  }

  if (event.eventType === "FILE_DELETED") {
    const previous = lookup.paths.get(relativePath);

    await enqueueMonitoringEvent({
      checksumBefore: previous?.checksum ?? null,
      connectedFolderId: folder.id, expectedRootRevision: folder.nativeConnectionRevision,
      eventType: "FILE_DELETED",
      modifiedAtBefore:
        previous?.lastModified ?? safeEventDate(event.detectedAt),
      previousRelativePath: relativePath,
      sizeBefore: previous?.sizeBytes ?? null,
    });
    return;
  }

  try {
    const snapshot = await localBridgeSnapshot(folder.bridgeRootId, relativePath);
    const monitoringEvent = eventFromSnapshot(
      folder.id,
      snapshot,
      baselineFiles,
      lookup,
    );

    if (monitoringEvent) {
      await enqueueMonitoringEvent({ ...monitoringEvent, expectedRootRevision: folder.nativeConnectionRevision });
    }
  } catch (error) {
    const category = localBridgeEventErrorCategory(error);

    if (category === "ROOT_UNAVAILABLE") {
      const previous = lookup.paths.get(relativePath);

      await enqueueMonitoringEvent({
        checksumBefore: previous?.checksum ?? null,
        connectedFolderId: folder.id, expectedRootRevision: folder.nativeConnectionRevision,
        eventType: "FILE_DELETED",
        modifiedAtBefore:
          previous?.lastModified ?? safeEventDate(event.detectedAt),
        previousRelativePath: relativePath,
        sizeBefore: previous?.sizeBytes ?? null,
      });
      return;
    }

    await enqueueMonitoringEvent({
      connectedFolderId: folder.id, expectedRootRevision: folder.nativeConnectionRevision,
      currentRelativePath: relativePath,
      eventType: monitoringEventType(event.eventType),
      processingStatus: "NEEDS_ATTENTION",
      safeErrorCategory: category,
    });
  }
}

async function drainLocalBridgeWatcherEvents(connectedFolderId?: string) {
  const prisma = getPrismaClient();
  const folders = await prisma.connectedLibrary.findMany({
    where: {
      bridgeDeviceId: null,
      bridgeRootId: {
        not: null,
      },
      id: connectedFolderId,
      ...currentReadableRootWhere,
      monitoringState: "WATCHING",
      watchPermission: true,
    },
  });

  for (const folder of folders) {
    const bridgeRootId = folder.bridgeRootId;

    if (!bridgeRootId) {
      continue;
    }

    try {
      const events = await takeLocalBridgeWatcherEvents(bridgeRootId);
      const baselineFiles = await latestBaselineFiles(folder.id);
      const lookup = { paths: new Map(baselineFiles.map((file) => [file.relativePath, file])), checksums: new Map<string, BaselineFile>() };
      for (const file of baselineFiles) if (file.checksum && !lookup.checksums.has(file.checksum)) lookup.checksums.set(file.checksum, file);

      for (const event of events) {
        await enqueueLocalBridgeChange(folder, event, baselineFiles, lookup);
      }

      await prisma.connectedLibrary.updateMany({
        data: {
          monitoringErrorCategory: null,
          monitoringHeartbeatAt: new Date(),
          monitoringLastCheckAt: new Date(),
          monitoringState: "WATCHING",
        },
        where: {
          id: folder.id, ...currentReadableRootWhere, watchPermission: true, monitoringState: "WATCHING", nativeConnectionRevision: folder.nativeConnectionRevision,
        },
      });
    } catch (error) {
      const category = localBridgeEventErrorCategory(error);

      await prisma.connectedLibrary.updateMany({
        data: {
          monitoringErrorCategory: category,
          monitoringLastCheckAt: new Date(),
          monitoringState: "NEEDS_ATTENTION",
        },
        where: {
          id: folder.id, ...currentReadableRootWhere, watchPermission: true, monitoringState: "WATCHING", nativeConnectionRevision: folder.nativeConnectionRevision,
        },
      });
    }
  }
}

function cloudWatchEventId(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null;
}

function cloudWatchEventType(value: unknown): BridgeMonitoringEventType | null {
  return typeof value === "string" &&
    [
      "FILE_ADDED",
      "FILE_MODIFIED",
      "FILE_RENAMED",
      "FILE_MOVED",
      "FILE_DELETED",
      "FOLDER_ADDED",
      "FOLDER_RENAMED",
      "FOLDER_MOVED",
      "FOLDER_DELETED",
    ].includes(value)
    ? (value as BridgeMonitoringEventType)
    : null;
}

function cloudWatchEventDate(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const maxFutureMs = 5 * 60 * 1000;

  if (date.getTime() - Date.now() > maxFutureMs) {
    return null;
  }

  return date;
}

function cloudWatchRelativePath(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const raw = value.trim().replaceAll("\\", "/");

  if (
    !raw ||
    raw.includes("\0") ||
    path.posix.isAbsolute(raw) ||
    /^[A-Za-z]:\//u.test(raw)
  ) {
    return null;
  }

  const parts = raw.split("/").filter(Boolean);

  if (parts.some((part) => part === "." || part === "..")) {
    return null;
  }

  const normalized = parts.join("/");

  if (!normalized) {
    return null;
  }

  return normalized;
}

export async function ingestBridgeWatchEvents(
  bridgeDeviceId: string,
  input: unknown,
  expectedPublicKey?: string,
) {
  const rawEvents = Array.isArray(input) ? input : [];

  if (rawEvents.length > 100) {
    throw new BridgeMonitoringError(
      "Too many watch events were sent at once.",
      413,
      "WATCH_EVENT_BATCH_TOO_LARGE",
    );
  }

  return getPrismaClient().$transaction(async (prisma) => {
  await prisma.$queryRaw`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${bridgeDeviceId} FOR SHARE`;
  const device = await prisma.bridgeDevice.findFirst({ where: { bridgeDeviceId, status: { not: "REVOKED" }, revokedAt: null, publicKey: expectedPublicKey } });
  if (!device) throw new BridgeMonitoringError("This device key no longer authorizes watch events.", 401, "WATCH_AUTHORITY_CHANGED");
  const acceptedEventIds: string[] = [];
  const duplicateEventIds: string[] = [];
  const now = new Date();

  for (const rawEvent of rawEvents) {
    const event =
      typeof rawEvent === "object" &&
      rawEvent !== null &&
      !Array.isArray(rawEvent)
        ? (rawEvent as Record<string, unknown>)
        : null;
    const eventId = cloudWatchEventId(event?.eventId ?? event?.id);
    const bridgeRootId =
      typeof event?.bridgeRootId === "string"
        ? event.bridgeRootId
        : typeof event?.rootId === "string"
          ? event.rootId
          : null;
    const eventType = cloudWatchEventType(event?.eventType);
    const relativePath = cloudWatchRelativePath(event?.relativePath);
    const detectedAt = cloudWatchEventDate(event?.detectedAt);

    if (
      !eventId ||
      !bridgeRootId ||
      !eventType ||
      !relativePath ||
      !detectedAt
    ) {
      throw new BridgeMonitoringError(
        "The Bridge sent a watch event that could not be accepted safely.",
        400,
        "INVALID_WATCH_EVENT",
      );
    }

    await prisma.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE "bridgeDeviceId" = ${bridgeDeviceId} AND "bridgeRootId" = ${bridgeRootId} FOR UPDATE`;
    const folder = await prisma.connectedLibrary.findFirst({
      where: {
        bridgeDeviceId,
        bridgeRootId,
        ...currentReadableRootWhere,
        watchPermission: true,
        monitoringState: "WATCHING",
      },
    });

    if (!folder) {
      throw new BridgeMonitoringError(
        "That watch event does not belong to this Bridge device.",
        404,
        "WATCH_EVENT_ROOT_NOT_FOUND",
      );
    }

    if (shouldIgnorePath(relativePath)) {
      acceptedEventIds.push(eventId);
      continue;
    }

    const eventKey = `bridge:${bridgeDeviceId}:${eventId}`;
    const existed = Boolean(
      await prisma.monitoringEvent.findUnique({
        select: { id: true },
        where: { eventKey },
      }),
    );

    await enqueueMonitoringEvent({
      connectedFolderId: folder.id,
      currentRelativePath:
        eventType === "FILE_DELETED" || eventType === "FOLDER_DELETED"
          ? null
          : relativePath,
      detectedAt,
      eventKey,
      eventType,
      modifiedAtAfter:
        eventType === "FILE_DELETED" || eventType === "FOLDER_DELETED"
          ? null
          : detectedAt,
      modifiedAtBefore:
        eventType === "FILE_DELETED" || eventType === "FOLDER_DELETED"
          ? detectedAt
          : null,
      previousRelativePath:
        eventType === "FILE_DELETED" || eventType === "FOLDER_DELETED"
          ? relativePath
          : null,
      processingStatus: "QUEUED",
    }, prisma);

    await prisma.connectedLibrary.updateMany({
      data: {
        lastMonitoringAt: detectedAt,
        monitoringErrorCategory: null,
        monitoringHeartbeatAt: now,
        monitoringLastCheckAt: now,
        monitoringLastSuccessfulCheckAt: now,
        monitoringReconciliationRequired: true,
        monitoringStartedAt:
          folder.monitoringStartedAt ??
          (folder.monitoringState === "WATCHING" ? now : undefined),
      },
      where: { id: folder.id, ...currentReadableRootWhere, watchPermission: true, monitoringState: "WATCHING" },
    });

    if (existed) {
      duplicateEventIds.push(eventId);
    } else {
      acceptedEventIds.push(eventId);
    }
  }

  return {
    acceptedEventIds,
    duplicateEventIds,
  };
  }, { timeout: 120_000 });
}

async function enqueuePathChange(
  connectedFolderId: string,
  rootPath: string,
  relativePath: string,
) {
  if (!relativePath || shouldIgnorePath(relativePath)) {
    return;
  }

  const prisma = getPrismaClient();

  const folder = await prisma.connectedLibrary.findFirst({ where: { id: connectedFolderId, ...currentReadableRootWhere, watchPermission: true, monitoringState: "WATCHING" } });
  if (!folder) return;
  await prisma.connectedLibrary.updateMany({
    data: {
      monitoringHeartbeatAt: new Date(),
      monitoringLastCheckAt: new Date(),
    },
    where: {
      id: connectedFolderId, ...currentReadableRootWhere, watchPermission: true, monitoringState: "WATCHING", nativeConnectionRevision: folder.nativeConnectionRevision,
    },
  });

  try {
    const baselineFiles = await latestBaselineFiles(connectedFolderId, normalizeIncomingRelativePath(relativePath));
    const snapshot = await stablePathSnapshot(rootPath, relativePath);

    if (snapshot.kind === "missing") {
      const previous = baselineFiles.find(
        (file) => file.relativePath === normalizeIncomingRelativePath(relativePath),
      );

      if (!previous) {
        await enqueueMonitoringEvent({
          connectedFolderId, expectedRootRevision: folder.nativeConnectionRevision,
          eventType: "FOLDER_DELETED",
          previousRelativePath: normalizeIncomingRelativePath(relativePath),
        });
        return;
      }

      await enqueueMonitoringEvent({
        checksumBefore: previous.checksum,
        connectedFolderId, expectedRootRevision: folder.nativeConnectionRevision,
        eventType: "FILE_DELETED",
        modifiedAtBefore: previous.lastModified,
        previousRelativePath: previous.relativePath,
        sizeBefore: previous.sizeBytes,
      });
      return;
    }

    if (snapshot.kind === "directory") {
      await enqueueMonitoringEvent({
        connectedFolderId, expectedRootRevision: folder.nativeConnectionRevision,
        currentRelativePath: snapshot.relativePath,
        eventType: "FOLDER_ADDED",
        modifiedAtAfter: snapshot.lastModified,
        sizeAfter: snapshot.sizeBytes,
      });
      return;
    }

    const event = eventFromSnapshot(connectedFolderId, snapshot, baselineFiles);

    if (event) {
      await enqueueMonitoringEvent({ ...event, expectedRootRevision: folder.nativeConnectionRevision });
    }
  } catch (error) {
    await prisma.connectedLibrary.updateMany({
      data: {
        monitoringErrorCategory:
          error instanceof BridgeMonitoringError
            ? "PATH_SECURITY"
            : "WATCH_EVENT_FAILED",
        monitoringState: "NEEDS_ATTENTION",
      },
      where: {
        id: connectedFolderId, ...currentReadableRootWhere, watchPermission: true, monitoringState: "WATCHING", nativeConnectionRevision: folder.nativeConnectionRevision,
      },
    });
  }
}

function closeWatcher(folderId: string) {
  const handle = watcherRegistry.get(folderId);

  if (!handle) {
    return;
  }

  for (const timer of handle.timers.values()) {
    clearTimeout(timer);
  }

  handle.watcher.close();
  watcherRegistry.delete(folderId);
}

function startWatcherForFolder(folder: {
  id: string;
  localPath: string;
  monitoringGeneration: number;
}) {
  closeWatcher(folder.id);

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let watcher: FSWatcher;

  try {
    watcher = watch(
      folder.localPath,
      {
        persistent: false,
        recursive: true,
      },
      (_eventType, fileName) => {
        const rawRelativePath = String(fileName ?? "");
        const relativePath = normalizeIncomingRelativePath(rawRelativePath);

        if (!relativePath || shouldIgnorePath(relativePath)) {
          return;
        }

        const existing = timers.get(relativePath);

        if (existing) {
          clearTimeout(existing);
        }

        timers.set(
          relativePath,
          setTimeout(() => {
            timers.delete(relativePath);
            void enqueuePathChange(folder.id, folder.localPath, relativePath);
          }, watchDebounceMs),
        );
      },
    );
  } catch {
    throw new BridgeMonitoringError(
      "The Bridge could not start continuous monitoring for this folder.",
      500,
    );
  }

  watcherRegistry.set(folder.id, {
    generation: folder.monitoringGeneration,
    rootPath: folder.localPath,
    timers,
    watcher,
  });
}

async function reconcileConnectedFolder(connectedFolderId: string) {
  const prisma = getPrismaClient();
  const { folder, rootPath } = await monitoringContextForFolder(
    connectedFolderId,
    "watch this folder",
  );
  const baselineFiles = await latestBaselineFiles(folder.id);
  const baselineByPath = new Map(
    baselineFiles.map((file) => [file.relativePath, file]),
  );
  const baselineByChecksum = new Map<string, BaselineFile>();
  for (const file of baselineFiles) if (file.checksum && !baselineByChecksum.has(file.checksum)) baselineByChecksum.set(file.checksum, file);
  const matchedBaselineIds = new Set<string>();
  const scan = folder.bridgeRootId
    ? await scanLocalBridgeRoot(folder.bridgeRootId)
    : await import("./scanner").then(({ scanBridgeFolder }) =>
        scanBridgeFolder(rootPath),
      );

  for (const file of scan.files) {
    if (shouldIgnorePath(file.relativePath)) {
      continue;
    }

    const snapshot: Extract<StablePathSnapshot, { kind: "file" }> = {
      audioMetadata: file.audioMetadata,
      checksum: file.checksum,
      fileType: file.fileType,
      kind: "file",
      lastModified: file.lastModified ?? new Date(),
      localPath: file.localPath,
      readStatus: file.readStatus,
      relativePath: file.relativePath,
      sourceCreatedAt: file.sourceCreatedAt ?? new Date(),
      sizeBytes: file.sizeBytes ?? BigInt(0),
      videoMetadata: file.videoMetadata,
    };
    const event = eventFromSnapshot(folder.id, snapshot, baselineFiles, { paths: baselineByPath, checksums: baselineByChecksum });

    if (!event) {
      const baseline = baselineByPath.get(file.relativePath);

      if (baseline) {
        matchedBaselineIds.add(baseline.id);
      }

      continue;
    }

    if (event.previousRelativePath) {
      const previous = baselineByPath.get(event.previousRelativePath);

      if (previous) {
        matchedBaselineIds.add(previous.id);
      }
    }

    await enqueueMonitoringEvent(event);
  }

  const currentPaths = new Set(scan.files.map((file) => file.relativePath));
  for (const baseline of baselineFiles) {
    if (matchedBaselineIds.has(baseline.id)) {
      continue;
    }

    if (currentPaths.has(baseline.relativePath)) {
      continue;
    }

    await enqueueMonitoringEvent({
      checksumBefore: baseline.checksum,
      connectedFolderId: folder.id,
      eventType: "FILE_DELETED",
      modifiedAtBefore: baseline.lastModified,
      previousRelativePath: baseline.relativePath,
      sizeBefore: baseline.sizeBytes,
    });
  }

  await prisma.connectedLibrary.update({
    data: {
      monitoringLastCheckAt: new Date(),
      monitoringLastSuccessfulCheckAt: new Date(),
      monitoringReconciliationRequired: false,
    },
    where: {
      id: folder.id,
    },
  });
}

async function restoreMonitoringAfterRestart() {
  const prisma = getPrismaClient();
  const now = new Date();
  const watchingFolders = await prisma.connectedLibrary.findMany({
    where: {
      ...currentReadableRootWhere,
      bridgeDeviceId: null,
      monitoringState: "WATCHING",
      watchPermission: true,
    },
  });

  for (const folder of watchingFolders) {
    if (!folder.bridgeRootId && watcherRegistry.has(folder.id)) {
      continue;
    }

    try {
      if (folder.bridgeRootId) {
        await startLocalBridgeWatcher(folder.bridgeRootId);
        await prisma.connectedLibrary.update({
          data: {
            monitoringErrorCategory: null,
            monitoringHeartbeatAt: now,
            monitoringReconciliationRequired: true,
          },
          where: {
            id: folder.id,
          },
        });
        continue;
      }

      await validateConnectedLibraryPath(folder.localPath);
      startWatcherForFolder(folder);
      await prisma.connectedLibrary.update({
        data: {
          monitoringHeartbeatAt: now,
          monitoringReconciliationRequired: true,
        },
        where: {
          id: folder.id,
        },
      });
    } catch (error) {
      await prisma.connectedLibrary.update({
        data: {
          monitoringErrorCategory:
            error instanceof LocalBridgeClientError
              ? error.code
              : "WATCHER_RESTART_FAILED",
          monitoringState: "NEEDS_ATTENTION",
        },
        where: {
          id: folder.id,
        },
      });
    }
  }
}

export async function getMonitoringDashboardData(): Promise<BridgeMonitoringDashboard> {
  await restoreMonitoringAfterRestart();
  await drainLocalBridgeWatcherEvents();

  const prisma = getPrismaClient();
  const [folders, recentEvents, recentBatches, queueGroups] =
    await Promise.all([
      prisma.connectedLibrary.findMany({
        include: {
          monitoringBatches: {
            orderBy: {
              startedAt: "desc",
            },
            take: 3,
          },
          monitoringEvents: {
            orderBy: {
              detectedAt: "desc",
            },
            take: 8,
          },
        },
        orderBy: {
          updatedAt: "desc",
        },
        take: 8,
        where: {
          isEnabled: true,
          status: {
            not: "DISCONNECTED",
          },
        },
      }),
      prisma.monitoringEvent.findMany({
        orderBy: {
          detectedAt: "desc",
        },
        take: 12,
      }),
      prisma.monitoringBatch.findMany({
        orderBy: {
          startedAt: "desc",
        },
        take: 6,
      }),
      prisma.monitoringEvent.groupBy({
        by: ["processingStatus"],
        _count: true,
      }),
    ]);

  const queueCounts = {
    completed: 0,
    needsAttention: 0,
    processing: 0,
    queued: 0,
  };

  for (const group of queueGroups) {
    const status = monitoringProcessingStatus(group.processingStatus);

    if (status === "QUEUED" || status === "STABILIZING") {
      queueCounts.queued += group._count;
    } else if (status === "PROCESSING") {
      queueCounts.processing += group._count;
    } else if (status === "NEEDS_ATTENTION" || status === "FAILED") {
      queueCounts.needsAttention += group._count;
    } else if (status === "COMPLETED" || status === "SKIPPED") {
      queueCounts.completed += group._count;
    }
  }

  const folderSummaries: BridgeMonitoringFolderSummary[] = await Promise.all(
    folders.map(async (folder) => {
      const eventCounts = await prisma.monitoringEvent.groupBy({
        by: ["processingStatus"],
        _count: true,
        where: {
          connectedFolderId: folder.id,
        },
      });
      const counts = {
        attentionEvents: 0,
        completedEvents: 0,
        processingEvents: 0,
        queuedEvents: 0,
      };

      for (const group of eventCounts) {
        const status = monitoringProcessingStatus(group.processingStatus);

        if (status === "QUEUED" || status === "STABILIZING") {
          counts.queuedEvents += group._count;
        } else if (status === "PROCESSING") {
          counts.processingEvents += group._count;
        } else if (status === "NEEDS_ATTENTION" || status === "FAILED") {
          counts.attentionEvents += group._count;
        } else if (status === "COMPLETED" || status === "SKIPPED") {
          counts.completedEvents += group._count;
        }
      }

      const state = monitoringState(folder.monitoringState);
      const heartbeatAt = folder.monitoringHeartbeatAt;
      const lastDetectedChangeAt =
        folder.monitoringEvents[0]?.detectedAt ?? null;
      const watchingAppearsStopped =
        state === "WATCHING" &&
        heartbeatAt !== null &&
        Date.now() - heartbeatAt.getTime() > staleProcessingThresholdMs;

      return {
        ...counts,
        displayName: folder.displayName,
        errorCategory: folder.monitoringErrorCategory,
        heartbeatAt: heartbeatAt?.toISOString() ?? null,
        humanState: monitoringStateLabel(state),
        id: folder.id,
        lastDetectedChangeAt:
          lastDetectedChangeAt?.toISOString() ?? null,
        lastCheckAt: folder.monitoringLastCheckAt?.toISOString() ?? null,
        lastSuccessfulCheckAt:
          folder.monitoringLastSuccessfulCheckAt?.toISOString() ?? null,
        needsReconciliation: folder.monitoringReconciliationRequired,
        pausedAt: folder.monitoringPausedAt?.toISOString() ?? null,
        recentBatches: folder.monitoringBatches.map(toBatchSummary),
        recentEvents: folder.monitoringEvents.map(toEventSummary),
        startedAt: folder.monitoringStartedAt?.toISOString() ?? null,
        state,
        stoppedAt: folder.monitoringStoppedAt?.toISOString() ?? null,
        watchingAppearsStopped,
      };
    }),
  );

  return {
    folders: folderSummaries,
    isDevelopment: isDevelopmentBridgeScannerEnabled(),
    queue: queueCounts,
    recentBatches: recentBatches.map(toBatchSummary),
    recentEvents: recentEvents.map(toEventSummary),
  };
}

export async function startMonitoringForConfiguredFolder() {
  if (!isDevelopmentBridgeScannerEnabled()) {
    throw new BridgeMonitoringError(
      "Folder monitoring is only available in local development mode.",
      403,
    );
  }

  const folder = await connectedFolderForConfiguredRoot();

  return startMonitoringForConnectedLibrary(folder.id);
}

export async function startMonitoringForConnectedLibrary(folderId: string) {
  const prisma = getPrismaClient();
  await requireConnectedLibraryPermission(
    folderId,
    "readPermission",
    "read files before watching changes",
  );
  const folder = await requireConnectedLibraryPermission(
    folderId,
    "watchPermission",
    "watch this folder",
  );

  if (folder.bridgeDeviceId && folder.bridgeRootId) {
    throw new BridgeMonitoringError(
      "Use the paired Mac to start watching this cloud-connected folder.",
      409,
      "REMOTE_MONITORING_REQUIRED",
    );
  }

  if (folder.bridgeRootId) {
    try {
      await startLocalBridgeWatcher(folder.bridgeRootId);
    } catch (error) {
      const monitoringError = localBridgeMonitoringError(
        error,
        "WATCHER_START_FAILED",
      );

      await prisma.connectedLibrary.updateMany({
        data: {
          monitoringErrorCategory: monitoringError.category,
          monitoringLastCheckAt: new Date(),
          monitoringState: "NEEDS_ATTENTION",
        },
        where: {
          id: folder.id, ...currentReadableRootWhere, watchPermission: true, nativeConnectionRevision: folder.nativeConnectionRevision,
        },
      });
      throw monitoringError;
    }

    const now = new Date();

    await prisma.connectedLibrary.updateMany({
      data: {
        lastMonitoringAt: now,
        monitoringErrorCategory: null,
        monitoringHeartbeatAt: now,
        monitoringLastCheckAt: now,
        monitoringPausedAt: null,
        monitoringReconciliationRequired: true,
        monitoringStartedAt: now,
        monitoringState: "WATCHING",
        monitoringStoppedAt: null,
      },
      where: {
        id: folder.id, ...currentReadableRootWhere, watchPermission: true, nativeConnectionRevision: folder.nativeConnectionRevision,
      },
    });

    await reconcileConnectedFolder(folder.id);

    return getMonitoringDashboardData();
  }

  const { rootPath } = await connectedLibraryForMonitoring(
    folderId,
    "watch this folder",
  );
  const changed = await prisma.connectedLibrary.updateMany({
    data: {
      monitoringErrorCategory: null,
      monitoringGeneration: {
        increment: 1,
      },
      monitoringHeartbeatAt: new Date(),
      monitoringLastCheckAt: new Date(),
      monitoringPausedAt: null,
      monitoringReconciliationRequired: true,
      monitoringStartedAt: new Date(),
      monitoringState: "WATCHING",
      monitoringStoppedAt: null,
    },
    where: {
      id: folder.id, ...currentReadableRootWhere, watchPermission: true, nativeConnectionRevision: folder.nativeConnectionRevision,
    },
  });

  if (!changed.count) throw new BridgeMonitoringError("Watcher authority changed.", 409, "WATCH_AUTHORITY_CHANGED");
  const updatedFolder = await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: folder.id } });
  startWatcherForFolder({
    ...updatedFolder,
    localPath: rootPath,
  });
  await reconcileConnectedFolder(updatedFolder.id);

  return getMonitoringDashboardData();
}

export async function pauseMonitoringForFolder(folderId: string) {
  const prisma = getPrismaClient();
  const folder = await prisma.connectedLibrary.findUnique({
    where: {
      id: folderId,
    },
  });

  if (!folder) {
    throw new BridgeMonitoringError(
      "The Bridge could not find that connected folder.",
      404,
    );
  }

  closeWatcher(folderId);

  if (folder.bridgeDeviceId && folder.bridgeRootId) {
    throw new BridgeMonitoringError(
      "Use the paired Mac to pause watching this cloud-connected folder.",
      409,
      "REMOTE_MONITORING_REQUIRED",
    );
  }

  if (folder.bridgeRootId) {
    await pauseLocalBridgeWatcher(folder.bridgeRootId).catch(() => undefined);
  }

  await prisma.connectedLibrary.update({
    data: {
      monitoringErrorCategory: null,
      monitoringPausedAt: new Date(),
      monitoringState: "PAUSED",
    },
    where: {
      id: folderId,
    },
  });

  return getMonitoringDashboardData();
}

export async function resumeMonitoringForFolder(folderId: string) {
  const prisma = getPrismaClient();
  await requireConnectedLibraryPermission(
    folderId,
    "readPermission",
    "read files before watching changes",
  );
  const folder = await requireConnectedLibraryPermission(
    folderId,
    "watchPermission",
    "watch this folder",
  );

  if (folder.bridgeDeviceId && folder.bridgeRootId) {
    throw new BridgeMonitoringError(
      "Use the paired Mac to resume watching this cloud-connected folder.",
      409,
      "REMOTE_MONITORING_REQUIRED",
    );
  }

  if (folder.bridgeRootId) {
    try {
      await resumeLocalBridgeWatcher(folder.bridgeRootId);
    } catch (error) {
      const monitoringError = localBridgeMonitoringError(
        error,
        "WATCHER_START_FAILED",
      );

      await prisma.connectedLibrary.updateMany({
        data: {
          monitoringErrorCategory: monitoringError.category,
          monitoringLastCheckAt: new Date(),
          monitoringState: "NEEDS_ATTENTION",
        },
        where: {
          id: folder.id, ...currentReadableRootWhere, watchPermission: true, nativeConnectionRevision: folder.nativeConnectionRevision,
        },
      });
      throw monitoringError;
    }

    const now = new Date();

    await prisma.connectedLibrary.updateMany({
      data: {
        monitoringErrorCategory: null,
        monitoringHeartbeatAt: now,
        monitoringLastCheckAt: now,
        monitoringPausedAt: null,
        monitoringReconciliationRequired: true,
        monitoringStartedAt: folder.monitoringStartedAt ?? now,
        monitoringState: "WATCHING",
        monitoringStoppedAt: null,
      },
      where: {
        id: folderId, ...currentReadableRootWhere, watchPermission: true, nativeConnectionRevision: folder.nativeConnectionRevision,
      },
    });

    await reconcileConnectedFolder(folder.id);

    return getMonitoringDashboardData();
  }

  const { rootPath } = await connectedLibraryForMonitoring(
    folderId,
    "watch this folder",
  );

  const changed = await prisma.connectedLibrary.updateMany({
    data: {
      monitoringErrorCategory: null,
      monitoringGeneration: {
        increment: 1,
      },
      monitoringHeartbeatAt: new Date(),
      monitoringLastCheckAt: new Date(),
      monitoringPausedAt: null,
      monitoringReconciliationRequired: true,
      monitoringState: "WATCHING",
      monitoringStoppedAt: null,
    },
    where: {
      id: folderId, ...currentReadableRootWhere, watchPermission: true, nativeConnectionRevision: folder.nativeConnectionRevision,
    },
  });

  if (!changed.count) throw new BridgeMonitoringError("Watcher authority changed.", 409, "WATCH_AUTHORITY_CHANGED");
  const updatedFolder = await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: folder.id } });
  startWatcherForFolder({
    ...updatedFolder,
    localPath: rootPath,
  });
  await reconcileConnectedFolder(folderId);

  return getMonitoringDashboardData();
}

export async function stopMonitoringForFolder(folderId: string) {
  const prisma = getPrismaClient();
  const folder = await prisma.connectedLibrary.findUnique({
    where: {
      id: folderId,
    },
  });

  if (!folder) {
    throw new BridgeMonitoringError(
      "The Bridge could not find that connected folder.",
      404,
    );
  }

  closeWatcher(folderId);

  if (folder.bridgeDeviceId && folder.bridgeRootId) {
    throw new BridgeMonitoringError(
      "Use the paired Mac to stop watching this cloud-connected folder.",
      409,
      "REMOTE_MONITORING_REQUIRED",
    );
  }

  if (folder.bridgeRootId) {
    await stopLocalBridgeWatcher(folder.bridgeRootId).catch(() => undefined);
  }

  await prisma.connectedLibrary.update({
    data: {
      monitoringErrorCategory: null,
      monitoringStoppedAt: new Date(),
      monitoringState: "STOPPED",
    },
    where: {
      id: folderId,
    },
  });

  return getMonitoringDashboardData();
}

export async function reconcileMonitoringForFolder(folderId: string) {
  await reconcileConnectedFolder(folderId);

  return getMonitoringDashboardData();
}

function batchNotification({
  failedEvents,
  fileEvents,
  folderEvents,
  supportedFileEvents,
}: {
  failedEvents: number;
  fileEvents: number;
  folderEvents: number;
  supportedFileEvents: number;
}) {
  return {
    notificationSummary:
      `${fileEvents} file change${fileEvents === 1 ? "" : "s"} and ` +
      `${folderEvents} folder change${folderEvents === 1 ? "" : "s"} were recorded. ` +
      `${supportedFileEvents} readable document${
        supportedFileEvents === 1 ? "" : "s"
      } were examined provisionally. ` +
      `${failedEvents} change${failedEvents === 1 ? "" : "s"} need attention.`,
    notificationTitle:
      failedEvents > 0
        ? "Some watched folder changes need attention."
        : "The Librarian kept the watched folder in step.",
  };
}

async function finalizeMonitoringBatch(batchId: string, owner: MonitoringOwner) {
  const batch = await getPrismaClient().$transaction(async (prisma) => {
  await lockMonitoringBatch(prisma, owner);
  const events = await prisma.monitoringEvent.findMany({
    where: {
      batchId,
    },
  });
  const fileEvents = events.filter((event) =>
    event.eventType.startsWith("FILE_"),
  ).length;
  const folderEvents = events.filter((event) =>
    event.eventType.startsWith("FOLDER_"),
  ).length;
  const supportedFileEvents = events.filter(
    (event) =>
      (event.eventType === "FILE_ADDED" ||
        event.eventType === "FILE_MODIFIED") &&
      event.checksumAfter,
  ).length;
  const unsupportedFileEvents = events.filter(
    (event) =>
      (event.eventType === "FILE_ADDED" ||
        event.eventType === "FILE_MODIFIED") &&
      !event.checksumAfter &&
      event.safeErrorCategory === null,
  ).length;
  const failedEvents = events.filter(
    (event) =>
      event.processingStatus === "NEEDS_ATTENTION" ||
      event.processingStatus === "FAILED",
  ).length;
  const notification = batchNotification({
    failedEvents,
    fileEvents,
    folderEvents,
    supportedFileEvents,
  });
  const status =
    failedEvents > 0 ? "COMPLETED_WITH_ERRORS" : "READY_FOR_REVIEW";

  const batch = await prisma.monitoringBatch.update({
    data: {
      completedAt: new Date(),
      processingLeaseUntil: null,
      failedEvents,
      fileEvents,
      folderEvents,
      notificationSummary: notification.notificationSummary,
      notificationTitle: notification.notificationTitle,
      status,
      summary: toJsonInput({
        failedEvents,
        fileEvents,
        folderEvents,
        supportedFileEvents,
        unsupportedFileEvents,
      }),
      supportedFileEvents,
      totalEvents: events.length,
      unsupportedFileEvents,
    },
    where: {
      id: batchId,
    },
  });

  return batch;
  }, { timeout: 120_000 });

  try {
    const notebookEntry = await recordMonitoringBatchNotebookEntry(batch.id);

    if (notebookEntry) {
      await getPrismaClient().monitoringBatch.update({
        data: {
          notebookEntryId: notebookEntry.id,
        },
        where: {
          id: batch.id,
        },
      });
    }
  } catch {
    // Notebook reflections should not block monitoring recovery.
  }

  try {
    await ensureKnowledgeGraphBackfill();
  } catch {
    // Provisional graph updates should not block monitoring recovery.
  }
}


const activeMonitoringScanStatuses = ["PENDING", "SCANNING", "READING", "EXAMINING", "GENERATING_SUGGESTIONS"] as const;

async function claimMonitoringRoot(rootId: string, retryAttention: boolean) {
  return getPrismaClient().$transaction(async (tx) => {
    const binding = await tx.connectedLibrary.findUniqueOrThrow({ where: { id: rootId } });
    if (binding.bridgeDeviceId) await tx.$queryRaw(Prisma.sql`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${binding.bridgeDeviceId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder" WHERE id = ${rootId} FOR UPDATE`);
    const folder = await tx.connectedLibrary.findFirst({ where: { id: rootId, ...currentReadableRootWhere, watchPermission: true, monitoringState: "WATCHING" } });
    if (!folder) return null;
    const now = new Date(), generation = randomUUID();
    const existing = await tx.monitoringBatch.findFirst({ where: { connectedFolderId: rootId, status: "PROCESSING" }, orderBy: [{ startedAt: "asc" }, { id: "asc" }] });
    if (existing?.processingLeaseUntil && existing.processingLeaseUntil > now) return null;
    if (existing && (existing.rootConnectionRevision ?? 0) === folder.nativeConnectionRevision) {
      const batch = await tx.monitoringBatch.update({ where: { id: existing.id }, data: { processingGeneration: generation,
        rootConnectionRevision: folder.nativeConnectionRevision, processingLeaseUntil: new Date(now.getTime() + monitoringLeaseMs) } });
      return { batch, folder, owner: { batchId: batch.id, generation } };
    }
    if (existing) {
      if (existing.scanSessionId) await tx.scanSession.updateMany({ where: { id: existing.scanSessionId, status: { in: [...activeMonitoringScanStatuses] } },
        data: { status: "FAILED", completedAt: now, recommendationGeneration: null, recommendationLeaseUntil: null } });
      await tx.monitoringBatch.update({ where: { id: existing.id }, data: { status: "COMPLETED_WITH_ERRORS", completedAt: now, processingLeaseUntil: null } });
      await tx.monitoringEvent.updateMany({ where: { batchId: existing.id, processingStatus: "PROCESSING" }, data: { batchId: null, processingStatus: "QUEUED", scanSessionId: null } });
    }
    if (await tx.scanSession.count({ where: { connectedFolderId: rootId, status: { in: [...activeMonitoringScanStatuses] } } })) return null;
    const events = await tx.monitoringEvent.findMany({ select: { id: true }, take: monitoringQueueLimit,
      orderBy: [{ detectedAt: "asc" }, { id: "asc" }], where: { connectedFolderId: rootId,
        processingStatus: { in: retryAttention ? ["QUEUED", "NEEDS_ATTENTION", "FAILED"] : ["QUEUED"] } } });
    if (!events.length) return null;
    const batch = await tx.monitoringBatch.create({ data: { connectedFolderId: rootId, status: "PROCESSING", processingGeneration: generation,
      processingLeaseUntil: new Date(now.getTime() + monitoringLeaseMs), rootConnectionRevision: folder.nativeConnectionRevision,
      summary: toJsonInput({ eventIds: events.map((event) => event.id), reconciliation: "FULL_CURRENT_INVENTORY" }) } });
    await tx.monitoringEvent.updateMany({ where: { id: { in: events.map((event) => event.id) } }, data: { batchId: batch.id,
      processingStatus: "PROCESSING", retryCount: { increment: retryAttention ? 1 : 0 } } });
    return { batch, folder, owner: { batchId: batch.id, generation } };
  }, { timeout: 120_000 });
}

async function finishMonitoringSnapshot(owner: MonitoringOwner) {
  const ready = await getPrismaClient().$transaction(async (tx) => {
    const batch = await lockMonitoringBatch(tx, owner);
    if (!batch.scanSessionId) return false;
    const scan = await tx.scanSession.findUniqueOrThrow({ where: { id: batch.scanSessionId } });
    if (activeMonitoringScanStatuses.includes(scan.status as typeof activeMonitoringScanStatuses[number])) return false;
    const events = await tx.monitoringEvent.findMany({ where: { batchId: batch.id, processingStatus: "PROCESSING" } });
    const files = await tx.scannedFile.findMany({ select: { relativePath: true, processingStage: true, readStatus: true }, where: { sessionId: scan.id } });
    const byPath = new Map(files.map((file) => [file.relativePath, file]));
    for (const event of events) {
      const file = event.currentRelativePath ? byPath.get(event.currentRelativePath) : null;
      const failed = scan.status === "FAILED" || file?.processingStage === "FAILED" || file?.readStatus === "FAILED";
      await tx.monitoringEvent.updateMany({ where: { id: event.id, batchId: batch.id, processingStatus: "PROCESSING" },
        data: { processedAt: new Date(), processingStatus: failed ? "NEEDS_ATTENTION" : "COMPLETED", safeErrorCategory: failed ? "PROCESSING_FAILED" : null } });
    }
    return true;
  }, { timeout: 120_000 });
  if (ready) await finalizeMonitoringBatch(owner.batchId, owner);
  return ready;
}

async function runMonitoringSnapshot(admitted: NonNullable<Awaited<ReturnType<typeof claimMonitoringRoot>>>) {
  const { batch, folder, owner } = admitted;
  let scanSessionId = batch.scanSessionId;
  if (!scanSessionId && folder.bridgeDeviceId && folder.bridgeRootId) {
    await getPrismaClient().$transaction(async (tx) => {
      // Keep device -> root -> batch lock order through cloud command creation.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${folder.bridgeDeviceId} FOR SHARE`);
      await lockMonitoringBatch(tx, owner);
      const currentRoot = await tx.connectedLibrary.findUniqueOrThrow({ where: { id: folder.id } });
      const scan = await tx.scanSession.create({ data: { connectedFolderId: folder.id, inventoryGeneration: currentRoot.physicalInventoryGeneration, status: "SCANNING" } });
      await createBridgeCloudCommand({ bridgeDeviceId: folder.bridgeDeviceId!, bridgeRootId: folder.bridgeRootId,
        connectedLibraryId: folder.id, commandType: "RECONCILE_LIBRARY", idempotencyKey: `monitor-reconcile:${batch.id}:${owner.generation}`,
        authorizationContext: { initiatedBy: "Deanne", purpose: "Reconcile read-only watch hints against a full current inventory." }, payload: { scanSessionId: scan.id } }, tx);
      await tx.monitoringBatch.update({ where: { id: batch.id }, data: { scanSessionId: scan.id } });
      await tx.monitoringEvent.updateMany({ where: { batchId: batch.id, processingStatus: "PROCESSING" }, data: { scanSessionId: scan.id } });
    }, { timeout: 120_000 });
    return; // Queued is not the same as reconciled or ready for review.
  }
  if (!scanSessionId) {
    await renewMonitoringBatch(owner);
    await monitoringContextForFolder(folder.id, "watch this folder");
    let renewal: Promise<void> | null = null, renewalError: unknown;
    const heartbeat = setInterval(() => {
      if (!renewal && !renewalError) renewal = renewMonitoringBatch(owner).then(() => undefined)
        .catch((error: unknown) => { renewalError = error; }).finally(() => { renewal = null; });
    }, 25_000);
    heartbeat.unref();
    let scan;
    try {
      scan = await import("./scanner").then(({ scanConnectedLibrary }) => scanConnectedLibrary(folder.id));
    } finally { clearInterval(heartbeat); await renewal; }
    if (renewalError) throw renewalError;
    await renewMonitoringBatch(owner);
    const session = await createBridgeScanSessionFromScan(scan, { connectedLibraryId: folder.id, allowReusableSession: false, monitoringOwner: owner });
    scanSessionId = session.id;
  }
  if (!folder.bridgeDeviceId) await processBridgeScanSession(scanSessionId, { recordNotebook: false, beforeFile: () => renewMonitoringBatch(owner) });
  await finishMonitoringSnapshot(owner);
}

export async function recoverMonitoringBatchesForDevice(bridgeDeviceId: string) {
  const candidates = await getPrismaClient().monitoringBatch.findMany({ select: { connectedFolderId: true }, take: 2,
    orderBy: [{ processingLeaseUntil: "asc" }, { id: "asc" }], where: { status: "PROCESSING",
      connectedFolder: { ...currentReadableRootWhere, bridgeDeviceId, watchPermission: true, monitoringState: "WATCHING" },
      OR: [{ processingLeaseUntil: null }, { processingLeaseUntil: { lte: new Date() } },
        { scanSession: { status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED"] } } }],
    } });
  for (const candidate of candidates) {
    // A live batch whose scan just completed may settle without replacing its owner.
    const current = await getPrismaClient().monitoringBatch.findFirst({ where: { connectedFolderId: candidate.connectedFolderId, status: "PROCESSING" } });
    if (current?.processingGeneration && current.processingLeaseUntil && current.processingLeaseUntil > new Date()) {
      await finishMonitoringSnapshot({ batchId: current.id, generation: current.processingGeneration }).catch(() => undefined);
    } else {
      const admitted = await claimMonitoringRoot(candidate.connectedFolderId, false);
      if (admitted) await runMonitoringSnapshot(admitted).catch(() => undefined);
    }
  }
}

export async function processMonitoringQueue(options: { connectedFolderId?: string; retryAttention?: boolean } = {}) {
  await drainLocalBridgeWatcherEvents(options.connectedFolderId);
  const prisma = getPrismaClient();
  const abandoned = await prisma.monitoringBatch.findFirst({ select: { connectedFolderId: true },
    orderBy: [{ processingLeaseUntil: "asc" }, { id: "asc" }], where: { connectedFolderId: options.connectedFolderId, status: "PROCESSING",
      connectedFolder: { ...currentReadableRootWhere, watchPermission: true, monitoringState: "WATCHING" },
      OR: [{ processingLeaseUntil: null }, { processingLeaseUntil: { lte: new Date() } }] } });
  const event = abandoned ? null : await prisma.monitoringEvent.findFirst({ select: { connectedFolderId: true },
    orderBy: [{ detectedAt: "asc" }, { id: "asc" }], where: { connectedFolderId: options.connectedFolderId,
      processingStatus: { in: options.retryAttention ? ["QUEUED", "NEEDS_ATTENTION", "FAILED"] : ["QUEUED"] },
      connectedFolder: { ...currentReadableRootWhere, watchPermission: true, monitoringState: "WATCHING",
        scanSessions: { none: { status: { in: [...activeMonitoringScanStatuses] } } },
        monitoringBatches: { none: { status: "PROCESSING", processingLeaseUntil: { gt: new Date() } } } },
    } });
  const rootId = abandoned?.connectedFolderId ?? event?.connectedFolderId;
  if (rootId) {
    const admitted = await claimMonitoringRoot(rootId, options.retryAttention ?? false);
    if (admitted) await runMonitoringSnapshot(admitted).catch(async () => {
      // The exact owner remains durable and reclaimable; do not forge terminal
      // success or edit path-only historical source records after a failure.
      await prisma.monitoringBatch.updateMany({ where: { id: admitted.batch.id, processingGeneration: admitted.owner.generation, status: "PROCESSING" },
        data: { processingLeaseUntil: new Date() } });
    });
  }
  return getMonitoringDashboardData();
}
