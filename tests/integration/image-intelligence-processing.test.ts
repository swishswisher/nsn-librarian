import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { createBridgeServer } from "../../bridge-app/src/api/server";
import { resolveBridgeRootFile } from "../../bridge-app/src/filesystem/resolver";
import { scanBridgeRoot } from "../../bridge-app/src/filesystem/scanner";
import {
  createFolderSelection,
  registerRootFromSelection,
} from "../../bridge-app/src/main/registry";
import { defaultBridgePermissions } from "../../bridge-app/src/permissions/defaults";
import type { LocalBridgeRootSummary } from "../../src/lib/bridge/local-bridge-client";

let prisma: PrismaClient;
let bridgeServer: Server;
let tempRoot: string;
let testDatabaseUrl: string;
let previousBridgeDataDir: string | undefined;
let previousBridgeUrl: string | undefined;
let previousDatabaseUrl: string | undefined;
let previousDeveloperFallback: string | undefined;
let previousOpenAIKey: string | undefined;
let previousClaudeKey: string | undefined;

let connectBridgeLibrary: typeof import("../../src/lib/bridge/connected-libraries").connectBridgeLibrary;
let createBridgeScanSessionFromScan: typeof import("../../src/lib/bridge/scan-sessions").createBridgeScanSessionFromScan;
let fileMatchesScannedFileFilter: typeof import("../../src/lib/bridge/scanned-file-filters").fileMatchesScannedFileFilter;
let generateOrganizationSuggestionsForScannedFileWithText: typeof import("../../src/lib/bridge/organization-suggestions").generateOrganizationSuggestionsForScannedFileWithText;
let getScannedImagePreviewSource: typeof import("../../src/lib/bridge/image-reader").getScannedImagePreviewSource;
let processBridgeScanSession: typeof import("../../src/lib/bridge/processing-pipeline").processBridgeScanSession;
let readScannedFile: typeof import("../../src/lib/bridge/reader").readScannedFile;
let retryBridgeScanSessionProcessing: typeof import("../../src/lib/bridge/processing-pipeline").retryBridgeScanSessionProcessing;
let scannedFileSummary: typeof import("../../src/lib/bridge/scan-sessions").scannedFileSummary;
let updateScannedImageReviewState: typeof import("../../src/lib/bridge/image-reader").updateScannedImageReviewState;

const testSchemaName = `image_intelligence_test_${process.pid}_${Date.now()}`;

function databaseUrlForSchema(schemaName: string) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for image intelligence tests.");
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

function jpegBuffer(width: number, height: number) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03,
    0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function pngBuffer(width: number, height: number) {
  const buffer = Buffer.alloc(33);

  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);

  return buffer;
}

function writeUInt24Le(buffer: Buffer, value: number, offset: number) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
}

function webpBuffer(width: number, height: number) {
  const buffer = Buffer.alloc(30);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8);
  buffer.write("VP8X", 12);
  buffer.writeUInt32LE(10, 16);
  writeUInt24Le(buffer, width - 1, 24);
  writeUInt24Le(buffer, height - 1, 27);

  return buffer;
}

async function resetTestData() {
  await prisma.scanSession.deleteMany();
  await prisma.libraryBatch.deleteMany();
  await prisma.connectedLibrary.deleteMany();
}

async function createBridgeBackedImageLibrary() {
  const libraryRoot = path.join(tempRoot, `library-${Date.now()}`);
  const files = new Map<string, Buffer>([
    [
      "Images/Website Candidates/becoming-workshop-hero.jpg",
      jpegBuffer(1600, 900),
    ],
    [
      "Images/Duplicates/becoming-workshop-hero-copy.jpg",
      jpegBuffer(1600, 900),
    ],
    [
      "Images/Duplicates/becoming-workshop-hero-small.jpg",
      jpegBuffer(640, 360),
    ],
    ["Images/Text Images/attachment-slide.png", pngBuffer(1280, 720)],
    ["Images/Private/private-family-placeholder.png", pngBuffer(800, 600)],
    ["Images/Web/becoming-card.webp", webpBuffer(1200, 630)],
    ["Images/Damaged/broken-image.jpg", Buffer.from("not a real jpeg")],
    ["Unsupported/vector.bmp", Buffer.from("unsupported")],
  ]);

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
  const connected = await connectBridgeLibrary({
    root: root as LocalBridgeRootSummary,
  });
  const scan = await scanBridgeRoot(root.id);
  const session = await createBridgeScanSessionFromScan(scan, {
    allowReusableSession: false,
    connectedLibraryId: connected.library.id,
  });

  return {
    rootId: root.id,
    sessionId: session.id,
  };
}

