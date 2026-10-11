import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { moveWithoutReplacement, physicalFileIdentity, samePhysicalIdentity, usablePhysicalIdentity } from "../src/filesystem/safe-move";
import { journaledMove, journaledCreateFolder, journaledRemoveFolder, recoverPhysicalAction } from "../src/filesystem/physical-journal";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nsn-physical-invariant-"));
  const prior = process.env.NSN_BRIDGE_DATA_DIR;
  process.env.NSN_BRIDGE_DATA_DIR = path.join(directory, "state");
  t.after(async () => {
    if (prior === undefined) delete process.env.NSN_BRIDGE_DATA_DIR; else process.env.NSN_BRIDGE_DATA_DIR = prior;
    assert.ok(path.resolve(directory).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, "source.txt"), destination = path.join(directory, "destination.txt");
  const bytes = "Synthetic approved physical content.\n", checksum = createHash("sha256").update(bytes).digest("hex");
  await writeFile(source, bytes);
  return { directory, source, destination, bytes, checksum };
}
test("FILE-1 exclusive move preserves a destination created after source verification", async (t) => {
  const f = await fixture(t);
  await assert.rejects(moveWithoutReplacement(f.source, f.destination, f.checksum, {
    intent: async () => { await writeFile(f.destination, "External user data", { flag: "wx" }); },
  }));
  assert.equal(await readFile(f.source, "utf8"), f.bytes);
  assert.equal(await readFile(f.destination, "utf8"), "External user data");
});
test("RECOVER-1 journal recovers the exclusive two-name interval without repeating the move", async (t) => {
  const f = await fixture(t);
  await assert.rejects(journaledMove("synthetic-link-owner", f.source, f.destination, f.checksum,
    async () => { throw new Error("Synthetic process death after durable LINKED"); }), /process death/);
  assert.equal(await readFile(f.source, "utf8"), f.bytes);
  assert.equal(await readFile(f.destination, "utf8"), f.bytes);
  await assert.rejects(recoverPhysicalAction("synthetic-link-owner"), /two names/);
  const outcome = await journaledMove("synthetic-link-owner", f.source, f.destination, f.checksum);
  assert.equal(outcome.state, "COMPLETED"); assert.equal(outcome.identity?.checksum, f.checksum);
  await assert.rejects(readFile(f.source), { code: "ENOENT" });
  assert.deepEqual(await journaledMove("synthetic-link-owner", f.source, f.destination, f.checksum), outcome);
  assert.equal(await readFile(f.destination, "utf8"), f.bytes);
});
test("FILE-1 source replacement at removal retains the unrelated editor file", async (t) => {
  const f = await fixture(t), replacement = path.join(f.directory, "editor.tmp");
  await writeFile(replacement, "Unrelated editor replacement");
  await assert.rejects(moveWithoutReplacement(f.source, f.destination, f.checksum, {
    beforeCapture: async () => {
      await rename(f.source, path.join(f.directory, "old-source-retained.txt"));
      await rename(replacement, f.source);
    },
  }), /captured source changed/);
  assert.equal(await readFile(f.source, "utf8"), "Unrelated editor replacement");
  assert.equal(await readFile(f.destination, "utf8"), f.bytes);
  const capture = (await readdir(f.directory)).find((name) => name.startsWith(".nsn-move-")); assert.ok(capture);
  assert.equal(await readFile(path.join(f.directory, capture, "source"), "utf8"), "Unrelated editor replacement");
});
test("RECOVER-1 source capture death retains a later replacement and recovers only its owned temporary name", async (t) => {
  const f = await fixture(t);
  await assert.rejects(journaledMove("synthetic-capture-owner", f.source, f.destination, f.checksum, undefined,
    async () => { throw new Error("Synthetic process death after source capture"); }), /process death/);
  await writeFile(f.source, "New editor file after captured move", { flag: "wx" });
  const result = await recoverPhysicalAction("synthetic-capture-owner");
  assert.equal(result?.state, "COMPLETED");
  assert.equal(await readFile(f.source, "utf8"), "New editor file after captured move");
  assert.equal(await readFile(f.destination, "utf8"), f.bytes);
  assert.equal((await readdir(f.directory)).some((name) => name.startsWith(".nsn-move-")), false);
  assert.deepEqual(await recoverPhysicalAction("synthetic-capture-owner"), result);
});
test("RECOVER-1 journal preserves a completed filesystem effect across caller persistence failure", async (t) => {
  const f = await fixture(t);
  await journaledMove("synthetic-database-gap", f.source, f.destination, f.checksum);
  // The next process has only the owner journal: the original source no longer
  // exists and no database acknowledgement was required to retain its outcome.
  const recovered = await recoverPhysicalAction("synthetic-database-gap");
  assert.equal(recovered?.state, "COMPLETED"); assert.equal(recovered?.identity?.checksum, f.checksum);
  await assert.rejects(journaledMove("synthetic-database-gap", f.source, path.join(f.directory, "unauthorized.txt"), f.checksum), /authority/);
  for (const binding of [
    { kind: "MOVE" as const, source: f.source, destination: path.join(f.directory, "unauthorized.txt"), checksum: f.checksum },
    { kind: "MOVE" as const, source: f.source, destination: f.destination, checksum: "0".repeat(64) },
    { kind: "CREATE_FOLDER" as const, source: null, destination: f.destination },
  ]) await assert.rejects(recoverPhysicalAction("synthetic-database-gap", binding), /authority/);
  assert.equal(await readFile(f.destination, "utf8"), f.bytes);
});
test("FILE-1 Undo removes only the empty directory owned by the original execution", async (t) => {
  const f = await fixture(t), folder = path.join(f.directory, "created");
  await journaledCreateFolder("synthetic-folder-owner", folder);
  await rename(folder, path.join(f.directory, "original-folder-retained"));
  await mkdir(folder);
  await assert.rejects(journaledRemoveFolder("synthetic-folder-undo", "synthetic-folder-owner", folder), /not the directory owned/);
  await writeFile(path.join(folder, "external.txt"), "Keep this data");
  assert.equal(await readFile(path.join(folder, "external.txt"), "utf8"), "Keep this data");
});
test("RECOVER-1 corrupt action journals fail closed and preserve their bytes", async (t) => {
  const f = await fixture(t), owner = "synthetic-corrupt-owner";
  const target = path.join(process.env.NSN_BRIDGE_DATA_DIR!, "physical-actions", `${createHash("sha256").update(owner).digest("hex")}.json`);
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, "{broken");
  await assert.rejects(journaledMove(owner, f.source, f.destination, f.checksum));
  assert.equal(await readFile(target, "utf8"), "{broken"); assert.equal(await readFile(f.source, "utf8"), f.bytes);
});

