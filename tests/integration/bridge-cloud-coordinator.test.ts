import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  createBridgeDeviceRequestHeaders,
  createBridgeDeviceId,
  createBridgeKeyPair,
} from "../../packages/bridge-protocol/src";
import { cloudBridgeHealth } from "../../src/lib/bridge/effective-health";
import { currentRecommendationGenerationVersion } from "../../src/lib/bridge/recommendation-generation";
import type { LocalBridgeRootSummary } from "../../src/lib/bridge/local-bridge-client";

let createBridgePairingCode: typeof import("../../src/lib/bridge/cloud-coordinator").createBridgePairingCode;
let pairBridgeDevice: typeof import("../../src/lib/bridge/cloud-coordinator").pairBridgeDevice;
let recordBridgeHeartbeat: typeof import("../../src/lib/bridge/cloud-coordinator").recordBridgeHeartbeat;
let completeBridgeCloudCommand: typeof import("../../src/lib/bridge/cloud-coordinator").completeBridgeCloudCommand;
let acknowledgeBridgeCloudCommand: typeof import("../../src/lib/bridge/cloud-coordinator").acknowledgeBridgeCloudCommand;
let BridgeCloudError: typeof import("../../src/lib/bridge/cloud-coordinator").BridgeCloudError;
let prepareBridgeCommandReportForPersistence: typeof import("../../src/lib/bridge/cloud-command-results").prepareBridgeCommandReportForPersistence;
let updateConnectedLibrary: typeof import("../../src/lib/bridge/connected-libraries").updateConnectedLibrary;
let getConnectedLibraryPermissionUpdateStatus: typeof import("../../src/lib/bridge/connected-libraries").getConnectedLibraryPermissionUpdateStatus;
let getConnectedLibrary: typeof import("../../src/lib/bridge/connected-libraries").getConnectedLibrary;
let syncBridgeDeviceRoots: typeof import("../../src/lib/bridge/device-root-sync").syncBridgeDeviceRoots;
let queueRemoteMonitoringAction: typeof import("../../src/lib/bridge/remote-monitoring").queueRemoteMonitoringAction;
let getRemoteMonitoringActionStatus: typeof import("../../src/lib/bridge/remote-monitoring").getRemoteMonitoringActionStatus;
let ingestBridgeWatchEvents: typeof import("../../src/lib/bridge/monitor").ingestBridgeWatchEvents;
let getMonitoringDashboardData: typeof import("../../src/lib/bridge/monitor").getMonitoringDashboardData;
let expireRemoteReadCommandsForSession: typeof import("../../src/lib/bridge/remote-read-commands").expireRemoteReadCommandsForSession;
let markRemoteReadFailure: typeof import("../../src/lib/bridge/remote-read-commands").markRemoteReadFailure;
let queueRemoteReadRetryForScannedFile: typeof import("../../src/lib/bridge/remote-read-commands").queueRemoteReadRetryForScannedFile;
let processScanSessionPost: typeof import("../../src/app/api/bridge/scan-sessions/[sessionId]/process/route").POST;
let prisma: PrismaClient;
let previousDatabaseUrl: string | undefined;
let previousDirectUrl: string | undefined;
let previousLocalBridgeUrl: string | undefined;
let previousCommandSigningSecret: string | undefined;
let previousOpenAIKey: string | undefined;
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
  previousOpenAIKey = process.env.OPENAI_API_KEY;
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
  process.env.OPENAI_API_KEY = "";
  runPrismaDbPush();

  const prismaModule = await import("../../src/lib/db/prisma");
  const coordinator = await import("../../src/lib/bridge/cloud-coordinator");
  const commandResults = await import("../../src/lib/bridge/cloud-command-results");
  const deviceRootSync = await import("../../src/lib/bridge/device-root-sync");
  const remoteReadCommands = await import("../../src/lib/bridge/remote-read-commands");
  const processRoute = await import(
    "../../src/app/api/bridge/scan-sessions/[sessionId]/process/route"
  );

  prisma = prismaModule.getPrismaClient();
  createBridgePairingCode = coordinator.createBridgePairingCode;
  pairBridgeDevice = coordinator.pairBridgeDevice;
  recordBridgeHeartbeat = coordinator.recordBridgeHeartbeat;
  completeBridgeCloudCommand = coordinator.completeBridgeCloudCommand;
  acknowledgeBridgeCloudCommand = coordinator.acknowledgeBridgeCloudCommand;
  BridgeCloudError = coordinator.BridgeCloudError;
  const connectedLibraries = await import("../../src/lib/bridge/connected-libraries");
  const remoteMonitoring = await import("../../src/lib/bridge/remote-monitoring");
  const bridgeMonitor = await import("../../src/lib/bridge/monitor");
  prepareBridgeCommandReportForPersistence =
    commandResults.prepareBridgeCommandReportForPersistence;
  updateConnectedLibrary = connectedLibraries.updateConnectedLibrary;
  getConnectedLibrary = connectedLibraries.getConnectedLibrary;
  getConnectedLibraryPermissionUpdateStatus =
    connectedLibraries.getConnectedLibraryPermissionUpdateStatus;
  syncBridgeDeviceRoots = deviceRootSync.syncBridgeDeviceRoots;
  queueRemoteMonitoringAction = remoteMonitoring.queueRemoteMonitoringAction;
  getRemoteMonitoringActionStatus =
    remoteMonitoring.getRemoteMonitoringActionStatus;
  ingestBridgeWatchEvents = bridgeMonitor.ingestBridgeWatchEvents;
  getMonitoringDashboardData = bridgeMonitor.getMonitoringDashboardData;
  expireRemoteReadCommandsForSession =
    remoteReadCommands.expireRemoteReadCommandsForSession;
  markRemoteReadFailure = remoteReadCommands.markRemoteReadFailure;
  queueRemoteReadRetryForScannedFile =
    remoteReadCommands.queueRemoteReadRetryForScannedFile;
  processScanSessionPost = processRoute.POST;
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

  if (previousOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousOpenAIKey;
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

  return { bridgeRootId, device, keys, library, scannedFile, session };
}

