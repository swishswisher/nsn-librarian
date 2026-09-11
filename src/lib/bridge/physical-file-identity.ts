import path from "node:path";

export type PhysicalFileIdentityInput = {
  relativePath: string;
  scanSession: {
    connectedFolder: {
      bridgeRootId: string | null;
      canonicalConnectedLibraryId: string | null;
      folderFingerprint: string | null;
      id: string;
      localPath: string;
      platform: string;
    };
  };
};

export type PhysicalRootIdentity = PhysicalFileIdentityInput["scanSession"]["connectedFolder"];

function caseInsensitivePlatform(platform: string) {
  return ["MACOS", "WINDOWS"].includes(platform.trim().toUpperCase());
}

function normalizedAlias(value: string) {
  return value.trim().toLowerCase();
}

function bridgeRootIdFromUri(value: string) {
  return /^bridge:\/\/([^/]+)(?:\/.*)?$/i.exec(value.trim())?.[1] ?? null;
}

function normalizeRootPathKey(value: string, platform: string) {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");

  return caseInsensitivePlatform(platform) ? normalized.toLowerCase() : normalized;
}

export function normalizePhysicalRelativePath(
  value: string,
  caseInsensitive = true,
) {
  const withForwardSlashes = value.trim().replace(/\\/g, "/");

  if (!withForwardSlashes) {
    return "";
  }

  const normalized = path.posix
    .normalize(`/${withForwardSlashes}`)
    .replace(/^\/+/, "");

  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function connectedRootAliases(root: PhysicalRootIdentity) {
  const bridgeUriRootId = bridgeRootIdFromUri(root.localPath);
  const aliases = [
    `library:${normalizedAlias(root.id)}`,
    root.canonicalConnectedLibraryId
      ? `library:${normalizedAlias(root.canonicalConnectedLibraryId)}`
      : null,
    root.bridgeRootId
      ? `root:${normalizedAlias(root.bridgeRootId)}`
      : null,
    root.folderFingerprint
      ? `root:${normalizedAlias(root.folderFingerprint)}`
      : null,
    bridgeUriRootId ? `root:${normalizedAlias(bridgeUriRootId)}` : null,
    bridgeUriRootId
      ? null
      : `path:${normalizedAlias(root.platform)}:${normalizeRootPathKey(root.localPath, root.platform)}`,
  ].filter((alias): alias is string => Boolean(alias));

  return new Set(aliases);
}

export function samePhysicalRoot(
  left: PhysicalRootIdentity,
  right: PhysicalRootIdentity,
) {
  const leftRootAliases = connectedRootAliases(left);

  return [...connectedRootAliases(right)].some(
    (alias) => leftRootAliases.has(alias),
  );
}

export function samePhysicalFile(
  left: PhysicalFileIdentityInput,
  right: PhysicalFileIdentityInput,
) {
  const sameRoot = samePhysicalRoot(
    left.scanSession.connectedFolder,
    right.scanSession.connectedFolder,
  );

  if (!sameRoot) {
    return false;
  }

  const caseInsensitive =
    caseInsensitivePlatform(left.scanSession.connectedFolder.platform) ||
    caseInsensitivePlatform(right.scanSession.connectedFolder.platform);

  return (
    normalizePhysicalRelativePath(left.relativePath, caseInsensitive) ===
    normalizePhysicalRelativePath(right.relativePath, caseInsensitive)
  );
}
