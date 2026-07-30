import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { createBridgeServer } from "../../bridge-app/src/api/server";
import { scanBridgeRoot } from "../../bridge-app/src/filesystem/scanner";
import { createFolderSelection, registerRootFromSelection } from "../../bridge-app/src/main/registry";
import { defaultBridgePermissions } from "../../bridge-app/src/permissions/defaults";
import type { LocalBridgeRootSummary } from "../../src/lib/bridge/local-bridge-client";

let prisma: PrismaClient;
let bridgeServer: Server;
let tempRoot: string;
let testDatabaseUrl: string;
let previousBridgeDataDir: string | undefined;
let previousBridgeUrl: string | undefined;
let previousDatabaseUrl: string | undefined;
let previousOpenAIKey: string | undefined;

let connectBridgeLibrary: typeof import("../../src/lib/bridge/connected-libraries").connectBridgeLibrary;
let createBridgeScanSessionFromScan: typeof import("../../src/lib/bridge/scan-sessions").createBridgeScanSessionFromScan;
let readScannedAudioFile: typeof import("../../src/lib/bridge/audio-reader").readScannedAudioFile;
let resolveConnectedLibraryFile: typeof import("../../src/lib/bridge/connected-library-file-resolver").resolveConnectedLibraryFile;
let ConnectedLibraryFileResolutionError: typeof import("../../src/lib/bridge/connected-library-file-resolver").ConnectedLibraryFileResolutionError;

const testSchemaName = `connected_library_file_resolver_${process.pid}_${Date.now()}`;

function databaseUrlForSchema(schemaName: string) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Connected Library file resolver tests.");
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
    },
    stdio: "pipe",
  });
}

function listen(server: Server) {
  return new Promise<{ port: number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;

      assert.ok(address);
      resolve({ port: address.port });
    });
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function wavSilenceBuffer() {
  const buffer = Buffer.alloc(44);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(0, 40);

  return buffer;
}

async function resetTestData() {
  await prisma.scanSession.deleteMany();
  await prisma.libraryBatch.deleteMany();
  await prisma.connectedLibrary.deleteMany();
}

async function createBridgeBackedAudioFile() {
  const libraryRoot = path.join(tempRoot, `library-${Date.now()}`);
  const audioFolder = path.join(libraryRoot, "Audio", "Meetings");
  const audioPath = path.join(audioFolder, "attachment-planning-meeting.wav");

  await mkdir(audioFolder, { recursive: true });
  await writeFile(audioPath, wavSilenceBuffer());

  const selection = await createFolderSelection(libraryRoot);
  const root = await registerRootFromSelection({
    permissions: defaultBridgePermissions,
    selectionToken: selection.selectionToken,
  });
  const connected = await connectBridgeLibrary({
    root: root as LocalBridgeRootSummary,
  });
  const scan = await scanBridgeRoot(root.id);
  const session = await createBridgeScanSessionFromScan(scan, {
    allowReusableSession: false,
    connectedLibraryId: connected.library.id,
  });
  const scannedFile = await prisma.scannedFile.findFirstOrThrow({
    where: {
      relativePath: "Audio/Meetings/attachment-planning-meeting.wav",
      sessionId: session.id,
    },
  });

  return {
    audioPath,
    connectedLibraryId: connected.library.id,
    rootId: root.id,
    scannedFileId: scannedFile.id,
  };
}

before(async () => {
  previousBridgeDataDir = process.env.NSN_BRIDGE_DATA_DIR;
  previousBridgeUrl = process.env.NSN_LOCAL_BRIDGE_URL;
  previousDatabaseUrl = process.env.DATABASE_URL;
  previousOpenAIKey = process.env.OPENAI_API_KEY;

  testDatabaseUrl = databaseUrlForSchema(testSchemaName);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "nsn-file-resolver-test-"));
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.NSN_BRIDGE_DATA_DIR = path.join(tempRoot, ".bridge-data");
  process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK = "false";

  runPrismaDbPush();

  bridgeServer = createBridgeServer();
  const address = await listen(bridgeServer);
  process.env.NSN_LOCAL_BRIDGE_URL = `http://127.0.0.1:${address.port}`;

  const prismaModule = await import("../../src/lib/db/prisma");
  const connectedLibraries = await import("../../src/lib/bridge/connected-libraries");
  const scanSessions = await import("../../src/lib/bridge/scan-sessions");
  const audioReader = await import("../../src/lib/bridge/audio-reader");
  const resolver = await import("../../src/lib/bridge/connected-library-file-resolver");

  prisma = prismaModule.getPrismaClient();
  connectBridgeLibrary = connectedLibraries.connectBridgeLibrary;
  createBridgeScanSessionFromScan = scanSessions.createBridgeScanSessionFromScan;
  readScannedAudioFile = audioReader.readScannedAudioFile;
  resolveConnectedLibraryFile = resolver.resolveConnectedLibraryFile;
  ConnectedLibraryFileResolutionError = resolver.ConnectedLibraryFileResolutionError;
});

