import { readFile } from "node:fs/promises";
import path from "node:path";

import type { BridgeReleaseManifest } from "../../../packages/bridge-protocol/src";
import { validateBridgeReleaseManifest } from "../../../packages/bridge-protocol/src";

export class BridgeReleaseManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeReleaseManifestError";
  }
}

let cachedManifest:
  | {
      loadedAt: number;
      manifest: BridgeReleaseManifest;
    }
  | null = null;

const manifestCacheMs = 5 * 60 * 1000;

function manifestPath() {
  return path.join(
    process.cwd(),
    "bridge-releases",
    "bridge-release-manifest.json",
  );
}

function releaseManifestFromEnv() {
  const raw = process.env.NSN_BRIDGE_RELEASE_MANIFEST_JSON?.trim();

  if (!raw) {
    return null;
  }

  return JSON.parse(raw) as BridgeReleaseManifest;
}

async function loadReleaseManifest() {
  const fromEnv = releaseManifestFromEnv();

  if (fromEnv) {
    return fromEnv;
  }

  return JSON.parse(await readFile(manifestPath(), "utf8")) as BridgeReleaseManifest;
}

export async function getBridgeReleaseManifest() {
  const now = Date.now();

  if (cachedManifest && now - cachedManifest.loadedAt < manifestCacheMs) {
    return cachedManifest.manifest;
  }

  const manifest = await loadReleaseManifest();
  const validation = validateBridgeReleaseManifest(manifest);

  if (!validation.ok) {
    throw new BridgeReleaseManifestError(validation.message);
  }

  cachedManifest = {
    loadedAt: now,
    manifest,
  };

  return manifest;
}
