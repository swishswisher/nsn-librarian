import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  createBridgeKeyPair,
} from "../../packages/bridge-protocol/src";
import { BridgeAppError } from "../src/types";
import {
  assertBridgePrivateKeyCanSign,
  bridgeIdentityCanAuthenticate,
  getCompletePairedBridgeIdentity,
  pairBridgeWithCloud,
  sendBridgeHeartbeat,
  setBridgeCloudDiagnosticSinkForTests,
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
  setBridgeCloudDiagnosticSinkForTests(null);
});

afterEach(async () => {
  setBridgeCloudFetchForTests();
  setBridgeCloudDiagnosticSinkForTests();

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

  it("reads legacy raw multiline PEM secrets and verifies they can sign", async () => {
    const keys = createBridgeKeyPair();
    const secureDir = path.join(process.env.NSN_BRIDGE_DATA_DIR ?? "", "secure");

    await mkdir(secureDir, { recursive: true });
    await saveBridgeSecret("bridge-device-id", "bridge-device-legacy-key");
    await writeFile(
      path.join(secureDir, "device-private-key.json"),
      `${JSON.stringify({ value: keys.privateKey }, null, 2)}\n`,
      "utf8",
    );

    const identity = await getCompletePairedBridgeIdentity();

    assert.equal(bridgeIdentityCanAuthenticate(identity), true);
    assert.equal(identity.status, "COMPLETE");
    assertBridgePrivateKeyCanSign({
      privateKey: identity.privateKey,
      publicKey: keys.publicKey,
    });
  });

  it("stores new multiline PEM secrets encoded and reads them back decoded", async () => {
    const keys = createBridgeKeyPair();
    const secureDir = path.join(process.env.NSN_BRIDGE_DATA_DIR ?? "", "secure");

    await saveBridgeSecret("device-private-key", keys.privateKey);
    const stored = await readFile(
      path.join(secureDir, "device-private-key.json"),
      "utf8",
    );
    const result = await readBridgeSecretState("device-private-key");

    assert.equal(stored.includes("nsn-secret-v1:"), true);
    assert.equal(stored.includes("BEGIN PRIVATE KEY"), false);
    assert.equal(result.status, "PRESENT");
    assert.equal(result.value, keys.privateKey);
  });

  it("does not treat a corrupted saved private key as usable", async () => {
    await saveBridgeSecret("bridge-device-id", "bridge-device-corrupt-key");
    await saveBridgeSecret("device-private-key", "not a valid private key");

    const identity = await getCompletePairedBridgeIdentity();

    assert.equal(bridgeIdentityCanAuthenticate(identity), false);
    assert.equal(identity.status, "UNUSABLE");
    assert.equal(identity.safeErrorCategory, "PRIVATE_KEY_INVALID");
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
    const diagnostics: string[] = [];

    await saveBridgeSecret("bridge-device-id", "bridge-device-heartbeat");
    await saveBridgeSecret("device-private-key", keys.privateKey);
    setBridgeCloudDiagnosticSinkForTests((message) => {
      diagnostics.push(message);
    });
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
    assert.ok(
      diagnostics.some((message) =>
        message.includes("stage=COMPLETE_IDENTITY_LOADED"),
      ),
    );
    assert.ok(
      diagnostics.some((message) =>
        message.includes("stage=PRIVATE_KEY_PARSE_SUCCEEDED"),
      ),
    );
    assert.ok(
      diagnostics.some((message) => message.includes("stage=REQUEST_SIGNED")),
    );
    assert.ok(
      diagnostics.some((message) => message.includes("stage=FETCH_STARTED")),
    );
    assert.ok(
      diagnostics.some((message) =>
        message.includes("stage=HEARTBEAT_SUCCEEDED"),
      ),
    );
    assert.equal(diagnostics.join("\n").includes(keys.privateKey), false);
    assert.equal(diagnostics.join("\n").includes("x-nsn-bridge"), false);
  });

  it("classifies heartbeat network failures without exposing request details", async () => {
    const keys = createBridgeKeyPair();
    const diagnostics: string[] = [];

    await saveBridgeSecret("bridge-device-id", "bridge-device-network-failure");
    await saveBridgeSecret("device-private-key", keys.privateKey);
    setBridgeCloudDiagnosticSinkForTests((message) => {
      diagnostics.push(message);
    });
    setBridgeCloudFetchForTests(async () => {
      throw new Error("raw network detail");
    });

    await assert.rejects(
      () => sendBridgeHeartbeat(),
      (error) =>
        error instanceof BridgeAppError &&
        error.code === "NETWORK_UNAVAILABLE",
    );
    assert.ok(
      diagnostics.some((message) =>
        message.includes("category=NETWORK_UNAVAILABLE"),
      ),
    );
    assert.equal(diagnostics.join("\n").includes("raw network detail"), false);
  });

  it("preserves safe heartbeat auth failure categories from the server", async () => {
    const keys = createBridgeKeyPair();

    await saveBridgeSecret("bridge-device-id", "bridge-device-expired-request");
    await saveBridgeSecret("device-private-key", keys.privateKey);
    setBridgeCloudFetchForTests(async () => {
      return new Response(
        JSON.stringify({
          code: "REQUEST_EXPIRED",
          error: "This Bridge request has expired.",
          ok: false,
        }),
        {
          headers: { "content-type": "application/json" },
          status: 401,
        },
      );
    });

    await assert.rejects(
      () => sendBridgeHeartbeat(),
      (error) =>
        error instanceof BridgeAppError &&
        error.code === "REQUEST_EXPIRED",
    );
  });

  it("detects invalid heartbeat signatures without collapsing them to network failures", async () => {
    const keys = createBridgeKeyPair();

    await saveBridgeSecret("bridge-device-id", "bridge-device-invalid-signature");
    await saveBridgeSecret("device-private-key", keys.privateKey);
    setBridgeCloudFetchForTests(async () => {
      return new Response(
        JSON.stringify({
          code: "REQUEST_SIGNATURE_INVALID",
          error: "This Bridge request signature is invalid.",
          ok: false,
        }),
        {
          headers: { "content-type": "application/json" },
          status: 401,
        },
      );
    });

    await assert.rejects(
      () => sendBridgeHeartbeat(),
      (error) =>
        error instanceof BridgeAppError &&
        error.code === "REQUEST_SIGNATURE_INVALID",
    );
  });

  it("persists a pairing private key that can be verified after pairing", async () => {
    let pairedPublicKey = "";

    setBridgeCloudFetchForTests(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        bridgeDeviceId: string;
        publicKey: string;
      };
      pairedPublicKey = body.publicKey;

      return new Response(
        JSON.stringify({
          device: {
            appVersion: "0.1.103",
            architecture: "x64",
            bridgeDeviceId: body.bridgeDeviceId,
            deviceDisplayName: "Deanne's Intel Mac",
            lastSeenAt: null,
            pairedAt: "2026-08-20T00:00:00.000Z",
            platform: "MACOS",
            revokedAt: null,
            status: "PAIRED",
          },
          ok: true,
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });

    const device = await pairBridgeWithCloud("ABCD-EFGH");
    const identity = await getCompletePairedBridgeIdentity();

    assert.equal(device.status, "PAIRED");
    assert.equal(bridgeIdentityCanAuthenticate(identity), true);
    assert.equal(identity.status, "COMPLETE");
    assertBridgePrivateKeyCanSign({
      privateKey: identity.privateKey,
      publicKey: pairedPublicKey,
    });
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
