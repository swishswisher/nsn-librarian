import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
let getBridgeScanSessionProgress: typeof import("../../src/lib/bridge/scan-sessions").getBridgeScanSessionProgress;
let importRemoteBridgeScanReport: typeof import("../../src/lib/bridge/remote-scan-queue").importRemoteBridgeScanReport;
let prepareBridgeCommandReportForPersistence: typeof import("../../src/lib/bridge/cloud-command-results").prepareBridgeCommandReportForPersistence;
let fetchRecoverableBridgeCommands: typeof import("../../src/lib/bridge/recoverable-commands").fetchRecoverableBridgeCommands;
let loadScanWorkingKnowledge: typeof import("../../src/lib/bridge/scan-working-knowledge").loadScanWorkingKnowledge;
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

function pngMetadataFixture() {
  const buffer = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(640, 16);
  buffer.writeUInt32BE(480, 20);
  return buffer;
}

function mp4VideoBuffer(options: { hasAudioTrack?: boolean } = {}) {
  const fixtureDirectory = mkdtempSync(path.join(os.tmpdir(), "nsn-video-fixture-"));
  const fixturePath = path.join(fixtureDirectory, "fixture.mp4");
  const inputs = ["-f", "lavfi", "-i", "color=c=blue:s=64x48:r=2:d=1"];
  if (options.hasAudioTrack) {
    inputs.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=1");
  }

  try {
    execFileSync(process.env.FFMPEG_PATH ?? "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", ...inputs,
      "-c:v", "mpeg4", "-pix_fmt", "yuv420p",
      ...(options.hasAudioTrack ? ["-c:a", "aac", "-shortest"] : ["-an"]),
      "-movflags", "+faststart", fixturePath,
    ], { stdio: "pipe" });
    return readFileSync(fixturePath);
  } catch (error) {
    const details = error && typeof error === "object"
      ? error as {
          code?: unknown;
          message?: unknown;
          signal?: unknown;
          status?: unknown;
          stderr?: Buffer | string;
        }
      : null;
    const diagnostics = [
      `message=${details?.message ?? String(error)}`,
      `code=${details?.code ?? "unknown"}`,
      `status=${details?.status ?? "unknown"}`,
      `signal=${details?.signal ?? "unknown"}`,
      `stderr=${String(details?.stderr ?? "<empty>") || "<empty>"}`,
    ].join("; ");

    throw new Error(`FFmpeg could not create the synthetic MP4 fixture: ${diagnostics}`, {
      cause: error,
    });
  } finally {
    rmSync(fixtureDirectory, { force: true, recursive: true });
  }
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

async function repeatCloudScan(root: Awaited<ReturnType<typeof createCloudBackedBridgeRoot>>) {
  const scan = await scanBridgeRoot(root.root.id);
  const session = await prisma.scanSession.create({
    data: { connectedFolderId: root.library.id, status: "SCANNING" },
  });
  const result = await importRemoteBridgeScanReport({
    bridgeDeviceId: root.device.bridgeDeviceId,
    bridgeRootId: root.root.id,
    commandPayload: { scanSessionId: session.id },
    connectedLibraryId: root.library.id,
    report: {
      commandId: `scan-${randomUUID()}`,
      result: bridgeJson(scan),
      safeErrorCategory: null,
      status: "COMPLETED",
    },
  });

  return { result, session };
}

