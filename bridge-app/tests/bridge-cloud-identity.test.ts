import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  createBridgeKeyPair,
} from "../../packages/bridge-protocol/src";
import { BridgeAppError } from "../src/types";
import {
  bridgeIdentityCanAuthenticate,
  getCompletePairedBridgeIdentity,
  sendBridgeHeartbeat,
  setBridgeCloudFetchForTests,
} from "../../apps/bridge/src/main/cloud-client";
import {
  readBridgeSecretState,
  saveBridgeSecret,
} from "../../apps/bridge/src/main/keychain";

let tempRoot: string;
let previousAppUrl: string | undefined;
let previousDataDir: string | undefined;
let previousForceFileSecrets: string | undefined;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "nsn-bridge-identity-"));
  previousAppUrl = process.env.NSN_LIBRARIAN_APP_URL;
  previousDataDir = process.env.NSN_BRIDGE_DATA_DIR;
  previousForceFileSecrets = process.env.NSN_BRIDGE_FORCE_FILE_SECRETS_FOR_TESTS;
  process.env.NSN_BRIDGE_DATA_DIR = path.join(tempRoot, ".nsn-bridge");
  process.env.NSN_BRIDGE_FORCE_FILE_SECRETS_FOR_TESTS = "1";
  process.env.NSN_LIBRARIAN_APP_URL = "https://librarian.example";
});

afterEach(async () => {
  setBridgeCloudFetchForTests();

  if (previousAppUrl === undefined) {
    delete process.env.NSN_LIBRARIAN_APP_URL;
  } else {
    process.env.NSN_LIBRARIAN_APP_URL = previousAppUrl;
  }

  if (previousDataDir === undefined) {
    delete process.env.NSN_BRIDGE_DATA_DIR;
  } else {
    process.env.NSN_BRIDGE_DATA_DIR = previousDataDir;
  }

  if (previousForceFileSecrets === undefined) {
    delete process.env.NSN_BRIDGE_FORCE_FILE_SECRETS_FOR_TESTS;
  } else {
    process.env.NSN_BRIDGE_FORCE_FILE_SECRETS_FOR_TESTS =
      previousForceFileSecrets;
  }

  await rm(tempRoot, { force: true, recursive: true });
});

describe("Bridge complete paired identity", () => {
  it("treats device ID plus private key as ready for authenticated cloud requests", async () => {
    const keys = createBridgeKeyPair();

    await saveBridgeSecret("bridge-device-id", "bridge-device-complete");
    await saveBridgeSecret("device-private-key", keys.privateKey);

    const identity = await getCompletePairedBridgeIdentity();

    assert.equal(bridgeIdentityCanAuthenticate(identity), true);
    assert.equal(identity.status, "COMPLETE");
    assert.equal(identity.bridgeDeviceId, "bridge-device-complete");
  });

  it("does not treat a saved device ID alone as paired", async () => {
    await saveBridgeSecret("bridge-device-id", "bridge-device-without-key");

    const identity = await getCompletePairedBridgeIdentity();

    assert.equal(bridgeIdentityCanAuthenticate(identity), false);
    assert.equal(identity.status, "INCOMPLETE");
    assert.equal(identity.bridgeDeviceId, "bridge-device-without-key");
    assert.equal(identity.safeErrorCategory, "PAIRING_INCOMPLETE");
  });

  it("does not treat a private key alone as paired", async () => {
    const keys = createBridgeKeyPair();

    await saveBridgeSecret("device-private-key", keys.privateKey);

    const identity = await getCompletePairedBridgeIdentity();

    assert.equal(bridgeIdentityCanAuthenticate(identity), false);
    assert.equal(identity.status, "INCOMPLETE");
    assert.equal(identity.bridgeDeviceId, null);
    assert.equal(identity.safeErrorCategory, "PAIRING_INCOMPLETE");
  });

  it("distinguishes an unavailable secret store from missing credentials", async () => {
    const blockedDataDir = path.join(tempRoot, "blocked-data-dir");

    await mkdir(path.join(blockedDataDir, "secure"), { recursive: true });
    await writeFile(
      path.join(blockedDataDir, "secure", "bridge-device-id.json"),
      "not json",
      "utf8",
    );
    process.env.NSN_BRIDGE_DATA_DIR = blockedDataDir;

    const result = await readBridgeSecretState("bridge-device-id");

    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(result.safeErrorCategory, "SECRET_READ_FAILED");
    assert.equal("value" in result, false);
  });

  it("sends a heartbeat when complete credentials are readable", async () => {
    const keys = createBridgeKeyPair();
    const fetchCalls: Array<{
      init?: RequestInit;
      input: RequestInfo | URL;
    }> = [];

    await saveBridgeSecret("bridge-device-id", "bridge-device-heartbeat");
    await saveBridgeSecret("device-private-key", keys.privateKey);
    setBridgeCloudFetchForTests(async (input, init) => {
      fetchCalls.push({ init, input });

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });

    await sendBridgeHeartbeat();

    assert.equal(fetchCalls.length, 1);
    assert.match(String(fetchCalls[0]?.input), /bridge-device-heartbeat/);
    assert.equal(
      JSON.stringify(fetchCalls[0]?.init ?? {}).includes(keys.privateKey),
      false,
    );
  });

  it("does not attempt authenticated fetches when credentials are incomplete", async () => {
    let fetchCalls = 0;

    await saveBridgeSecret("bridge-device-id", "bridge-device-without-key");
    setBridgeCloudFetchForTests(async () => {
      fetchCalls += 1;

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });

    await assert.rejects(
      () => sendBridgeHeartbeat(),
      (error) =>
        error instanceof BridgeAppError && error.code === "BRIDGE_NOT_PAIRED",
    );
    assert.equal(fetchCalls, 0);
  });
});
