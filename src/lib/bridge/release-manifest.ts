import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  BridgeReleaseAsset,
  BridgeReleaseManifest,
} from "../../../packages/bridge-protocol/src";
import {
  parseBridgeReleaseVersion,
  validateBridgeReleaseManifest,
} from "../../../packages/bridge-protocol/src";

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

type GitHubReleaseAsset = {
  browser_download_url: string;
  name: string;
  size: number;
};

type GitHubRelease = {
  assets: GitHubReleaseAsset[];
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  tag_name: string;
};

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

async function loadFallbackManifest() {
  const fromEnv = releaseManifestFromEnv();

  if (fromEnv) {
    return fromEnv;
  }

  return JSON.parse(await readFile(manifestPath(), "utf8")) as BridgeReleaseManifest;
}

function githubHeaders() {
  const token = process.env.NSN_BRIDGE_GITHUB_TOKEN?.trim();

  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "NSN-Librarian-Bridge-Release-Reader",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function parseChecksums(value: string) {
  const checksums = new Map<string, string>();

  for (const line of value.split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/iu.exec(line.trim());

    if (match) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }

  return checksums;
}

function architectureForAsset(fileName: string) {
  if (/mac-arm64/i.test(fileName)) {
    return "arm64" as const;
  }

  if (/mac-x64/i.test(fileName)) {
    return "x64" as const;
  }

  return "universal" as const;
}

function releaseNotes(release: GitHubRelease, fallback: string[]) {
  const notes = release.body
    ?.split(/\r?\n/u)
    .map((line) => line.replace(/^[-*#\s]+/u, "").trim())
    .filter(Boolean)
    .slice(0, 8);

  return notes && notes.length > 0 ? notes : fallback;
}

async function loadGitHubReleaseManifest(
  fallback: BridgeReleaseManifest,
): Promise<BridgeReleaseManifest | null> {
  const repository =
    process.env.NSN_BRIDGE_GITHUB_REPOSITORY?.trim() ||
    "swishswisher/nsn-librarian";
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases?per_page=20`,
    {
      headers: githubHeaders(),
      next: { revalidate: 300 },
    },
  );

  if (!response.ok) {
    return null;
  }

  const releases = (await response.json()) as GitHubRelease[];
  const release = releases.find(
    (item) =>
      !item.draft &&
      item.tag_name.startsWith("bridge-v") &&
      item.assets.some((asset) => asset.name.endsWith(".dmg")),
  );

  if (!release) {
    return null;
  }

  const checksumAsset = release.assets.find(
    (asset) => asset.name === "SHA256SUMS.txt",
  );
  const checksumText = checksumAsset
    ? await fetch(checksumAsset.browser_download_url, {
        headers: githubHeaders(),
        next: { revalidate: 300 },
      }).then((checksumResponse) =>
        checksumResponse.ok ? checksumResponse.text() : "",
      )
    : "";
  const checksums = parseChecksums(checksumText);
  const assets: BridgeReleaseAsset[] = release.assets
    .filter(
      (asset) =>
        asset.name.endsWith(".dmg") ||
        asset.name === "SHA256SUMS.txt" ||
        asset.name === "latest-mac.json",
    )
    .map((asset) => ({
      architecture: architectureForAsset(asset.name),
      available: Boolean(checksums.get(asset.name)),
      fileName: asset.name,
      kind: asset.name.endsWith(".dmg")
        ? "dmg"
        : asset.name === "SHA256SUMS.txt"
          ? "checksums"
          : "json",
      sha256: checksums.get(asset.name) ?? "pending-release-asset",
      sizeBytes: asset.size,
      url: checksums.get(asset.name) ? asset.browser_download_url : null,
    }));
  const parsedVersion = parseBridgeReleaseVersion(
    release.tag_name.replace(/^bridge-/u, ""),
  );

  if (!parsedVersion) {
    return null;
  }

  return {
    ...fallback,
    assets,
    releaseDate: release.published_at ?? fallback.releaseDate,
    releaseNotes: releaseNotes(release, fallback.releaseNotes),
    version: parsedVersion.version,
  };
}

export async function getBridgeReleaseManifest() {
  const now = Date.now();

  if (cachedManifest && now - cachedManifest.loadedAt < manifestCacheMs) {
    return cachedManifest.manifest;
  }

  const fallback = await loadFallbackManifest();
  const manifest =
    (await loadGitHubReleaseManifest(fallback).catch(() => null)) ?? fallback;
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
