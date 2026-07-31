import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@prisma/client";

import type { LocalBridgeRootSummary } from "../../src/lib/bridge/local-bridge-client";
import type { connectBridgeLibrary as connectBridgeLibraryType } from "../../src/lib/bridge/connected-libraries";

type ConnectBridgeLibrary = typeof connectBridgeLibraryType;

let prisma: PrismaClient;
let connectBridgeLibrary: ConnectBridgeLibrary;
let disconnectConnectedLibrary: typeof import("../../src/lib/bridge/connected-libraries").disconnectConnectedLibrary;
let getConnectedLibraries: typeof import("../../src/lib/bridge/connected-libraries").getConnectedLibraries;
let hideConnectedLibrary: typeof import("../../src/lib/bridge/connected-libraries").hideConnectedLibrary;
let reconcileDuplicateConnectedLibraries: typeof import("../../src/lib/bridge/connected-libraries").reconcileDuplicateConnectedLibraries;
let stableFolderFingerprintForLocalPath: typeof import("../../src/lib/bridge/connected-libraries").stableFolderFingerprintForLocalPath;
let testDatabaseUrl: string;

const testSchemaName = `connected_libraries_test_${process.pid}_${Date.now()}`;

function databaseUrlForSchema(schemaName: string) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Connected Library tests.");
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

async function resetTestData() {
  await prisma.monitoringEvent.deleteMany();
  await prisma.monitoringBatch.deleteMany();
  await prisma.scanSession.deleteMany();
  await prisma.connectedLibrary.deleteMany();
}

function rootSummary(
  id: string,
  overrides: Partial<LocalBridgeRootSummary> = {},
): LocalBridgeRootSummary {
  return {
    connectedAt: "2026-07-22T00:00:00.000Z",
    createFolderPermission: false,
    displayName: "NSN Full System Test Library",
    id,
    lastScanAt: null,
    lastWatchingAt: null,
    moveFilePermission: false,
    organizationPlanPermission: true,
    platform: "WINDOWS",
    readPermission: true,
    recommendationPermission: true,
    renameFilePermission: false,
    safeLocation: "D:\\NSN-Full-System-Test-Library",
    status: "CONNECTED",
    updatedAt: "2026-07-22T00:00:00.000Z",
    watcherState: "STOPPED",
    watchPermission: false,
    ...overrides,
  };
}

async function connectedRowsForFingerprint(fingerprint: string) {
  return prisma.connectedLibrary.findMany({
    orderBy: { connectedAt: "asc" },
    where: {
      OR: [
        { bridgeRootId: fingerprint },
        { folderFingerprint: fingerprint },
        { localPath: `bridge://${fingerprint}` },
      ],
    },
  });
}

before(async () => {
  testDatabaseUrl = databaseUrlForSchema(testSchemaName);
  process.env.DATABASE_URL = testDatabaseUrl;
  runPrismaDbPush();

  const prismaModule = await import("../../src/lib/db/prisma");
  const connectedLibraries = await import("../../src/lib/bridge/connected-libraries");

  prisma = prismaModule.getPrismaClient();
  connectBridgeLibrary = connectedLibraries.connectBridgeLibrary;
  disconnectConnectedLibrary = connectedLibraries.disconnectConnectedLibrary;
  getConnectedLibraries = connectedLibraries.getConnectedLibraries;
  hideConnectedLibrary = connectedLibraries.hideConnectedLibrary;
  reconcileDuplicateConnectedLibraries =
    connectedLibraries.reconcileDuplicateConnectedLibraries;
  stableFolderFingerprintForLocalPath =
    connectedLibraries.stableFolderFingerprintForLocalPath;
});

beforeEach(async () => {
  await resetTestData();
});

