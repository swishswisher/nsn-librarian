import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bridgeRequestTimestampIsFresh,
  canonicalBridgeRequest,
  createBridgeDeviceRequestHeaders,
  createBridgeKeyPair,
  verifyBridgeDeviceRequestSignature,
} from "../../packages/bridge-protocol/src";

describe("Bridge device request authentication", () => {
  const keys = createBridgeKeyPair();
  const timestamp = "2026-07-30T12:00:00.000Z";
  const nonce = "a".repeat(48);
  const request = {
    bodyText: JSON.stringify({ appVersion: "0.1.0" }),
    bridgeDeviceId: "bridge_device_test",
    method: "POST",
    nonce,
    pathname: "/api/bridge/cloud/devices/bridge_device_test/heartbeat",
    timestamp,
  };

  it("signs and verifies a paired device request", () => {
    const headers = createBridgeDeviceRequestHeaders({
      ...request,
      privateKey: keys.privateKey,
    });

    assert.equal(
      verifyBridgeDeviceRequestSignature({
        ...request,
        publicKey: keys.publicKey,
        signature: headers["x-nsn-bridge-signature"],
      }),
      true,
    );
  });

  it("rejects a changed request body", () => {
    const headers = createBridgeDeviceRequestHeaders({
      ...request,
      privateKey: keys.privateKey,
    });

    assert.equal(
      verifyBridgeDeviceRequestSignature({
        ...request,
        bodyText: JSON.stringify({ appVersion: "changed" }),
        publicKey: keys.publicKey,
        signature: headers["x-nsn-bridge-signature"],
      }),
      false,
    );
  });

  it("uses a deterministic canonical request and validates clock freshness", () => {
    assert.equal(canonicalBridgeRequest(request), canonicalBridgeRequest(request));
    assert.equal(
      bridgeRequestTimestampIsFresh(timestamp, new Date(timestamp)),
      true,
    );
    assert.equal(
      bridgeRequestTimestampIsFresh(
        timestamp,
        new Date("2026-07-30T12:06:00.000Z"),
      ),
      false,
    );
  });
});