function cloudRootSummary(
  id: string,
  overrides: Partial<LocalBridgeRootSummary> = {},
): LocalBridgeRootSummary {
  return {
    connectedAt: "2026-08-01T00:00:00.000Z",
    createFolderPermission: false,
    displayName: "SCAN_ROOT_A_GENERAL_INBOX",
    id,
    lastScanAt: null,
    lastWatchingAt: null,
    moveFilePermission: false,
    organizationPlanPermission: true,
    platform: "MACOS",
    readPermission: true,
    recommendationPermission: true,
    renameFilePermission: false,
    safeLocation: "A folder selected on this Mac",
    status: "CONNECTED",
    updatedAt: "2026-08-01T00:00:00.000Z",
    watcherState: "STOPPED",
    watchPermission: false,
    ...overrides,
  };
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

async function completeTemporaryRead(input: {
  bridgeDeviceId: string;
  commandId: string;
  relativePath: string;
  text: string;
}) {
  await acknowledgeBridgeCloudCommand(input.bridgeDeviceId, input.commandId);
  const prepared = await prepareBridgeCommandReportForPersistence(
    input.bridgeDeviceId,
    {
      commandId: input.commandId,
      result: {
        extractedText: input.text,
        fileName: input.relativePath.split("/").at(-1) ?? "note.txt",
        fileType: "DOCUMENT",
        relativePath: input.relativePath,
        warnings: [],
      },
      safeErrorCategory: null,
      status: "COMPLETED",
    },
  );

  await completeBridgeCloudCommand(input.bridgeDeviceId, prepared);
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

test("cloud-managed recommendation regeneration queues temporary reads and completes idempotently", async () => {
  const firstRelativePath = "Notes/remote-regeneration-one.txt";
  const secondRelativePath = "Notes/remote-regeneration-two.txt";
  const cloud = await createCloudScannedFile({
    relativePath: firstRelativePath,
  });
  const secondFile = await prisma.scannedFile.create({
    data: {
      checksum: `checksum-${randomUUID()}`,
      extractionErrorCategory: "READ_FAILED",
      extractionStatus: "FAILED",
      fileType: "txt",
      localPath: `bridge://${cloud.bridgeRootId}/${secondRelativePath}`,
      processingErrorCategory: "READ_FAILED",
      processingStage: "FAILED",
      readStatus: "SUPPORTED",
      readingStatus: "FAILED",
      relativePath: secondRelativePath,
      scanError: "Previous read attempt needs attention.",
      sessionId: cloud.session.id,
      sizeBytes: BigInt(192),
    },
  });
  await prisma.scannedFile.createMany({
    data: [
      {
        checksum: `checksum-${randomUUID()}`,
        extractionErrorCategory: "FILE_CORRUPT",
        extractionStatus: "FAILED",
        fileType: "pdf",
        localPath: `bridge://${cloud.bridgeRootId}/Damaged/broken.pdf`,
        processingErrorCategory: "FILE_CORRUPT",
        processingStage: "FAILED",
        readStatus: "SUPPORTED",
        readingStatus: "FAILED",
        relativePath: "Damaged/broken.pdf",
        scanError: "This file appears damaged.",
        sessionId: cloud.session.id,
        sizeBytes: BigInt(32),
      },
      {
        extractionErrorCategory: "UNSUPPORTED_FILE_TYPE",
        extractionStatus: "UNSUPPORTED",
        fileType: "UNSUPPORTED",
        localPath: `bridge://${cloud.bridgeRootId}/Archives/package.zip`,
        processingErrorCategory: "UNSUPPORTED_FILE_TYPE",
        processingStage: "UNSUPPORTED",
        readStatus: "UNSUPPORTED",
        readingStatus: "UNSUPPORTED",
        relativePath: "Archives/package.zip",
        scanError: "Unsupported for reading.",
        sessionId: cloud.session.id,
        sizeBytes: BigInt(64),
      },
    ],
  });
  await prisma.scanSession.update({
    data: {
      failedFiles: 3,
      filesScanned: 4,
      supportedFiles: 3,
      unsupportedFiles: 1,
    },
    where: {
      id: cloud.session.id,
    },
  });

  for (const file of [cloud.scannedFile, secondFile]) {
    await queueRemoteReadRetryForScannedFile(file.id);
  }

  for (const [file, text] of [
    [cloud.scannedFile, "A calm note about home records and weekly planning."],
    [secondFile, "A separate note about gardening dates and family receipts."],
  ] as const) {
    const command = await latestReadCommand(file.id);

    assert.ok(command);
    await completeTemporaryRead({
      bridgeDeviceId: cloud.device.bridgeDeviceId,
      commandId: command.commandId,
      relativePath: file.relativePath,
      text,
    });
  }

  const observationsBefore = await prisma.observationSession.count({
    where: {
      libraryDocument: {
        scannedFiles: {
          some: {
            sessionId: cloud.session.id,
          },
        },
      },
    },
  });
  const oldRecommendations = await prisma.organizationSuggestion.findMany({
    where: {
      invalidatedAt: null,
      recommendationGenerationVersion:
        currentRecommendationGenerationVersion,
      scanSessionId: cloud.session.id,
    },
  });

  assert.equal(observationsBefore, 2);
  assert.ok(oldRecommendations.length >= 2);

  await prisma.organizationSuggestion.updateMany({
    data: {
      invalidatedAt: new Date(),
      invalidatedReason: "Cloud regeneration regression test.",
      reviewedAt: null,
      status: "PENDING",
    },
    where: {
      id: {
        in: oldRecommendations.map((suggestion) => suggestion.id),
      },
    },
  });

  const response = await processScanSessionPost(
    new Request(
      `http://localhost/api/bridge/scan-sessions/${cloud.session.id}/process`,
      {
        body: JSON.stringify({ retryFailed: false }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ),
    {
      params: Promise.resolve({ sessionId: cloud.session.id }),
    },
  );
  const payload = (await response.json()) as {
    message: string;
    ok: boolean;
    progress: { remainingFiles: number };
    queued: boolean;
    queuedFiles: number;
  };

  assert.equal(response.status, 202);
  assert.equal(payload.ok, true);
  assert.equal(payload.queued, true);
  assert.equal(payload.queuedFiles, 2);
  assert.match(payload.message, /queued for 2 files/i);
  assert.equal(payload.progress.remainingFiles, 2);

  const regenerationCommands = await prisma.bridgeCommand.findMany({
    orderBy: {
      issuedAt: "asc",
    },
    where: {
      commandType: "READ_FILE_TEMPORARILY",
      idempotencyKey: {
        startsWith: `recommendation-regeneration:${currentRecommendationGenerationVersion}:${cloud.session.id}:`,
      },
    },
  });

  assert.equal(regenerationCommands.length, 2);

  for (const command of regenerationCommands) {
    const commandPayload = command.payload as Record<string, unknown>;

    assert.equal(
      commandPayload.processingPurpose,
      "RECOMMENDATION_REGENERATION",
    );
    assert.equal(
      commandPayload.recommendationGenerationVersion,
      currentRecommendationGenerationVersion,
    );
    assert.equal(commandPayload.localPath, undefined);
    assert.equal(commandPayload.actualPath, undefined);
  }

  const repeatedResponse = await processScanSessionPost(
    new Request(
      `http://localhost/api/bridge/scan-sessions/${cloud.session.id}/process`,
      {
        body: JSON.stringify({ retryFailed: false }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ),
    {
      params: Promise.resolve({ sessionId: cloud.session.id }),
    },
  );
  const repeatedPayload = (await repeatedResponse.json()) as {
    queued: boolean;
    queuedFiles: number;
  };

  assert.equal(repeatedResponse.status, 202);
  assert.equal(repeatedPayload.queued, true);
  assert.equal(repeatedPayload.queuedFiles, 0);
  assert.equal(
    await prisma.bridgeCommand.count({
      where: {
        idempotencyKey: {
          startsWith: `recommendation-regeneration:${currentRecommendationGenerationVersion}:${cloud.session.id}:`,
        },
      },
    }),
    2,
  );

  for (const command of regenerationCommands) {
    const commandPayload = command.payload as Record<string, unknown>;
    const scannedFileId = String(commandPayload.scannedFileId);
    const relativePath = String(commandPayload.relativePath);

    await completeTemporaryRead({
      bridgeDeviceId: cloud.device.bridgeDeviceId,
      commandId: command.commandId,
      relativePath,
      text:
        scannedFileId === cloud.scannedFile.id
          ? "A calm note about home records and weekly planning."
          : "A separate note about gardening dates and family receipts.",
    });
  }

  const completedResponse = await processScanSessionPost(
    new Request(
      `http://localhost/api/bridge/scan-sessions/${cloud.session.id}/process`,
      {
        body: JSON.stringify({ retryFailed: false }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ),
    {
      params: Promise.resolve({ sessionId: cloud.session.id }),
    },
  );
  const completedPayload = (await completedResponse.json()) as {
    progress: {
      filesWithSuggestions: number;
      remainingFiles: number;
    };
    queued: boolean;
  };
  const currentRecommendations = await prisma.organizationSuggestion.findMany({
    where: {
      invalidatedAt: null,
      recommendationGenerationVersion:
        currentRecommendationGenerationVersion,
      scanSessionId: cloud.session.id,
    },
  });
  const observationsAfter = await prisma.observationSession.count({
    where: {
      libraryDocument: {
        scannedFiles: {
          some: {
            sessionId: cloud.session.id,
          },
        },
      },
    },
  });
  const storedOldRecommendations = await prisma.organizationSuggestion.findMany({
    where: {
      id: {
        in: oldRecommendations.map((suggestion) => suggestion.id),
      },
    },
  });
  const allCommands = await prisma.bridgeCommand.findMany({
    where: {
      connectedLibraryId: cloud.library.id,
    },
  });

  assert.equal(completedResponse.status, 200);
  assert.equal(completedPayload.queued, false);
  assert.equal(completedPayload.progress.filesWithSuggestions, 2);
  assert.equal(completedPayload.progress.remainingFiles, 0);
  assert.ok(currentRecommendations.length >= 2);
  assert.ok(
    storedOldRecommendations.every(
      (suggestion) => suggestion.invalidatedAt !== null,
    ),
  );
  assert.equal(observationsAfter, observationsBefore);
  assert.equal(
    await prisma.bridgeCommand.count({
      where: {
        idempotencyKey: {
          startsWith: `recommendation-regeneration:${currentRecommendationGenerationVersion}:${cloud.session.id}:`,
        },
      },
    }),
    2,
  );
  assert.ok(
    allCommands.every(
      (command) => command.commandType === "READ_FILE_TEMPORARILY",
    ),
  );
});

test("cloud-managed recommendation regeneration reports an offline Bridge", async () => {
  const cloud = await createCloudScannedFile({
    deviceStatus: "OFFLINE",
    relativePath: "Notes/offline-regeneration.txt",
  });

  await prisma.scannedFile.update({
    data: {
      extractionErrorCategory: null,
      extractionStatus: "COMPLETED",
      processingErrorCategory: null,
      processingStage: "SUGGESTIONS_GENERATED",
      readingStatus: "READ",
      scanError: null,
    },
    where: {
      id: cloud.scannedFile.id,
    },
  });

  const response = await processScanSessionPost(
    new Request(
      `http://localhost/api/bridge/scan-sessions/${cloud.session.id}/process`,
      {
        body: JSON.stringify({ retryFailed: false }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ),
    {
      params: Promise.resolve({ sessionId: cloud.session.id }),
    },
  );
  const payload = (await response.json()) as {
    code: string;
    error: string;
    ok: boolean;
  };

  assert.equal(response.status, 409);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "BRIDGE_OFFLINE");
  assert.match(payload.error, /open nsn bridge/i);
  assert.equal(await prisma.bridgeCommand.count(), 0);
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

test("cloud-owned permission updates queue a Bridge command instead of using localhost", async () => {
  process.env.NSN_LOCAL_BRIDGE_URL = "http://127.0.0.1:9";
  const { bridgeRootId, device, library } = await createCloudScannedFile({
    relativePath: "Notes/permission.txt",
  });
  const result = await updateConnectedLibrary(library.id, {
    watchPermission: true,
  });
  const command = await prisma.bridgeCommand.findFirstOrThrow({
    where: {
      commandType: "UPDATE_ROOT_PERMISSIONS",
    },
  });
  const storedLibrary = await prisma.connectedLibrary.findUniqueOrThrow({
    where: {
      id: library.id,
    },
  });
  const payload = command.payload as Record<string, unknown>;

  assert.equal(result.permissionUpdate?.status, "PENDING");
  assert.equal(result.permissionUpdate?.commandId, command.commandId);
  assert.equal(result.library.watchPermission, false);
  assert.equal(storedLibrary.watchPermission, false);
  assert.equal(command.bridgeDeviceId, device.bridgeDeviceId);
  assert.equal(command.bridgeRootId, bridgeRootId);
  assert.equal(command.connectedLibraryId, library.id);
  assert.equal(payload.bridgeRootId, bridgeRootId);
  assert.equal(payload.watchPermission, true);
  assert.equal(payload.localPath, undefined);
  assert.equal(payload.actualPath, undefined);
  assert.doesNotMatch(JSON.stringify(payload), /127\.0\.0\.1|localhost|D:\\|\/Users\//);
});

test("permission updates persist only after the Bridge confirms completion", async () => {
  const { bridgeRootId, device, library } = await createCloudScannedFile({
    relativePath: "Notes/confirmed-permission.txt",
  });
  const queued = await updateConnectedLibrary(library.id, {
    watchPermission: true,
  });
  const commandId = queued.permissionUpdate?.commandId;

  assert.ok(commandId);
  await acknowledgeBridgeCloudCommand(device.bridgeDeviceId, commandId);
  assert.equal(
    (await prisma.connectedLibrary.findUniqueOrThrow({
      where: { id: library.id },
    })).watchPermission,
    false,
  );

  const prepared = await prepareBridgeCommandReportForPersistence(
    device.bridgeDeviceId,
    {
      commandId,
      result: {
        bridgeRootId,
        createFolderPermission: false,
        displayName: library.displayName,
        id: bridgeRootId,
        moveFilePermission: false,
        organizationPlanPermission: true,
        readPermission: true,
        recommendationPermission: true,
        renameFilePermission: false,
        safeLocation: library.safeLocalLocation,
        status: "CONNECTED",
        updatedAt: "2026-08-01T00:00:02.000Z",
        watcherState: "PAUSED",
        watchPermission: true,
      },
      safeErrorCategory: null,
      status: "COMPLETED",
    },
  );
  await completeBridgeCloudCommand(device.bridgeDeviceId, prepared);

  const status = await getConnectedLibraryPermissionUpdateStatus(
    library.id,
    commandId,
  );
  const permissionStatusRoute = await import(
    "../../src/app/api/bridge/connected-libraries/[libraryId]/permission-updates/[commandId]/route"
  );
  const statusResponse = await permissionStatusRoute.GET(
    new Request(
      `http://localhost/api/bridge/connected-libraries/${library.id}/permission-updates/${commandId}`,
    ),
    {
      params: Promise.resolve({
        commandId,
        libraryId: library.id,
      }),
    },
  );
  const statusPayload = (await statusResponse.json()) as {
    library?: { watchPermission?: boolean };
    ok: boolean;
    status: string;
  };
  const updated = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: library.id },
  });

  assert.equal(status.status, "COMPLETED");
  assert.equal(statusResponse.status, 200);
  assert.equal(statusPayload.ok, true);
  assert.equal(statusPayload.status, "COMPLETED");
  assert.equal(statusPayload.library?.watchPermission, true);
  assert.equal(updated.watchPermission, true);
  assert.equal(updated.readPermission, true);
  assert.equal(updated.monitoringState, "PAUSED");
});

test("stale root sync cannot revert a completed watch permission update", async () => {
  const bridgeRootId = "root_cccccccccccccccccccccccc";
  const { device, library } = await createCloudScannedFile({
    bridgeRootId,
    relativePath: "Notes/stale-root-sync.txt",
  });
  const queued = await updateConnectedLibrary(library.id, {
    watchPermission: true,
  });
  const commandId = queued.permissionUpdate?.commandId;

  assert.ok(commandId);
  await acknowledgeBridgeCloudCommand(device.bridgeDeviceId, commandId);
  const prepared = await prepareBridgeCommandReportForPersistence(
    device.bridgeDeviceId,
    {
      commandId,
      result: cloudRootSummary(bridgeRootId, {
        updatedAt: "2026-08-01T00:00:02.000Z",
        watcherState: "PAUSED",
        watchPermission: true,
      }),
      safeErrorCategory: null,
      status: "COMPLETED",
    },
  );
  await completeBridgeCloudCommand(device.bridgeDeviceId, prepared);

  await syncBridgeDeviceRoots(device.bridgeDeviceId, [
    cloudRootSummary(bridgeRootId, {
      updatedAt: "2026-08-01T00:00:01.000Z",
      watcherState: "STOPPED",
      watchPermission: false,
    }),
  ]);

  const afterStaleSync = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: library.id },
  });

  assert.equal(afterStaleSync.watchPermission, true);
  assert.equal(afterStaleSync.readPermission, true);

  await syncBridgeDeviceRoots(device.bridgeDeviceId, [
    cloudRootSummary(bridgeRootId, {
      updatedAt: "2026-08-01T00:00:03.000Z",
      watcherState: "STOPPED",
      watchPermission: false,
    }),
  ]);

  const afterNewerSync = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: library.id },
  });

  assert.equal(afterNewerSync.watchPermission, false);
  assert.equal(afterNewerSync.readPermission, true);
});

test("completed permission command can turn watch permission off", async () => {
  const bridgeRootId = "root_dddddddddddddddddddddddd";
  const { device, library } = await createCloudScannedFile({
    bridgeRootId,
    relativePath: "Notes/disable-watch.txt",
  });

  await prisma.connectedLibrary.update({
    data: {
      readPermission: true,
      watchPermission: true,
    },
    where: {
      id: library.id,
    },
  });

  const queued = await updateConnectedLibrary(library.id, {
    watchPermission: false,
  });
  const commandId = queued.permissionUpdate?.commandId;

  assert.ok(commandId);
  await acknowledgeBridgeCloudCommand(device.bridgeDeviceId, commandId);
  const prepared = await prepareBridgeCommandReportForPersistence(
    device.bridgeDeviceId,
    {
      commandId,
      result: cloudRootSummary(bridgeRootId, {
        updatedAt: "2026-08-01T00:00:04.000Z",
        watcherState: "STOPPED",
        watchPermission: false,
      }),
      safeErrorCategory: null,
      status: "COMPLETED",
    },
  );
  await completeBridgeCloudCommand(device.bridgeDeviceId, prepared);

  const updated = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: library.id },
  });

  assert.equal(updated.watchPermission, false);
  assert.equal(updated.readPermission, true);
  assert.equal(updated.monitoringState, "STOPPED");
});

