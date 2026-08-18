import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createBridgeUpdateManager } from "../../apps/bridge/src/main/update-manager";
import type { BridgeReleaseManifest } from "../../packages/bridge-protocol/src";

let tempRoot: string;

function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function dmgAsset(options: {
  architecture: "arm64" | "x64";
  available?: boolean;
  fileName?: string;
  sha?: string;
  url?: string | null;
}) {
  return {
    architecture: options.architecture,
    available: options.available ?? true,
    fileName:
      options.fileName ??
      `NSN-Bridge-v0.1.98-mac-${options.architecture}-unsigned.dmg`,
    kind: "dmg" as const,
    sha256: options.sha ?? sha256("valid dmg"),
    sizeBytes: 9,
    url:
      options.url ??
      `https://downloads.example/NSN-Bridge-v0.1.98-mac-${options.architecture}-unsigned.dmg`,
  };
}

function manifest(
  version = "0.1.98",
  overrides: Partial<BridgeReleaseManifest> = {},
): BridgeReleaseManifest {
  return {
    assets: [dmgAsset({ architecture: "arm64" }), dmgAsset({ architecture: "x64" })],
    minimumMacOSVersion: "13.0",
    privacySummary: ["Folders stay on this Mac."],
    releaseDate: "2026-08-18T00:00:00.000Z",
    releaseNotes: ["Fixed packaged Mac folder selection."],
    systemRequirements: ["macOS 13 or newer."],
    version,
    ...overrides,
  };
}

function fetchForManifest(options: {
  downloadContent?: Buffer | string;
  failManifest?: boolean;
  manifest?: BridgeReleaseManifest;
}) {
  const content = Buffer.from(options.downloadContent ?? "valid dmg");
  const responseManifest = options.manifest ?? manifest();

  return async (url: string) => {
    if (url.endsWith("/api/download/bridge/manifest")) {
      if (options.failManifest) {
        return new Response(JSON.stringify({ ok: false }), { status: 503 });
      }

      return Response.json({
        manifest: responseManifest,
        ok: true,
      });
    }

    return new Response(content, {
      headers: {
        "content-length": String(content.length),
      },
      status: 200,
    });
  };
}

async function updateFiles() {
  return readdir(tempRoot).catch(() => []);
}

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "nsn-update-test-"));
});

afterEach(async () => {
  await rm(tempRoot, { force: true, recursive: true });
});

