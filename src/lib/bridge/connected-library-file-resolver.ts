import { constants as fsConstants, type Stats } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { getPrismaClient } from "@/lib/db/prisma";

import {
  ConnectedLibraryError,
  requireScannedFilePermission,
  validateConnectedLibraryPath,
  type ConnectedLibraryPermission,
} from "./connected-libraries";
import {
  LocalBridgeClientError,
  resolveLocalBridgeFile,
} from "./local-bridge-client";

export type ConnectedLibraryFileErrorCategory =
  | "CONNECTED_LIBRARY_UNAVAILABLE"
  | "READ_PERMISSION_REQUIRED"
  | "SOURCE_FILE_MISSING"
  | "PATH_OUTSIDE_CONNECTED_LIBRARY"
  | "UNSAFE_SYMLINK"
  | "NOT_FOUND"
  | "NOT_A_READABLE_FILE";

type ScannedFileForResolution = {
  id: string;
  localPath: string;
  relativePath: string;
  scanSession: {
    connectedFolderId: string;
    connectedFolder: {
      bridgeRootId: string | null;
      displayName: string;
      localPath: string;
      platform: string;
    };
  };
};

export type ResolvedConnectedLibraryFile = {
  bridgeRootId: string | null;
  connectedLibraryId: string;
  fileName: string;
  filePath: string;
  fileStats: Stats;
  relativePath: string;
  scannedFile: ScannedFileForResolution;
};

export class ConnectedLibraryFileResolutionError extends Error {
  statusCode: number;
  category: ConnectedLibraryFileErrorCategory;

  constructor(
    message: string,
    statusCode = 400,
    category: ConnectedLibraryFileErrorCategory = "NOT_A_READABLE_FILE",
  ) {
    super(message);
    this.name = "ConnectedLibraryFileResolutionError";
    this.statusCode = statusCode;
    this.category = category;
  }
}

