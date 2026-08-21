import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  createBridgeDeviceId,
  createBridgeKeyPair,
} from "../../packages/bridge-protocol/src";
import { cloudBridgeHealth } from "../../src/lib/bridge/effective-health";

let createBridgePairingCode: typeof import("../../src/lib/bridge/cloud-coordinator").createBridgePairingCode;
let pairBridgeDevice: typeof import("../../src/lib/bridge/cloud-coordinator").pairBridgeDevice;
let recordBridgeHeartbeat: typeof import("../../src/lib/bridge/cloud-coordinator").recordBridgeHeartbeat;
let BridgeCloudError: typeof import("../../src/lib/bridge/cloud-coordinator").BridgeCloudError;
let prepareBridgeCommandReportForPersistence: typeof import("../../src/lib/bridge/cloud-command-results").prepareBridgeCommandReportForPersistence;
let expireRemoteReadCommandsForSession: typeof import("../../src/lib/bridge/remote-read-commands").expireRemoteReadCommandsForSession;
let markRemoteReadFailure: typeof import("../../src/lib/bridge/remote-read-commands").markRemoteReadFailure;
let queueRemoteReadRetryForScannedFile: typeof import("../../src/lib/bridge/remote-read-commands").queueRemoteReadRetryForScannedFile;
let prisma: PrismaClient;
let previousDatabaseUrl: string | undefined;
let previousDirectUrl: string | undefined;
let previousLocalBridgeUrl: string | undefined;
let previousCommandSigningSecret: string | undefined;
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
  previousLocalBridgeUrl = process.env.NSN_LOCAL_BRIDGE_URL;
  previousCommandSigningSecret = process.env.NSN_BRIDGE_COMMAND_SIGNING_SECRET;
  previousPairingSecret = process.env.NSN_BRIDGE_PAIRING_SECRET;
  testDatabaseUrl = databaseUrlForSchema(testSchemaName);
  testDirectDatabaseUrl = databaseUrlForSchema(
    testSchemaName,
    process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  );
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.DIRECT_URL = testDirectDatabaseUrl;
  process.env.NSN_BRIDGE_COMMAND_SIGNING_SECRET =
    "bridge-cloud-coordinator-command-test-secret";
  process.env.NSN_BRIDGE_PAIRING_SECRET = "bridge-cloud-coordinator-test-secret";
  runPrismaDbPush();

  const prismaModule = await import("../../src/lib/db/prisma");
  const coordinator = await import("../../src/lib/bridge/cloud-coordinator");
  const commandResults = await import("../../src/lib/bridge/cloud-command-results");
  const remoteReadCommands = await import("../../src/lib/bridge/remote-read-commands");

  prisma = prismaModule.getPrismaClient();
  createBridgePairingCode = coordinator.createBridgePairingCode;
  pairBridgeDevice = coordinator.pairBridgeDevice;
  recordBridgeHeartbeat = coordinator.recordBridgeHeartbeat;
  BridgeCloudError = coordinator.BridgeCloudError;
  prepareBridgeCommandReportForPersistence =
    commandResults.prepareBridgeCommandReportForPersistence;
  expireRemoteReadCommandsForSession =
    remoteReadCommands.expireRemoteReadCommandsForSession;
  markRemoteReadFailure = remoteReadCommands.markRemoteReadFailure;
  queueRemoteReadRetryForScannedFile =
    remoteReadCommands.queueRemoteReadRetryForScannedFile;
});

beforeEach(async () => {
  await prisma.bridgeAuditEntry.deleteMany();
  await prisma.bridgeCommand.deleteMany();
  await prisma.scannedFile.deleteMany();
  await prisma.scanSession.deleteMany();
  await prisma.connectedLibrary.deleteMany();
  await prisma.bridgePairingCode.deleteMany();
  await prisma.bridgeDevice.deleteMany();
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

  if (previousLocalBridgeUrl === undefined) {
    delete process.env.NSN_LOCAL_BRIDGE_URL;
  } else {
    process.env.NSN_LOCAL_BRIDGE_URL = previousLocalBridgeUrl;
  }

  if (previousCommandSigningSecret === undefined) {
    delete process.env.NSN_BRIDGE_COMMAND_SIGNING_SECRET;
  } else {
    process.env.NSN_BRIDGE_COMMAND_SIGNING_SECRET =
      previousCommandSigningSecret;
  }

  if (previousPairingSecret === undefined) {
    delete process.env.NSN_BRIDGE_PAIRING_SECRET;
  } else {
    process.env.NSN_BRIDGE_PAIRING_SECRET = previousPairingSecret;
  }
});

