import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createFolderSelection, getRoot, listRoots, registerRootFromSelection, updateRoot } from "../src/main/registry";
import { listBridgeWatcherEvents, queueBridgeWatcherEvent } from "../src/watcher/event-outbox";
import { loadBridgeCommandOutbox, queueBridgeCommandReport, removeBridgeCommandReport } from "../../apps/bridge/src/main/command-outbox";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nsn-local-state-"));
  const previous = process.env.NSN_BRIDGE_DATA_DIR;
  process.env.NSN_BRIDGE_DATA_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.NSN_BRIDGE_DATA_DIR; else process.env.NSN_BRIDGE_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const selection = await createFolderSelection(directory);
  const root = await registerRootFromSelection({ selectionToken: selection.selectionToken });
  return { directory, root };
}

test("TX-1 local registry serializes concurrent grants and watcher mutations", async (t) => {
  const { root } = await fixture(t);
  await Promise.all([
    updateRoot(root.id, { permissions: { moveFilePermission: true } }),
    updateRoot(root.id, { watcherState: "PAUSED" }),
    updateRoot(root.id, { permissions: { renameFilePermission: true } }),
    updateRoot(root.id, { lastScanAt: "2026-10-07T00:00:00.000Z" }),
  ]);
  const current = await getRoot(root.id);
  assert.equal(current.moveFilePermission, true);
  assert.equal(current.renameFilePermission, true);
  assert.equal(current.watcherState, "PAUSED");
  assert.equal(current.lastScanAt, "2026-10-07T00:00:00.000Z");
  const selections = await Promise.all(Array.from({ length: 20 }, () => createFolderSelection(current.actualPath)));
  const registrations = await Promise.all(selections.map((selection) => registerRootFromSelection({ selectionToken: selection.selectionToken })));
  assert.equal((await listRoots()).length, 1);
  const ordered = [...registrations].sort((left, right) => left.connectionRevision! - right.connectionRevision!);
  assert.equal(new Set(ordered.map((record) => record.connectionRevision)).size, 20);
  assert.equal(ordered.at(-1)?.connectionRevision, (root.connectionRevision ?? 0) + 20);
  assert.equal((await getRoot(root.id)).connectionRevision, ordered.at(-1)?.connectionRevision);
  assert.ok(ordered.every((record, index) => index === 0 || record.updatedAt! > ordered[index - 1].updatedAt!), "Native authority times increase in serialized revision order");
});

test("RECOVER-1 local registry corruption fails closed without replacing bytes", async (t) => {
  const { directory, root } = await fixture(t);
  const file = path.join(directory, "registry.json");
  const broken = '{"roots":[';
  await writeFile(file, broken);
  await assert.rejects(updateRoot(root.id, { permissions: { moveFilePermission: true } }));
  await assert.rejects(createFolderSelection(directory));
  assert.equal(await readFile(file, "utf8"), broken);
});

test("RECOVER-1 command reports retain concurrent writers and corrupt state", async (t) => {
  const { directory } = await fixture(t);
  await Promise.all(Array.from({ length: 50 }, (_, index) => queueBridgeCommandReport(`replay-${index}`, {
    commandId: `command-${index}`, completedAt: new Date().toISOString(), result: null,
    safeErrorCategory: null, status: "COMPLETED",
  })));
  assert.equal((await loadBridgeCommandOutbox()).length, 50);
  await Promise.all(Array.from({ length: 10 }, (_, index) => removeBridgeCommandReport(`command-${index}`)));
  assert.equal((await loadBridgeCommandOutbox()).length, 40);
  const file = path.join(directory, "command-outbox.json");
  const broken = '[{"queuedAt":"incomplete"}]';
  await writeFile(file, broken);
  await assert.rejects(loadBridgeCommandOutbox());
  await assert.rejects(removeBridgeCommandReport("command-11"));
  assert.equal(await readFile(file, "utf8"), broken);
});

test("RECOVER-1 watcher corruption remains recoverable instead of becoming empty", async (t) => {
  const { directory, root } = await fixture(t);
  const file = path.join(directory, "watcher-event-outbox.json");
  const broken = '{"events":[{"id":"incomplete"}]}';
  await writeFile(file, broken);
  await assert.rejects(listBridgeWatcherEvents());
  await assert.rejects(queueBridgeWatcherEvent({ id: "new", rootId: root.id, relativePath: "example.txt", detectedAt: new Date().toISOString(), eventType: "FILE_ADDED" }));
  assert.equal(await readFile(file, "utf8"), broken);
});
