import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createBridgeCommandEnvelope,
  createBridgeCommandReplayKey,
  createBridgeKeyPair,
  createPairingCode,
  parseBridgeReleaseVersion,
  validateBridgeCommandForDevice,
  validateBridgeReleaseManifest,
  validatePairingRedemption,
  type BridgeReleaseManifest,
} from "../../packages/bridge-protocol/src";
import { validateBridgeRelativePath } from "../../packages/filesystem-plans/src";

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
});