after(async () => {
  await prisma?.$disconnect();

  const cleanupPrisma = new PrismaClient();

  await cleanupPrisma.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`,
  );
  await cleanupPrisma.$disconnect();
});

test("same folder selected twice reuses one canonical ConnectedLibrary", async () => {
  const fingerprint = "root_duplicate_same_folder";
  const first = await connectBridgeLibrary({ root: rootSummary(fingerprint) });
  const second = await connectBridgeLibrary({ root: rootSummary(fingerprint) });
  const rows = await connectedRowsForFingerprint(fingerprint);

  assert.equal(second.library.id, first.library.id);
  assert.equal(second.action, "ALREADY_CONNECTED");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "CONNECTED");
});

test("native path and trailing slash variants produce one fingerprint", () => {
  const base = path.join(process.cwd(), "NSN-Full-System-Test-Library");
  const trailingVariant = `${base}${path.sep}`;

  assert.equal(
    stableFolderFingerprintForLocalPath(trailingVariant),
    stableFolderFingerprintForLocalPath(base),
  );

  if (process.platform === "win32") {
    const windowsBase = "D:\\NSN-Full-System-Test-Library";
    assert.equal(
      stableFolderFingerprintForLocalPath("D:/NSN-Full-System-Test-Library/"),
      stableFolderFingerprintForLocalPath(windowsBase),
    );
    assert.equal(
      stableFolderFingerprintForLocalPath("d:\\nsn-full-system-test-library"),
      stableFolderFingerprintForLocalPath(windowsBase),
    );
  }
});

test("disconnected folder reconnect reuses the canonical record and preserves scan history", async () => {
  const fingerprint = "root_reconnect_preserves_history";
  const first = await connectBridgeLibrary({ root: rootSummary(fingerprint) });

  await prisma.scanSession.create({
    data: {
      connectedFolderId: first.library.id,
      filesScanned: 1,
      status: "COMPLETED",
    },
  });
  await disconnectConnectedLibrary(first.library.id);

  const reconnected = await connectBridgeLibrary({
    root: rootSummary(fingerprint, {
      displayName: "Reconnected Library",
      watchPermission: true,
    }),
  });
  const scanSessions = await prisma.scanSession.findMany({
    where: { connectedFolderId: first.library.id },
  });

  assert.equal(reconnected.action, "RECONNECTED");
  assert.equal(reconnected.library.id, first.library.id);
  assert.equal(reconnected.library.status, "CONNECTED");
  assert.equal(reconnected.library.disconnectedAt, null);
  assert.equal(scanSessions.length, 1);
});

test("concurrent duplicate connection attempts leave one canonical record", async () => {
  const fingerprint = "root_concurrent_duplicate";
  const [first, second] = await Promise.all([
    connectBridgeLibrary({ root: rootSummary(fingerprint) }),
    connectBridgeLibrary({ root: rootSummary(fingerprint) }),
  ]);
  const rows = await connectedRowsForFingerprint(fingerprint);

  assert.equal(first.library.id, second.library.id);
  assert.equal(rows.length, 1);
});

test("duplicate reconciliation is idempotent and relinks history", async () => {
  const basePath = path.join(process.cwd(), "NSN-Full-System-Test-Library");
  const variantPath = `${basePath}${path.sep}`;
  const first = await prisma.connectedLibrary.create({
    data: {
      displayName: "Canonical raw path",
      localPath: basePath,
      platform:
        process.platform === "win32"
          ? "WINDOWS"
          : process.platform === "darwin"
            ? "MACOS"
            : "LINUX",
      status: "CONNECTED",
    },
  });
  const duplicate = await prisma.connectedLibrary.create({
    data: {
      displayName: "Duplicate raw path",
      isEnabled: false,
      localPath: variantPath,
      platform:
        process.platform === "win32"
          ? "WINDOWS"
          : process.platform === "darwin"
            ? "MACOS"
            : "LINUX",
      status: "DISCONNECTED",
    },
  });

  await prisma.scanSession.create({
    data: {
      connectedFolderId: duplicate.id,
      filesScanned: 2,
      status: "COMPLETED",
    },
  });

  const firstRun = await reconcileDuplicateConnectedLibraries();
  const secondRun = await reconcileDuplicateConnectedLibraries();
  const mergedDuplicate = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: duplicate.id },
  });
  const relinkedSession = await prisma.scanSession.findFirstOrThrow();

  assert.equal(firstRun, 1);
  assert.equal(secondRun, 0);
  assert.equal(mergedDuplicate.status, "MERGED");
  assert.equal(mergedDuplicate.canonicalConnectedLibraryId, first.id);
  assert.equal(relinkedSession.connectedFolderId, first.id);
});

test("disconnect preserves history and stops watching state", async () => {
  const fingerprint = "root_disconnect_preserves_history";
  const connected = await connectBridgeLibrary({
    root: rootSummary(fingerprint, {
      watchPermission: true,
      watcherState: "WATCHING",
    }),
  });

  await prisma.scanSession.create({
    data: {
      connectedFolderId: connected.library.id,
      filesScanned: 1,
      status: "COMPLETED",
    },
  });

  const disconnected = await disconnectConnectedLibrary(connected.library.id);
  const rows = await prisma.scanSession.findMany({
    where: { connectedFolderId: connected.library.id },
  });

  assert.equal(disconnected.status, "DISCONNECTED");
  assert.equal(disconnected.monitoringState, "STOPPED");
  assert.equal(disconnected.watchPermission, false);
  assert.ok(disconnected.disconnectedAt);
  assert.equal(rows.length, 1);
});

test("hidden historical connection does not appear in the normal connected library list", async () => {
  const fingerprint = "root_hidden_history";
  const connected = await connectBridgeLibrary({ root: rootSummary(fingerprint) });

  await disconnectConnectedLibrary(connected.library.id);
  await hideConnectedLibrary(connected.library.id);

  const libraries = await getConnectedLibraries();
  const stored = await prisma.connectedLibrary.findUniqueOrThrow({
    where: { id: connected.library.id },
  });

  assert.equal(stored.status, "HIDDEN_FROM_ACTIVE_LIST");
  assert.equal(libraries.some((library) => library.id === connected.library.id), false);
});
