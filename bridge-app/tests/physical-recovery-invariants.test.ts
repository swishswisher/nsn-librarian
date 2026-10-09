import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { moveWithoutReplacement } from "../src/filesystem/safe-move";
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
