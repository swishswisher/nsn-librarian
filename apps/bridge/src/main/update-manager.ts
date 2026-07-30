import type { BridgeReleaseManifest } from "../../../../packages/bridge-protocol/src";
import {
  parseBridgeReleaseVersion,
  validateBridgeReleaseManifest,
} from "../../../../packages/bridge-protocol/src";

function appUrl() {
  return (
    process.env.NSN_LIBRARIAN_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function currentVersion() {
  return process.env.NSN_BRIDGE_APP_VERSION ?? "0.1.0";
}

function versionIsNewer(candidate: string, current: string) {
  const left = parseBridgeReleaseVersion(candidate);
  const right = parseBridgeReleaseVersion(current);

  if (!left || !right) {
    return false;
  }

  return (
    left.major > right.major ||
    (left.major === right.major && left.minor > right.minor) ||
    (left.major === right.major &&
      left.minor === right.minor &&
      left.patch > right.patch)
  );
}

export async function checkBridgeUpdateManifest() {
  const response = await fetch(`${appUrl()}/api/download/bridge/manifest`, {
    headers: {
      "X-NSN-Bridge-Client": "nsn-macos-bridge",
    },
    method: "GET",
  });
  const payload = (await response.json().catch(() => null)) as
    | { manifest?: BridgeReleaseManifest; ok?: boolean }
    | null;

  if (!response.ok || !payload?.ok || !payload.manifest) {
    return {
      available: false,
      message: "Update information is not available right now.",
      releaseNotes: [],
      version: currentVersion(),
    };
  }

  const validation = validateBridgeReleaseManifest(payload.manifest);

  if (!validation.ok) {
    return {
      available: false,
      message: "Update information could not be verified.",
      releaseNotes: [],
      version: currentVersion(),
    };
  }

  return {
    available: versionIsNewer(payload.manifest.version, currentVersion()),
    message: versionIsNewer(payload.manifest.version, currentVersion())
      ? "A Bridge update is available. Review the release notes before installing."
      : "NSN Bridge is up to date.",
    releaseNotes: payload.manifest.releaseNotes,
    version: payload.manifest.version,
  };
}
