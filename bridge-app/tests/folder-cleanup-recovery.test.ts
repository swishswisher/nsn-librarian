import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { journaledCreateFolder, journaledRemoveFolder, recoverPhysicalAction } from "../src/filesystem/physical-journal";

type Entry = NonNullable<Awaited<ReturnType<typeof recoverPhysicalAction>>>;
type Recovery = "journaledRemoveFolder" | "recoverPhysicalAction";
const routes: Recovery[] = ["journaledRemoveFolder", "recoverPhysicalAction"];
async function interrupted(t: TestContext, boundary = "before-cleanup") {
  const parent = path.resolve(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, "nsn-folder-cleanup-"));
  const marker = path.join(root, ".synthetic-owner"); await fs.writeFile(marker, root);
  const previous = process.env.NSN_BRIDGE_DATA_DIR;
  process.env.NSN_BRIDGE_DATA_DIR = path.join(root, "state");
  t.after(async () => {
    if (previous === undefined) delete process.env.NSN_BRIDGE_DATA_DIR; else process.env.NSN_BRIDGE_DATA_DIR = previous;
    assert.ok(path.resolve(root).startsWith(parent + path.sep)); assert.ok(path.basename(root).startsWith("nsn-folder-cleanup-"));
    assert.equal(await fs.readFile(marker, "utf8"), root); await fs.rm(root, { recursive: true, force: true });
  });
  const target = path.join(root, "approved"), owner = "completed-folder-undo", originalOwner = "approved-folder-owner";
  await journaledCreateFolder(originalOwner, target);
  const original = await fs.lstat(target, { bigint: true });
  const journal = path.join(process.env.NSN_BRIDGE_DATA_DIR, "physical-actions", `${createHash("sha256").update(owner).digest("hex")}.json`);
  const child = spawn(process.execPath, ["--import", "tsx", "bridge-app/tests/fixtures/folder-cleanup-process.ts", target, owner, originalOwner, boundary],
    { cwd: process.cwd(), env: { ...process.env }, windowsHide: true });
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "pipe" });
    else child.kill("SIGKILL");
  };
  t.after(kill);
  const ended = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const barrier = await new Promise<{ boundary: string; capturePath: string; state: string; dev: string; ino: string }>((resolve, reject) => {
    let output = "", errors = "", reached = false;
    const timer = setTimeout(() => reject(new Error(`Cleanup barrier not reached: ${errors}`)), 20_000);
    child.stderr.on("data", bytes => { errors += bytes.toString(); });
    child.stdout.on("data", bytes => {
      output += bytes.toString(); const line = output.split("\n").find(value => value.startsWith("FOLDER_CLEANUP_BARRIER "));
      if (line && output.endsWith("\n")) { reached = true; clearTimeout(timer); resolve(JSON.parse(line.slice("FOLDER_CLEANUP_BARRIER ".length))); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); if (!reached) reject(new Error(`Worker exited before cleanup barrier: ${errors}`)); });
  });
  kill(); await ended;
  const raw = await fs.readFile(journal, "utf8"), entry: Entry = JSON.parse(raw);
  assert.equal(entry.state, "COMPLETED"); assert.equal(entry.identity?.ino, original.ino.toString());
  assert.equal(entry.directoryCapture?.directory, barrier.capturePath);
  await assert.rejects(fs.lstat(target), { code: "ENOENT" });
  if (boundary === "before-cleanup") {
    const captured = await fs.lstat(barrier.capturePath, { bigint: true });
    assert.equal(captured.ino.toString(), barrier.ino); assert.deepEqual(await fs.readdir(barrier.capturePath), []);
  } else await assert.rejects(fs.lstat(barrier.capturePath), { code: "ENOENT" });
  await fs.mkdir(target); await fs.writeFile(path.join(target, "unapproved.txt"), "New public directory must survive unchanged.");
  const replacement = await fs.lstat(target, { bigint: true });
  const recover = (route: Recovery) => route === "journaledRemoveFolder" ? journaledRemoveFolder(owner, originalOwner, target) : recoverPhysicalAction(owner);
  const publicUnchanged = async () => {
    assert.equal((await fs.lstat(target, { bigint: true })).ino, replacement.ino);
    assert.equal(await fs.readFile(path.join(target, "unapproved.txt"), "utf8"), "New public directory must survive unchanged.");
  };
  console.log(`Owned cleanup worker ${child.pid} killed at ${boundary}; durable COMPLETED retained.`);
  return { root, target, owner, originalOwner, journal, raw, entry, capture: barrier.capturePath, barrier, recover, publicUnchanged };
}

for (const route of routes) test(`RECOVER-1 completed folder cleanup after real process death recovers through ${route}`, async t => {
  const f = await interrupted(t); let removals = 0;
  const remove = fs.rmdir;
  t.mock.method(fs, "rmdir", async (target: Parameters<typeof fs.rmdir>[0], options: Parameters<typeof fs.rmdir>[1]) => {
    if (String(target) === f.capture) removals++; return remove(target, options);
  }); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await f.recover(route); assert.equal(result?.state, "COMPLETED"); await f.publicUnchanged();
  const remains = await fs.lstat(f.capture, { bigint: true }).then(s => ({ dev: s.dev.toString(), ino: s.ino.toString() }), error => {
    assert.equal(error.code, "ENOENT"); return null;
  });
  if (process.env.NSN_CERT_DIRECTORY) await fs.writeFile(path.join(process.env.NSN_CERT_DIRECTORY, `${process.env.NSN_CERT_GATE}-${route}-evidence.json`),
    JSON.stringify({ route, barrier: f.barrier, durableJournal: f.entry, recoveredState: result?.state, captureRemains: remains, removals, publicPreserved: true }, null, 2) + "\n");
  assert.equal(remains, null, "Completed recovery stranded its exact empty private capture"); assert.equal(removals, 1);
  assert.deepEqual(await f.recover(route), result); assert.equal(removals, 1); await f.publicUnchanged();
  assert.equal(await fs.readFile(f.journal, "utf8"), f.raw, "Cleanup must retain completed physical history");
});

