import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

// Electron owns one process for a data directory. Watcher, IPC, loopback and
// cloud mutations in that process must serialize the entire read/modify/write,
// rather than just the final rename. Readers see one complete atomic snapshot.
const mutations = new Map<string, Promise<void>>();
export async function withLocalStoreLock<T>(target: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(target);
  const previous = mutations.get(key) ?? Promise.resolve();
  const result = previous.then(work);
  const tail = result.then(() => undefined, () => undefined);
  mutations.set(key, tail);
  try { return await result; }
  finally { if (mutations.get(key) === tail) mutations.delete(key); }
}

export async function readLocalJson<T>(target: string, absent: () => T, validate: (value: unknown) => T): Promise<T> {
  let content: string;
  try { content = await readFile(target, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent();
    throw error;
  }
  // Existing unreadable, malformed or incomplete state must never become an
  // empty registry/outbox. Preserve its bytes and stop the mutating operation.
  return validate(JSON.parse(content));
}

export async function writeLocalJson(target: string, value: unknown) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, target);
  if (process.platform !== "win32") {
    const directory = await open(path.dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
