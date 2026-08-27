import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import {
  createBridgeDeviceId,
  createBridgeKeyPair,
  type BridgeJson,
} from "../../packages/bridge-protocol/src";
import { readBridgeRootFile } from "../../bridge-app/src/filesystem/reader";
import { scanBridgeRoot } from "../../bridge-app/src/filesystem/scanner";
import {
  createFolderSelection,
  registerRootFromSelection,
} from "../../bridge-app/src/main/registry";
import { defaultBridgePermissions } from "../../bridge-app/src/permissions/defaults";
import { BridgeAppError } from "../../bridge-app/src/types";

let acknowledgeBridgeCloudCommand: typeof import("../../src/lib/bridge/cloud-coordinator").acknowledgeBridgeCloudCommand;
let completeBridgeCloudCommand: typeof import("../../src/lib/bridge/cloud-coordinator").completeBridgeCloudCommand;
let fileMatchesScannedFileFilter: typeof import("../../src/lib/bridge/scanned-file-filters").fileMatchesScannedFileFilter;
let getBridgeScanSessionDetail: typeof import("../../src/lib/bridge/scan-sessions").getBridgeScanSessionDetail;
let importRemoteBridgeScanReport: typeof import("../../src/lib/bridge/remote-scan-queue").importRemoteBridgeScanReport;
let prepareBridgeCommandReportForPersistence: typeof import("../../src/lib/bridge/cloud-command-results").prepareBridgeCommandReportForPersistence;
let prisma: PrismaClient;
let previousBridgeDataDir: string | undefined;
let previousClaudeKey: string | undefined;
let previousCommandSigningSecret: string | undefined;
let previousDatabaseUrl: string | undefined;
let previousDeveloperFallback: string | undefined;
let previousDirectUrl: string | undefined;
let previousOpenAIKey: string | undefined;
let tempRoot: string;
let testDatabaseUrl: string;
let testDirectDatabaseUrl: string;

const testSchemaName = `bridge_media_command_${process.pid}_${Date.now()}`;

function databaseUrlForSchema(
  schemaName: string,
  databaseUrl = process.env.DATABASE_URL,
) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Bridge media command tests.");
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

function bridgeJson(value: unknown): BridgeJson {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "bigint") {
        return nested.toString();
      }

      if (nested instanceof Date) {
        return nested.toISOString();
      }

      return nested;
    }),
  ) as BridgeJson;
}

function mp3FrameBuffer(marker = 0) {
  const buffer = Buffer.concat([
    Buffer.from([0xff, 0xfb, 0x90, 0x64]),
    Buffer.alloc(2048),
  ]);

  buffer[buffer.length - 1] = marker;

  return buffer;
}

function atom(type: string, payload: Buffer) {
  const buffer = Buffer.alloc(8 + payload.length);

  buffer.writeUInt32BE(buffer.length, 0);
  buffer.write(type, 4, 4, "ascii");
  payload.copy(buffer, 8);

  return buffer;
}

function mp4VideoBuffer(options: { hasAudioTrack?: boolean } = {}) {
  const mvhdPayload = Buffer.alloc(100);

  mvhdPayload.writeUInt32BE(1000, 12);
  mvhdPayload.writeUInt32BE(4000, 16);

  return Buffer.concat([
    atom("ftyp", Buffer.from("isom0000isommp42", "ascii")),
    atom(
      "moov",
      Buffer.concat([
        atom("mvhd", mvhdPayload),
        Buffer.from(options.hasAudioTrack ? "vide soun" : "vide", "ascii"),
      ]),
    ),
    Buffer.alloc(128),
  ]);
}

async function resetTestData() {
  await prisma.bridgeAuditEntry.deleteMany();
  await prisma.bridgeCommand.deleteMany();
  await prisma.scannedFile.deleteMany();
  await prisma.scanSession.deleteMany();
  await prisma.connectedLibrary.deleteMany();
  await prisma.bridgeDevice.deleteMany();
  await prisma.libraryBatch.deleteMany();
}