describe("Bridge assisted update manager", () => {
  it("does not treat the same version as an update", async () => {
    const manager = createBridgeUpdateManager({
      appUrl: "https://nsn.example",
      architecture: "x64",
      currentVersion: "0.1.98",
      fetchImpl: fetchForManifest({}),
      updateDirectory: tempRoot,
    });
    const result = await manager.checkForUpdates();

    assert.equal(result.state, "UP_TO_DATE");
    assert.equal(result.available, false);
  });

  it("does not treat an older version as an update", async () => {
    const manager = createBridgeUpdateManager({
      appUrl: "https://nsn.example",
      architecture: "x64",
      currentVersion: "0.1.99",
      fetchImpl: fetchForManifest({ manifest: manifest("0.1.98") }),
      updateDirectory: tempRoot,
    });
    const result = await manager.checkForUpdates();

    assert.equal(result.state, "UP_TO_DATE");
    assert.equal(result.available, false);
  });

  it("selects only the matching Mac architecture", async () => {
    const manager = createBridgeUpdateManager({
      appUrl: "https://nsn.example",
      architecture: "x64",
      currentVersion: "0.1.97",
      fetchImpl: fetchForManifest({}),
      updateDirectory: tempRoot,
    });
    const result = await manager.checkForUpdates();

    assert.equal(result.state, "UPDATE_AVAILABLE");
    assert.equal(result.fileName, "NSN-Bridge-v0.1.98-mac-x64-unsigned.dmg");
    assert.equal(result.architecture, "x64");
  });

  it("does not install when the matching architecture is missing", async () => {
    const manager = createBridgeUpdateManager({
      appUrl: "https://nsn.example",
      architecture: "x64",
      currentVersion: "0.1.97",
      fetchImpl: fetchForManifest({
        manifest: manifest("0.1.98", {
          assets: [dmgAsset({ architecture: "arm64" })],
        }),
      }),
      updateDirectory: tempRoot,
    });
    const result = await manager.checkForUpdates();

    assert.equal(result.state, "UP_TO_DATE");
    assert.equal(result.available, false);
  });

  it("rejects unavailable, non-HTTPS, and unsafe release assets", async () => {
    for (const badAsset of [
      dmgAsset({ architecture: "x64", available: false, url: null }),
      dmgAsset({ architecture: "x64", url: "http://downloads.example/update.dmg" }),
      dmgAsset({ architecture: "x64", fileName: "../NSN-Bridge.dmg" }),
    ]) {
      const manager = createBridgeUpdateManager({
        appUrl: "https://nsn.example",
        architecture: "x64",
        currentVersion: "0.1.97",
        fetchImpl: fetchForManifest({
          manifest: manifest("0.1.98", {
            assets: [dmgAsset({ architecture: "arm64" }), badAsset],
          }),
        }),
        updateDirectory: tempRoot,
      });
      const result = await manager.checkForUpdates();

      assert.equal(
        result.state === "UP_TO_DATE" || result.state === "FAILED",
        true,
      );
      assert.equal(result.available, false);
    }
  });

  it("downloads and verifies a matching update", async () => {
    const manager = createBridgeUpdateManager({
      appUrl: "https://nsn.example",
      architecture: "arm64",
      currentVersion: "0.1.97",
      fetchImpl: fetchForManifest({}),
      updateDirectory: tempRoot,
    });

    assert.equal((await manager.checkForUpdates()).state, "UPDATE_AVAILABLE");
    const result = await manager.downloadUpdate();
    const files = await updateFiles();

    assert.equal(result.state, "READY_TO_OPEN");
    assert.equal(files.includes("NSN-Bridge-v0.1.98-mac-arm64-unsigned.dmg"), true);
    assert.equal(files.some((fileName) => fileName.endsWith(".download")), false);
  });

  it("deletes checksum mismatches and refuses to open them", async () => {
    let openCalls = 0;
    const manager = createBridgeUpdateManager({
      appUrl: "https://nsn.example",
      architecture: "x64",
      currentVersion: "0.1.97",
      fetchImpl: fetchForManifest({ downloadContent: "tampered dmg" }),
      openPath: async () => {
        openCalls += 1;
        return "";
      },
      updateDirectory: tempRoot,
    });

    await manager.checkForUpdates();
    const result = await manager.downloadUpdate();
    const openResult = await manager.openDownloadedUpdate();

    assert.equal(result.state, "FAILED");
    assert.equal(result.message, "The downloaded update could not be verified and was not opened.");
    assert.deepEqual(await updateFiles(), []);
    assert.equal(openResult.state, "FAILED");
    assert.equal(openCalls, 0);
  });

  it("removes partial downloads on cancellation", async () => {
    await mkdir(tempRoot, { recursive: true });
    const manager = createBridgeUpdateManager({
      appUrl: "https://nsn.example",
      architecture: "x64",
      currentVersion: "0.1.97",
      fetchImpl: fetchForManifest({}),
      updateDirectory: tempRoot,
    });

    await manager.checkForUpdates();
    await manager.downloadUpdate();
    const beforeCancel = await updateFiles();
    const result = await manager.cancelDownloadedUpdate();

    assert.equal(beforeCancel.length, 1);
    assert.equal(result.state, "UPDATE_AVAILABLE");
    assert.deepEqual(await updateFiles(), []);
  });

  it("opens only a verified downloaded update", async () => {
    let openedPath = "";
    const manager = createBridgeUpdateManager({
      appUrl: "https://nsn.example",
      architecture: "x64",
      currentVersion: "0.1.97",
      fetchImpl: fetchForManifest({}),
      openPath: async (filePath) => {
        openedPath = filePath;
        return "";
      },
      updateDirectory: tempRoot,
    });

    assert.equal((await manager.openDownloadedUpdate()).state, "FAILED");
    await manager.checkForUpdates();
    await manager.downloadUpdate();
    const opened = await manager.openDownloadedUpdate();

    assert.equal(opened.state, "READY_TO_OPEN");
    assert.match(openedPath, /NSN-Bridge-v0\.1\.98-mac-x64-unsigned\.dmg$/u);
  });

  it("does not report failed or invalid manifest checks as successful", async () => {
    const failedManager = createBridgeUpdateManager({
      appUrl: "https://nsn.example",
      architecture: "x64",
      currentVersion: "0.1.97",
      fetchImpl: fetchForManifest({ failManifest: true }),
      updateDirectory: tempRoot,
    });
    const invalidManager = createBridgeUpdateManager({
      appUrl: "https://nsn.example",
      architecture: "x64",
      currentVersion: "0.1.97",
      fetchImpl: fetchForManifest({
        manifest: manifest("0.1.98", {
          releaseDate: "not-a-date",
        }),
      }),
      updateDirectory: tempRoot,
    });

    assert.equal((await failedManager.checkForUpdates()).state, "FAILED");
    assert.equal((await invalidManager.checkForUpdates()).state, "FAILED");
  });
});