test("FILE-1 exact identity distinguishes the two real NTFS IDs that Number rounded together", () => {
  const original = 9288674232275576n, replacement = 9288674232275577n;
  assert.notEqual(original, replacement); assert.equal(Number(original), Number(replacement));
  assert.equal(samePhysicalIdentity({ dev: 4269342101n, ino: replacement },
    { dev: "4269342101", ino: original.toString(), encoding: "bigint-v1" }), false);
  assert.equal(samePhysicalIdentity({ dev: 4269342101n, ino: original },
    { dev: "4269342101", ino: original.toString(), encoding: "bigint-v1" }), true);
  // An untagged old journal cannot establish whether its unsafe decimal was
  // rounded. Exact-looking unsafe legacy numbers are not upgraded by guessing.
  assert.equal(samePhysicalIdentity({ dev: 4269342101n, ino: original },
    { dev: "4269342101", ino: original.toString() }), false);
  for (const ino of ["-1", "1e16", "NaN", "001", "18446744073709551616"])
    assert.equal(usablePhysicalIdentity({ dev: "1", ino, encoding: "bigint-v1" }), false);
});

test("RECOVER-3 unsafe legacy move and folder journals preserve bytes and admit no filesystem effect", async (t) => {
  const f = await fixture(t), folder = path.join(f.directory, "legacy-folder"); await mkdir(folder);
  const put = async (owner: string, entry: unknown) => {
    const target = path.join(process.env.NSN_BRIDGE_DATA_DIR!, "physical-actions", `${createHash("sha256").update(owner).digest("hex")}.json`);
    await mkdir(path.dirname(target), { recursive: true }); const text = JSON.stringify(entry) + "\n";
    await writeFile(target, text); return { target, text };
  };
  const identity = { dev: "1", ino: "9288674232275576", checksum: f.checksum };
  const move = await put("legacy-unsafe-move", { version: 1, owner: "legacy-unsafe-move", kind: "MOVE", source: f.source, destination: f.destination, state: "INTENT", created: false, identity });
  await assert.rejects(journaledMove("legacy-unsafe-move", f.source, f.destination, f.checksum), /exact ownership/);
  await assert.rejects(recoverPhysicalAction("legacy-unsafe-move"), /exact ownership/);
  assert.equal(await readFile(move.target, "utf8"), move.text);
  assert.equal(await readFile(f.source, "utf8"), f.bytes); await assert.rejects(readFile(f.destination), { code: "ENOENT" });
  const original = await put("legacy-unsafe-folder", { version: 1, owner: "legacy-unsafe-folder", kind: "CREATE_FOLDER", source: null, destination: folder, state: "COMPLETED", created: true, identity: { ...identity, checksum: "" } });
  await assert.rejects(journaledRemoveFolder("legacy-unsafe-undo", "legacy-unsafe-folder", folder), /not the directory owned/);
  await writeFile(path.join(folder, "unrelated.txt"), "Unrelated data remains");
  assert.equal(await readFile(original.target, "utf8"), original.text);
  assert.equal(await readFile(path.join(folder, "unrelated.txt"), "utf8"), "Unrelated data remains");
  assert.equal((await recoverPhysicalAction("legacy-unsafe-folder"))?.state, "COMPLETED", "Historical outcome remains readable without authorizing removal");
});