async function createCloudScannedFile(
  input: {
    bridgeRootId?: string;
    deviceStatus?: "ONLINE" | "OFFLINE" | "PAIRED";
    libraryStatus?: "CONNECTED" | "DISCONNECTED";
    readStatus?: "SUPPORTED" | "UNSUPPORTED";
    relativePath: string;
  },
) {
  const bridgeRootId = input.bridgeRootId ?? `root_${randomUUID()}`;
  const bridgeDeviceId = createBridgeDeviceId();
  const keys = createBridgeKeyPair();
  const now = new Date();
  const device = await prisma.bridgeDevice.create({
    data: {
      appVersion: "0.1.104",
      architecture: "x64",
      bridgeDeviceId,
      deviceDisplayName: "Deanne's Intel Mac",
      lastSeenAt:
        input.deviceStatus === "OFFLINE"
          ? new Date(now.getTime() - 5 * 60 * 1000)
          : now,
      pairedAt: now,
      platform: "MACOS",
      publicKey: keys.publicKey,
      status: input.deviceStatus ?? "ONLINE",
    },
  });
  const library = await prisma.connectedLibrary.create({
    data: {
      bridgeDeviceId,
      bridgeRootId,
      displayName: "SCAN_ROOT_A_GENERAL_INBOX",
      folderFingerprint: `${bridgeRootId}:fingerprint`,
      localPath: `bridge://${bridgeRootId}`,
      platform: "MACOS",
      readPermission: true,
      safeLocalLocation: "A folder selected on this Mac",
      status: input.libraryStatus ?? "CONNECTED",
    },
  });
  const session = await prisma.scanSession.create({
    data: {
      connectedFolderId: library.id,
      failedFiles: 1,
      filesScanned: 1,
      status: "COMPLETED_WITH_ERRORS",
      supportedFiles: input.readStatus === "UNSUPPORTED" ? 0 : 1,
      unsupportedFiles: input.readStatus === "UNSUPPORTED" ? 1 : 0,
    },
  });
  const scannedFile = await prisma.scannedFile.create({
    data: {
      checksum: `checksum-${randomUUID()}`,
      extractionErrorCategory:
        input.readStatus === "UNSUPPORTED" ? "UNSUPPORTED_FILE_TYPE" : "READ_FAILED",
      extractionStatus:
        input.readStatus === "UNSUPPORTED" ? "UNSUPPORTED" : "FAILED",
      fileType:
        input.readStatus === "UNSUPPORTED"
          ? "UNSUPPORTED"
          : input.relativePath.split(".").at(-1)?.toLowerCase() ?? "txt",
      localPath: `bridge://${bridgeRootId}/${input.relativePath}`,
      processingErrorCategory:
        input.readStatus === "UNSUPPORTED" ? "UNSUPPORTED_FILE_TYPE" : "READ_FAILED",
      processingStage:
        input.readStatus === "UNSUPPORTED" ? "UNSUPPORTED" : "FAILED",
      readStatus: input.readStatus ?? "SUPPORTED",
      readingStatus:
        input.readStatus === "UNSUPPORTED" ? "UNSUPPORTED" : "FAILED",
      relativePath: input.relativePath,
      scanError: "Previous read attempt needs attention.",
      sessionId: session.id,
      sizeBytes: 128n,
    },
  });

  return { bridgeRootId, device, library, scannedFile, session };
}

async function latestReadCommand(scannedFileId: string) {
  const commands = await prisma.bridgeCommand.findMany({
    orderBy: {
      issuedAt: "desc",
    },
    where: {
      commandType: "READ_FILE_TEMPORARILY",
    },
  });

  return commands.find((command) => {
    const payload =
      typeof command.payload === "object" &&
      command.payload !== null &&
      !Array.isArray(command.payload)
        ? (command.payload as Record<string, unknown>)
        : {};

    return payload.scannedFileId === scannedFileId;
  });
}

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

