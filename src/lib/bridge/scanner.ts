import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import { access, lstat, opendir } from "node:fs/promises";
import path from "node:path";

import type {
  BridgeFolderScanResult,
  BridgeScannedFileDraft,
  BridgeStatus,
  BridgeUnavailableResult,
} from "./types";
import { classifyBridgeFileType } from "./file-classifier";
import { extractAudioMetadata } from "./audio-metadata";
import { extractVideoMetadata } from "./video-metadata";
import {
  ConnectedLibraryError,
  requireConnectedLibraryPermission,
  rootForConnectedLibrary,
} from "./connected-libraries";
import { scanLocalBridgeRoot } from "./local-bridge-client";

export const bridgeComingSoonMessage =
  "Folder connection through the local Bridge app is coming later.";

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

export class BridgeScannerError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "BridgeScannerError";
    this.statusCode = statusCode;
  }
}

export function getBridgeStatus(): BridgeStatus {
  return {
    status: "NOT_CONNECTED",
    label: "Bridge not connected",
    connectedFolders: [],
  };
}

export function isDevelopmentBridgeScannerEnabled() {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK === "true"
  );
}

export function connectFolderPlaceholder(): BridgeUnavailableResult {
  return {
    ok: false,
    message: bridgeComingSoonMessage,
  };
}

export function scanFolderPlaceholder(): BridgeUnavailableResult {
  return {
    ok: false,
    message: "Scan Folder waits until the NSN Bridge is connected.",
  };
}

function displayNameForFolder(folderPath: string) {
  return path.basename(folderPath) || folderPath;
}

function userFacingValidationError() {
  return "The fallback Bridge folder could not be read safely.";
}

function normalizeRootPath(folderPath: string) {
  const trimmedPath = folderPath.trim();

  if (!trimmedPath) {
    throw new BridgeScannerError(
      "Choose a readable folder before scanning.",
    );
  }

  return path.normalize(path.resolve(trimmedPath));
}

export async function validateBridgeFolderPath(folderPath: string) {
  const normalizedPath = normalizeRootPath(folderPath);

  try {
    const folderStats = await lstat(normalizedPath);

    if (!folderStats.isDirectory() || folderStats.isSymbolicLink()) {
      throw new BridgeScannerError(userFacingValidationError());
    }

    await access(normalizedPath, fsConstants.R_OK);
  } catch (error) {
    if (error instanceof BridgeScannerError) {
      throw error;
    }

    throw new BridgeScannerError(userFacingValidationError());
  }

  return normalizedPath;
}

export async function getConfiguredBridgeTestFolder() {
  const configuredPath = process.env.NSN_BRIDGE_TEST_FOLDER;

  if (!configuredPath) {
    throw new BridgeScannerError(
      "Connect a folder before scanning.",
    );
  }

  return validateBridgeFolderPath(configuredPath);
}

function shouldIgnoreFolder(folderName: string) {
  const normalizedName = folderName.toLowerCase();

  return folderName.startsWith(".") || ignoredFolderNames.has(normalizedName);
}

function shouldIgnoreSystemFile(fileName: string) {
  return ignoredSystemFileNames.has(fileName.toLowerCase());
}

function relativePathFor(rootPath: string, localPath: string) {
  const relativePath = path.relative(rootPath, localPath);

  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new BridgeScannerError(
      "The scanner found a path outside the selected folder and skipped it.",
    );
  }

  return relativePath.split(path.sep).join(path.posix.sep);
}

function classifyFileType(fileName: string) {
  return classifyBridgeFileType(fileName);
}

function isSupportedFileType(fileType: string) {
  return fileType !== "UNSUPPORTED";
}

