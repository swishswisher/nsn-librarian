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
let syncBridgeDeviceRoots: typeof import("../../src/lib/bridge/device-root-sync").syncBridgeDeviceRoots;
let testDatabaseUrl: string;
let testDirectDatabaseUrl: string;

const testSchemaName = `connected_libraries_test_${process.pid}_${Date.now()}`;

function databaseUrlForSchema(
  schemaName: string,
  databaseUrl = process.env.DATABASE_URL,
) {
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
      DIRECT_URL: testDirectDatabaseUrl,
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
  testDirectDatabaseUrl = databaseUrlForSchema(
    testSchemaName,
    process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  );
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.DIRECT_URL = testDirectDatabaseUrl;
  runPrismaDbPush();

  const prismaModule = await import("../../src/lib/db/prisma");
  const connectedLibraries = await import("../../src/lib/bridge/connected-libraries");
  const deviceRootSync = await import("../../src/lib/bridge/device-root-sync");

  prisma = prismaModule.getPrismaClient();
  connectBridgeLibrary = connectedLibraries.connectBridgeLibrary;
  disconnectConnectedLibrary = connectedLibraries.disconnectConnectedLibrary;
  getConnectedLibraries = connectedLibraries.getConnectedLibraries;
  hideConnectedLibrary = connectedLibraries.hideConnectedLibrary;
  reconcileDuplicateConnectedLibraries =
    connectedLibraries.reconcileDuplicateConnectedLibraries;
  stableFolderFingerprintForLocalPath =
    connectedLibraries.stableFolderFingerprintForLocalPath;
  syncBridgeDeviceRoots = deviceRootSync.syncBridgeDeviceRoots;
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

async function createBridgeDevice(bridgeDeviceId: string) {
  return prisma.bridgeDevice.create({
    data: {
      appVersion: "0.1.108",
      architecture: "x64",
      bridgeDeviceId,
      deviceDisplayName: "Deanne's Intel Mac",
      lastSeenAt: new Date(),
      pairedAt: new Date(),
      platform: "MACOS",
      publicKey: "test-public-key",
      status: "ONLINE",
    },
  });
}

test("cloud root sync reactivates a disconnected canonical record without duplicating history", async () => {
  const bridgeDeviceId = "bridge-sync-reconnect";
  const rootId = "root_aaaaaaaaaaaaaaaaaaaaaaaa";
  await createBridgeDevice(bridgeDeviceId);
  const connected = await connectBridgeLibrary({
    root: rootSummary(rootId, {
      displayName: "SCAN_ROOT_A_GENERAL_INBOX",
      platform: "MACOS",
    }),
  });

  await prisma.connectedLibrary.update({
    data: {
      bridgeDeviceId,
    },
    where: {
      id: connected.library.id,
    },
  });
  await prisma.scanSession.create({
    data: {
      connectedFolderId: connected.library.id,
      filesScanned: 1,
      status: "COMPLETED",
    },
  });
  await disconnectConnectedLibrary(connected.library.id);

  await syncBridgeDeviceRoots(bridgeDeviceId, [
    {
      ...rootSummary(rootId, {
        displayName: "SCAN_ROOT_A_GENERAL_INBOX",
        platform: "MACOS",
        safeLocation: "SCAN_ROOT_A_GENERAL_INBOX",
      }),
      id: rootId,
    },
  ]);

  const current = await getConnectedLibraries();
  const rows = await prisma.connectedLibrary.findMany({
    where: {
      OR: [{ bridgeRootId: rootId }, { folderFingerprint: rootId }],
    },
  });
  const sessions = await prisma.scanSession.findMany();

  assert.equal(current.filter((library) => library.bridgeRootId === rootId).length, 1);
  assert.equal(rows.filter((row) => row.status !== "MERGED").length, 1);
  assert.equal(rows[0]?.id, connected.library.id);
  assert.equal(rows[0]?.status, "CONNECTED");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.connectedFolderId, connected.library.id);
});

test("repeated cloud root sync merges stale duplicates and leaves one current library", async () => {
  const bridgeDeviceId = "bridge-sync-duplicates";
  const rootId = "root_bbbbbbbbbbbbbbbbbbbbbbbb";
  await createBridgeDevice(bridgeDeviceId);
  const canonical = await prisma.connectedLibrary.create({
    data: {
      bridgeDeviceId,
      bridgeRootId: rootId,
      connectedAt: new Date("2026-08-01T00:00:00.000Z"),
      displayName: "SCAN_ROOT_A_GENERAL_INBOX",
      localPath: `bridge://${rootId}`,
      platform: "MACOS",
      safeLocalLocation: "SCAN_ROOT_A_GENERAL_INBOX",
      status: "CONNECTED",
    },
  });
  const duplicate = await prisma.connectedLibrary.create({
    data: {
      bridgeDeviceId,
      connectedAt: new Date("2026-08-02T00:00:00.000Z"),
      displayName: "SCAN_ROOT_A_GENERAL_INBOX duplicate",
      folderFingerprint: rootId,
      localPath: `bridge://${rootId}/duplicate`,
      platform: "MACOS",
      safeLocalLocation: "SCAN_ROOT_A_GENERAL_INBOX",
      status: "CONNECTED",
    },
  });
  await prisma.scanSession.create({
    data: {
      connectedFolderId: duplicate.id,
      filesScanned: 3,
      status: "COMPLETED",
    },
  });

  await syncBridgeDeviceRoots(bridgeDeviceId, [rootSummary(rootId, { platform: "MACOS" })]);
  await syncBridgeDeviceRoots(bridgeDeviceId, [rootSummary(rootId, { platform: "MACOS" })]);

  const rows = await prisma.connectedLibrary.findMany({
    orderBy: { connectedAt: "asc" },
  });
  const sessions = await prisma.scanSession.findMany();
  const current = await getConnectedLibraries();

  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === canonical.id)?.status, "CONNECTED");
  assert.equal(rows.find((row) => row.id === duplicate.id)?.status, "MERGED");
  assert.equal(sessions[0]?.connectedFolderId, canonical.id);
  assert.equal(current.filter((library) => library.bridgeRootId === rootId).length, 1);
});