test("failed cloud permission command leaves the prior permission state", async () => {
  const { device, library } = await createCloudScannedFile({
    relativePath: "Notes/failed-permission.txt",
  });
  const queued = await updateConnectedLibrary(library.id, {
    watchPermission: true,
  });
  const commandId = queued.permissionUpdate?.commandId;

  assert.ok(commandId);
  await acknowledgeBridgeCloudCommand(device.bridgeDeviceId, commandId);
  await completeBridgeCloudCommand(device.bridgeDeviceId, {
    commandId,
    result: null,
    safeErrorCategory: "ROOT_NOT_FOUND",
    status: "FAILED",
  });

  const status = await getConnectedLibraryPermissionUpdateStatus(
    library.id,
    commandId,
  );
  const unchanged = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: library.id },
  });

  assert.equal(status.status, "FAILED");
  assert.equal("error" in status, true);
  assert.equal(unchanged.watchPermission, false);
});

test("watch permission requires read permission and disabling read disables watch", async () => {
  const noRead = await createCloudScannedFile({
    relativePath: "Notes/no-read.txt",
  });
  await prisma.connectedLibrary.update({
    data: {
      readPermission: false,
    },
    where: {
      id: noRead.library.id,
    },
  });

  await assert.rejects(
    () => updateConnectedLibrary(noRead.library.id, { watchPermission: true }),
    /Reading permission is required/i,
  );

  const watched = await createCloudScannedFile({
    relativePath: "Notes/disable-read.txt",
  });
  await prisma.connectedLibrary.update({
    data: {
      readPermission: true,
      watchPermission: true,
    },
    where: {
      id: watched.library.id,
    },
  });
  const queued = await updateConnectedLibrary(watched.library.id, {
    readPermission: false,
  });
  const commandId = queued.permissionUpdate?.commandId;

  assert.ok(commandId);
  await acknowledgeBridgeCloudCommand(watched.device.bridgeDeviceId, commandId);
  const command = await prisma.bridgeCommand.findUniqueOrThrow({
    where: {
      commandId,
    },
  });
  const payload = command.payload as Record<string, unknown>;

  assert.equal(payload.readPermission, false);
  assert.equal(payload.watchPermission, false);

  const prepared = await prepareBridgeCommandReportForPersistence(
    watched.device.bridgeDeviceId,
    {
      commandId,
      result: {
        bridgeRootId: watched.bridgeRootId,
        createFolderPermission: false,
        displayName: watched.library.displayName,
        id: watched.bridgeRootId,
        moveFilePermission: false,
        organizationPlanPermission: true,
        readPermission: false,
        recommendationPermission: true,
        renameFilePermission: false,
        safeLocation: watched.library.safeLocalLocation,
        status: "CONNECTED",
        watcherState: "STOPPED",
        watchPermission: false,
      },
      safeErrorCategory: null,
      status: "COMPLETED",
    },
  );
  await completeBridgeCloudCommand(watched.device.bridgeDeviceId, prepared);

  const updated = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: watched.library.id },
  });

  assert.equal(updated.readPermission, false);
  assert.equal(updated.watchPermission, false);
  assert.equal(updated.monitoringState, "STOPPED");
});

