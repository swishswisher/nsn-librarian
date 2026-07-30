import { constants as fsConstants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import path from "node:path";

import { requireRootPermission } from "../main/registry";
import { BridgeAppError, type BridgeResolvedFile } from "../types";
import { resolveInsideRoot } from "./safety";

function missingFileError() {
  return new BridgeAppError(
    "This file is no longer available at its scanned location.",
    "SOURCE_FILE_MISSING",
    404,
  );
}

export async function resolveBridgeRootFile(
  rootId: string,
  relativePath: string,
): Promise<BridgeResolvedFile> {
  const root = await requireRootPermission(
    rootId,
    "readPermission",
    "read files",
  );
  const safePath = await resolveInsideRoot(root.actualPath, relativePath);
  const stats = await lstat(safePath.resolvedPath).catch(() => null);

  if (!stats) {
    throw missingFileError();
  }

  if (stats.isSymbolicLink()) {
    throw new BridgeAppError(
      "This file points outside the connected folder and was not opened.",
      "UNSAFE_SYMLINK",
      403,
    );
  }

  if (!stats.isFile()) {
    throw missingFileError();
  }

  await access(safePath.resolvedPath, fsConstants.R_OK).catch(() => {
    throw new BridgeAppError(
      "The Bridge does not currently have permission to read this file.",
      "READ_PERMISSION_REQUIRED",
      403,
    );
  });

  return {
    fileName: path.posix.basename(safePath.relativePath),
    lastModified: stats.mtime,
    localPath: safePath.resolvedPath,
    relativePath: safePath.relativePath,
    sizeBytes: BigInt(stats.size),
    sourceCreatedAt: stats.birthtime,
  };
}
