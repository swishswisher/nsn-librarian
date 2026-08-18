import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BridgeAppError, type BridgePlatform } from "../types";

const unsafeWindowsDirectoryNames = new Set([
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "$recycle.bin",
  "system volume information",
]);

const unsafePosixDirectoryNames = new Set([
  "applications",
  "bin",
  "boot",
  "dev",
  "etc",
  "library",
  "network",
  "private",
  "sbin",
  "system",
  "usr",
  "var",
  "volumes",
]);

const unsafeFolderNames = new Set([
  ".git",
  ".next",
  "node_modules",
  "prisma",
]);

const invalidPathCharacters = /[<>:"\\|?*\u0000]/;

export type RootPathValidationOptions = {
  forbiddenApplicationPaths?: string[];
};

export function bridgePlatform(): BridgePlatform {
  if (process.platform === "win32") {
    return "WINDOWS";
  }

  if (process.platform === "darwin") {
    return "MACOS";
  }

  if (process.platform === "linux") {
    return "LINUX";
  }

  return "UNKNOWN";
}

export function pathKey(value: string) {
  const normalized = path.normalize(value);

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeForComparison(value: string) {
  return pathKey(path.resolve(value)).replace(/[\\/]$/, "");
}

function isSameOrInside(parent: string, child: string) {
  const parentKey = normalizeForComparison(parent);
  const childKey = normalizeForComparison(child);

  return childKey === parentKey || childKey.startsWith(`${parentKey}${path.sep}`);
}

export function safeLocationDescription(actualPath: string) {
  const normalized = path.normalize(actualPath);
  const parsed = path.parse(normalized);
  const relative = normalized.slice(parsed.root.length);
  const parts = relative.split(path.sep).filter(Boolean);

  if (parts.length === 0) {
    return "Computer root";
  }

  if (parts.length <= 2) {
    return path.join(parsed.root, ...parts);
  }

  return path.join(parsed.root, "...", ...parts.slice(-2));
}

export function displayNameForFolder(actualPath: string) {
  return path.basename(actualPath) || "Connected Folder";
}

function ensureNotDriveRoot(actualPath: string) {
  const parsed = path.parse(actualPath);
  const normalized = normalizeForComparison(actualPath);
  const root = normalizeForComparison(parsed.root);

  if (normalized === root) {
    throw new BridgeAppError(
      "Choose a folder inside the drive instead of the entire drive.",
      "UNSAFE_SYSTEM_ROOT",
      422,
    );
  }
}

function ensureNotSystemDirectory(actualPath: string) {
  const parsed = path.parse(actualPath);
  const relative = actualPath.slice(parsed.root.length);
  const parts = relative.split(path.sep).filter(Boolean);
  const firstPart = parts[0]?.toLowerCase();

  if (
    firstPart &&
    (unsafeWindowsDirectoryNames.has(firstPart) ||
      (bridgePlatform() !== "WINDOWS" && unsafePosixDirectoryNames.has(firstPart)))
  ) {
    throw new BridgeAppError(
      "Choose a personal work folder instead of a system folder.",
      "UNSAFE_SYSTEM_DIRECTORY",
      422,
    );
  }

  if (parts.some((part) => unsafeFolderNames.has(part.toLowerCase()))) {
    throw new BridgeAppError(
      "Choose a library folder, not the NSN application or its build folders.",
      "UNSAFE_APPLICATION_DIRECTORY",
      422,
    );
  }
}

function normalizedApplicationPath(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const resolved = path.resolve(trimmed);
  const parsed = path.parse(resolved);

  if (normalizeForComparison(resolved) === normalizeForComparison(parsed.root)) {
    return null;
  }

  return resolved;
}

function ensureNotAppDirectory(
  actualPath: string,
  options: RootPathValidationOptions,
) {
  const forbiddenApplicationPaths = [
    ...new Set(
      (options.forbiddenApplicationPaths ?? [])
        .map(normalizedApplicationPath)
        .filter((value): value is string => value !== null),
    ),
  ];

  for (const appPath of forbiddenApplicationPaths) {
    if (isSameOrInside(appPath, actualPath) || isSameOrInside(actualPath, appPath)) {
      throw new BridgeAppError(
        "Choose a library folder outside the NSN application files.",
        "UNSAFE_APPLICATION_DIRECTORY",
        422,
      );
    }
  }
}

export async function validateRootPath(
  folderPath: string,
  options: RootPathValidationOptions = {},
) {
  const trimmed = folderPath.trim();

  if (!trimmed) {
    throw new BridgeAppError("Choose a folder first.", "EMPTY_PATH", 400);
  }

  const resolvedPath = path.resolve(trimmed);
  const stats = await lstat(resolvedPath).catch(() => null);

  if (!stats) {
    throw new BridgeAppError(
      "Choose a readable folder before connecting it.",
      "FOLDER_UNREADABLE",
      422,
    );
  }

  if (stats.isSymbolicLink()) {
    throw new BridgeAppError(
      "Choose a real folder instead of a symlink.",
      "UNSAFE_SYMLINK",
      422,
    );
  }

  if (!stats.isDirectory()) {
    throw new BridgeAppError(
      "Choose a readable folder before connecting it.",
      "FOLDER_UNREADABLE",
      422,
    );
  }

  await access(resolvedPath, fsConstants.R_OK).catch(() => {
    throw new BridgeAppError(
      "The NSN Bridge could not read that folder safely.",
      "FOLDER_UNREADABLE",
      422,
    );
  });

  const realRoot = await realpath(resolvedPath);

  ensureNotDriveRoot(realRoot);
  ensureNotSystemDirectory(realRoot);
  ensureNotAppDirectory(realRoot, options);

  return path.normalize(realRoot);
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

export function normalizeRelativePath(value: string, allowRoot = false) {
  const trimmed = value.trim().replace(/\\/g, "/");

  if (!trimmed) {
    if (allowRoot) {
      return "";
    }

    throw new BridgeAppError(
      "Use a relative path inside the connected folder.",
      "INVALID_RELATIVE_PATH",
      400,
    );
  }

  if (path.posix.isAbsolute(trimmed) || hasDrivePrefix(trimmed)) {
    throw new BridgeAppError(
      "Use a relative path inside the connected folder.",
      "ABSOLUTE_PATH_REJECTED",
      403,
    );
  }

  const normalized = path.posix.normalize(trimmed);

  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new BridgeAppError(
      "Use a relative path inside the connected folder.",
      "PATH_TRAVERSAL_REJECTED",
      403,
    );
  }

  if (normalized === ".") {
    if (allowRoot) {
      return "";
    }

    throw new BridgeAppError(
      "Use a relative path inside the connected folder.",
      "INVALID_RELATIVE_PATH",
      400,
    );
  }

  if (normalized.split("/").some(invalidPathSegment)) {
    throw new BridgeAppError(
      "Use folder and file names the Bridge can handle safely.",
      "INVALID_RELATIVE_PATH",
      400,
    );
  }

  return normalized;
}

export function isPathInsideRoot(rootPath: string, candidatePath: string) {
  const rootKey = normalizeForComparison(rootPath);
  const candidateKey = normalizeForComparison(candidatePath);

  return (
    candidateKey !== rootKey &&
    candidateKey.startsWith(`${rootKey}${path.sep}`)
  );
}

export async function resolveInsideRoot(
  rootPath: string,
  relativePath: string,
  options: { allowRoot?: boolean } = {},
) {
  const normalizedRelativePath = normalizeRelativePath(
    relativePath,
    options.allowRoot,
  );
  const resolvedPath = path.normalize(
    path.resolve(rootPath, ...normalizedRelativePath.split("/").filter(Boolean)),
  );
  const realRoot = await realpath(rootPath);
  const parentForRealpath = normalizedRelativePath
    ? path.dirname(resolvedPath)
    : resolvedPath;
  const realParent = await realpath(parentForRealpath).catch(() => null);
  const realResolvedPath = await realpath(resolvedPath).catch(() => null);

  if (!isSameOrInside(realRoot, resolvedPath)) {
    throw new BridgeAppError(
      "The Bridge refused a path outside the connected folder.",
      "PATH_OUTSIDE_ROOT",
      403,
    );
  }

  if (realParent && !isSameOrInside(realRoot, realParent)) {
    throw new BridgeAppError(
      "The Bridge refused a symlink path outside the connected folder.",
      "SYMLINK_ESCAPE_REJECTED",
      403,
    );
  }

  if (realResolvedPath && !isSameOrInside(realRoot, realResolvedPath)) {
    throw new BridgeAppError(
      "The Bridge refused a symlink path outside the connected folder.",
      "SYMLINK_ESCAPE_REJECTED",
      403,
    );
  }

  return {
    relativePath: normalizedRelativePath,
    resolvedPath,
  };
}

export function platformHomeLabel() {
  return bridgePlatform() === "WINDOWS"
    ? safeLocationDescription(os.homedir())
    : "this computer";
}

export function bridgeRootUri(rootId: string, relativePath = "") {
  const normalized = relativePath
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");

  return normalized ? `bridge://${rootId}/${normalized}` : `bridge://${rootId}`;
}

export function bridgeRootIdFromUri(value: string) {
  const match = /^bridge:\/\/([^/]+)(?:\/.*)?$/.exec(value);

  return match?.[1] ?? null;
}