function safeFileScanError() {
  return "The Librarian could not inspect this file safely.";
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

function failedFileDraft(
  rootPath: string,
  localPath: string,
  fileName: string,
  fileType = "UNKNOWN",
): BridgeScannedFileDraft {
  return {
    checksum: null,
    fileType,
    lastModified: null,
    localPath,
    readStatus: "FAILED",
    relativePath: relativePathFor(rootPath, localPath) || fileName,
    scanError: safeFileScanError(),
    sourceCreatedAt: null,
    sizeBytes: null,
  };
}

async function scanFile(
  rootPath: string,
  localPath: string,
  fileName: string,
): Promise<BridgeScannedFileDraft> {
  let fileStats;

  try {
    fileStats = await lstat(localPath);
  } catch {
    return failedFileDraft(rootPath, localPath, fileName);
  }

  const relativePath = relativePathFor(rootPath, localPath);

  if (fileStats.isSymbolicLink()) {
    return {
      checksum: null,
      fileType: "SYMLINK",
      lastModified: fileStats.mtime,
      localPath,
      readStatus: "UNSUPPORTED",
      relativePath,
      sourceCreatedAt: fileStats.birthtime,
      sizeBytes: BigInt(fileStats.size),
    };
  }

  if (!fileStats.isFile()) {
    return {
      checksum: null,
      fileType: "UNSUPPORTED",
      lastModified: fileStats.mtime,
      localPath,
      readStatus: "UNSUPPORTED",
      relativePath,
      sourceCreatedAt: fileStats.birthtime,
      sizeBytes: BigInt(fileStats.size),
    };
  }

  const fileType = classifyFileType(fileName);

  if (!isSupportedFileType(fileType)) {
    return {
      checksum: null,
      fileType,
      lastModified: fileStats.mtime,
      localPath,
      readStatus: "UNSUPPORTED",
      relativePath,
      sourceCreatedAt: fileStats.birthtime,
      sizeBytes: BigInt(fileStats.size),
    };
  }

  try {
    const audioMetadata = fileType.startsWith("AUDIO_")
      ? await extractAudioMetadata(localPath, relativePath, fileStats)
      : null;
    const videoMetadata = fileType.startsWith("VIDEO_")
      ? await extractVideoMetadata(localPath, relativePath, fileStats)
      : null;

    return {
      audioMetadata,
      checksum: await checksumFile(localPath),
      fileType,
      lastModified: fileStats.mtime,
      localPath,
      readStatus: "SUPPORTED",
      relativePath,
      sourceCreatedAt: fileStats.birthtime,
      sizeBytes: BigInt(fileStats.size),
      videoMetadata,
    };
  } catch {
    return {
      checksum: null,
      fileType,
      lastModified: fileStats.mtime,
      localPath,
      readStatus: "FAILED",
      relativePath,
      scanError: safeFileScanError(),
      sourceCreatedAt: fileStats.birthtime,
      sizeBytes: BigInt(fileStats.size),
    };
  }
}

async function scanDirectory(
  rootPath: string,
  currentPath: string,
  scannedFiles: BridgeScannedFileDraft[],
) {
  let directory;

  try {
    directory = await opendir(currentPath);
  } catch {
    return;
  }

  for await (const entry of directory) {
    if (shouldIgnoreSystemFile(entry.name)) {
      continue;
    }

    const entryPath = path.normalize(path.join(currentPath, entry.name));

    if (entry.isDirectory()) {
      if (shouldIgnoreFolder(entry.name)) {
        continue;
      }

      await scanDirectory(rootPath, entryPath, scannedFiles);
      continue;
    }

    scannedFiles.push(await scanFile(rootPath, entryPath, entry.name));
  }
}

export async function scanBridgeFolder(
  folderPath: string,
): Promise<BridgeFolderScanResult> {
  const startedAt = new Date();
  const rootPath = await validateBridgeFolderPath(folderPath);
  const files: BridgeScannedFileDraft[] = [];

  await scanDirectory(rootPath, rootPath, files);

  const completedAt = new Date();
  const supportedFiles = files.filter(
    (file) => file.readStatus === "SUPPORTED",
  ).length;
  const unsupportedFiles = files.filter(
    (file) => file.readStatus === "UNSUPPORTED",
  ).length;
  const failedFiles = files.filter((file) => file.readStatus === "FAILED").length;

  return {
    completedAt,
    failedFiles,
    files,
    folderDisplayName: displayNameForFolder(rootPath),
    rootPath,
    startedAt,
    supportedFiles,
    totalFiles: files.length,
    unsupportedFiles,
  };
}

export async function scanConfiguredBridgeTestFolder() {
  const folderPath = await getConfiguredBridgeTestFolder();

  return scanBridgeFolder(folderPath);
}

export async function scanConnectedLibrary(connectedLibraryId: string) {
  const library = await requireConnectedLibraryPermission(
    connectedLibraryId,
    "readPermission",
    "scan files",
  );

  if (library.bridgeRootId) {
    try {
      return await scanLocalBridgeRoot(library.bridgeRootId);
    } catch (error) {
      throw new BridgeScannerError(
        error instanceof Error
          ? error.message
          : "The NSN Bridge could not scan this folder.",
        503,
      );
    }
  }

  if (!isDevelopmentBridgeScannerEnabled()) {
    throw new ConnectedLibraryError(
      "Reconnect this folder through the NSN Bridge before scanning it.",
      403,
    );
  }

  const folderPath = await rootForConnectedLibrary(
    connectedLibraryId,
    "readPermission",
    "scan files",
  );

  return scanBridgeFolder(folderPath);
}
