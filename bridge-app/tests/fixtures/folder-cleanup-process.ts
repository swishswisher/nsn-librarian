import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { journaledRemoveFolder } from "../../src/filesystem/physical-journal";

const [target, owner, originalOwner, boundary] = process.argv.slice(2);
assert.ok(["before-cleanup", "after-cleanup"].includes(boundary));
const remove = fs.rmdir;
fs.rmdir = async (directory, options) => {
  const capturePath = String(directory);
  if (path.dirname(capturePath) !== path.dirname(target) || !path.basename(capturePath).startsWith(".nsn-remove-"))
    return remove(directory, options);
  const journalPath = path.join(process.env.NSN_BRIDGE_DATA_DIR!, "physical-actions", `${createHash("sha256").update(owner).digest("hex")}.json`);
  const entry = JSON.parse(await fs.readFile(journalPath, "utf8"));
  assert.equal(entry.state, "COMPLETED"); assert.equal(entry.directoryCapture.directory, capturePath);
  const stats = await fs.lstat(capturePath, { bigint: true });
  assert.equal(stats.dev.toString(), entry.directoryCapture.dev); assert.equal(stats.ino.toString(), entry.directoryCapture.ino);
  assert.deepEqual(await fs.readdir(capturePath), []);
  if (boundary === "after-cleanup") await remove(directory, options);
  process.stdout.write(`FOLDER_CLEANUP_BARRIER ${JSON.stringify({ boundary, capturePath, state: entry.state, dev: stats.dev.toString(), ino: stats.ino.toString() })}\n`);
  await new Promise<void>(() => { setInterval(() => undefined, 1000); });
};
syncBuiltinESMExports();
void journaledRemoveFolder(owner, originalOwner, target).catch(error => { console.error(error); process.exitCode = 1; });