test("RECOVER-1 safe legacy identities still recover owned moves; new journals preserve exact identity", async (t) => {
  const f = await fixture(t), owner = "legacy-safe-move";
  await assert.rejects(journaledMove(owner, f.source, f.destination, f.checksum, async () => { throw new Error("stop at link"); }), /stop at link/);
  const target = path.join(process.env.NSN_BRIDGE_DATA_DIR!, "physical-actions", `${createHash("sha256").update(owner).digest("hex")}.json`);
  const entry = JSON.parse(await readFile(target, "utf8")); assert.equal(entry.identity.encoding, "bigint-v1");
  assert.deepEqual(await physicalFileIdentity(f.source), entry.identity);
  const legacy = { ...entry.identity }; delete legacy.encoding;
  if (usablePhysicalIdentity(legacy)) {
    entry.identity = legacy; await writeFile(target, JSON.stringify(entry) + "\n");
    assert.equal((await journaledMove(owner, f.source, f.destination, f.checksum)).state, "COMPLETED");
    await assert.rejects(readFile(f.source), { code: "ENOENT" });
  } else {
    entry.identity = legacy; const raw = JSON.stringify(entry) + "\n"; await writeFile(target, raw);
    await assert.rejects(journaledMove(owner, f.source, f.destination, f.checksum), /exact ownership/);
    assert.equal(await readFile(target, "utf8"), raw); assert.equal(await readFile(f.source, "utf8"), f.bytes);
  }
  assert.equal(await readFile(f.destination, "utf8"), f.bytes);
  const folder = path.join(f.directory, "positive-owned-folder");
  const created = await journaledCreateFolder("exact-folder", folder); assert.equal(created.identity?.encoding, "bigint-v1");
  assert.equal((await journaledRemoveFolder("exact-undo", "exact-folder", folder)).state, "COMPLETED");
  assert.deepEqual(await journaledRemoveFolder("exact-undo", "exact-folder", folder), await recoverPhysicalAction("exact-undo"));
});

test("FILE-1 folder replacement between verification and capture is retained unresolved, never deleted", async (t) => {
  const f = await fixture(t), folder = path.join(f.directory, "approved-folder"), retained = path.join(f.directory, "original-retained");
  await journaledCreateFolder("folder-race-original", folder);
  let replacement: bigint | undefined;
  await assert.rejects(journaledRemoveFolder("folder-race-undo", "folder-race-original", folder, async () => {
    await rename(folder, retained); await mkdir(folder);
    replacement = (await lstat(folder, { bigint: true })).ino;
    await writeFile(path.join(folder, "unapproved.txt"), "Unrelated contents must survive");
  }), /not the empty directory owned/);
  const capture = (await readdir(f.directory)).find(name => name.startsWith(".nsn-remove-")); assert.ok(capture);
  assert.equal((await lstat(path.join(f.directory, capture, "directory"), { bigint: true })).ino, replacement);
  assert.equal(await readFile(path.join(f.directory, capture, "directory", "unapproved.txt"), "utf8"), "Unrelated contents must survive");
  assert.ok((await lstat(retained)).isDirectory());
  await mkdir(folder); await writeFile(path.join(folder, "later.txt"), "A later public replacement");
  await assert.rejects(recoverPhysicalAction("folder-race-undo"), /not the empty directory owned/);
  assert.equal(await readFile(path.join(folder, "later.txt"), "utf8"), "A later public replacement");
  assert.equal(await readFile(path.join(f.directory, capture, "directory", "unapproved.txt"), "utf8"), "Unrelated contents must survive");
});

