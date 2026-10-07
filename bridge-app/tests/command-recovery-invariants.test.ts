import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createBridgeCommandEnvelope, createBridgeDeviceId, createBridgeKeyPair } from "../../packages/bridge-protocol/src";
import { createFolderSelection, disconnectRoot, registerRootFromSelection, updateRoot, withRootAuthority } from "../src/main/registry";
import { saveBridgeSecret } from "../../apps/bridge/src/main/keychain";
import { unfinishedPhysicalCommands } from "../../apps/bridge/src/main/command-journal";
import { executeBridgePlanActions } from "../src/filesystem/operations";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nsn-command-recovery-"));
  const previous = process.env.NSN_BRIDGE_DATA_DIR;
  process.env.NSN_BRIDGE_DATA_DIR = path.join(directory, "state");
  t.after(async () => {
    if (previous === undefined) delete process.env.NSN_BRIDGE_DATA_DIR; else process.env.NSN_BRIDGE_DATA_DIR = previous;
    assert.ok(path.resolve(directory).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  const selection = await createFolderSelection(directory);
  const root = await registerRootFromSelection({ selectionToken: selection.selectionToken, permissions: { readPermission: true, moveFilePermission: true } });
  const deviceId = createBridgeDeviceId(), keys = createBridgeKeyPair();
  await saveBridgeSecret("bridge-device-id", deviceId); await saveBridgeSecret("device-private-key", keys.privateKey);
  const bytes = "Synthetic command content", checksum = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(directory, "source.txt"), bytes);
  const action = { id: "synthetic-owned-action", actionType: "MOVE_FILE" as const, sourceRelativePath: "source.txt", destinationRelativePath: "destination.txt", sourceChecksum: checksum };
  const command = createBridgeCommandEnvelope({ bridgeDeviceId: deviceId, bridgeRootId: root.id, commandType: "EXECUTE_PLAN", signingSecret: "synthetic-test-command-signing-key",
    authorizationContext: { rootConnectionRevision: root.connectionRevision ?? 0 }, payload: { actions: [action] } });
  const fixturePath = path.join(directory, "command.json"), outputPath = path.join(directory, "reports.json");
  await writeFile(fixturePath, JSON.stringify(command));
  const run = (mode: string) => execFileSync(process.execPath, ["--import", "tsx", "bridge-app/tests/fixtures/physical-command-process.ts", fixturePath, mode, outputPath],
    { cwd: process.cwd(), env: { ...process.env, NSN_BRIDGE_FORCE_FILE_SECRETS_FOR_TESTS: "1" }, stdio: "pipe", timeout: 20_000 });
  return { directory, root, deviceId, action, bytes, run, outputPath };
}

test("RECOVER-1 actual command process death after effect replays its durable report after revocation without repeating the move", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.run("effect-death"), (error: unknown) => (error as { status: number }).status === 74);
  assert.equal(await readFile(path.join(f.directory, "destination.txt"), "utf8"), f.bytes);
  await assert.rejects(readFile(path.join(f.directory, "source.txt")), { code: "ENOENT" });
  assert.equal((await unfinishedPhysicalCommands(f.deviceId)).length, 1);
  await disconnectRoot(f.root.id);
  f.run("recover");
  const reports = JSON.parse(await readFile(f.outputPath, "utf8"));
  assert.ok(reports.length >= 1); assert.equal(reports[0].result.actions[0].status, "COMPLETED");
  assert.equal((await unfinishedPhysicalCommands(f.deviceId)).length, 0);
  f.run("recover");
  assert.deepEqual(JSON.parse(await readFile(f.outputPath, "utf8")), []);
  assert.equal(await readFile(path.join(f.directory, "destination.txt"), "utf8"), f.bytes);
});

test("RECOVER-1 command process death at ACK retains admission and revoked retry cannot start a file operation", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.run("admission-death"), (error: unknown) => (error as { status: number }).status === 75);
  assert.equal((await unfinishedPhysicalCommands(f.deviceId)).length, 1);
  await disconnectRoot(f.root.id);
  f.run("recover");
  const reports = JSON.parse(await readFile(f.outputPath, "utf8"));
  assert.equal(reports[0].result.actions[0].status, "FAILED");
  assert.equal((await unfinishedPhysicalCommands(f.deviceId)).length, 0);
  assert.equal(await readFile(path.join(f.directory, "source.txt"), "utf8"), f.bytes);
  await assert.rejects(readFile(path.join(f.directory, "destination.txt")), { code: "ENOENT" });
});
test("RECOVER-1 actual process death during source capture recovers after revocation without deleting a new public file", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.run("capture-death"), (error: unknown) => (error as { status: number }).status === 76);
  await writeFile(path.join(f.directory, "source.txt"), "New unrelated public file", { flag: "wx" });
  await disconnectRoot(f.root.id); f.run("recover");
  const reports = JSON.parse(await readFile(f.outputPath, "utf8"));
  assert.equal(reports[0].result.actions[0].status, "COMPLETED");
  assert.equal(await readFile(path.join(f.directory, "source.txt"), "utf8"), "New unrelated public file");
  assert.equal(await readFile(path.join(f.directory, "destination.txt"), "utf8"), f.bytes);
  assert.equal((await readdir(f.directory)).some((name) => name.startsWith(".nsn-move-")), false);
  f.run("recover"); assert.deepEqual(JSON.parse(await readFile(f.outputPath, "utf8")), []);
});

test("ROOT-2 native grant mutation queued before execution is rechecked inside the root mutex", async (t) => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  const lock = withRootAuthority(f.root.id, async () => { entered(); await gate; });
  await held;
  const denial = updateRoot(f.root.id, { permissions: { readPermission: false } });
  const execution = executeBridgePlanActions(f.root.id, [f.action], f.root.connectionRevision ?? 0);
  release(); await lock; await denial;
  await assert.rejects(execution, /permission/);
  assert.equal(await readFile(path.join(f.directory, "source.txt"), "utf8"), f.bytes);
});
