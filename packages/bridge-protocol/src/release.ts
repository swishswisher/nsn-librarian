import type {
  BridgeProtocolValidationResult,
  BridgeReleaseAsset,
  BridgeReleaseManifest,
} from "./types";

export function parseBridgeReleaseVersion(version: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());

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

function validSha256(value: string) {
  return /^[a-f0-9]{64}$/i.test(value);
}

function validateReleaseAsset(asset: BridgeReleaseAsset) {
  if (!asset.fileName.trim()) {
    return "Every Bridge release asset needs a file name.";
  }

  if (asset.available) {
    if (!asset.url) {
      return "Available Bridge assets need a download URL.";
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