async function storedFile(sessionId: string, relativePath: string) {
  return prisma.scannedFile.findFirstOrThrow({
    include: {
      imageMetadata: true,
      libraryDocument: {
        include: {
          observationSessions: true,
        },
      },
      organizationSuggestions: true,
    },
    where: {
      relativePath,
      sessionId,
    },
  });
}

before(async () => {
  previousBridgeDataDir = process.env.NSN_BRIDGE_DATA_DIR;
  previousBridgeUrl = process.env.NSN_LOCAL_BRIDGE_URL;
  previousDatabaseUrl = process.env.DATABASE_URL;
  previousDeveloperFallback = process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK;
  previousOpenAIKey = process.env.OPENAI_API_KEY;
  previousClaudeKey = process.env.CLAUDE_API_KEY;

  testDatabaseUrl = databaseUrlForSchema(testSchemaName);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "nsn-image-intel-test-"));
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.NSN_BRIDGE_DATA_DIR = path.join(tempRoot, ".bridge-data");
  process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK = "false";
  process.env.OPENAI_API_KEY = "";
  process.env.CLAUDE_API_KEY = "";

  runPrismaDbPush();

  bridgeServer = createBridgeServer();
  const address = await listen(bridgeServer);
  process.env.NSN_LOCAL_BRIDGE_URL = `http://127.0.0.1:${address.port}`;

  const prismaModule = await import("../../src/lib/db/prisma");
  const connectedLibraries = await import("../../src/lib/bridge/connected-libraries");
  const scanSessions = await import("../../src/lib/bridge/scan-sessions");
  const filters = await import("../../src/lib/bridge/scanned-file-filters");
  const imageReader = await import("../../src/lib/bridge/image-reader");
  const organizationSuggestions = await import(
    "../../src/lib/bridge/organization-suggestions"
  );
  const processingPipeline = await import(
    "../../src/lib/bridge/processing-pipeline"
  );
  const reader = await import("../../src/lib/bridge/reader");

  prisma = prismaModule.getPrismaClient();
  connectBridgeLibrary = connectedLibraries.connectBridgeLibrary;
  createBridgeScanSessionFromScan = scanSessions.createBridgeScanSessionFromScan;
  scannedFileSummary = scanSessions.scannedFileSummary;
  fileMatchesScannedFileFilter = filters.fileMatchesScannedFileFilter;
  getScannedImagePreviewSource = imageReader.getScannedImagePreviewSource;
  updateScannedImageReviewState = imageReader.updateScannedImageReviewState;
  generateOrganizationSuggestionsForScannedFileWithText =
    organizationSuggestions.generateOrganizationSuggestionsForScannedFileWithText;
  processBridgeScanSession = processingPipeline.processBridgeScanSession;
  retryBridgeScanSessionProcessing =
    processingPipeline.retryBridgeScanSessionProcessing;
  readScannedFile = reader.readScannedFile;
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

  if (previousDeveloperFallback === undefined) {
    delete process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK;
  } else {
    process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK =
      previousDeveloperFallback;
  }

  if (previousOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousOpenAIKey;
  }

  if (previousClaudeKey === undefined) {
    delete process.env.CLAUDE_API_KEY;
  } else {
    process.env.CLAUDE_API_KEY = previousClaudeKey;
  }
});

