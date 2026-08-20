import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  createBridgeDeviceId,
  createBridgeKeyPair,
} from "../../packages/bridge-protocol/src";
import { cloudBridgeHealth } from "../../src/lib/bridge/effective-health";

let createBridgePairingCode: typeof import("../../src/lib/bridge/cloud-coordinator").createBridgePairingCode;
let pairBridgeDevice: typeof import("../../src/lib/bridge/cloud-coordinator").pairBridgeDevice;
let recordBridgeHeartbeat: typeof import("../../src/lib/bridge/cloud-coordinator").recordBridgeHeartbeat;
let prisma: PrismaClient;
let previousDatabaseUrl: string | undefined;
let previousDirectUrl: string | undefined;
let previousPairingSecret: string | undefined;
let testDatabaseUrl: string;
let testDirectDatabaseUrl: string;

const testSchemaName = `bridge_cloud_coordinator_${process.pid}_${Date.now()}`;

function databaseUrlForSchema(
  schemaName: string,
  databaseUrl = process.env.DATABASE_URL,
) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Bridge cloud coordinator tests.");
  }

  const url = new URL(databaseUrl);
  url.searchParams.set("schema", schemaName);

  return url.toString();
}

function runPrismaDbPush() {
  execFileSync(process.execPath, [
    "node_modules/prisma/build/index.js",
    "db",
    "push",
    "--skip-generate",
  ], {
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
      DIRECT_URL: testDirectDatabaseUrl,
    },
    stdio: "pipe",
  });
}

before(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  previousDirectUrl = process.env.DIRECT_URL;
  previousPairingSecret = process.env.NSN_BRIDGE_PAIRING_SECRET;
  testDatabaseUrl = databaseUrlForSchema(testSchemaName);
  testDirectDatabaseUrl = databaseUrlForSchema(
    testSchemaName,
    process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  );
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.DIRECT_URL = testDirectDatabaseUrl;
  process.env.NSN_BRIDGE_PAIRING_SECRET = "bridge-cloud-coordinator-test-secret";
  runPrismaDbPush();

  const prismaModule = await import("../../src/lib/db/prisma");
  const coordinator = await import("../../src/lib/bridge/cloud-coordinator");

  prisma = prismaModule.getPrismaClient();
  createBridgePairingCode = coordinator.createBridgePairingCode;
  pairBridgeDevice = coordinator.pairBridgeDevice;
  recordBridgeHeartbeat = coordinator.recordBridgeHeartbeat;
});

after(async () => {
  await prisma?.$disconnect();

  const cleanupPrisma = new PrismaClient();

  await cleanupPrisma.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`,
  );
  await cleanupPrisma.$disconnect();

  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }

  if (previousDirectUrl === undefined) {
    delete process.env.DIRECT_URL;
  } else {
    process.env.DIRECT_URL = previousDirectUrl;
  }

  if (previousPairingSecret === undefined) {
    delete process.env.NSN_BRIDGE_PAIRING_SECRET;
  } else {
    process.env.NSN_BRIDGE_PAIRING_SECRET = previousPairingSecret;
  }
});

test("pairing creates a paired device but heartbeat is required for online health", async () => {
  const keys = createBridgeKeyPair();
  const bridgeDeviceId = createBridgeDeviceId();
  const pairing = await createBridgePairingCode("deanne");
  const pairedDevice = await pairBridgeDevice(
    {
      appVersion: "0.1.103",
      architecture: "x64",
      bridgeDeviceId,
      deviceDisplayName: "Deanne's Intel Mac",
      pairingCode: pairing.code,
      platform: "MACOS",
      publicKey: keys.publicKey,
    },
    "deanne",
  );
  const persistedAfterPairing = await prisma.bridgeDevice.findUniqueOrThrow({
    where: { bridgeDeviceId },
  });

  assert.equal(pairedDevice.status, "PAIRED");
  assert.equal(pairedDevice.lastSeenAt, null);
  assert.equal(persistedAfterPairing.status, "PAIRED");
  assert.equal(persistedAfterPairing.lastSeenAt, null);
  assert.equal(
    cloudBridgeHealth([pairedDevice], new Date("2026-08-20T10:00:00.000Z")).ok,
    false,
  );

  const heartbeatDevice = await recordBridgeHeartbeat(bridgeDeviceId, {
    appVersion: "0.1.104",
    architecture: "x64",
    platform: "MACOS",
  });

  assert.equal(heartbeatDevice.status, "ONLINE");
  assert.notEqual(heartbeatDevice.lastSeenAt, null);
  assert.equal(
    cloudBridgeHealth(
      [heartbeatDevice],
      new Date(heartbeatDevice.lastSeenAt ?? ""),
    ).ok,
    true,
  );
});
