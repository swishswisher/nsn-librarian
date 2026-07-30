import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import {
  BridgeAppError,
  type BridgeFolderScanResult,
  type BridgeScannedFileDraft,
} from "../types";
import { bridgeRootUri, isPathInsideRoot, pathKey } from "./safety";
import { requireRootPermission, updateRoot } from "../main/registry";

const supportedExtensions = new Map<string, string>([
  [".txt", "TEXT"],
  [".md", "MARKDOWN"],
  [".markdown", "MARKDOWN"],
  [".pdf", "PDF"],
  [".docx", "DOCX"],
  [".html", "HTML"],
  [".htm", "HTML"],
  [".jpg", "IMAGE_JPG"],
  [".jpeg", "IMAGE_JPEG"],
  [".png", "IMAGE_PNG"],
  [".webp", "IMAGE_WEBP"],
  [".gif", "IMAGE_GIF"],
  [".tiff", "IMAGE_TIFF"],
  [".tif", "IMAGE_TIF"],
  [".heic", "IMAGE_HEIC"],
  [".heif", "IMAGE_HEIF"],
  [".mp3", "AUDIO_MP3"],
  [".wav", "AUDIO_WAV"],
  [".m4a", "AUDIO_M4A"],
  [".aac", "AUDIO_AAC"],
  [".mp4", "VIDEO_MP4"],
  [".mov", "VIDEO_MOV"],
  [".m4v", "VIDEO_M4V"],
]);

const ignoredFolderNames = new Set([
  "$recycle.bin",
  "system volume information",
  ".fseventsd",
  ".spotlight-v100",
  ".trashes",
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
]);

const ignoredSystemFileNames = new Set([
  ".ds_store",
  "desktop.ini",
  "thumbs.db",
]);

function relativePathFor(rootPath: string, filePath: string) {
  const relative = path.relative(rootPath, filePath);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new BridgeAppError(
      "The Bridge only scans files inside the connected folder.",
      "PATH_OUTSIDE_ROOT",
      403,
    );
  }

  return relative.split(path.sep).join(path.posix.sep);
}

function shouldIgnore(relativePath: string) {
  const parts = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  const fileName = parts.at(-1)?.toLowerCase() ?? "";

  if (ignoredSystemFileNames.has(fileName)) {
    return true;
  }

  return parts.some((part) => {
    const normalized = part.toLowerCase();

    return part.startsWith(".") || ignoredFolderNames.has(normalized);
  });
}

function classifyFileType(relativePath: string) {
  return supportedExtensions.get(path.posix.extname(relativePath).toLowerCase()) ?? "UNSUPPORTED";
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

async function fileDraft(rootId: string, rootPath: string, filePath: string) {
  const relativePath = relativePathFor(rootPath, filePath);
  const fileType = classifyFileType(relativePath);

  try {
    const stats = await lstat(filePath);

    if (!stats.isFile() || stats.isSymbolicLink()) {
      return {
        checksum: null,
        fileType: "UNSUPPORTED",
        lastModified: stats.mtime,
        localPath: bridgeRootUri(rootId, relativePath),
        readStatus: "UNSUPPORTED",
        relativePath,
        sizeBytes: BigInt(stats.size),
        sourceCreatedAt: stats.birthtime,
      } satisfies BridgeScannedFileDraft;
    }

    if (fileType === "UNSUPPORTED") {
      return {
        checksum: null,
        fileType,
        lastModified: stats.mtime,
        localPath: bridgeRootUri(rootId, relativePath),
        readStatus: "UNSUPPORTED",
        relativePath,
        sizeBytes: BigInt(stats.size),
        sourceCreatedAt: stats.birthtime,
      } satisfies BridgeScannedFileDraft;
    }

    await access(filePath, fsConstants.R_OK);

    return {
      checksum: await checksumFile(filePath),
      fileType,
      lastModified: stats.mtime,
      localPath: bridgeRootUri(rootId, relativePath),
      readStatus: "SUPPORTED",
      relativePath,
      sizeBytes: BigInt(stats.size),
      sourceCreatedAt: stats.birthtime,
    } satisfies BridgeScannedFileDraft;
  } catch {
    return {
      checksum: null,
      fileType,
      lastModified: null,
      localPath: bridgeRootUri(rootId, relativePath),
      readStatus: "FAILED",
      relativePath,
      scanError: "The Bridge could not inspect this file safely.",
      sizeBytes: null,
      sourceCreatedAt: null,
    } satisfies BridgeScannedFileDraft;
  }
}

async function scanDirectory(
  rootId: string,
  rootPath: string,
  currentPath: string,
  files: BridgeScannedFileDraft[],
) {
  const currentStats = await lstat(currentPath);

  if (!currentStats.isDirectory() || currentStats.isSymbolicLink()) {
    return;
  }

  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name);
    const relativePath = relativePathFor(rootPath, entryPath);

    if (shouldIgnore(relativePath)) {
      continue;
    }

    const stats = await lstat(entryPath).catch(() => null);

    if (!stats) {
      files.push({
        checksum: null,
        fileType: "UNSUPPORTED",
        lastModified: null,
        localPath: bridgeRootUri(rootId, relativePath),
        readStatus: "FAILED",
        relativePath,
        scanError: "The Bridge could not inspect this file safely.",
        sizeBytes: null,
        sourceCreatedAt: null,
      });
      continue;
    }

    if (stats.isSymbolicLink()) {
      files.push({
        checksum: null,
        fileType: "UNSUPPORTED",
        lastModified: stats.mtime,
        localPath: bridgeRootUri(rootId, relativePath),
        readStatus: "UNSUPPORTED",
        relativePath,
        scanError: "The Bridge does not follow symlinks outside connected folders.",
        sizeBytes: BigInt(stats.size),
        sourceCreatedAt: stats.birthtime,
      });
      continue;
    }

    if (stats.isDirectory()) {
      await scanDirectory(rootId, rootPath, entryPath, files);
      continue;
    }

    if (stats.isFile()) {
      files.push(await fileDraft(rootId, rootPath, entryPath));
    }
  }
}

export async function scanBridgeRoot(rootId: string): Promise<BridgeFolderScanResult> {
  const root = await requireRootPermission(rootId, "readPermission", "scan files");
  const startedAt = new Date();
  const files: BridgeScannedFileDraft[] = [];

  if (!isPathInsideRoot(path.dirname(root.actualPath), root.actualPath)) {
    throw new BridgeAppError(
      "The connected folder could not be verified safely.",
      "ROOT_UNAVAILABLE",
      422,
    );
  }

  await scanDirectory(root.id, root.actualPath, root.actualPath, files);

  const completedAt = new Date();
  const supportedFiles = files.filter((file) => file.readStatus === "SUPPORTED").length;
  const unsupportedFiles = files.filter((file) => file.readStatus === "UNSUPPORTED").length;
  const failedFiles = files.filter((file) => file.readStatus === "FAILED").length;

  await updateRoot(rootId, {
    lastScanAt: completedAt.toISOString(),
    status: "CONNECTED",
  });

  return {
    bridgeRootId: root.id,
    completedAt,
    failedFiles,
    files: files.sort((left, right) =>
      pathKey(left.relativePath).localeCompare(pathKey(right.relativePath)),
    ),
    folderDisplayName: root.displayName,
    rootPath: bridgeRootUri(root.id),
    safeLocation: root.safeLocation,
    startedAt,
    supportedFiles,
    totalFiles: files.length,
    unsupportedFiles,
  };
}