test("RECOVER-1 captured folder Undo recovers only its exact private owner and preserves a new public name", async (t) => {
  const f = await fixture(t), folder = path.join(f.directory, "approved-folder");
  const created = await journaledCreateFolder("captured-folder-original", folder);
  await assert.rejects(journaledRemoveFolder("captured-folder-undo", "captured-folder-original", folder, undefined,
    async () => { throw new Error("stop after folder capture"); }), /stop after folder capture/);
  const capture = (await readdir(f.directory)).find(name => name.startsWith(".nsn-remove-")); assert.ok(capture);
  assert.equal((await lstat(path.join(f.directory, capture, "directory"), { bigint: true })).ino.toString(), created.identity?.ino);
  await mkdir(folder); await writeFile(path.join(folder, "unapproved.txt"), "Public replacement after capture");
  const result = await recoverPhysicalAction("captured-folder-undo"); assert.equal(result?.state, "COMPLETED");
  assert.equal(await readFile(path.join(folder, "unapproved.txt"), "utf8"), "Public replacement after capture");
  await assert.rejects(lstat(path.join(f.directory, capture)), { code: "ENOENT" });
  assert.deepEqual(await recoverPhysicalAction("captured-folder-undo"), result);
});

test("RECOVER-1 absent legacy folder removal and unstarted capture stay unknown rather than fabricating success", async (t) => {
  const f = await fixture(t), folder = path.join(f.directory, "approved-folder"), owner = "legacy-remove-intent";
  const target = path.join(process.env.NSN_BRIDGE_DATA_DIR!, "physical-actions", `${createHash("sha256").update(owner).digest("hex")}.json`);
  const legacy = JSON.stringify({ version: 1, owner, kind: "REMOVE_FOLDER", source: folder, destination: folder, state: "INTENT", created: false, identity: null, originalOwner: "unverified" }) + "\n";
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, legacy);
  await assert.rejects(recoverPhysicalAction(owner), /ownership recovery/); assert.equal(await readFile(target, "utf8"), legacy);
  await journaledCreateFolder("not-captured-original", folder);
  await assert.rejects(journaledRemoveFolder("not-captured-undo", "not-captured-original", folder,
    async () => { throw new Error("stop before capture"); }), /stop before capture/);
  await assert.rejects(recoverPhysicalAction("not-captured-undo"), /no verified removal proof/);
  assert.ok((await lstat(folder)).isDirectory());
});

test("RECOVER-1 actual process termination after folder capture preserves a later public replacement on recovery", async t => {
  const f = await fixture(t), folder = path.join(f.directory, "approved-folder"), originalOwner = "killed-folder-original", owner = "killed-folder-undo";
  await journaledCreateFolder(originalOwner, folder);
  const child = spawn(process.execPath, ["--import", "tsx", "bridge-app/tests/fixtures/folder-undo-process.ts", folder, owner, originalOwner],
    { cwd: process.cwd(), env: { ...process.env }, windowsHide: true });
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "pipe", windowsHide: true });
    else child.kill("SIGKILL");
  };
  t.after(kill);
  const ended = new Promise<void>(resolve => child.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Owned folder capture barrier not reached")), 20_000);
    child.stdout.on("data", data => { output += data.toString(); if (output.includes("OWNED_FOLDER_CAPTURED")) { clearTimeout(timer); resolve(); } });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); if (!output.includes("OWNED_FOLDER_CAPTURED")) reject(new Error("Worker exited before capture")); });
  });
  kill(); await ended;
  await mkdir(folder); await writeFile(path.join(folder, "replacement.txt"), "Unapproved public directory contents");
  assert.equal((await recoverPhysicalAction(owner))?.state, "COMPLETED");
  assert.equal(await readFile(path.join(folder, "replacement.txt"), "utf8"), "Unapproved public directory contents");
  assert.equal((await readdir(f.directory)).some(name => name.startsWith(".nsn-remove-")), false);
  assert.equal((await recoverPhysicalAction(owner))?.state, "COMPLETED");
  console.log(`Folder capture worker ${child.pid} terminated; original recovered once, replacement retained.`);
});

test("TX-3 concurrent folder Undo owners cannot remove twice or manufacture a second completed outcome", async t => {
  const f = await fixture(t), folder = path.join(f.directory, "approved-folder");
  await journaledCreateFolder("concurrent-folder-original", folder);
  const results = await Promise.allSettled([
    journaledRemoveFolder("concurrent-folder-undo-a", "concurrent-folder-original", folder),
    journaledRemoveFolder("concurrent-folder-undo-b", "concurrent-folder-original", folder),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const winner = results[0].status === "fulfilled" ? "concurrent-folder-undo-a" : "concurrent-folder-undo-b";
  assert.equal((await recoverPhysicalAction(winner))?.state, "COMPLETED");
  await mkdir(folder); await writeFile(path.join(folder, "unrelated.txt"), "New public folder");
  const repeated = await Promise.all([journaledRemoveFolder(winner, "concurrent-folder-original", folder), journaledRemoveFolder(winner, "concurrent-folder-original", folder)]);
  assert.ok(repeated.every(result => result.state === "COMPLETED"));
  assert.equal(await readFile(path.join(folder, "unrelated.txt"), "utf8"), "New public folder");
});