for (const route of routes) test(`RECOVER-1 real death after private cleanup before parent sync is idempotent through ${route}`, async t => {
  const f = await interrupted(t, "after-cleanup");
  assert.equal((await f.recover(route))?.state, "COMPLETED"); await f.publicUnchanged();
  await assert.rejects(fs.lstat(f.capture), { code: "ENOENT" });
  assert.equal((await f.recover(route))?.state, "COMPLETED"); await f.publicUnchanged();
  assert.equal(await fs.readFile(f.journal, "utf8"), f.raw);
});

test("FILE-1 completed cleanup preserves a different directory occupying its private capture name", async t => {
  const f = await interrupted(t), retained = path.join(f.root, "retained-original-capture");
  await fs.rename(f.capture, retained); await fs.mkdir(f.capture);
  const replacement = await fs.lstat(f.capture, { bigint: true }); assert.notEqual(replacement.ino.toString(), f.entry.directoryCapture?.ino);
  for (const route of routes) { await assert.rejects(f.recover(route), /cleanup inspection/); await f.publicUnchanged(); }
  assert.equal((await fs.lstat(f.capture, { bigint: true })).ino, replacement.ino);
  assert.equal((await fs.lstat(retained, { bigint: true })).ino.toString(), f.entry.directoryCapture?.ino);
  assert.equal(await fs.readFile(f.journal, "utf8"), f.raw);
});

test("FILE-1 completed cleanup preserves nonempty capture contents without repeating folder removal", async t => {
  const f = await interrupted(t), nested = path.join(f.capture, "directory");
  await fs.mkdir(nested); await fs.writeFile(path.join(f.capture, "unrelated.txt"), "Keep private replacement data");
  // Even an exact-looking captured child can never re-enter completed removal.
  const stats = await fs.lstat(nested, { bigint: true });
  const entry = { ...f.entry, identity: { dev: stats.dev.toString(), ino: stats.ino.toString(), checksum: "", encoding: "bigint-v1" } };
  const raw = JSON.stringify(entry) + "\n"; await fs.writeFile(f.journal, raw);
  for (const route of routes) { await assert.rejects(f.recover(route), /cleanup inspection/); await f.publicUnchanged(); }
  assert.equal((await fs.lstat(nested, { bigint: true })).ino, stats.ino);
  assert.equal(await fs.readFile(path.join(f.capture, "unrelated.txt"), "utf8"), "Keep private replacement data");
  assert.equal(await fs.readFile(f.journal, "utf8"), raw);
});

test("FILE-1 completed cleanup preserves a regular file replacing the capture directory", async t => {
  const f = await interrupted(t); await fs.rename(f.capture, path.join(f.root, "retained-capture"));
  await fs.writeFile(f.capture, "Unrelated regular file");
  for (const route of routes) { await assert.rejects(f.recover(route), /cleanup inspection/); await f.publicUnchanged(); }
  assert.equal(await fs.readFile(f.capture, "utf8"), "Unrelated regular file");
  assert.equal(await fs.readFile(f.journal, "utf8"), f.raw);
});

test("RECOVER-3 completed cleanup preserves corrupt or unsafe journal proof without inventing authority", async t => {
  const f = await interrupted(t);
  for (const raw of ["{broken", JSON.stringify({ ...f.entry, directoryCapture: { ...f.entry.directoryCapture, ino: "9288674232275576", encoding: undefined } }),
    JSON.stringify({ ...f.entry, identity: { dev: "1", ino: "9288674232275576", checksum: "" } })]) {
    await fs.writeFile(f.journal, raw);
    for (const route of routes) { await assert.rejects(f.recover(route)); await f.publicUnchanged(); }
    assert.equal(await fs.readFile(f.journal, "utf8"), raw);
    assert.equal((await fs.lstat(f.capture, { bigint: true })).ino.toString(), f.entry.directoryCapture?.ino);
  }
});

test("RECOVER-3 old completed journals without a directory capture remain historical and effect-free", async t => {
  const f = await interrupted(t), legacy = { ...f.entry, directoryCapture: undefined, identity: { dev: "1", ino: "9288674232275576", checksum: "" } };
  const raw = JSON.stringify(legacy) + "\n"; await fs.writeFile(f.journal, raw);
  for (const route of routes) { assert.equal((await f.recover(route))?.state, "COMPLETED"); await f.publicUnchanged(); }
  assert.equal(await fs.readFile(f.journal, "utf8"), raw);
  assert.equal((await fs.lstat(f.capture, { bigint: true })).ino.toString(), f.entry.directoryCapture?.ino);
});

test("TX-3 concurrent completed cleanup entry points remove the exact empty capture only once", async t => {
  const f = await interrupted(t); let removals = 0;
  const remove = fs.rmdir;
  t.mock.method(fs, "rmdir", async (target: Parameters<typeof fs.rmdir>[0], options: Parameters<typeof fs.rmdir>[1]) => {
    if (String(target) === f.capture) removals++; return remove(target, options);
  }); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const results = await Promise.all([f.recover(routes[0]), f.recover(routes[1]), f.recover(routes[0])]);
  assert.ok(results.every(entry => entry?.state === "COMPLETED")); assert.equal(removals, 1);
  await assert.rejects(fs.lstat(f.capture), { code: "ENOENT" }); await f.publicUnchanged();
  assert.equal(await fs.readFile(f.journal, "utf8"), f.raw);
});