function pathKey(value: string, platform: string) {
  const normalized = path.normalize(value);

  return platform === "WINDOWS" || process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function relativePathKey(value: string, platform: string) {
  const normalized = value.replace(/\\/g, "/");

  return platform === "WINDOWS" || process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function hasDrivePrefix(value: string) {
  return /^[a-zA-Z]:/.test(value.trim());
}

function normalizeRelativePath(value: string) {
  const trimmed = value.trim().replace(/\\/g, "/");

  if (!trimmed) {
    throw new ConnectedLibraryFileResolutionError(
      "This file could not be opened because its location is outside the connected folder.",
      400,
      "PATH_OUTSIDE_CONNECTED_LIBRARY",
    );
  }

  if (path.posix.isAbsolute(trimmed) || hasDrivePrefix(trimmed)) {
    throw new ConnectedLibraryFileResolutionError(
      "This file could not be opened because its location is outside the connected folder.",
      403,
      "PATH_OUTSIDE_CONNECTED_LIBRARY",
    );
  }

  const normalized = path.posix.normalize(trimmed);

  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new ConnectedLibraryFileResolutionError(
      "This file could not be opened because its location is outside the connected folder.",
      403,
      "PATH_OUTSIDE_CONNECTED_LIBRARY",
    );
  }

  return normalized;
}

function normalizeForComparison(value: string, platform: string) {
  return pathKey(path.resolve(value), platform).replace(/[\\/]$/, "");
}

function isSameOrInside(rootPath: string, candidatePath: string, platform: string) {
  const rootKey = normalizeForComparison(rootPath, platform);
  const candidateKey = normalizeForComparison(candidatePath, platform);

  return (
    candidateKey === rootKey ||
    candidateKey.startsWith(`${rootKey}${path.sep}`)
  );
}

function missingFileMessage(itemLabel: string) {
  return `This ${itemLabel} is no longer available at its scanned location.`;
}

function connectedLibraryUnavailable() {
  return new ConnectedLibraryFileResolutionError(
    "The connected folder is not currently available.",
    403,
    "CONNECTED_LIBRARY_UNAVAILABLE",
  );
}

function readPermissionRequired() {
  return new ConnectedLibraryFileResolutionError(
    "The Librarian does not currently have permission to read this folder.",
    403,
    "READ_PERMISSION_REQUIRED",
  );
}

function sourceMissing(itemLabel: string) {
  return new ConnectedLibraryFileResolutionError(
    missingFileMessage(itemLabel),
    404,
    "SOURCE_FILE_MISSING",
  );
}

function unsafeSymlink() {
  return new ConnectedLibraryFileResolutionError(
    "This file points outside the connected folder and was not opened.",
    403,
    "UNSAFE_SYMLINK",
  );
}

function pathOutside() {
  return new ConnectedLibraryFileResolutionError(
    "This file could not be opened because its location is outside the connected folder.",
    403,
    "PATH_OUTSIDE_CONNECTED_LIBRARY",
  );
}

function readableFileStats(filePath: string, itemLabel: string) {
  return lstat(filePath)
    .catch(() => {
      throw sourceMissing(itemLabel);
    })
    .then(async (stats) => {
      if (stats.isSymbolicLink()) {
        throw unsafeSymlink();
      }

      if (!stats.isFile()) {
        throw sourceMissing(itemLabel);
      }

      await access(filePath, fsConstants.R_OK).catch(() => {
        throw readPermissionRequired();
      });

      return stats;
    });
}

function mapConnectedLibraryError(error: ConnectedLibraryError) {
  if (/permission/i.test(error.message)) {
    return readPermissionRequired();
  }

  return connectedLibraryUnavailable();
}

function mapLocalBridgeError(
  error: LocalBridgeClientError,
  itemLabel: string,
) {
  if (
    error.code === "PERMISSION_DENIED" ||
    error.code === "READ_PERMISSION_REQUIRED"
  ) {
    return readPermissionRequired();
  }

  if (error.code === "SOURCE_FILE_MISSING") {
    return sourceMissing(itemLabel);
  }

  if (error.code === "ROOT_NOT_FOUND") {
    return connectedLibraryUnavailable();
  }

  if (
    error.code === "SYMLINK_ESCAPE_REJECTED" ||
    error.code === "UNSAFE_SYMLINK"
  ) {
    return unsafeSymlink();
  }

  if (
    error.code === "ABSOLUTE_PATH_REJECTED" ||
    error.code === "INVALID_RELATIVE_PATH" ||
    error.code === "PATH_OUTSIDE_ROOT" ||
    error.code === "PATH_TRAVERSAL_REJECTED"
  ) {
    return pathOutside();
  }

  return connectedLibraryUnavailable();
}

async function resolveFallbackFile(input: {
  itemLabel: string;
  relativePath: string;
  rootPath: string;
  scannedFile: ScannedFileForResolution;
}) {
  const platform = input.scannedFile.scanSession.connectedFolder.platform;
  const resolvedPath = path.normalize(
    path.resolve(
      input.rootPath,
      ...input.relativePath.split("/").filter(Boolean),
    ),
  );
  const realRoot = await realpath(input.rootPath).catch(() => null);
  const realParent = await realpath(path.dirname(resolvedPath)).catch(
    () => null,
  );
  const realResolvedPath = await realpath(resolvedPath).catch(() => null);

  if (!isSameOrInside(input.rootPath, resolvedPath, platform)) {
    throw pathOutside();
  }

  if (realRoot) {
    if (realParent && !isSameOrInside(realRoot, realParent, platform)) {
      throw unsafeSymlink();
    }

    if (
      realResolvedPath &&
      !isSameOrInside(realRoot, realResolvedPath, platform)
    ) {
      throw unsafeSymlink();
    }
  }

  if (
    input.scannedFile.localPath &&
    !input.scannedFile.localPath.startsWith("bridge://") &&
    pathKey(input.scannedFile.localPath, platform) !==
      pathKey(resolvedPath, platform)
  ) {
    throw pathOutside();
  }

  return {
    filePath: resolvedPath,
    fileStats: await readableFileStats(resolvedPath, input.itemLabel),
  };
}

export async function resolveConnectedLibraryFile(input: {
  actionLabel?: string;
  connectedLibraryId?: string;
  itemLabel?: string;
  relativePath?: string;
  requiredPermission?: ConnectedLibraryPermission;
  scannedFileId: string;
}): Promise<ResolvedConnectedLibraryFile> {
  const prisma = getPrismaClient();
  const scannedFile = await prisma.scannedFile.findUnique({
    include: {
      scanSession: {
        select: {
          connectedFolderId: true,
          connectedFolder: {
            select: {
              bridgeRootId: true,
              displayName: true,
              localPath: true,
              platform: true,
            },
          },
        },
      },
    },
    where: {
      id: input.scannedFileId,
    },
  });
  const itemLabel = input.itemLabel ?? "file";

  if (!scannedFile) {
    throw new ConnectedLibraryFileResolutionError(
      "The Librarian could not find that scanned file.",
      404,
      "NOT_FOUND",
    );
  }

  if (
    input.connectedLibraryId &&
    scannedFile.scanSession.connectedFolderId !== input.connectedLibraryId
  ) {
    throw new ConnectedLibraryFileResolutionError(
      "The Librarian could not find that file in this connected folder.",
      404,
      "NOT_FOUND",
    );
  }

  const requestedRelativePath = normalizeRelativePath(
    input.relativePath ?? scannedFile.relativePath,
  );
  const storedRelativePath = normalizeRelativePath(scannedFile.relativePath);
  const platform = scannedFile.scanSession.connectedFolder.platform;

  if (
    relativePathKey(requestedRelativePath, platform) !==
    relativePathKey(storedRelativePath, platform)
  ) {
    throw pathOutside();
  }

  let library;

  try {
    library = await requireScannedFilePermission(
      scannedFile.id,
      input.requiredPermission ?? "readPermission",
      input.actionLabel ?? "read files",
    );
  } catch (error) {
    if (error instanceof ConnectedLibraryError) {
      throw mapConnectedLibraryError(error);
    }

    throw error;
  }

  const bridgeRootId =
    library.bridgeRootId ?? scannedFile.scanSession.connectedFolder.bridgeRootId;

  if (bridgeRootId) {
    try {
      const resolvedFile = await resolveLocalBridgeFile(
        bridgeRootId,
        storedRelativePath,
      );

      if (
        relativePathKey(resolvedFile.relativePath, platform) !==
        relativePathKey(storedRelativePath, platform)
      ) {
        throw pathOutside();
      }

      return {
        bridgeRootId,
        connectedLibraryId: library.id,
        fileName: resolvedFile.fileName,
        filePath: resolvedFile.localPath,
        fileStats: await readableFileStats(resolvedFile.localPath, itemLabel),
        relativePath: resolvedFile.relativePath,
        scannedFile,
      };
    } catch (error) {
      if (error instanceof ConnectedLibraryFileResolutionError) {
        throw error;
      }

      if (error instanceof LocalBridgeClientError) {
        throw mapLocalBridgeError(error, itemLabel);
      }

      throw connectedLibraryUnavailable();
    }
  }

  let rootPath: string;

  try {
    rootPath = await validateConnectedLibraryPath(library.localPath);
  } catch (error) {
    if (error instanceof ConnectedLibraryError) {
      throw mapConnectedLibraryError(error);
    }

    throw error;
  }

  const fallback = await resolveFallbackFile({
    itemLabel,
    relativePath: storedRelativePath,
    rootPath,
    scannedFile,
  });

  return {
    bridgeRootId: null,
    connectedLibraryId: library.id,
    fileName: path.posix.basename(storedRelativePath),
    filePath: fallback.filePath,
    fileStats: fallback.fileStats,
    relativePath: storedRelativePath,
    scannedFile,
  };
}