async function createCloudBackedBridgeRoot(
  displayName: string,
  files: Map<string, Buffer>,
) {
  const libraryRoot = path.join(tempRoot, `${displayName}-${randomUUID()}`);

  for (const [relativePath, content] of files) {
    const fullPath = path.join(libraryRoot, ...relativePath.split("/"));

    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }

  const selection = await createFolderSelection(libraryRoot);
  const root = await registerRootFromSelection({
    permissions: defaultBridgePermissions,
    selectionToken: selection.selectionToken,
  });
  const now = new Date();
  const bridgeDeviceId = createBridgeDeviceId();
  const keys = createBridgeKeyPair();
  const device = await prisma.bridgeDevice.create({
    data: {
      appVersion: "0.1.109",
      architecture: "x64",
      bridgeDeviceId,
      deviceDisplayName: "Deanne's Intel Mac",
      lastSeenAt: now,
      pairedAt: now,
      platform: "MACOS",
      publicKey: keys.publicKey,
      status: "ONLINE",
    },
  });
  const library = await prisma.connectedLibrary.create({
    data: {
      bridgeDeviceId,
      bridgeRootId: root.id,
      displayName,
      folderFingerprint: root.id,
      localPath: `bridge://${root.id}`,
      platform: "MACOS",
      readPermission: true,
      recommendationPermission: true,
      safeLocalLocation: "A folder selected on this Mac",
      status: "CONNECTED",
    },
  });
  const scan = await scanBridgeRoot(root.id);
  const session = await prisma.scanSession.create({
    data: {
      connectedFolderId: library.id,
      status: "SCANNING",
    },
  });
  const importResult = await importRemoteBridgeScanReport({
    bridgeDeviceId: device.bridgeDeviceId,
    bridgeRootId: root.id,
    commandPayload: { scanSessionId: session.id },
    connectedLibraryId: library.id,
    report: {
      commandId: `scan-${randomUUID()}`,
      result: bridgeJson(scan),
      safeErrorCategory: null,
      status: "COMPLETED",
    },
  });

  return {
    device,
    importResult,
    library,
    root,
    rootPath: libraryRoot,
    session,
  };
}

async function scannedFile(sessionId: string, relativePath: string) {
  return prisma.scannedFile.findFirstOrThrow({
    include: {
      audioMetadata: true,
      organizationSuggestions: true,
      videoMetadata: true,
    },
    where: {
      relativePath,
      sessionId,
    },
  });
}