test("watch permission does not imply an active cloud watcher", async () => {
  const bridgeRootId = "root_aaaaaaaaaaaaaaaaaaaaaaaa";
  const { device, library } = await createCloudScannedFile({
    bridgeRootId,
    relativePath: "Notes/watcher-paused.txt",
  });

  await prisma.connectedLibrary.update({
    data: {
      monitoringHeartbeatAt: new Date(),
      monitoringState: "WATCHING",
      readPermission: true,
      watchPermission: true,
    },
    where: { id: library.id },
  });

  await syncBridgeDeviceRoots(device.bridgeDeviceId, [
    cloudRootSummary(bridgeRootId, {
      lastWatchingAt: null,
      updatedAt: "2026-08-01T00:00:05.000Z",
      watcherState: "PAUSED",
      watchPermission: true,
    }),
  ]);

  const updated = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: library.id },
  });

  assert.equal(updated.watchPermission, true);
  assert.equal(updated.monitoringState, "PAUSED");
  assert.equal(updated.monitoringHeartbeatAt, null);
});

test("remote monitoring commands persist only after native watcher confirmation", async () => {
  const bridgeRootId = "root_bbbbbbbbbbbbbbbbbbbbbbbb";
  const { device, library } = await createCloudScannedFile({
    bridgeRootId,
    relativePath: "Notes/start-watching.txt",
  });

  await prisma.connectedLibrary.update({
    data: {
      monitoringState: "PAUSED",
      readPermission: true,
      watchPermission: true,
    },
    where: { id: library.id },
  });

  const queued = await queueRemoteMonitoringAction(library.id, "start");
  const afterQueue = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: library.id },
  });

  assert.equal(afterQueue.monitoringState, "PAUSED");
  assert.equal(queued.library.monitoringState, "PAUSED");

  await acknowledgeBridgeCloudCommand(device.bridgeDeviceId, queued.commandId);
  const prepared = await prepareBridgeCommandReportForPersistence(
    device.bridgeDeviceId,
    {
      commandId: queued.commandId,
      result: cloudRootSummary(bridgeRootId, {
        lastWatchingAt: "2026-08-01T00:01:00.000Z",
        updatedAt: "2026-08-01T00:01:00.000Z",
        watcherState: "WATCHING",
        watchPermission: true,
      }),
      safeErrorCategory: null,
      status: "COMPLETED",
    },
  );
  await completeBridgeCloudCommand(device.bridgeDeviceId, prepared);

  const status = await getRemoteMonitoringActionStatus(
    library.id,
    queued.commandId,
  );
  const afterComplete = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: library.id },
  });

  assert.equal(status.status, "COMPLETED");
  assert.equal(afterComplete.monitoringState, "WATCHING");
  assert.notEqual(afterComplete.monitoringStartedAt, null);
  assert.notEqual(afterComplete.monitoringHeartbeatAt, null);
});