beforeEach(async () => {
  await resetTestData();
});

after(async () => {
  await prisma?.$disconnect();
  await closeServer(bridgeServer);
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

  if (previousBridgeUrl === undefined) {
    delete process.env.NSN_LOCAL_BRIDGE_URL;
  } else {
    process.env.NSN_LOCAL_BRIDGE_URL = previousBridgeUrl;
  }

  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }

  if (previousOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousOpenAIKey;
  }
});

test("resolves a Bridge-backed nested audio file through its ConnectedLibrary", async () => {
  const { audioPath, connectedLibraryId, scannedFileId } =
    await createBridgeBackedAudioFile();
  const resolvedFile = await resolveConnectedLibraryFile({
    connectedLibraryId,
    itemLabel: "audio file",
    scannedFileId,
  });

  assert.equal(resolvedFile.relativePath, "Audio/Meetings/attachment-planning-meeting.wav");
  assert.equal(path.normalize(resolvedFile.filePath), path.normalize(audioPath));
});

test("returns file-specific path safety categories for invalid audio access", async () => {
  const { connectedLibraryId, scannedFileId } = await createBridgeBackedAudioFile();

  await assert.rejects(
    () =>
      resolveConnectedLibraryFile({
        connectedLibraryId,
        itemLabel: "audio file",
        relativePath: "../outside.wav",
        scannedFileId,
      }),
    (error) =>
      error instanceof ConnectedLibraryFileResolutionError &&
      error.category === "PATH_OUTSIDE_CONNECTED_LIBRARY",
  );

  await prisma.connectedLibrary.update({
    data: {
      readPermission: false,
    },
    where: {
      id: connectedLibraryId,
    },
  });

  await assert.rejects(
    () =>
      resolveConnectedLibraryFile({
        connectedLibraryId,
        itemLabel: "audio file",
        scannedFileId,
      }),
    (error) =>
      error instanceof ConnectedLibraryFileResolutionError &&
      error.category === "READ_PERMISSION_REQUIRED",
  );
});

test("keeps audio readable when transcription is unavailable after metadata", async () => {
  const { scannedFileId } = await createBridgeBackedAudioFile();

  process.env.OPENAI_API_KEY = "";

  const result = await readScannedAudioFile(scannedFileId);
  const metadata = await prisma.audioRecordingMetadata.findUniqueOrThrow({
    where: {
      scannedFileId,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.file.readingStatus, "READ");
  assert.equal(result.file.extractionStatus, "COMPLETED");
  assert.equal(metadata.transcriptionStatus, "UNAVAILABLE");
  assert.equal(metadata.transcriptionErrorCategory, "AUDIO_TRANSCRIPTION_UNAVAILABLE");
  assert.match(result.preview.extractedText, /Audio review material/);
});

test("reports missing sources and stale Bridge roots without calling the file a folder", async () => {
  const { audioPath, connectedLibraryId, rootId, scannedFileId } =
    await createBridgeBackedAudioFile();

  await rm(audioPath, { force: true });

  await assert.rejects(
    () =>
      resolveConnectedLibraryFile({
        connectedLibraryId,
        itemLabel: "audio file",
        scannedFileId,
      }),
    (error) =>
      error instanceof ConnectedLibraryFileResolutionError &&
      error.category === "SOURCE_FILE_MISSING" &&
      error.message ===
        "This audio file is no longer available at its scanned location.",
  );

  await prisma.connectedLibrary.update({
    data: {
      bridgeRootId: "root_stale_for_audio",
      folderFingerprint: "root_stale_for_audio",
      localPath: "bridge://root_stale_for_audio",
    },
    where: {
      id: connectedLibraryId,
    },
  });
  await prisma.scannedFile.update({
    data: {
      localPath: `bridge://${rootId}/Audio/Meetings/attachment-planning-meeting.wav`,
    },
    where: {
      id: scannedFileId,
    },
  });

  await assert.rejects(
    () =>
      resolveConnectedLibraryFile({
        connectedLibraryId,
        itemLabel: "audio file",
        scannedFileId,
      }),
    (error) =>
      error instanceof ConnectedLibraryFileResolutionError &&
      error.category === "CONNECTED_LIBRARY_UNAVAILABLE",
  );
});
