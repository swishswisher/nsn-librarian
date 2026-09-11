import path from "node:path";

export type PhysicalFileIdentityInput = {
  localPath?: string | null;
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

function bridgeFileIdentity(value: string, caseInsensitive: boolean) {
  const match = /^bridge:\/\/([^/]+)(?:\/(.*))?$/i.exec(value.trim());

  if (!match?.[1]) {
    return null;
  }

  const rootId = normalizedAlias(match[1]);
  const relativePath = normalizePhysicalRelativePath(
    match[2] ?? "",
    caseInsensitive,
  );

  return {
    fullPath: `bridge://${rootId}/${relativePath}`,
    rootAlias: `root:${rootId}`,
  };
}

function stableLocalFilePath(value: string | null | undefined, platform: string) {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  const caseInsensitive = caseInsensitivePlatform(platform);
  const bridgeIdentity = bridgeFileIdentity(trimmed, caseInsensitive);

  if (bridgeIdentity) {
    return bridgeIdentity.fullPath;
  }

  const withForwardSlashes = trimmed.replace(/\\/g, "/");
  const isAbsolute =
    path.posix.isAbsolute(withForwardSlashes) || path.win32.isAbsolute(trimmed);

  if (!isAbsolute) {
    return null;
  }

  const normalized = path.posix.normalize(withForwardSlashes);

  return caseInsensitive ? normalized.toLowerCase() : normalized;
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

function connectedRootAliases(
  root: PhysicalRootIdentity,
  fileLocalPath?: string | null,
) {
  const bridgeUriRootId = bridgeRootIdFromUri(root.localPath);
  const fileBridgeRootId = fileLocalPath
    ? bridgeFileIdentity(
        fileLocalPath,
        caseInsensitivePlatform(root.platform),
      )?.rootAlias ?? null
    : null;
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
    fileBridgeRootId,
    bridgeUriRootId
      ? null
      : `path:${normalizedAlias(root.platform)}:${normalizeRootPathKey(root.localPath, root.platform)}`,
  ].filter((alias): alias is string => Boolean(alias));

  return new Set(aliases);
}

export function samePhysicalRoot(
  left: PhysicalRootIdentity,
  right: PhysicalRootIdentity,
  leftFileLocalPath?: string | null,
  rightFileLocalPath?: string | null,
) {
  const leftRootAliases = connectedRootAliases(left, leftFileLocalPath);

  return [...connectedRootAliases(right, rightFileLocalPath)].some(
    (alias) => leftRootAliases.has(alias),
  );
}

export function samePhysicalFile(
  left: PhysicalFileIdentityInput,
  right: PhysicalFileIdentityInput,
) {
  const leftStablePath = stableLocalFilePath(
    left.localPath,
    left.scanSession.connectedFolder.platform,
  );
  const rightStablePath = stableLocalFilePath(
    right.localPath,
    right.scanSession.connectedFolder.platform,
  );

  if (leftStablePath && rightStablePath && leftStablePath === rightStablePath) {
    return true;
  }

  const sameRoot = samePhysicalRoot(
    left.scanSession.connectedFolder,
    right.scanSession.connectedFolder,
    left.localPath,
    right.localPath,
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