test("failed remote monitoring command keeps the previous confirmed watcher state", async () => {
  const bridgeRootId = "root_eeeeeeeeeeeeeeeeeeeeeeee";
  const { device, library } = await createCloudScannedFile({
    bridgeRootId,
    relativePath: "Notes/failed-start.txt",
  });

  await prisma.connectedLibrary.update({
    data: {
      monitoringState: "PAUSED",
      readPermission: true,
      watchPermission: true,
    },
    where: { id: library.id },
  });

  const queued = await queueRemoteMonitoringAction(library.id, "start");

  await acknowledgeBridgeCloudCommand(device.bridgeDeviceId, queued.commandId);
  await completeBridgeCloudCommand(device.bridgeDeviceId, {
    commandId: queued.commandId,
    result: null,
    safeErrorCategory: "WATCHER_START_FAILED",
    status: "FAILED",
  });

  const status = await getRemoteMonitoringActionStatus(
    library.id,
    queued.commandId,
  );
  const unchanged = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: library.id },
  });

  assert.equal(status.status, "FAILED");
  assert.equal("error" in status, true);
  assert.equal(unchanged.monitoringState, "PAUSED");
});

test("completed pause command marks the cloud watcher paused from native truth", async () => {
  const bridgeRootId = "root_ffffffffffffffffffffffff";
  const { device, library } = await createCloudScannedFile({
    bridgeRootId,
    relativePath: "Notes/pause-watching.txt",
  });

  await prisma.connectedLibrary.update({
    data: {
      monitoringHeartbeatAt: new Date(),
      monitoringStartedAt: new Date(),
      monitoringState: "WATCHING",
      readPermission: true,
      watchPermission: true,
    },
    where: { id: library.id },
  });

  const queued = await queueRemoteMonitoringAction(library.id, "pause");

  await acknowledgeBridgeCloudCommand(device.bridgeDeviceId, queued.commandId);
  const prepared = await prepareBridgeCommandReportForPersistence(
    device.bridgeDeviceId,
    {
      commandId: queued.commandId,
      result: cloudRootSummary(bridgeRootId, {
        updatedAt: "2026-08-01T00:02:00.000Z",
        watcherState: "PAUSED",
        watchPermission: true,
      }),
      safeErrorCategory: null,
      status: "COMPLETED",
    },
  );
  await completeBridgeCloudCommand(device.bridgeDeviceId, prepared);

  const paused = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: library.id },
  });

  assert.equal(paused.monitoringState, "PAUSED");
  assert.equal(paused.monitoringHeartbeatAt, null);
  assert.notEqual(paused.monitoringPausedAt, null);
});

