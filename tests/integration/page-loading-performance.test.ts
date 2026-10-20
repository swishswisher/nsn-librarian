import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { getMonitoringDashboardData } from "../../src/lib/bridge/monitor";
import { getConnectedLibraries } from "../../src/lib/bridge/connected-libraries";
import { getLibraryDocumentCount } from "../../src/lib/library/data";

// Exercise the production loaders with deterministic database/transport boundaries.
// These query-budget tests supplement, rather than replace, the DB invariant gate.
async function unexpectedQuery(...args: unknown[]): Promise<unknown> {
  throw new Error(`Unexpected database access (${args.length} arguments)`);
}
const prisma = {
  libraryDocument: { count: unexpectedQuery, findMany: unexpectedQuery },
  connectedLibrary: { findMany: unexpectedQuery },
  monitoringEvent: { findMany: unexpectedQuery, groupBy: unexpectedQuery },
  monitoringBatch: { findMany: unexpectedQuery },
  scannedFile: { groupBy: unexpectedQuery },
  scanSession: { findMany: unexpectedQuery },
  organizationPlan: { findMany: unexpectedQuery },
  bridgeDevice: { findMany: unexpectedQuery },
};
(globalThis as unknown as { prismaClient: PrismaClient }).prismaClient = prisma as unknown as PrismaClient;
afterEach(() => mock.restoreAll());

function folder(id: string, bridgeDeviceId: string | null = null) {
  return {
    id, bridgeDeviceId, bridgeRootId: `root-${id}`, folderFingerprint: `root-${id}`,
    localPath: `bridge://root-${id}`, displayName: id, status: "CONNECTED",
    platform: "MACOS", isEnabled: true, isLegacyConnection: false,
    readPermission: true, watchPermission: false, recommendationPermission: true,
    organizationPlanPermission: true, createFolderPermission: false,
    moveFilePermission: false, renameFilePermission: false,
    connectedAt: new Date(), monitoringState: "STOPPED",
    monitoringEvents: [], monitoringBatches: [],
  };
}

test("Home counts documents without loading document text or relationships", async () => {
  const count = mock.method(prisma.libraryDocument, "count", async () => 50000);
  mock.method(prisma.libraryDocument, "findMany", async () => {
    throw new Error("Home must not materialize documents");
  });
  assert.equal(await getLibraryDocumentCount(), 50000);
  assert.equal(count.mock.callCount(), 1);
});

test("Monitoring groups eight folders in one query and preserves distinct status counts", async () => {
  const folders = Array.from({ length: 8 }, (_, i) => folder(`folder-${i}`));
  mock.method(prisma.connectedLibrary, "findMany", async (input: unknown) =>
    (input as { take?: number })?.take === 8 ? folders : []);
  mock.method(prisma.monitoringEvent, "findMany", async () => []);
  mock.method(prisma.monitoringBatch, "findMany", async () => []);
  let folderQueries = 0;
  mock.method(prisma.monitoringEvent, "groupBy", async (input: unknown) => {
    const query = input as { by: string[]; where?: { connectedFolderId: { in: string[] } } };
    if (!query.by.includes("connectedFolderId")) {
      return [{ processingStatus: "FAILED", _count: 7 }];
    }
    folderQueries++;
    assert.deepEqual(query.where?.connectedFolderId.in, folders.map((item) => item.id));
    return [
      { connectedFolderId: "folder-0", processingStatus: "FAILED", _count: 2 },
      { connectedFolderId: "folder-0", processingStatus: "NEEDS_ATTENTION", _count: 3 },
      { connectedFolderId: "folder-1", processingStatus: "COMPLETED", _count: 4 },
      { connectedFolderId: "folder-1", processingStatus: "SKIPPED", _count: 6 },
      { connectedFolderId: "folder-2", processingStatus: "STABILIZING", _count: 8 },
      { connectedFolderId: "folder-2", processingStatus: "QUEUED", _count: 9 },
      { connectedFolderId: "folder-3", processingStatus: "PROCESSING", _count: 11 },
    ];
  });
  const data = await getMonitoringDashboardData();
  assert.equal(folderQueries, 1);
  assert.equal(data.folders.length, 8);
  assert.equal(data.queue.needsAttention, 7);
  assert.equal(data.folders[0].attentionEvents, 5);
  assert.equal(data.folders[1].completedEvents, 10);
  assert.equal(data.folders[2].queuedEvents, 17);
  assert.equal(data.folders[3].processingEvents, 11);
  assert.equal(data.folders[7].attentionEvents, 0);
});