async function readCommandFor(scannedFileId: string) {
  const commands = await prisma.bridgeCommand.findMany({
    orderBy: {
      issuedAt: "asc",
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

async function completeNativeRead(input: {
  bridgeDeviceId: string;
  bridgeRootId: string;
  relativePath: string;
  scannedFileId: string;
}) {
  const command = await readCommandFor(input.scannedFileId);

  assert.ok(command);
  await acknowledgeBridgeCloudCommand(input.bridgeDeviceId, command.commandId);

  const result = await readBridgeRootFile(input.bridgeRootId, input.relativePath);
  const prepared = await prepareBridgeCommandReportForPersistence(
    input.bridgeDeviceId,
    {
      commandId: command.commandId,
      result: bridgeJson(result),
      safeErrorCategory: null,
      status: "COMPLETED",
    },
  );

  await completeBridgeCloudCommand(input.bridgeDeviceId, prepared);

  return result;
}

before(async () => {
  previousBridgeDataDir = process.env.NSN_BRIDGE_DATA_DIR;
  previousClaudeKey = process.env.CLAUDE_API_KEY;
  previousCommandSigningSecret = process.env.NSN_BRIDGE_COMMAND_SIGNING_SECRET;
  previousDatabaseUrl = process.env.DATABASE_URL;
  previousDeveloperFallback = process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK;
  previousDirectUrl = process.env.DIRECT_URL;
  previousOpenAIKey = process.env.OPENAI_API_KEY;

  testDatabaseUrl = databaseUrlForSchema(testSchemaName);
  testDirectDatabaseUrl = databaseUrlForSchema(
    testSchemaName,
    process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  );
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "nsn-bridge-media-command-"));
  process.env.CLAUDE_API_KEY = "";
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.DIRECT_URL = testDirectDatabaseUrl;
  process.env.NSN_BRIDGE_DATA_DIR = path.join(tempRoot, ".bridge-data");
  process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK = "false";
  process.env.OPENAI_API_KEY = "";
  process.env.NSN_BRIDGE_COMMAND_SIGNING_SECRET =
    "bridge-media-command-test-secret";

  runPrismaDbPush();

  const prismaModule = await import("../../src/lib/db/prisma");
  const coordinator = await import("../../src/lib/bridge/cloud-coordinator");
  const commandResults = await import("../../src/lib/bridge/cloud-command-results");
  const remoteScanQueue = await import("../../src/lib/bridge/remote-scan-queue");
  const scanSessions = await import("../../src/lib/bridge/scan-sessions");
  const filters = await import("../../src/lib/bridge/scanned-file-filters");

  prisma = prismaModule.getPrismaClient();
  acknowledgeBridgeCloudCommand = coordinator.acknowledgeBridgeCloudCommand;
  completeBridgeCloudCommand = coordinator.completeBridgeCloudCommand;
  prepareBridgeCommandReportForPersistence =
    commandResults.prepareBridgeCommandReportForPersistence;
  importRemoteBridgeScanReport = remoteScanQueue.importRemoteBridgeScanReport;
  getBridgeScanSessionDetail = scanSessions.getBridgeScanSessionDetail;
  fileMatchesScannedFileFilter = filters.fileMatchesScannedFileFilter;
});

beforeEach(async () => {
  await resetTestData();
});

after(async () => {
  await prisma?.$disconnect();
  await rm(tempRoot, { force: true, recursive: true });

  const cleanupPrisma = new PrismaClient();

  await cleanupPrisma.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`,
  );
  await cleanupPrisma.$disconnect();

  if (previousBridgeDataDir === undefined) {
    delete process.env.NSN_BRIDGE_DATA_DIR;
  } else {
    process.env.NSN_BRIDGE_DATA_DIR = previousBridgeDataDir;
  }

  if (previousClaudeKey === undefined) {
    delete process.env.CLAUDE_API_KEY;
  } else {
    process.env.CLAUDE_API_KEY = previousClaudeKey;
  }

  if (previousCommandSigningSecret === undefined) {
    delete process.env.NSN_BRIDGE_COMMAND_SIGNING_SECRET;
  } else {
    process.env.NSN_BRIDGE_COMMAND_SIGNING_SECRET =
      previousCommandSigningSecret;
  }

  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }

  if (previousDeveloperFallback === undefined) {
    delete process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK;
  } else {
    process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK =
      previousDeveloperFallback;
  }

  if (previousDirectUrl === undefined) {
    delete process.env.DIRECT_URL;
  } else {
    process.env.DIRECT_URL = previousDirectUrl;
  }

  if (previousOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousOpenAIKey;
  }
});

test("cloud scan import queues audio reads and records checksum duplicates across roots", async () => {
  const duplicateAudio = mp3FrameBuffer(1);
  const first = await createCloudBackedBridgeRoot(
    "SCAN_ROOT_A_GENERAL_INBOX",
    new Map([
      ["Audio/Meetings/attachment-planning-meeting.mp3", duplicateAudio],
      ["Audio/Meetings/unrelated-note.mp3", mp3FrameBuffer(2)],
    ]),
  );
  const second = await createCloudBackedBridgeRoot(
    "SCAN_ROOT_B_ARCHIVE",
    new Map([["Audio/Archive/attachment-planning-meeting-copy.mp3", duplicateAudio]]),
  );
  const firstDuplicate = await scannedFile(
    first.session.id,
    "Audio/Meetings/attachment-planning-meeting.mp3",
  );
  const secondDuplicate = await scannedFile(
    second.session.id,
    "Audio/Archive/attachment-planning-meeting-copy.mp3",
  );
  const unrelated = await scannedFile(
    first.session.id,
    "Audio/Meetings/unrelated-note.mp3",
  );

  assert.equal(first.importResult?.queuedReads, 2);
  assert.equal(second.importResult?.queuedReads, 1);
  assert.equal(firstDuplicate.readStatus, "SUPPORTED");
  assert.equal(firstDuplicate.audioMetadata?.duplicateKind, "EXACT_DUPLICATE");
  assert.equal(secondDuplicate.audioMetadata?.duplicateKind, "EXACT_DUPLICATE");
  assert.equal(unrelated.audioMetadata?.duplicateKind ?? null, null);

  const firstDetail = await getBridgeScanSessionDetail(first.session.id);
  const firstSummary = firstDetail?.scannedFiles.find(
    (file) => file.id === firstDuplicate.id,
  );

  assert.ok(firstSummary);
  assert.equal(firstSummary.hasPossibleDuplicateSuggestion, true);
  assert.equal(
    fileMatchesScannedFileFilter(firstSummary, "POSSIBLE_DUPLICATES"),
    true,
  );

  await completeNativeRead({
    bridgeDeviceId: first.device.bridgeDeviceId,
    bridgeRootId: first.root.id,
    relativePath: firstDuplicate.relativePath,
    scannedFileId: firstDuplicate.id,
  });
  await completeNativeRead({
    bridgeDeviceId: second.device.bridgeDeviceId,
    bridgeRootId: second.root.id,
    relativePath: secondDuplicate.relativePath,
    scannedFileId: secondDuplicate.id,
  });

  const processedFirst = await scannedFile(
    first.session.id,
    firstDuplicate.relativePath,
  );
  const processedSecond = await scannedFile(
    second.session.id,
    secondDuplicate.relativePath,
  );

  assert.equal(processedFirst.readingStatus, "READ");
  assert.equal(processedFirst.extractionStatus, "COMPLETED");
  assert.equal(processedFirst.audioMetadata?.transcriptionStatus, "UNAVAILABLE");
  assert.equal(processedFirst.audioMetadata?.transcriptSnippet, null);
  assert.equal(processedFirst.audioMetadata?.duplicateKind, "EXACT_DUPLICATE");
  assert.equal(processedSecond.audioMetadata?.duplicateKind, "EXACT_DUPLICATE");
  assert.ok(
    processedFirst.organizationSuggestions.some(
      (suggestion) => suggestion.suggestionType === "POSSIBLE_DUPLICATE",
    ),
  );
  assert.deepEqual(
    await readFile(
      path.join(
        first.rootPath,
        "Audio",
        "Meetings",
        "attachment-planning-meeting.mp3",
      ),
    ),
    duplicateAudio,
  );
});

test("cloud media read commands persist video metadata without inventing transcripts", async () => {
  const root = await createCloudBackedBridgeRoot(
    "SCAN_ROOT_VIDEO",
    new Map([
      ["Video/Workshops/silent-workshop.mp4", mp4VideoBuffer({ hasAudioTrack: false })],
      ["Video/Meetings/planning-call.mov", mp4VideoBuffer({ hasAudioTrack: true })],
    ]),
  );
  const silent = await scannedFile(
    root.session.id,
    "Video/Workshops/silent-workshop.mp4",
  );
  const withAudio = await scannedFile(
    root.session.id,
    "Video/Meetings/planning-call.mov",
  );

  const silentResult = await completeNativeRead({
    bridgeDeviceId: root.device.bridgeDeviceId,
    bridgeRootId: root.root.id,
    relativePath: silent.relativePath,
    scannedFileId: silent.id,
  });
  const audioResult = await completeNativeRead({
    bridgeDeviceId: root.device.bridgeDeviceId,
    bridgeRootId: root.root.id,
    relativePath: withAudio.relativePath,
    scannedFileId: withAudio.id,
  });
  const processedSilent = await scannedFile(root.session.id, silent.relativePath);
  const processedWithAudio = await scannedFile(
    root.session.id,
    withAudio.relativePath,
  );

  assert.equal(silentResult.videoMetadata?.hasAudioTrack, false);
  assert.equal(audioResult.videoMetadata?.hasAudioTrack, true);
  assert.equal(processedSilent.fileType, "VIDEO_MP4");
  assert.equal(processedSilent.readingStatus, "READ");
  assert.equal(processedSilent.videoMetadata?.hasAudioTrack, false);
  assert.equal(processedSilent.videoMetadata?.transcriptionStatus, "UNAVAILABLE");
  assert.equal(processedSilent.videoMetadata?.transcriptSnippet, null);
  assert.equal(processedWithAudio.fileType, "VIDEO_MOV");
  assert.equal(processedWithAudio.videoMetadata?.hasAudioTrack, true);
  assert.equal(processedWithAudio.videoMetadata?.transcriptionStatus, "UNAVAILABLE");
  assert.equal(processedWithAudio.videoMetadata?.transcriptSnippet, null);
});

test("damaged supported media fails safely while other read commands continue", async () => {
  const root = await createCloudBackedBridgeRoot(
    "SCAN_ROOT_DAMAGED_MEDIA",
    new Map([
      ["Audio/Damaged/broken.mp3", Buffer.from("not really audio")],
      ["Audio/Meetings/usable.mp3", mp3FrameBuffer(3)],
      ["Archives/package.zip", Buffer.from("unsupported")],
    ]),
  );
  const damaged = await scannedFile(root.session.id, "Audio/Damaged/broken.mp3");
  const usable = await scannedFile(root.session.id, "Audio/Meetings/usable.mp3");
  const unsupported = await scannedFile(root.session.id, "Archives/package.zip");
  const damagedCommand = await readCommandFor(damaged.id);

  assert.ok(damagedCommand);
  await acknowledgeBridgeCloudCommand(
    root.device.bridgeDeviceId,
    damagedCommand.commandId,
  );
  await assert.rejects(
    () => readBridgeRootFile(root.root.id, damaged.relativePath),
    (error) =>
      error instanceof BridgeAppError &&
      error.code === "AUDIO_DECODE_FAILED",
  );
  const failedReport = await prepareBridgeCommandReportForPersistence(
    root.device.bridgeDeviceId,
    {
      commandId: damagedCommand.commandId,
      result: null,
      safeErrorCategory: "AUDIO_DECODE_FAILED",
      status: "FAILED",
    },
  );

  await completeBridgeCloudCommand(root.device.bridgeDeviceId, failedReport);
  await completeNativeRead({
    bridgeDeviceId: root.device.bridgeDeviceId,
    bridgeRootId: root.root.id,
    relativePath: usable.relativePath,
    scannedFileId: usable.id,
  });

  const damagedAfter = await scannedFile(root.session.id, damaged.relativePath);
  const usableAfter = await scannedFile(root.session.id, usable.relativePath);

  assert.equal(damagedAfter.fileType, "AUDIO_MP3");
  assert.equal(damagedAfter.readStatus, "SUPPORTED");
  assert.equal(damagedAfter.readingStatus, "FAILED");
  assert.equal(damagedAfter.extractionStatus, "FAILED");
  assert.equal(damagedAfter.processingErrorCategory, "AUDIO_DECODE_FAILED");
  assert.equal(usableAfter.readingStatus, "READ");
  assert.equal(usableAfter.extractionStatus, "COMPLETED");
  assert.equal(unsupported.readStatus, "UNSUPPORTED");
  assert.equal(unsupported.processingStage, "UNSUPPORTED");
});