test("cloud watch event ingestion is idempotent and updates monitoring summary", async () => {
  const bridgeRootId = "root_111111111111111111111111";
  const { device, library } = await createCloudScannedFile({
    bridgeRootId,
    relativePath: "Notes/event-source.txt",
  });

  await prisma.connectedLibrary.update({
    data: {
      monitoringState: "WATCHING",
      readPermission: true,
      watchPermission: true,
    },
    where: { id: library.id },
  });

  const first = await ingestBridgeWatchEvents(device.bridgeDeviceId, [
    {
      detectedAt: new Date().toISOString(),
      eventId: "evt_cloud_create",
      eventType: "FILE_ADDED",
      relativePath: "Inbox/watching-test.txt",
      rootId: bridgeRootId,
    },
  ]);
  const second = await ingestBridgeWatchEvents(device.bridgeDeviceId, [
    {
      detectedAt: new Date().toISOString(),
      eventId: "evt_cloud_create",
      eventType: "FILE_ADDED",
      relativePath: "Inbox/watching-test.txt",
      rootId: bridgeRootId,
    },
  ]);
  const storedEvents = await prisma.monitoringEvent.findMany();
  const summary = await getConnectedLibrary(library.id);

  assert.deepEqual(first.acceptedEventIds, ["evt_cloud_create"]);
  assert.deepEqual(second.duplicateEventIds, ["evt_cloud_create"]);
  assert.equal(storedEvents.length, 1);
  assert.equal(storedEvents[0]?.eventType, "FILE_ADDED");
  assert.equal(summary.recentChangeCount, 1);
  assert.notEqual(summary.lastDetectedChangeAt, null);
});