test("Connected Libraries shares health lookups but refreshes device liveness on the next request", async () => {
  const folders = [folder("one", "device-a"), folder("two", "device-a"), folder("three", "device-b"), folder("local")];
  mock.method(prisma.connectedLibrary, "findMany", async (input: unknown) => {
    if ((input as { select?: unknown })?.select) return [];
    return folders;
  });
  mock.method(prisma.scannedFile, "groupBy", async () => []);
  mock.method(prisma.monitoringEvent, "groupBy", async () => []);
  mock.method(prisma.scanSession, "findMany", async () => []);
  mock.method(prisma.organizationPlan, "findMany", async () => []);
  let revoked = false;
  const deviceRead = mock.method(prisma.bridgeDevice, "findMany", async () => [
    { bridgeDeviceId: "device-a", status: revoked ? "REVOKED" : "ONLINE", lastSeenAt: new Date(), revokedAt: revoked ? new Date() : null },
    { bridgeDeviceId: "device-b", status: "OFFLINE", lastSeenAt: new Date(0), revokedAt: null },
  ]);
  const health = mock.method(globalThis, "fetch", async () => { throw new Error("Loopback unavailable"); });
  const first = await getConnectedLibraries();
  assert.deepEqual(first.map((item) => item.bridgeReachable), [true, true, false, false]);
  assert.equal(health.mock.callCount(), 1);
  assert.equal(deviceRead.mock.callCount(), 1);
  assert.ok(first.every((item) => !item.moveFilePermission && !item.createFolderPermission));
  revoked = true;
  const second = await getConnectedLibraries();
  assert.ok(second.every((item) => !item.bridgeReachable));
  assert.equal(health.mock.callCount(), 2);
  assert.equal(deviceRead.mock.callCount(), 2);
});

test("shared shell streams content before a delayed Bridge check completes", { timeout: 5000 }, async () => {
  const { createElement } = await import("react");
  const { renderToPipeableStream } = await import("react-dom/server");
  const { PassThrough } = await import("node:stream");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  const { LibraryShell } = await import("../../src/components/library/LibraryShell");
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  mock.method(globalThis, "fetch", async () => {
    await waiting;
    throw new Error("Loopback unavailable");
  });
  mock.method(prisma.bridgeDevice, "findMany", async () => []);
  mock.method(prisma.connectedLibrary, "findMany", async () => []);
  const noop = () => {};
  const tree = createElement(AppRouterContext.Provider, { value: {
    back: noop, forward: noop, refresh: noop,
    push: noop, replace: noop, prefetch: noop,
  } }, createElement(PathnameContext.Provider, { value: "/admin/library/history" },
    createElement(LibraryShell, { active: "history", children: "History is ready" })));
  let output = "";
  const destination = new PassThrough();
  destination.on("data", (chunk) => { output += chunk.toString(); });
  let rendering: ReturnType<typeof renderToPipeableStream> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      rendering = renderToPipeableStream(tree, {
        onShellReady() { rendering!.pipe(destination); resolve(); },
        onShellError: reject,
        onError: reject,
      });
    });
    assert.match(output, /History is ready/);
    assert.match(output, /Checking connection/);
    assert.doesNotMatch(output, /Bridge: <!-- -->Bridge not connected/);
    release();
    await new Promise<void>((resolve) => destination.on("end", resolve));
    assert.match(output, /Bridge not connected|Bridge unavailable|Bridge not paired|Bridge offline|Download Bridge/i);
  } finally {
    release();
    rendering?.abort();
  }
});
