import type {
  BridgeProtocolValidationResult,
  BridgeReleaseAsset,
  BridgeReleaseManifest,
} from "./types";

export function parseBridgeReleaseVersion(version: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());

  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    version: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

export function compareBridgeReleaseVersions(left: string, right: string) {
  const parsedLeft = parseBridgeReleaseVersion(left);
  const parsedRight = parseBridgeReleaseVersion(right);

  if (!parsedLeft || !parsedRight) {
    return null;
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }

  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }

  return parsedLeft.patch - parsedRight.patch;
}

export function bridgeReleaseVersionIsNewer(candidate: string, current: string) {
  const comparison = compareBridgeReleaseVersions(candidate, current);

  return comparison !== null && comparison > 0;
}

function validSha256(value: string) {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function bridgeReleaseFileNameIsSafe(fileName: string) {
  const trimmed = fileName.trim();

  return (
    trimmed.length > 0 &&
    trimmed === fileName &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    !trimmed.includes("..") &&
    !trimmed.startsWith(".")
  );
}

function bridgeReleaseUrlIsSafe(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validateReleaseAsset(asset: BridgeReleaseAsset) {
  if (!bridgeReleaseFileNameIsSafe(asset.fileName)) {
    return "Every Bridge release asset needs a file name.";
  }

  if (asset.available) {
    if (!asset.url) {
      return "Available Bridge assets need a download URL.";
    }

    if (!bridgeReleaseUrlIsSafe(asset.url)) {
      return "Available Bridge assets need a secure download URL.";
    }

    if (!validSha256(asset.sha256)) {
      return "Available Bridge assets need a SHA-256 checksum.";
    }
  }

  return null;
}

export function validateBridgeReleaseManifest(
  manifest: BridgeReleaseManifest,
): BridgeProtocolValidationResult {
  if (!parseBridgeReleaseVersion(manifest.version)) {
    return {
      code: "INVALID_RELEASE_VERSION",
      message: "The Bridge release version could not be read.",
      ok: false,
    };
  }

  if (!Number.isFinite(Date.parse(manifest.releaseDate))) {
    return {
      code: "INVALID_RELEASE_DATE",
      message: "The Bridge release date could not be read.",
      ok: false,
    };
  }

  for (const asset of manifest.assets) {
    const error = validateReleaseAsset(asset);

    if (error) {
      return {
        code: "INVALID_RELEASE_ASSET",
        message: error,
        ok: false,
      };
    }
  }

  return {
    code: "RELEASE_MANIFEST_VALID",
    message: "The Bridge release manifest is valid.",
    ok: true,
  };
}

export function selectBridgeReleaseAsset(
  manifest: BridgeReleaseManifest,
  architecture: Extract<BridgeReleaseAsset["architecture"], "arm64" | "x64">,
) {
  return (
    manifest.assets.find(
      (asset) =>
        asset.kind === "dmg" &&
        asset.architecture === architecture &&
        asset.available &&
        Boolean(asset.url) &&
        validSha256(asset.sha256) &&
        bridgeReleaseFileNameIsSafe(asset.fileName) &&
        bridgeReleaseUrlIsSafe(asset.url ?? ""),
    ) ?? null
  );
}

export function suggestedMacArchitecture(userAgent: string) {
  const normalized = userAgent.toLowerCase();

  if (!normalized.includes("mac")) {
    return null;
  }

  if (normalized.includes("arm") || normalized.includes("apple")) {
    return "arm64" as const;
  }

  return "x64" as const;
}