async function withMockObserver(run: (requestCount: () => number) => Promise<void>, delayMs = 0, failFirstRequests = 0, incompleteFirstRequests = 0) {
  let requests = 0;
  const server = createServer(async (_request, response) => {
    requests += 1;
    if (requests <= failFirstRequests) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Local test failure" } }));
      return;
    }
    if (delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      id: `resp_${requests}`,
      object: "response",
      created_at: 1,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      status: requests <= incompleteFirstRequests ? "incomplete" : "completed",
      incomplete_details: requests <= incompleteFirstRequests ? { reason: "max_output_tokens" } : null,
      output: [{
        id: `msg_${requests}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            observations: [{ text: "Possible workshop notes", evidence: ["Workshop facilitation notes."], whyItMatters: "Review this file.", confidence: 0.7, uncertainty: "Possible" }],
            possibleThemes: [],
            possibleRelationships: [],
            questions: [],
            confidence: 0.7,
            uncertainty: "Human review needed.",
            warnings: [],
          }),
          annotations: [],
        }],
      }],
      usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousModel = process.env.OPENAI_MODEL;
  process.env.OPENAI_API_KEY = "test-only-local-stub";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;

  try {
    await run(() => requests);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousModel;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
  const recoverableCommands = await import("../../src/lib/bridge/recoverable-commands");
  const workingKnowledge = await import("../../src/lib/bridge/scan-working-knowledge");

  prisma = prismaModule.getPrismaClient();
  acknowledgeBridgeCloudCommand = coordinator.acknowledgeBridgeCloudCommand;
  completeBridgeCloudCommand = coordinator.completeBridgeCloudCommand;
  prepareBridgeCommandReportForPersistence =
    commandResults.prepareBridgeCommandReportForPersistence;
  importRemoteBridgeScanReport = remoteScanQueue.importRemoteBridgeScanReport;
  getBridgeScanSessionDetail = scanSessions.getBridgeScanSessionDetail;
  getBridgeScanSessionProgress = scanSessions.getBridgeScanSessionProgress;
  fileMatchesScannedFileFilter = filters.fileMatchesScannedFileFilter;
  fetchRecoverableBridgeCommands = recoverableCommands.fetchRecoverableBridgeCommands;
  loadScanWorkingKnowledge = workingKnowledge.loadScanWorkingKnowledge;
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

  assert.equal((first.importResult as Record<string, unknown>)?.queuedReads, 2);
  assert.equal((second.importResult as Record<string, unknown>)?.queuedReads, 1);
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

test("mixed cloud scans finish a valid image as metadata-only and isolate a corrupt image", async () => {
  const root = await createCloudBackedBridgeRoot(
    "SCAN_ROOT_MIXED_IMAGES",
    new Map([
      ["Images/valid.png", pngMetadataFixture()],
      ["Images/broken.jpg", Buffer.from("not a jpeg")],
      ["Documents/note.txt", Buffer.from("Workshop facilitation notes.")],
    ]),
  );
  const valid = await scannedFile(root.session.id, "Images/valid.png");
  const broken = await scannedFile(root.session.id, "Images/broken.jpg");
  const document = await scannedFile(root.session.id, "Documents/note.txt");
  const metadata = await prisma.imageAssetMetadata.findUnique({
    where: { scannedFileId: valid.id },
  });

  assert.equal(valid.fileType, "IMAGE_PNG");
  assert.equal(valid.readStatus, "SUPPORTED");
  assert.equal(metadata?.width, 640);
  assert.equal(metadata?.height, 480);
  assert.equal(broken.fileType, "IMAGE_JPG");
  assert.equal(broken.readStatus, "SUPPORTED");
  const brokenCommand = await readCommandFor(broken.id);
  assert.ok(brokenCommand);
  await acknowledgeBridgeCloudCommand(root.device.bridgeDeviceId, brokenCommand.commandId);
  await assert.rejects(
    () => readBridgeRootFile(root.root.id, broken.relativePath),
    (error) => error instanceof BridgeAppError && error.code === "IMAGE_DECODE_FAILED",
  );
  const failedReport = await prepareBridgeCommandReportForPersistence(
    root.device.bridgeDeviceId,
    {
      commandId: brokenCommand.commandId,
      result: null,
      safeErrorCategory: "IMAGE_DECODE_FAILED",
      status: "FAILED",
    },
  );
  await completeBridgeCloudCommand(root.device.bridgeDeviceId, failedReport);

  const result = await completeNativeRead({
    bridgeDeviceId: root.device.bridgeDeviceId,
    bridgeRootId: root.root.id,
    relativePath: valid.relativePath,
    scannedFileId: valid.id,
  });
  assert.match(result.extractedText, /metadata only/);
  assert.match(result.extractedText, /OCR text: unavailable/);
  assert.doesNotMatch(result.extractedText, /workshop facilitation/i);

  await completeNativeRead({
    bridgeDeviceId: root.device.bridgeDeviceId,
    bridgeRootId: root.root.id,
    relativePath: document.relativePath,
    scannedFileId: document.id,
  });
  const processed = await scannedFile(root.session.id, valid.relativePath);
  const processedMetadata = await prisma.imageAssetMetadata.findUnique({
    where: { scannedFileId: valid.id },
  });
  const session = await prisma.scanSession.findUniqueOrThrow({ where: { id: root.session.id } });
  const imageObservation = await prisma.observationSession.findFirst({
    where: { libraryDocumentId: processed.libraryDocumentId ?? "" },
  });

  assert.equal(processed.readingStatus, "READ");
  assert.equal(processed.extractionStatus, "COMPLETED");
  const brokenAfter = await scannedFile(root.session.id, broken.relativePath);
  assert.equal(brokenAfter.readingStatus, "FAILED");
  assert.equal(brokenAfter.extractionErrorCategory, "IMAGE_DECODE_FAILED");
  assert.equal(imageObservation?.observerType, "DETERMINISTIC");
  assert.match(JSON.stringify(imageObservation?.warnings), /Only image metadata was examined/);
  assert.equal(processedMetadata?.ocrStatus, "UNAVAILABLE");
  assert.equal(processedMetadata?.visualAnalysisStatus, "UNAVAILABLE");
  assert.match(JSON.stringify(imageObservation?.observations), /did not examine/);
  assert.equal(session.status, "COMPLETED_WITH_ERRORS");
  assert.deepEqual(await readFile(path.join(root.rootPath, "Images", "valid.png")), pngMetadataFixture());
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

test("an unchanged cloud document reuses its grounded observation but receives fresh recommendations", async () => {
  await withMockObserver(async (requestCount) => {
    const root = await createCloudBackedBridgeRoot(
      "SCAN_ROOT_REUSE",
      new Map([["Loose/notes.txt", Buffer.from("Workshop facilitation notes.")]]),
    );
    const first = await scannedFile(root.session.id, "Loose/notes.txt");
    assert.ok(await readCommandFor(first.id));
    await completeNativeRead({
      bridgeDeviceId: root.device.bridgeDeviceId,
      bridgeRootId: root.root.id,
      relativePath: first.relativePath,
      scannedFileId: first.id,
    });
    const observed = await scannedFile(root.session.id, first.relativePath);
    assert.equal(requestCount(), 1);
    assert.equal(observed.observationOrigin, "NEW_AI");
    assert.match(observed.observationFingerprint ?? "", /^[a-f\d]{64}$/);
    assert.equal(observed.aiRequestCount, 1);
    assert.equal(observed.aiHttpAttempts, 1);
    assert.equal(observed.aiInputTokens, 123);
    assert.equal(observed.aiOutputTokens, 45);
    const observation = await prisma.observationSession.findFirstOrThrow({
      where: { libraryDocumentId: observed.libraryDocumentId ?? "" },
    });
    await prisma.observationSession.update({
      data: { status: "MODIFIED" },
      where: { id: observation.id },
    });
    await prisma.humanDecision.create({
      data: { observationSessionId: observation.id, decisionType: "MODIFY", editedSuggestion: "Corrected workshop context" },
    });

    const second = await repeatCloudScan(root);
    const secondFile = await scannedFile(second.session.id, first.relativePath);
    assert.equal((second.result as Record<string, unknown>)?.queuedReads, 0);
    assert.equal((second.result as Record<string, unknown>)?.reusedObservations, 1);
    assert.equal(requestCount(), 1);
    assert.equal(secondFile.observationOrigin, "REUSED_AI");
    assert.equal(secondFile.libraryDocumentId, observed.libraryDocumentId);
    assert.equal(secondFile.aiRequestCount, 0);
    assert.ok(secondFile.organizationSuggestions.length > 0);
    assert.equal(secondFile.organizationSuggestions.every((item) => item.scanSessionId === second.session.id), true);
    assert.equal((await prisma.observationSession.findUniqueOrThrow({ where: { id: observation.id } })).status, "MODIFIED");
    const progress = await getBridgeScanSessionProgress(second.session.id);
    assert.equal(progress?.progress.aiUsage?.reusedObservations, 1);
    assert.equal(progress?.progress.aiUsage?.avoidedRequests, 1);
    assert.equal(progress?.progress.aiUsage?.requests, 0);
    assert.deepEqual(progress?.progress.aiUsage?.models, ["gpt-4o-mini"]);
    assert.deepEqual(progress?.progress.aiUsage?.processingVersions, ["phase1-grounded-observer-v2"]);
    assert.equal(progress?.progress.remainingFiles, 0);
    const commandsBefore = await prisma.bridgeCommand.count();
    assert.deepEqual(await fetchRecoverableBridgeCommands(root.device.bridgeDeviceId), []);
    assert.equal(await prisma.bridgeCommand.count(), commandsBefore);
    assert.equal(await readCommandFor(secondFile.id), undefined);

    await writeFile(path.join(root.rootPath, "Loose", "notes.txt"), "Workshop facilitation notes. Changed content.");
    const changed = await repeatCloudScan(root);
    assert.equal((changed.result as Record<string, unknown>)?.queuedReads, 1);
    const changedFile = await scannedFile(changed.session.id, first.relativePath);
    assert.equal(changedFile.observationOrigin, null);
    await completeNativeRead({
      bridgeDeviceId: root.device.bridgeDeviceId,
      bridgeRootId: root.root.id,
      relativePath: changedFile.relativePath,
      scannedFileId: changedFile.id,
    });
    assert.equal(requestCount(), 2);
    process.env.OPENAI_MODEL = "test-observer-next-version";
    const incompatible = await repeatCloudScan(root);
    assert.equal((incompatible.result as Record<string, unknown>)?.queuedReads, 1);
    assert.equal(requestCount(), 2);
  });
});

test("partial observations are not reused and simultaneous reports claim paid work once", async () => {
  await withMockObserver(async (requestCount) => {
    const root = await createCloudBackedBridgeRoot(
      "SCAN_ROOT_PARTIAL",
      new Map([["Loose/notes.txt", Buffer.from(`Workshop facilitation notes.${" Routine notes.".repeat(10_000)}`)]]),
    );
    const first = await scannedFile(root.session.id, "Loose/notes.txt");
    await completeNativeRead({
      bridgeDeviceId: root.device.bridgeDeviceId,
      bridgeRootId: root.root.id,
      relativePath: first.relativePath,
      scannedFileId: first.id,
    });
    assert.equal((await scannedFile(root.session.id, first.relativePath)).observationFingerprint, null);
    const second = await repeatCloudScan(root);
    assert.equal((second.result as Record<string, unknown>)?.queuedReads, 1);
    const secondFile = await scannedFile(second.session.id, first.relativePath);
    const command = await readCommandFor(secondFile.id);
    assert.ok(command);
    await acknowledgeBridgeCloudCommand(root.device.bridgeDeviceId, command.commandId);
    await prisma.scannedFile.update({
      data: { observationClaimedAt: new Date(Date.now() - 11 * 60_000) },
      where: { id: secondFile.id },
    });
    const nativeResult = bridgeJson(await readBridgeRootFile(root.root.id, secondFile.relativePath));
    const reports = await Promise.all([0, 1].map(() => prepareBridgeCommandReportForPersistence(
      root.device.bridgeDeviceId,
      { commandId: command.commandId, result: nativeResult, safeErrorCategory: null, status: "COMPLETED" },
    )));
    assert.equal(requestCount(), 2);
    assert.equal(reports.some((report) => (report.result as Record<string, unknown>)?.observationPrepared === true), true);
    assert.equal(await prisma.observationSession.count({
      where: { libraryDocument: { scannedFiles: { some: { id: secondFile.id } } } },
    }), 1);
    assert.equal((await scannedFile(second.session.id, first.relativePath)).observationClaimedAt, null);
  }, 150);
});

test("75 unread files advance in bounded batches only after active reads are consumed", async () => {
  const files = new Map(Array.from({ length: 75 }, (_, index) => [
    `Documents/note-${index}.txt`, Buffer.from(`Document ${index} remains on the Mac.`),
  ]));
  const root = await createCloudBackedBridgeRoot("SCAN_ROOT_LARGE", files);

  assert.equal((root.importResult as Record<string, unknown>)?.queuedReads, 4);
  assert.equal(await prisma.bridgeCommand.count({ where: { commandType: "READ_FILE_TEMPORARILY" } }), 4);
  const firstBatch = await fetchRecoverableBridgeCommands(root.device.bridgeDeviceId);
  assert.equal(firstBatch.length, 4);
  await acknowledgeBridgeCloudCommand(root.device.bridgeDeviceId, firstBatch[0].commandId);
  await prisma.bridgeCommand.update({ where: { commandId: firstBatch[1].commandId }, data: { status: "RUNNING" } });
  for (const retry of await Promise.all([
    fetchRecoverableBridgeCommands(root.device.bridgeDeviceId), fetchRecoverableBridgeCommands(root.device.bridgeDeviceId),
  ])) assert.deepEqual(new Set(retry.map((command) => command.commandId)), new Set(firstBatch.map((command) => command.commandId)));
  assert.equal(await prisma.bridgeCommand.count({ where: { commandType: "READ_FILE_TEMPORARILY" } }), 4);
  assert.equal((await getBridgeScanSessionProgress(root.session.id))?.progress.remainingFiles, 75);
  let batch = firstBatch;
  const seen = new Set<string>();
  while (batch.length > 0) {
    assert.ok(batch.length <= 4);
    for (const command of batch) {
      const payload = command.payload as { scannedFileId: string; relativePath: string };
      assert.equal(seen.has(payload.scannedFileId), false);
      seen.add(payload.scannedFileId);
      await completeNativeRead({ bridgeDeviceId: root.device.bridgeDeviceId, bridgeRootId: root.root.id, ...payload });
    }
    const [next, concurrent] = await Promise.all([
      fetchRecoverableBridgeCommands(root.device.bridgeDeviceId), fetchRecoverableBridgeCommands(root.device.bridgeDeviceId),
    ]);
    assert.deepEqual(new Set(next.map((row) => row.commandId)), new Set(concurrent.map((row) => row.commandId)));
    batch = next;
  }
  assert.equal(seen.size, 75);
  const progress = await getBridgeScanSessionProgress(root.session.id);
  assert.equal(progress?.progress.remainingFiles, 0);
  assert.equal(progress?.progress.filesWithSuggestions, 75);
  assert.equal(progress?.session.status, "COMPLETED");
  assert.deepEqual(await fetchRecoverableBridgeCommands(root.device.bridgeDeviceId), []);
  assert.equal(await prisma.bridgeCommand.count(), 75);
});

test("expired read batches are isolated before recovery admits remaining files", async () => {
  const root = await createCloudBackedBridgeRoot("SCAN_ROOT_EXPIRED_BATCH", new Map(Array.from({ length: 75 }, (_, i) => [
    `Documents/expired-${i}.txt`, Buffer.from(`Synthetic document ${i}.`),
  ])));
  const first = await prisma.bridgeCommand.findMany({ where: { commandType: "READ_FILE_TEMPORARILY" } });
  assert.equal(first.length, 4);
  assert.ok(first.every((row) => row.expiresAt.getTime() - row.issuedAt.getTime() <= 10 * 60_000));
  await prisma.bridgeCommand.updateMany({ where: { commandId: { in: first.map((row) => row.commandId) } },
    data: { expiresAt: new Date(Date.now() - 1_000) } });
  const next = await fetchRecoverableBridgeCommands(root.device.bridgeDeviceId);
  assert.equal(next.length, 4);
  assert.equal(await prisma.bridgeCommand.count({ where: { status: "EXPIRED" } }), 4);
  assert.equal(await prisma.scannedFile.count({ where: { sessionId: root.session.id, processingErrorCategory: "READ_COMMAND_TIMEOUT" } }), 4);
  assert.equal((await getBridgeScanSessionProgress(root.session.id))?.progress.remainingFiles, 71);
  assert.equal((await fetchRecoverableBridgeCommands(root.device.bridgeDeviceId)).length, 4);
  assert.equal(await prisma.bridgeCommand.count(), 8);
});

test("reused observations join new files in the next scan's working knowledge", async () => {
  await withMockObserver(async (requestCount) => {
    const root = await createCloudBackedBridgeRoot(
      "SCAN_ROOT_FRESH_CONTEXT",
      new Map([["Workshops/outline.txt", Buffer.from("Workshop facilitation notes.")]]),
    );
    const first = await scannedFile(root.session.id, "Workshops/outline.txt");
    await completeNativeRead({
      bridgeDeviceId: root.device.bridgeDeviceId,
      bridgeRootId: root.root.id,
      relativePath: first.relativePath,
      scannedFileId: first.id,
    });
    await writeFile(path.join(root.rootPath, "Workshops", "agenda.txt"), "Workshop facilitation agenda.");

    const second = await repeatCloudScan(root);
    const reused = await scannedFile(second.session.id, first.relativePath);
    const fresh = await scannedFile(second.session.id, "Workshops/agenda.txt");
    assert.equal(reused.observationOrigin, "REUSED_AI");
    assert.equal((second.result as Record<string, unknown>)?.queuedReads, 1);
    await completeNativeRead({
      bridgeDeviceId: root.device.bridgeDeviceId,
      bridgeRootId: root.root.id,
      relativePath: fresh.relativePath,
      scannedFileId: fresh.id,
    });
    const knowledge = await loadScanWorkingKnowledge(second.session.id);
    assert.equal(requestCount(), 2);
    assert.equal(knowledge?.files.length, 2);
    assert.ok((await scannedFile(second.session.id, reused.relativePath)).organizationSuggestions.length > 0);
    assert.ok((await scannedFile(second.session.id, fresh.relativePath)).organizationSuggestions.length > 0);
  });
});

test("provider retries count real HTTP attempts and failed AI observations remain non-reusable", async () => {
  await withMockObserver(async (requestCount) => {
    const root = await createCloudBackedBridgeRoot(
      "SCAN_ROOT_PROVIDER_RETRY",
      new Map([["Loose/notes.txt", Buffer.from("Workshop facilitation notes.")]]),
    );
    const first = await scannedFile(root.session.id, "Loose/notes.txt");
    await completeNativeRead({
      bridgeDeviceId: root.device.bridgeDeviceId,
      bridgeRootId: root.root.id,
      relativePath: first.relativePath,
      scannedFileId: first.id,
    });
    const failed = await scannedFile(root.session.id, first.relativePath);
    assert.equal(failed.observationOrigin, "BASIC");
    assert.equal(failed.observationFingerprint, null);
    assert.equal(failed.aiRequestCount, 1);
    assert.equal(failed.aiHttpAttempts, requestCount());
    assert.ok(failed.aiHttpAttempts > 1);
    const failedProgress = await getBridgeScanSessionProgress(root.session.id);
    assert.equal(failedProgress?.progress.aiUsage?.failedObservations, 1);
    assert.equal(failedProgress?.progress.aiUsage?.unreportedTokenRequests, 1);

    const second = await repeatCloudScan(root);
    assert.equal((second.result as Record<string, unknown>)?.queuedReads, 1);
    const retry = await scannedFile(second.session.id, first.relativePath);
    await completeNativeRead({
      bridgeDeviceId: root.device.bridgeDeviceId,
      bridgeRootId: root.root.id,
      relativePath: retry.relativePath,
      scannedFileId: retry.id,
    });
    assert.equal((await scannedFile(second.session.id, first.relativePath)).observationOrigin, "NEW_AI");
  }, 0, 3);
});

test("a file changed after scanning cannot be observed under its stale checksum", async () => {
  await withMockObserver(async (requestCount) => {
    const root = await createCloudBackedBridgeRoot(
      "SCAN_ROOT_CHANGED_AFTER_SCAN",
      new Map([["Loose/notes.txt", Buffer.from("Original workshop notes.")]]),
    );
    const file = await scannedFile(root.session.id, "Loose/notes.txt");
    await writeFile(path.join(root.rootPath, "Loose", "notes.txt"), "Different workshop notes.");
    await completeNativeRead({
      bridgeDeviceId: root.device.bridgeDeviceId,
      bridgeRootId: root.root.id,
      relativePath: file.relativePath,
      scannedFileId: file.id,
    });
    const changed = await scannedFile(root.session.id, file.relativePath);
    assert.equal(changed.processingStage, "FAILED");
    assert.equal(changed.processingErrorCategory, "FILE_CHANGED_SINCE_SCAN");
    assert.equal(changed.observationFingerprint, null);
    assert.equal(requestCount(), 0);
    assert.equal((await getBridgeScanSessionProgress(root.session.id))?.progress.remainingFiles, 0);
  });
});

test("an image changed after scanning is isolated before a stale observation can be accepted", async () => {
  const relativePath = "Images/changed.png";
  const original = pngMetadataFixture();
  const root = await createCloudBackedBridgeRoot("SCAN_ROOT_CHANGED_IMAGE", new Map([[relativePath, original]]));
  const file = await scannedFile(root.session.id, relativePath);
  const changedBytes = Buffer.from(original);
  changedBytes.writeUInt32BE(800, 16);
  await writeFile(path.join(root.rootPath, "Images", "changed.png"), changedBytes);
  const result = await completeNativeRead({ bridgeDeviceId: root.device.bridgeDeviceId,
    bridgeRootId: root.root.id, relativePath, scannedFileId: file.id });
  assert.equal(result.sourceChecksum, createHash("sha256").update(changedBytes).digest("hex"));
  assert.notEqual(result.sourceChecksum, file.checksum);
  assert.equal(JSON.stringify(result).includes(changedBytes.toString("base64")), false);
  assert.match(result.extractedText, /technical metadata only/);
  const rejected = await scannedFile(root.session.id, relativePath);
  assert.equal(rejected.processingStage, "FAILED");
  assert.equal(rejected.processingErrorCategory, "FILE_CHANGED_SINCE_SCAN");
  assert.equal(rejected.libraryDocumentId, null);
  assert.equal(rejected.observationFingerprint, null);
  assert.equal(rejected.organizationSuggestions.length, 0);
  assert.equal(await prisma.bridgeCommand.count({ where: { commandType: { in: ["EXECUTE_PLAN", "EXECUTE_UNDO"] } } }), 0);
});

test("unchanged image reads return a verified checksum and keep metadata-only semantics", async () => {
  const bytes = pngMetadataFixture();
  const relativePath = "Images/unchanged.png";
  const root = await createCloudBackedBridgeRoot("SCAN_ROOT_UNCHANGED_IMAGE", new Map([[relativePath, bytes]]));
  const file = await scannedFile(root.session.id, relativePath);
  const result = await completeNativeRead({ bridgeDeviceId: root.device.bridgeDeviceId,
    bridgeRootId: root.root.id, relativePath, scannedFileId: file.id });
  assert.equal(result.sourceChecksum, file.checksum);
  assert.equal(result.sourceChecksum, createHash("sha256").update(bytes).digest("hex"));
  assert.match(result.extractedText, /OCR text: unavailable/);
  assert.match(result.extractedText, /Visual analysis: unavailable/);
  const processed = await scannedFile(root.session.id, relativePath);
  assert.ok(processed.libraryDocumentId);
  assert.equal(await prisma.observationSession.count({ where: { libraryDocumentId: processed.libraryDocumentId } }), 1);
});

for (const medium of ["audio", "video"] as const) {
  const relativePath = medium === "audio" ? "Audio/verified.mp3" : "Video/verified.mp4";
  const bytes = medium === "audio" ? mp3FrameBuffer(1) : mp4VideoBuffer({ hasAudioTrack: true });

  test(`${medium} changed after scanning cannot seed a stale observation`, async () => {
    const root = await createCloudBackedBridgeRoot(`SCAN_ROOT_CHANGED_${medium}`, new Map([[relativePath, bytes]]));
    const file = await scannedFile(root.session.id, relativePath);
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    await writeFile(path.join(root.rootPath, ...relativePath.split("/")), changed);
    const result = await completeNativeRead({ bridgeDeviceId: root.device.bridgeDeviceId,
      bridgeRootId: root.root.id, relativePath, scannedFileId: file.id });
    assert.equal(result.sourceChecksum, createHash("sha256").update(changed).digest("hex"));
    assert.notEqual(result.sourceChecksum, file.checksum);
    assert.equal(JSON.stringify(result).includes(changed.toString("base64")), false);
    const rejected = await scannedFile(root.session.id, relativePath);
    assert.equal(rejected.processingStage, "FAILED");
    assert.equal(rejected.processingErrorCategory, "FILE_CHANGED_SINCE_SCAN");
    assert.equal(rejected.libraryDocumentId, null);
    assert.equal(rejected.observationFingerprint, null);
    assert.equal(rejected.organizationSuggestions.length, 0);
    assert.deepEqual(await readFile(path.join(root.rootPath, ...relativePath.split("/"))), changed);
    assert.equal(await prisma.bridgeCommand.count({ where: { commandType: { in: ["EXECUTE_PLAN", "EXECUTE_UNDO"] } } }), 0);
  });

  test(`unchanged ${medium} returns a verified checksum and processes metadata only`, async () => {
    const root = await createCloudBackedBridgeRoot(`SCAN_ROOT_UNCHANGED_${medium}`, new Map([[relativePath, bytes]]));
    const file = await scannedFile(root.session.id, relativePath);
    const result = await completeNativeRead({ bridgeDeviceId: root.device.bridgeDeviceId,
      bridgeRootId: root.root.id, relativePath, scannedFileId: file.id });
    assert.equal(result.sourceChecksum, file.checksum);
    assert.equal(result.sourceChecksum, createHash("sha256").update(bytes).digest("hex"));
    assert.match(result.extractedText, /Transcript: unavailable\. No transcript was invented/);
    const processed = await scannedFile(root.session.id, relativePath);
    assert.ok(processed.libraryDocumentId);
    assert.equal(await prisma.observationSession.count({ where: { libraryDocumentId: processed.libraryDocumentId } }), 1);
    assert.deepEqual(await readFile(path.join(root.rootPath, ...relativePath.split("/"))), bytes);
    assert.equal(await prisma.bridgeCommand.count({ where: { commandType: { in: ["EXECUTE_PLAN", "EXECUTE_UNDO"] } } }), 0);
  });
}

test("legacy checksum-less temporary reads are rejected before observation or reuse", async () => {
  await withMockObserver(async (requestCount) => {
    const root = await createCloudBackedBridgeRoot(
      "SCAN_ROOT_LEGACY_READ",
      new Map([["Loose/notes.txt", Buffer.from("Workshop facilitation notes.")]]),
    );
    const file = await scannedFile(root.session.id, "Loose/notes.txt");
    const command = await readCommandFor(file.id);
    assert.ok(command);
    await acknowledgeBridgeCloudCommand(root.device.bridgeDeviceId, command.commandId);
    const legacyResult = bridgeJson(await readBridgeRootFile(root.root.id, file.relativePath)) as Record<string, unknown>;
    delete legacyResult.sourceChecksum;
    const prepared = await prepareBridgeCommandReportForPersistence(root.device.bridgeDeviceId, {
      commandId: command.commandId,
      result: legacyResult as BridgeJson,
      safeErrorCategory: null,
      status: "COMPLETED",
    });
    assert.equal(prepared.status, "FAILED");
    assert.equal(prepared.safeErrorCategory, "SOURCE_CHECKSUM_MISSING");
    await completeBridgeCloudCommand(root.device.bridgeDeviceId, prepared);
    const observed = await scannedFile(root.session.id, file.relativePath);
    assert.equal(observed.processingStage, "FAILED");
    assert.equal(observed.processingErrorCategory, "SOURCE_CHECKSUM_MISSING");
    assert.equal(observed.libraryDocumentId, null);
    assert.equal(observed.previewText, null);
    assert.equal(observed.organizationSuggestions.length, 0);
    assert.equal(observed.observationFingerprint, null);
    assert.equal(requestCount(), 0);
    const nextScan = await repeatCloudScan(root);
    assert.equal((nextScan.result as Record<string, unknown>)?.queuedReads, 1);
  });
});

for (const medium of ["document", "image", "audio", "video"] as const) {
  for (const checksumCase of ["missing", "malformed", "overlong", "non-string"] as const) {
    test(`${medium} completed reads reject ${checksumCase} source checksums before accepting content`, async () => {
      const relativePath = { document: "notes.txt", image: "image.png", audio: "audio.mp3", video: "video.mp4" }[medium];
      const bytes = { document: Buffer.from("Synthetic workshop notes."), image: pngMetadataFixture(),
        audio: mp3FrameBuffer(1), video: mp4VideoBuffer({ hasAudioTrack: true }) }[medium];
      const root = await createCloudBackedBridgeRoot(`Integrity_${medium}_${checksumCase}`, new Map([[relativePath, bytes]]));
      const file = await scannedFile(root.session.id, relativePath);
      const command = await readCommandFor(file.id);
      assert.ok(command);
      await acknowledgeBridgeCloudCommand(root.device.bridgeDeviceId, command.commandId);
      const result = bridgeJson(await readBridgeRootFile(root.root.id, relativePath)) as Record<string, unknown>;
      if (checksumCase === "missing") delete result.sourceChecksum;
      else result.sourceChecksum = checksumCase === "malformed" ? "not-a-sha256" :
        checksumCase === "non-string" ? 123 : `${file.checksum}0`;
      const prepared = await prepareBridgeCommandReportForPersistence(root.device.bridgeDeviceId, {
        commandId: command.commandId, result: result as BridgeJson, safeErrorCategory: null, status: "COMPLETED",
      });
      const category = checksumCase === "missing" ? "SOURCE_CHECKSUM_MISSING" : "SOURCE_CHECKSUM_INVALID";
      assert.equal(prepared.status, "FAILED");
      assert.equal(prepared.safeErrorCategory, category);
      await completeBridgeCloudCommand(root.device.bridgeDeviceId, prepared);
      const rejected = await scannedFile(root.session.id, relativePath);
      assert.equal(rejected.processingStage, "FAILED");
      assert.equal(rejected.processingErrorCategory, category);
      assert.equal(rejected.libraryDocumentId, null);
      assert.equal(rejected.previewText, null);
      assert.equal(rejected.organizationSuggestions.length, 0);
      assert.equal(await prisma.observationSession.count(), 0);
      assert.equal((await prisma.bridgeCommand.findUniqueOrThrow({ where: { id: command.id } })).status, "FAILED");
      assert.deepEqual(await readFile(path.join(root.rootPath, relativePath)), bytes);
      assert.equal(await prisma.bridgeCommand.count({ where: { commandType: { in: ["EXECUTE_PLAN", "EXECUTE_UNDO"] } } }), 0);
    });
  }
}

test("a completed read cannot establish integrity against an unverified scan checksum", async () => {
  const root = await createCloudBackedBridgeRoot("Integrity_unverified_scan", new Map([["notes.txt", Buffer.from("Synthetic notes.")]]));
  const file = await scannedFile(root.session.id, "notes.txt");
  await prisma.scannedFile.update({ where: { id: file.id }, data: { checksum: null } });
  await completeNativeRead({ bridgeDeviceId: root.device.bridgeDeviceId, bridgeRootId: root.root.id,
    relativePath: file.relativePath, scannedFileId: file.id });
  const rejected = await scannedFile(root.session.id, file.relativePath);
  assert.equal(rejected.processingErrorCategory, "SCAN_CHECKSUM_UNVERIFIED");
  assert.equal(rejected.libraryDocumentId, null);
  assert.equal(await prisma.observationSession.count(), 0);
  const errors = await import("../../src/lib/bridge/remote-read-commands");
  assert.match(errors.remoteReadFailureMessageFor("SOURCE_CHECKSUM_MISSING", file.relativePath), /Update NSN Bridge/);
  assert.match(errors.remoteReadFailureMessageFor("SOURCE_CHECKSUM_INVALID", file.relativePath), /verify/);
  assert.match(errors.remoteReadFailureMessageFor(rejected.processingErrorCategory, file.relativePath), /Scan the folder again/);
});

test("an incomplete provider response is reviewable but never reused as complete", async () => {
  await withMockObserver(async (requestCount) => {
    const root = await createCloudBackedBridgeRoot(
      "SCAN_ROOT_INCOMPLETE_RESPONSE",
      new Map([["Loose/notes.txt", Buffer.from("Workshop facilitation notes.")]]),
    );
    const first = await scannedFile(root.session.id, "Loose/notes.txt");
    await completeNativeRead({
      bridgeDeviceId: root.device.bridgeDeviceId,
      bridgeRootId: root.root.id,
      relativePath: first.relativePath,
      scannedFileId: first.id,
    });
    const incomplete = await scannedFile(root.session.id, first.relativePath);
    assert.equal(incomplete.observationOrigin, "NEW_AI");
    assert.equal(incomplete.observationFingerprint, null);
    const nextScan = await repeatCloudScan(root);
    assert.equal((nextScan.result as Record<string, unknown>)?.queuedReads, 1);
    assert.equal(requestCount(), 1);
  }, 0, 0, 1);
});
