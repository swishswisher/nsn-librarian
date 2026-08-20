import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BridgeAppError } from "../src/types";
import {
  createBridgeCloudState,
  safeCloudErrorCategory,
} from "../../apps/bridge/src/main/cloud-state";

describe("Bridge cloud runtime state", () => {
  it("records heartbeat success as online with a safe timestamp", () => {
    const cloudState = createBridgeCloudState(
      () => new Date("2026-08-19T10:00:00.000Z"),
    );

    cloudState.recordHeartbeatSuccess();

    assert.deepEqual(cloudState.getState(), {
      cloudConnectionState: "ONLINE",
      lastSuccessfulHeartbeatAt: "2026-08-19T10:00:00.000Z",
      lastSuccessfulRootSyncAt: null,
      latestSafeCloudErrorCategory: null,
    });
  });

  it("records incomplete credentials as authentication unavailable", () => {
    const cloudState = createBridgeCloudState();

    cloudState.recordAuthenticationUnavailable("PAIRING_INCOMPLETE");

    assert.equal(cloudState.getState().cloudConnectionState, "AUTH_UNAVAILABLE");
    assert.equal(
      cloudState.getState().latestSafeCloudErrorCategory,
      "PAIRING_INCOMPLETE",
    );
  });

  it("records root sync failure without losing the previous heartbeat", () => {
    const cloudState = createBridgeCloudState(
      () => new Date("2026-08-19T10:00:00.000Z"),
    );

    cloudState.recordHeartbeatSuccess();
    cloudState.recordRootSyncFailure(new Error("network detail stays local"));

    assert.equal(
      cloudState.getState().lastSuccessfulHeartbeatAt,
      "2026-08-19T10:00:00.000Z",
    );
    assert.equal(cloudState.getState().cloudConnectionState, "ROOT_SYNC_FAILED");
    assert.equal(
      cloudState.getState().latestSafeCloudErrorCategory,
      "ROOT_SYNC_FAILED",
    );
  });

  it("recovers to online when a later root sync succeeds", () => {
    let current = new Date("2026-08-19T10:00:00.000Z");
    const cloudState = createBridgeCloudState(() => current);

    cloudState.recordRootSyncFailure(new Error("temporary network problem"));
    current = new Date("2026-08-19T10:01:00.000Z");
    cloudState.recordRootSyncSuccess();

    assert.equal(cloudState.getState().cloudConnectionState, "ONLINE");
    assert.equal(
      cloudState.getState().lastSuccessfulRootSyncAt,
      "2026-08-19T10:01:00.000Z",
    );
    assert.equal(cloudState.getState().latestSafeCloudErrorCategory, null);
  });

  it("classifies Keychain and missing-pairing failures as auth failures", () => {
    assert.equal(
      safeCloudErrorCategory(
        new BridgeAppError("hidden detail", "KEYCHAIN_UNAVAILABLE", 503),
      ),
      "AUTH_UNAVAILABLE",
    );
    assert.equal(
      safeCloudErrorCategory(
        new BridgeAppError("hidden detail", "BRIDGE_NOT_PAIRED", 401),
      ),
      "AUTH_UNAVAILABLE",
    );
  });
});
