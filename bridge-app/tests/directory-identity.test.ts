import assert from "node:assert/strict";
import { mkdir, mkdtemp, lstat, rename, rmdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { journaledCreateFolder, journaledRemoveFolder } from "../src/filesystem/physical-journal";

test("FILE-1 actual NTFS colliding Number IDs cannot authorize Undo of a replacement directory", { skip: process.platform !== "win32" }, async t => {
  const parent = path.resolve(process.env.LOCALAPPDATA!, "Temp");
  const root = await mkdtemp(path.join(parent, "nsn-directory-identity-"));
  assert.ok(path.resolve(root).startsWith(parent + path.sep));
  const marker = path.join(root, ".owned-fixture.json");
  await writeFile(marker, JSON.stringify({ root, syntheticOnly: true }));
  const prior = process.env.NSN_BRIDGE_DATA_DIR;
  process.env.NSN_BRIDGE_DATA_DIR = path.join(root, "state");
  t.after(async () => {
    if (prior === undefined) delete process.env.NSN_BRIDGE_DATA_DIR; else process.env.NSN_BRIDGE_DATA_DIR = prior;
    assert.ok(path.resolve(root).startsWith(parent + path.sep));
    assert.ok(path.basename(root).startsWith("nsn-directory-identity-"));
    assert.equal(JSON.parse(await readFile(marker, "utf8")).root, root);
    await rm(root, { recursive: true, force: true });
  });
  const pool = path.join(root, "pool"); await mkdir(pool);
  const deadline = Date.now() + 240_000;
  for (let round = 0; round < 1000 && Date.now() < deadline; round++) {
    const journals = round % 16 === 0;
    const live: { target: string; owner: string; dev: bigint; ino: bigint; numeric: string }[] = [];
    for (let i = 0; i < 64; i++) {
      const target = path.join(pool, `owned-${i}`), owner = `directory-${round}-${i}`;
      if (journals) await journaledCreateFolder(owner, target); else await mkdir(target);
      const exact = await lstat(target, { bigint: true }), numeric = await lstat(target);
      live.push({ target, owner, dev: exact.dev, ino: exact.ino, numeric: `${numeric.dev}:${numeric.ino}` });
    }
    const groups = new Map<string, typeof live[number]>();
    for (const replacement of live) {
      const original = groups.get(replacement.numeric); groups.set(replacement.numeric, replacement);
      if (!journals || !original || original.ino === replacement.ino) continue;
      const retained = path.join(root, "original-retained");
      await rename(original.target, retained); await rename(replacement.target, original.target);
      assert.notEqual(original.ino, replacement.ino);
      assert.equal(Number(original.ino), Number(replacement.ino));
      await assert.rejects(journaledRemoveFolder("collision-undo", original.owner, original.target), /not the directory owned/);
      assert.equal((await lstat(original.target, { bigint: true })).ino, replacement.ino);
      assert.equal((await lstat(retained, { bigint: true })).ino, original.ino);
      // Repeated denial cannot create ownership or terminal removal evidence.
      await assert.rejects(journaledRemoveFolder("collision-undo", original.owner, original.target), /not the directory owned/);
      const positive = path.join(root, "approved-folder");
      await journaledCreateFolder("approved-folder", positive);
      assert.equal((await journaledRemoveFolder("approved-undo", "approved-folder", positive)).state, "COMPLETED");
      await assert.rejects(lstat(positive), { code: "ENOENT" });
      const evidence = { round, numericIdentity: original.numeric, originalExact: original.ino.toString(), replacementExact: replacement.ino.toString(), originalRetained: (await lstat(retained, { bigint: true })).ino.toString(), replacementSurvives: (await lstat(original.target, { bigint: true })).ino.toString(), approvedUndoCompleted: true };
      console.log(JSON.stringify(evidence));
      if (process.env.NSN_CERT_DIRECTORY) await writeFile(path.join(process.env.NSN_CERT_DIRECTORY, "permanent-ntfs-collision-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
      return;
    }
    for (const item of live) {
      assert.ok(path.resolve(item.target).startsWith(path.resolve(root) + path.sep));
      assert.equal((await lstat(item.target, { bigint: true })).ino, item.ino);
      assert.equal((await readdir(item.target)).length, 0); await rmdir(item.target);
    }
  }
  assert.fail("A real NTFS collision was not established within this bounded probe; do not infer safety from repeated misses.");
});