test("Retry Reading on a cloud-owned scanned file queues a Bridge command instead of using localhost", async () => {
  process.env.NSN_LOCAL_BRIDGE_URL = "http://127.0.0.1:9";
  const { bridgeRootId, device, library, scannedFile, session } =
    await createCloudScannedFile({
      relativePath: "Damaged/broken-document.pdf",
    });

  const result = await queueRemoteReadRetryForScannedFile(scannedFile.id);

  assert.equal(result?.ok, true);
  assert.equal(result?.queued, true);

  const commands = await prisma.bridgeCommand.findMany({
    where: {
      commandType: "READ_FILE_TEMPORARILY",
    },
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.bridgeDeviceId, device.bridgeDeviceId);
  assert.equal(commands[0]?.bridgeRootId, bridgeRootId);
  assert.equal(commands[0]?.connectedLibraryId, library.id);

  const payload = commands[0]?.payload as Record<string, unknown>;

  assert.equal(payload.relativePath, "Damaged/broken-document.pdf");
  assert.equal(payload.scanSessionId, session.id);
  assert.equal(payload.scannedFileId, scannedFile.id);
  assert.equal(payload.localPath, undefined);
  assert.equal(payload.actualPath, undefined);
  assert.doesNotMatch(JSON.stringify(payload), /127\.0\.0\.1|localhost|D:\\|\/Users\//);

  const updatedFile = await prisma.scannedFile.findUniqueOrThrow({
    where: {
      id: scannedFile.id,
    },
  });

  assert.equal(updatedFile.processingStage, "READING");
  assert.equal(updatedFile.extractionStatus, "EXTRACTING");
  assert.equal(updatedFile.readingStatus, "NOT_READ");

  await queueRemoteReadRetryForScannedFile(scannedFile.id);

  assert.equal(
    await prisma.bridgeCommand.count({
      where: {
        commandType: "READ_FILE_TEMPORARILY",
      },
    }),
    1,
  );
});

test("remote read failures keep file-specific categories instead of Bridge offline", async () => {
  const damagedPdf = await createCloudScannedFile({
    relativePath: "Damaged/broken-document.pdf",
  });

  await queueRemoteReadRetryForScannedFile(damagedPdf.scannedFile.id);
  const pdfCommand = await latestReadCommand(damagedPdf.scannedFile.id);

  assert.ok(pdfCommand);
  await prepareBridgeCommandReportForPersistence(damagedPdf.device.bridgeDeviceId, {
    commandId: pdfCommand.commandId,
    safeErrorCategory: "BRIDGE_COMMAND_FAILED",
    status: "FAILED",
  });

  const updatedPdf = await prisma.scannedFile.findUniqueOrThrow({
    where: {
      id: damagedPdf.scannedFile.id,
    },
  });

  assert.equal(updatedPdf.processingErrorCategory, "PDF_PARSE_FAILED");
  assert.equal(
    updatedPdf.scanError,
    "This PDF appears damaged or could not be read safely.",
  );
  assert.notEqual(updatedPdf.processingErrorCategory, "BRIDGE_OFFLINE");

  const emptyText = await createCloudScannedFile({
    relativePath: "Mixed_Loose/empty-file.txt",
  });

  await queueRemoteReadRetryForScannedFile(emptyText.scannedFile.id);
  const textCommand = await latestReadCommand(emptyText.scannedFile.id);

  assert.ok(textCommand);
  await prepareBridgeCommandReportForPersistence(emptyText.device.bridgeDeviceId, {
    commandId: textCommand.commandId,
    safeErrorCategory: "NO_TEXT_EXTRACTED",
    status: "FAILED",
  });

  const updatedText = await prisma.scannedFile.findUniqueOrThrow({
    where: {
      id: emptyText.scannedFile.id,
    },
  });

  assert.equal(updatedText.processingErrorCategory, "FILE_EMPTY");
  assert.equal(updatedText.scanError, "This file is empty.");
  assert.notEqual(updatedText.processingErrorCategory, "BRIDGE_OFFLINE");
});

test("Retry Reading reports real offline, disconnected, unsupported, missing, and timed-out states", async () => {
  const offline = await createCloudScannedFile({
    deviceStatus: "OFFLINE",
    relativePath: "Notes/offline.txt",
  });

  await assert.rejects(
    () => queueRemoteReadRetryForScannedFile(offline.scannedFile.id),
    (error) =>
      error instanceof BridgeCloudError && error.code === "BRIDGE_OFFLINE",
  );

  const disconnected = await createCloudScannedFile({
    libraryStatus: "DISCONNECTED",
    relativePath: "Notes/disconnected.txt",
  });

  await assert.rejects(
    () => queueRemoteReadRetryForScannedFile(disconnected.scannedFile.id),
    (error) =>
      error instanceof BridgeCloudError && error.code === "ROOT_NOT_CONNECTED",
  );

  const unsupported = await createCloudScannedFile({
    readStatus: "UNSUPPORTED",
    relativePath: "Archives/file.zip",
  });

  await assert.rejects(
    () => queueRemoteReadRetryForScannedFile(unsupported.scannedFile.id),
    (error) =>
      error instanceof BridgeCloudError &&
      error.code === "UNSUPPORTED_FILE_TYPE",
  );

  const missing = await createCloudScannedFile({
    relativePath: "Notes/missing.txt",
  });

  await markRemoteReadFailure({
    safeErrorCategory: "SOURCE_FILE_MISSING",
    scanSessionId: missing.session.id,
    scannedFileId: missing.scannedFile.id,
  });

  const missingFile = await prisma.scannedFile.findUniqueOrThrow({
    where: {
      id: missing.scannedFile.id,
    },
  });

  assert.equal(missingFile.processingErrorCategory, "FILE_NOT_FOUND");
  assert.notEqual(missingFile.sourceUnavailableAt, null);

  const timedOut = await createCloudScannedFile({
    relativePath: "Notes/slow.txt",
  });

  await queueRemoteReadRetryForScannedFile(timedOut.scannedFile.id);
  const command = await latestReadCommand(timedOut.scannedFile.id);

  assert.ok(command);
  await prisma.bridgeCommand.update({
    data: {
      expiresAt: new Date(Date.now() - 1_000),
    },
    where: {
      commandId: command.commandId,
    },
  });

  assert.equal(await expireRemoteReadCommandsForSession(timedOut.session.id), 1);

  const timedOutFile = await prisma.scannedFile.findUniqueOrThrow({
    where: {
      id: timedOut.scannedFile.id,
    },
  });
  const timedOutSession = await prisma.scanSession.findUniqueOrThrow({
    where: {
      id: timedOut.session.id,
    },
  });

  assert.equal(timedOutFile.processingErrorCategory, "READ_COMMAND_TIMEOUT");
  assert.equal(timedOutSession.status, "COMPLETED_WITH_ERRORS");
});