test("processes scanned images through image intelligence without treating damaged images as unsupported", async () => {
  const { rootId, sessionId } = await createBridgeBackedImageLibrary();

  await processBridgeScanSession(sessionId, { recordNotebook: false });

  const slashResolved = await resolveBridgeRootFile(
    rootId,
    "Images\\Website Candidates\\becoming-workshop-hero.jpg",
  );

  assert.equal(
    slashResolved.relativePath,
    "Images/Website Candidates/becoming-workshop-hero.jpg",
  );

  const hero = await storedFile(
    sessionId,
    "Images/Website Candidates/becoming-workshop-hero.jpg",
  );
  const copy = await storedFile(
    sessionId,
    "Images/Duplicates/becoming-workshop-hero-copy.jpg",
  );
  const small = await storedFile(
    sessionId,
    "Images/Duplicates/becoming-workshop-hero-small.jpg",
  );
  const privateImage = await storedFile(
    sessionId,
    "Images/Private/private-family-placeholder.png",
  );
  const textImage = await storedFile(
    sessionId,
    "Images/Text Images/attachment-slide.png",
  );
  const webp = await storedFile(sessionId, "Images/Web/becoming-card.webp");
  const damaged = await storedFile(sessionId, "Images/Damaged/broken-image.jpg");
  const unsupported = await storedFile(sessionId, "Unsupported/vector.bmp");

  for (const file of [hero, copy, small, privateImage, textImage, webp]) {
    assert.match(file.fileType, /^IMAGE_/);
    assert.equal(file.readStatus, "SUPPORTED");
    assert.equal(file.readingStatus, "READ");
    assert.equal(file.extractionStatus, "COMPLETED");
    assert.equal(file.processingStage, "RECOMMENDATIONS_READY");
    assert.ok(file.imageMetadata);
    assert.equal(file.imageMetadata.previewStatus, "COMPLETED");
    assert.equal(file.imageMetadata.visualAnalysisStatus, "COMPLETED");
    assert.ok(file.libraryDocument?.observationSessions.length);
    assert.ok(file.organizationSuggestions.length);
  }

  assert.equal(hero.imageMetadata?.width, 1600);
  assert.equal(hero.imageMetadata?.height, 900);
  assert.equal(textImage.imageMetadata?.ocrStatus, "UNAVAILABLE");
  assert.equal(textImage.imageMetadata?.ocrErrorCategory, "IMAGE_OCR_FAILED");
  assert.equal(copy.imageMetadata?.duplicateKind, "EXACT_DUPLICATE");
  assert.equal(small.imageMetadata?.duplicateKind, "LIKELY_RESIZED_COPY");
  assert.equal(webp.fileType, "IMAGE_WEBP");

  assert.equal(damaged.fileType, "IMAGE_JPG");
  assert.equal(damaged.readStatus, "SUPPORTED");
  assert.equal(damaged.readingStatus, "FAILED");
  assert.equal(damaged.extractionStatus, "FAILED");
  assert.equal(damaged.processingStage, "FAILED");
  assert.equal(damaged.extractionErrorCategory, "IMAGE_DECODE_FAILED");

  assert.equal(unsupported.fileType, "UNSUPPORTED");
  assert.equal(unsupported.readStatus, "UNSUPPORTED");
  assert.equal(unsupported.processingStage, "UNSUPPORTED");

  const privateReview = await updateScannedImageReviewState({
    labels: ["PRIVATE"],
    privacyState: "PRIVATE",
    scannedFileId: privateImage.id,
  });
  const privateSummary = scannedFileSummary({
    ...(await storedFile(
      sessionId,
      "Images/Private/private-family-placeholder.png",
    )),
  });
  const websiteSummary = scannedFileSummary(hero);
  const copySummary = scannedFileSummary(copy);

  assert.equal(privateReview.imageMetadata?.privacyState, "PRIVATE");
  assert.equal(fileMatchesScannedFileFilter(privateSummary, "IMAGES"), true);
  assert.equal(fileMatchesScannedFileFilter(privateSummary, "PRIVATE"), true);
  assert.equal(
    fileMatchesScannedFileFilter(privateSummary, "WEBSITE_CANDIDATES"),
    false,
  );
  assert.equal(
    fileMatchesScannedFileFilter(websiteSummary, "WEBSITE_CANDIDATES"),
    true,
  );
  assert.equal(
    fileMatchesScannedFileFilter(copySummary, "POSSIBLE_DUPLICATES"),
    true,
  );

  const previewSource = await getScannedImagePreviewSource(hero.id);

  assert.equal(previewSource.contentType, "image/jpeg");
  assert.equal(
    previewSource.relativePath,
    "Images/Website Candidates/becoming-workshop-hero.jpg",
  );

  const suggestionCountBefore = await prisma.organizationSuggestion.count({
    where: {
      scannedFileId: hero.id,
    },
  });
  const reread = await readScannedFile(hero.id);
  const regenerated = await generateOrganizationSuggestionsForScannedFileWithText(
    hero.id,
    reread.preview.extractedText,
  );
  const suggestionCountAfter = await prisma.organizationSuggestion.count({
    where: {
      scannedFileId: hero.id,
    },
  });

  assert.equal(regenerated.createdCount, 0);
  assert.equal(suggestionCountAfter, suggestionCountBefore);

  await retryBridgeScanSessionProcessing(sessionId);

  const retrySuggestionCount = await prisma.organizationSuggestion.count({
    where: {
      scannedFileId: hero.id,
    },
  });

  assert.equal(retrySuggestionCount, suggestionCountBefore);
});
