import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdtemp, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

export type PhysicalDeviceIdentity = { dev: string; ino: string; encoding?: "bigint-v1" };
export type PhysicalFileIdentity = PhysicalDeviceIdentity & { checksum: string };
export type SourceCapture = PhysicalDeviceIdentity & { directory: string };
export function usablePhysicalIdentity(identity: PhysicalDeviceIdentity | null | undefined) {
  if (!identity || (identity.encoding !== undefined && identity.encoding !== "bigint-v1")) return false;
  return [identity.dev, identity.ino].every(value => typeof value === "string" && /^(0|[1-9]\d{0,19})$/u.test(value) &&
    BigInt(value) <= (identity.encoding === "bigint-v1" ? BigInt("18446744073709551615") : BigInt(Number.MAX_SAFE_INTEGER)));
}
export function samePhysicalIdentity(stats: { dev: bigint; ino: bigint }, identity: PhysicalDeviceIdentity | null | undefined) {
  return usablePhysicalIdentity(identity) && stats.dev.toString() === identity!.dev && stats.ino.toString() === identity!.ino;
}

// Never unlink the public source pathname: an editor can atomically replace it
// after verification. Capture its current entry in a private same-volume
// directory, then verify what rename actually captured before deleting it.
export async function removeOwnedSource(source: string, identity: PhysicalFileIdentity,
  hooks: { captureIntent?: (capture: SourceCapture) => Promise<void>; beforeCapture?: () => Promise<void>;
    captured?: () => Promise<void> } = {}, admitted?: SourceCapture, allowSourceChanges = true) {
  if (!usablePhysicalIdentity(identity) || (admitted && !usablePhysicalIdentity(admitted)))
    throw new Error("Legacy physical identity cannot establish exact ownership; preserve it for recovery.");
  const capture = admitted ?? await (async () => {
    const directory = await mkdtemp(path.join(path.dirname(source), ".nsn-move-"));
    const stats = await lstat(directory, { bigint: true });
    const value: SourceCapture = { directory, dev: stats.dev.toString(), ino: stats.ino.toString(), encoding: "bigint-v1" };
    await syncDirectory(path.dirname(source)); await hooks.captureIntent?.(value);
    return value;
  })();
  const directoryStats = await lstat(capture.directory, { bigint: true });
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() || !samePhysicalIdentity(directoryStats, capture) ||
      path.dirname(capture.directory) !== path.dirname(source) || !path.basename(capture.directory).startsWith(".nsn-move-"))
    throw new Error("The private source capture lost its ownership; recovery is required.");
  const captured = path.join(capture.directory, "source");
  let capturedStats;
  try { capturedStats = await lstat(captured); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!capturedStats) {
    if (!allowSourceChanges) throw new Error("The capture is unfinished; recovery is required.");
    const current = await physicalFileIdentity(source);
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.checksum !== identity.checksum)
      throw new Error("The original source changed; both names are retained for recovery.");
    await hooks.beforeCapture?.();
    await rename(source, captured);
    await syncDirectory(path.dirname(source)); await syncDirectory(capture.directory);
    await hooks.captured?.();
  }
  const current = await physicalFileIdentity(captured);
  if (current.dev !== identity.dev || current.ino !== identity.ino || current.checksum !== identity.checksum) {
    // Preserve an unrelated replacement even if it won the check/rename race.
    // Exclusive link restores its public name only when that name is vacant.
    if (allowSourceChanges) {
      try { await link(captured, source); await syncDirectory(path.dirname(source)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    throw new Error("The captured source changed; its bytes are retained for recovery.");
  }
  await unlink(captured); await syncDirectory(capture.directory);
  await rmdir(capture.directory); await syncDirectory(path.dirname(source));
  return capture;
}
export async function syncDirectory(directoryPath: string) {
  if (process.platform === "win32") return;
  const directory = await open(directoryPath, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function physicalFileIdentity(filePath: string): Promise<PhysicalFileIdentity> {
  const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("A regular source file is required.");
    const hash = createHash("sha256");
    for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
    const after = await file.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new Error("The physical source changed during verification.");
    return { dev: before.dev.toString(), ino: before.ino.toString(), checksum: hash.digest("hex"), encoding: "bigint-v1" };
  } finally { await file.close(); }
}

// link() fails atomically if the destination exists. It never replaces it. A
// same-volume regular file is required; EXDEV fails closed, with the source
// intact. Journal callbacks durably record intent and the two-name interval.
export async function moveWithoutReplacement(source: string, destination: string, expectedChecksum?: string | null,
  hooks: { intent?: (identity: PhysicalFileIdentity) => Promise<void>; linked?: (identity: PhysicalFileIdentity) => Promise<void>;
    captureIntent?: (capture: SourceCapture) => Promise<void>; beforeCapture?: () => Promise<void>; captured?: () => Promise<void> } = {}) {
  const identity = await physicalFileIdentity(source);
  if (expectedChecksum && identity.checksum !== expectedChecksum) throw new Error("The authorized source checksum changed.");
  await hooks.intent?.(identity);
  await link(source, destination);
  await syncDirectory(path.dirname(destination));
  const destinationIdentity = await physicalFileIdentity(destination);
  if (destinationIdentity.dev !== identity.dev || destinationIdentity.ino !== identity.ino || destinationIdentity.checksum !== identity.checksum)
    throw new Error("The exclusive destination does not match the intended physical source; recovery is required.");
  await hooks.linked?.(identity);
  await removeOwnedSource(source, identity, hooks);
  return identity;
}