test("cloud watch events reject unsafe paths and cross-root delivery", async () => {
  const rootA = "root_222222222222222222222222";
  const rootB = "root_333333333333333333333333";
  const first = await createCloudScannedFile({
    bridgeRootId: rootA,
    relativePath: "Notes/root-a.txt",
  });
  const second = await createCloudScannedFile({
    bridgeRootId: rootB,
    relativePath: "Notes/root-b.txt",
  });

  await assert.rejects(
    () =>
      ingestBridgeWatchEvents(first.device.bridgeDeviceId, [
        {
          detectedAt: new Date().toISOString(),
          eventId: "evt_bad_path",
          eventType: "FILE_MODIFIED",
          relativePath: "../outside.txt",
          rootId: rootA,
        },
      ]),
    /watch event/i,
  );
  await assert.rejects(
    () =>
      ingestBridgeWatchEvents(first.device.bridgeDeviceId, [
        {
          detectedAt: new Date().toISOString(),
          eventId: "evt_cross_root",
          eventType: "FILE_MODIFIED",
          relativePath: "Inbox/file.txt",
          rootId: rootB,
        },
      ]),
    /does not belong/i,
  );

  assert.notEqual(first.device.bridgeDeviceId, second.device.bridgeDeviceId);
});

test("signed watch-events route accepts device events without exposing localhost", async () => {
  const bridgeRootId = "root_444444444444444444444444";
  const { device, keys } = await createCloudScannedFile({
    bridgeRootId,
    relativePath: "Notes/route-event.txt",
  });
  const route = await import(
    "../../src/app/api/bridge/cloud/devices/[deviceId]/watch-events/route"
  );
  const pathname = `/api/bridge/cloud/devices/${device.bridgeDeviceId}/watch-events`;
  const bodyText = JSON.stringify({
    events: [
      {
        detectedAt: new Date().toISOString(),
        eventId: "evt_route_create",
        eventType: "FILE_MODIFIED",
        relativePath: "Inbox/watching-test.txt",
        rootId: bridgeRootId,
      },
    ],
  });
  const headers = createBridgeDeviceRequestHeaders({
    bodyText,
    bridgeDeviceId: device.bridgeDeviceId,
    method: "POST",
    pathname,
    privateKey: keys.privateKey,
  });
  const response = await route.POST(
    new Request(`http://localhost${pathname}`, {
      body: bodyText,
      headers,
      method: "POST",
    }),
    {
      params: Promise.resolve({ deviceId: device.bridgeDeviceId }),
    },
  );
  const payload = (await response.json()) as {
    acceptedEventIds: string[];
    ok: boolean;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.acceptedEventIds, ["evt_route_create"]);
});

test("production cloud monitoring dashboard does not drain localhost events", async () => {
  process.env.NSN_LOCAL_BRIDGE_URL = "http://127.0.0.1:9";
  const bridgeRootId = "root_555555555555555555555555";
  const { library } = await createCloudScannedFile({
    bridgeRootId,
    relativePath: "Notes/no-localhost.txt",
  });

  await prisma.connectedLibrary.update({
    data: {
      monitoringState: "WATCHING",
      readPermission: true,
      watchPermission: true,
    },
    where: { id: library.id },
  });

  await getMonitoringDashboardData();

  const afterDashboard = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: library.id },
  });

  assert.equal(afterDashboard.monitoringState, "WATCHING");
  assert.equal(afterDashboard.monitoringErrorCategory, null);
});
