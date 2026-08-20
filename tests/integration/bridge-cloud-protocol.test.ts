import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createBridgeCommandEnvelope,
  createBridgeCommandReplayKey,
  createBridgeKeyPair,
  createPairingCode,
  bridgeReleaseVersionIsNewer,
  parseBridgeReleaseVersion,
  selectBridgeReleaseAsset,
  validateBridgeCommandForDevice,
  validateBridgeReleaseManifest,
  validatePairingRedemption,
  type BridgeDeviceSummary,
  type BridgeReleaseManifest,
} from "../../packages/bridge-protocol/src";
import { validateBridgeRelativePath } from "../../packages/filesystem-plans/src";
import {
  cloudBridgeHealth,
  effectiveBridgeHealth,
} from "../../src/lib/bridge/effective-health";
import { bridgeHomeHealthDisplay } from "../../src/lib/bridge/home-health";
import type { LocalBridgeHealth } from "../../src/lib/bridge/local-bridge-client";

describe("Bridge cloud protocol", () => {
  const pairingSecret = "test-pairing-secret";
  const commandSecret = "test-command-secret";
  const now = new Date("2026-07-24T12:00:00.000Z");

  it("accepts a valid one-time device pairing request", () => {
    const pairing = createPairingCode(pairingSecret, now);
    const keys = createBridgeKeyPair();
    const validation = validatePairingRedemption({
      actorUserId: "deanne",
      appVersion: "0.1.0",
      codeHash: pairing.codeHash,
      expectedUserId: "deanne",
      expiresAt: pairing.expiresAt,
      pairingCode: pairing.code,
      pairingSecret,
      publicKey: keys.publicKey,
      status: "ACTIVE",
      now,
    });

    assert.equal(validation.ok, true);
  });

  it("rejects expired pairing codes", () => {
    const pairing = createPairingCode(pairingSecret, now);
    const validation = validatePairingRedemption({
      actorUserId: "deanne",
      appVersion: "0.1.0",
      codeHash: pairing.codeHash,
      expectedUserId: "deanne",
      expiresAt: pairing.expiresAt,
      pairingCode: pairing.code,
      pairingSecret,
      publicKey: createBridgeKeyPair().publicKey,
      status: "ACTIVE",
      now: new Date(pairing.expiresAt.getTime() + 1),
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.code, "PAIRING_CODE_EXPIRED");
  });

  it("rejects reused pairing codes", () => {
    const pairing = createPairingCode(pairingSecret, now);
    const validation = validatePairingRedemption({
      actorUserId: "deanne",
      appVersion: "0.1.0",
      codeHash: pairing.codeHash,
      expectedUserId: "deanne",
      expiresAt: pairing.expiresAt,
      pairingCode: pairing.code,
      pairingSecret,
      publicKey: createBridgeKeyPair().publicKey,
      status: "CONSUMED",
      now,
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.code, "PAIRING_CODE_USED");
  });

  it("rejects pairing codes for the wrong user", () => {
    const pairing = createPairingCode(pairingSecret, now);
    const validation = validatePairingRedemption({
      actorUserId: "someone-else",
      appVersion: "0.1.0",
      codeHash: pairing.codeHash,
      expectedUserId: "deanne",
      expiresAt: pairing.expiresAt,
      pairingCode: pairing.code,
      pairingSecret,
      publicKey: createBridgeKeyPair().publicKey,
      status: "ACTIVE",
      now,
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.code, "WRONG_USER");
  });

  it("validates command signatures for the intended device", () => {
    const envelope = createBridgeCommandEnvelope({
      bridgeDeviceId: "bridge-device-a",
      bridgeRootId: "root-a",
      commandType: "SCAN_LIBRARY",
      connectedLibraryId: "library-a",
      issuedAt: now,
      payload: {
        mode: "read-only",
      },
      signingSecret: commandSecret,
    });
    const validation = validateBridgeCommandForDevice({
      deviceStatus: "ONLINE",
      envelope,
      expectedBridgeDeviceId: "bridge-device-a",
      now,
      signingSecret: commandSecret,
    });

    assert.equal(validation.ok, true);
  });

  it("prevents expired commands, replay, and multi-device leakage", () => {
    const envelope = createBridgeCommandEnvelope({
      bridgeDeviceId: "bridge-device-a",
      commandType: "EXECUTE_PLAN",
      expiresAt: new Date(now.getTime() + 1000),
      issuedAt: now,
      payload: {
        planId: "plan-a",
      },
      signingSecret: commandSecret,
    });

    assert.equal(
      validateBridgeCommandForDevice({
        deviceStatus: "ONLINE",
        envelope,
        expectedBridgeDeviceId: "bridge-device-b",
        now,
        signingSecret: commandSecret,
      }).code,
      "WRONG_DEVICE",
    );

    assert.equal(
      validateBridgeCommandForDevice({
        deviceStatus: "ONLINE",
        envelope,
        expectedBridgeDeviceId: "bridge-device-a",
        now: new Date(now.getTime() + 1001),
        signingSecret: commandSecret,
      }).code,
      "COMMAND_EXPIRED",
    );

    assert.equal(
      validateBridgeCommandForDevice({
        alreadyProcessedReplayKeys: new Set([createBridgeCommandReplayKey(envelope)]),
        deviceStatus: "ONLINE",
        envelope,
        expectedBridgeDeviceId: "bridge-device-a",
        now,
        signingSecret: commandSecret,
      }).code,
      "COMMAND_REPLAYED",
    );
  });

  it("blocks commands for revoked devices", () => {
    const envelope = createBridgeCommandEnvelope({
      bridgeDeviceId: "bridge-device-a",
      commandType: "START_WATCHING",
      issuedAt: now,
      signingSecret: commandSecret,
    });
    const validation = validateBridgeCommandForDevice({
      deviceStatus: "REVOKED",
      envelope,
      expectedBridgeDeviceId: "bridge-device-a",
      now,
      signingSecret: commandSecret,
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.code, "DEVICE_REVOKED");
  });

  it("keeps command creation deterministic around idempotency keys", () => {
    const first = createBridgeCommandEnvelope({
      bridgeDeviceId: "bridge-device-a",
      commandType: "PREVIEW_EXECUTION",
      idempotencyKey: "preview-plan-a",
      issuedAt: now,
      payload: {
        planId: "plan-a",
      },
      signingSecret: commandSecret,
    });
    const second = createBridgeCommandEnvelope({
      bridgeDeviceId: "bridge-device-a",
      commandType: "PREVIEW_EXECUTION",
      idempotencyKey: "preview-plan-a",
      issuedAt: now,
      payload: {
        planId: "plan-a",
      },
      signingSecret: commandSecret,
    });

    assert.equal(first.idempotencyKey, second.idempotencyKey);
    assert.equal(first.payloadHash, second.payloadHash);
  });

  it("rejects unsafe relative paths for root-owned filesystem plans", () => {
    assert.equal(validateBridgeRelativePath("Folder/file.txt").ok, true);
    assert.equal(validateBridgeRelativePath("../outside.txt").reason, "PATH_TRAVERSAL");
    assert.equal(validateBridgeRelativePath("C:/Users/deanne/file.txt").reason, "ABSOLUTE_PATH");
  });

  it("validates the download manifest and release version", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(
          process.cwd(),
          "bridge-releases",
          "bridge-release-manifest.json",
        ),
        "utf8",
      ),
    ) as BridgeReleaseManifest;
    const version = parseBridgeReleaseVersion(manifest.version);
    const validation = validateBridgeReleaseManifest(manifest);

    assert.deepEqual(version, {
      major: 0,
      minor: 1,
      patch: 0,
      version: "0.1.0",
    });
    assert.equal(validation.ok, true);
  });

  it("orders release versions without collapsing prerelease suffixes", () => {
    assert.equal(bridgeReleaseVersionIsNewer("0.1.98", "0.1.97"), true);
    assert.equal(bridgeReleaseVersionIsNewer("0.1.98", "0.1.98"), false);
    assert.equal(bridgeReleaseVersionIsNewer("0.1.97", "0.1.98"), false);
    assert.equal(parseBridgeReleaseVersion("0.1.0-dev-98"), null);
  });

  it("selects only installable architecture-compatible DMG assets", () => {
    const manifest: BridgeReleaseManifest = {
      assets: [
        {
          architecture: "arm64",
          available: true,
          fileName: "NSN-Bridge-v0.1.98-mac-arm64-unsigned.dmg",
          kind: "dmg",
          sha256: "a".repeat(64),
          sizeBytes: 1024,
          url: "https://downloads.example/arm64.dmg",
        },
        {
          architecture: "x64",
          available: true,
          fileName: "NSN-Bridge-v0.1.98-mac-x64-unsigned.dmg",
          kind: "dmg",
          sha256: "b".repeat(64),
          sizeBytes: 1024,
          url: "https://downloads.example/x64.dmg",
        },
      ],
      minimumMacOSVersion: "13.0",
      privacySummary: ["Folders stay on this Mac."],
      releaseDate: "2026-08-18T00:00:00.000Z",
      releaseNotes: ["Test release."],
      systemRequirements: ["macOS 13 or newer."],
      version: "0.1.98",
    };

    assert.equal(
      selectBridgeReleaseAsset(manifest, "arm64")?.fileName,
      "NSN-Bridge-v0.1.98-mac-arm64-unsigned.dmg",
    );
    assert.equal(
      selectBridgeReleaseAsset(manifest, "x64")?.fileName,
      "NSN-Bridge-v0.1.98-mac-x64-unsigned.dmg",
    );
    assert.equal(
      selectBridgeReleaseAsset(
        {
          ...manifest,
          assets: [manifest.assets[0]],
        },
        "x64",
      ),
      null,
    );
    assert.equal(
      selectBridgeReleaseAsset(
        {
          ...manifest,
          assets: [
            {
              ...manifest.assets[1],
              available: false,
              url: null,
            },
          ],
        },
        "x64",
      ),
      null,
    );
  });
});

describe("Bridge effective Home health", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");
  const localReady: LocalBridgeHealth = {
    message: "Bridge ready",
    ok: true,
    paired: true,
    platform: "darwin",
    status: "BRIDGE_READY",
    version: "0.1.0",
  };
  const localUnavailable: LocalBridgeHealth = {
    message: "The NSN Bridge is not reachable from this server.",
    ok: false,
    paired: false,
    platform: null,
    status: "BRIDGE_UNAVAILABLE",
    version: null,
  };

  function device(
    overrides: Partial<BridgeDeviceSummary> = {},
  ): BridgeDeviceSummary {
    return {
      appVersion: "0.1.0",
      architecture: "x64",
      bridgeDeviceId: "bridge-device-intel-mac",
      deviceDisplayName: "Deanne's Intel Mac",
      lastSeenAt: now.toISOString(),
      pairedAt: now.toISOString(),
      platform: "MACOS",
      revokedAt: null,
      status: "ONLINE",
      ...overrides,
    };
  }

  function display(bridgeHealth: LocalBridgeHealth, devices: BridgeDeviceSummary[]) {
    return bridgeHomeHealthDisplay({
      bridgeHealth,
      devices,
      formatLastSeen: () => "18 Aug 2026, 12:00 PM",
    });
  }

  it("keeps Home ready when the local Bridge is directly reachable", () => {
    const health = effectiveBridgeHealth(localReady, [], now);
    const home = display(health, []);

    assert.equal(health.ok, true);
    assert.equal(health.status, "BRIDGE_READY");
    assert.equal(home.badgeLabel, "Bridge ready");
    assert.equal(home.thisMacLabel, "This Mac is online");
    assert.equal(home.deviceLabel, "This Mac");
    assert.equal(home.versionLabel, "0.1.0");
  });

  it("uses a recent ONLINE cloud heartbeat when local Bridge is unavailable", () => {
    const devices = [device()];
    const health = effectiveBridgeHealth(localUnavailable, devices, now);
    const home = display(health, devices);

    assert.equal(health.ok, true);
    assert.equal(health.status, "BRIDGE_READY");
    assert.equal(home.badgeLabel, "Bridge ready");
    assert.equal(home.thisMacLabel, "This Mac is online");
    assert.equal(home.deviceLabel, "Deanne's Intel Mac");
    assert.equal(
      home.versionLabel,
      "0.1.0, last seen 18 Aug 2026, 12:00 PM",
    );
  });

  it("does not treat pairing alone as a recent cloud heartbeat", () => {
    const pairedOnly = [
      device({
        lastSeenAt: null,
        status: "PAIRED",
      }),
    ];
    const pairedWithTimestampButNoOnlineStatus = [
      device({
        status: "PAIRED",
      }),
    ];

    assert.equal(
      effectiveBridgeHealth(localUnavailable, pairedOnly, now).ok,
      false,
    );
    assert.equal(
      effectiveBridgeHealth(
        localUnavailable,
        pairedWithTimestampButNoOnlineStatus,
        now,
      ).ok,
      false,
    );
  });

  it("marks Home unavailable when the cloud device is stale or offline", () => {
    const staleDevices = [
      device({
        lastSeenAt: new Date(now.getTime() - 91_000).toISOString(),
      }),
    ];
    const offlineDevices = [device({ status: "OFFLINE" })];
    const staleHealth = effectiveBridgeHealth(
      localUnavailable,
      staleDevices,
      now,
    );
    const offlineHealth = effectiveBridgeHealth(
      localUnavailable,
      offlineDevices,
      now,
    );

    assert.equal(staleHealth.ok, false);
    assert.equal(staleHealth.status, "BRIDGE_UNAVAILABLE");
    assert.equal(display(staleHealth, staleDevices).badgeLabel, "Bridge unavailable");
    assert.equal(offlineHealth.ok, false);
    assert.equal(offlineHealth.status, "BRIDGE_UNAVAILABLE");
  });

  it("keeps Home in the not-paired state when no active cloud device exists", () => {
    const health = effectiveBridgeHealth(localUnavailable, [], now);
    const home = display(health, []);

    assert.equal(health.ok, false);
    assert.equal(health.paired, false);
    assert.equal(home.badgeLabel, "Bridge not paired");
    assert.equal(home.thisMacLabel, "No paired Mac yet");
    assert.equal(home.deviceLabel, "No paired Mac yet");
    assert.equal(home.versionLabel, "Pair a Mac to begin");
  });

  it("does not let Home badge and This Mac labels contradict each other", () => {
    const staleDevices = [
      device({
        lastSeenAt: new Date(now.getTime() - 91_000).toISOString(),
      }),
    ];
    const cases = [
      display(effectiveBridgeHealth(localReady, [], now), []),
      display(effectiveBridgeHealth(localUnavailable, [device()], now), [device()]),
      display(
        cloudBridgeHealth(
          staleDevices,
          now,
        ),
        staleDevices,
      ),
      display(effectiveBridgeHealth(localUnavailable, [], now), []),
    ];

    for (const home of cases) {
      if (home.badgeLabel === "Bridge ready") {
        assert.equal(home.thisMacLabel, "This Mac is online");
      } else {
        assert.notEqual(home.thisMacLabel, "This Mac is online");
      }
    }
  });
});
