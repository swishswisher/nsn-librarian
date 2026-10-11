import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rename, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readLocalJson, withLocalStoreLock, writeLocalJson } from "../main/local-json-store";
import { moveWithoutReplacement, physicalFileIdentity, removeOwnedSource, samePhysicalIdentity, usablePhysicalIdentity, syncDirectory, type PhysicalFileIdentity, type SourceCapture } from "./safe-move";
import { normalizeRelativePath } from "./safety";

type Journal = { version: 1; owner: string; kind: "MOVE" | "CREATE_FOLDER" | "REMOVE_FOLDER";
  source: string | null; destination: string; state: "INTENT" | "LINKED" | "COMPLETED";
  identity: PhysicalFileIdentity | null; created: boolean; originalOwner?: string; modifiedAt?: string; sizeBytes?: string; sourceCapture?: SourceCapture; directoryCapture?: SourceCapture };
export class PhysicalRecoveryRequired extends Error {
  code = "COMMAND_RECOVERY_REQUIRED";
}
function journalPath(owner: string) {
  const directory = process.env.NSN_BRIDGE_DATA_DIR?.trim() || process.env.NSN_LOCAL_STATE_DIR?.trim() || path.join(os.homedir(), ".nsn-bridge");
  return path.join(directory, "physical-actions", `${createHash("sha256").update(owner).digest("hex")}.json`);
}
async function load(owner: string) {
  return readLocalJson(journalPath(owner), () => null as Journal | null, (value) => {
    const entry = value as Journal;
    if (!entry || entry.version !== 1 || entry.owner !== owner || !["MOVE", "CREATE_FOLDER", "REMOVE_FOLDER"].includes(entry.kind) ||
        !["INTENT", "LINKED", "COMPLETED"].includes(entry.state) || typeof entry.destination !== "string" ||
        (entry.kind === "MOVE" && (typeof entry.source !== "string" || !entry.identity ||
          typeof entry.identity.dev !== "string" || typeof entry.identity.ino !== "string" || !/^[a-f0-9]{64}$/u.test(entry.identity.checksum))) ||
        (entry.sourceCapture && (entry.kind !== "MOVE" || typeof entry.sourceCapture.directory !== "string" ||
          typeof entry.sourceCapture.dev !== "string" || typeof entry.sourceCapture.ino !== "string" ||
          path.dirname(entry.sourceCapture.directory) !== path.dirname(entry.source!) || !path.basename(entry.sourceCapture.directory).startsWith(".nsn-move-"))) ||
        (entry.directoryCapture && (entry.kind !== "REMOVE_FOLDER" || typeof entry.directoryCapture.directory !== "string" ||
          !usablePhysicalIdentity(entry.directoryCapture) || typeof entry.originalOwner !== "string" ||
          path.dirname(entry.directoryCapture.directory) !== path.dirname(entry.destination) ||
          !path.basename(entry.directoryCapture.directory).startsWith(".nsn-remove-"))))
      throw new PhysicalRecoveryRequired("The physical action journal is corrupt; preserve it for recovery.");
    return entry;
  });
}
export async function hasPhysicalActionJournal(owner: string) { return Boolean(await load(owner)); }
function matches(left: PhysicalFileIdentity, right: PhysicalFileIdentity) {
  return usablePhysicalIdentity(left) && usablePhysicalIdentity(right) && left.dev === right.dev && left.ino === right.ino && left.checksum === right.checksum;
}
async function statOrAbsent(target: string) {
  try { return await lstat(target, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function completeMove(entry: Journal) {
  const stats = await lstat(entry.destination);
  entry.state = "COMPLETED"; entry.modifiedAt = stats.mtime.toISOString(); entry.sizeBytes = BigInt(stats.size).toString();
  await writeLocalJson(journalPath(entry.owner), entry);
  return entry;
}
async function recoverMove(entry: Journal, finishOwnedLink: boolean) {
  if (entry.state === "COMPLETED") return entry;
  if (!usablePhysicalIdentity(entry.identity) || (entry.sourceCapture && !usablePhysicalIdentity(entry.sourceCapture)))
    throw new PhysicalRecoveryRequired("Legacy physical identity cannot establish exact ownership; preserve it for recovery.");
  const source = await statOrAbsent(entry.source!); const destination = await statOrAbsent(entry.destination);
  if (!destination) return null; // Durable intent preceded the exclusive link.
  const destinationIdentity = destination.isFile() && !destination.isSymbolicLink() ? await physicalFileIdentity(entry.destination) : null;
  if (!destinationIdentity || !matches(destinationIdentity, entry.identity!)) {
    if (source) return null; // An occupied external destination is never removed.
    throw new PhysicalRecoveryRequired("The intended source and owned destination cannot be established.");
  }
  const capture = entry.sourceCapture;
  const captureStats = capture ? await statOrAbsent(capture.directory) : null;
  const capturedSource = captureStats ? await statOrAbsent(path.join(capture!.directory, "source")) : null;
  if (capturedSource) {
    // This is an internal owned duplicate, not a newly authorized library move.
    // Historical recovery may clean it after verifying destination ownership.
    try { await removeOwnedSource(entry.source!, entry.identity!, {}, capture, false); }
    catch { throw new PhysicalRecoveryRequired("The captured source needs ownership recovery; preserve its bytes."); }
  } else if (source) {
    if (!finishOwnedLink || !source.isFile() || source.isSymbolicLink() || !matches(await physicalFileIdentity(entry.source!), entry.identity!))
      throw new PhysicalRecoveryRequired("The interrupted move retains two names or a changed source; recovery is required.");
    try { await removeOwnedSource(entry.source!, entry.identity!, {
      captureIntent: async (value) => { entry.sourceCapture = value; await writeLocalJson(journalPath(entry.owner), entry); },
    }, captureStats ? capture : undefined); }
    catch { throw new PhysicalRecoveryRequired("The source capture needs ownership recovery; preserve its bytes."); }
  } else if (captureStats) {
    if (!captureStats.isDirectory() || captureStats.isSymbolicLink() || !samePhysicalIdentity(captureStats, capture))
      throw new PhysicalRecoveryRequired("The private source capture lost its ownership.");
    try { await rmdir(capture!.directory); await syncDirectory(path.dirname(entry.source!)); }
    catch { throw new PhysicalRecoveryRequired("The private source capture is not empty; preserve it for recovery."); }
  }
  return completeMove(entry);
}
export async function journaledMove(owner: string, source: string, destination: string, checksum?: string | null,
  afterLinked?: () => Promise<void>, afterCaptured?: () => Promise<void>) {
  return withLocalStoreLock(journalPath(owner), async () => {
    const existing = await load(owner);
    if (existing && (existing.kind !== "MOVE" || existing.source !== source || existing.destination !== destination ||
        (checksum && existing.identity?.checksum !== checksum))) throw new PhysicalRecoveryRequired("Physical journal authority does not match this action.");
    if (existing) { const recovered = await recoverMove(existing, true); if (recovered) return recovered; }
    let entry: Journal;
    try { await moveWithoutReplacement(source, destination, checksum, {
      intent: async (identity) => { entry = { version: 1, owner, kind: "MOVE", source, destination, identity, created: false, state: "INTENT" }; await writeLocalJson(journalPath(owner), entry); },
      linked: async () => { entry.state = "LINKED"; await writeLocalJson(journalPath(owner), entry); await afterLinked?.(); },
      captureIntent: async (capture) => { entry.sourceCapture = capture; await writeLocalJson(journalPath(owner), entry); },
      captured: afterCaptured,
    });
    return await completeMove(entry!);
    } catch (error) {
      if (entry! && (entry.sourceCapture || entry.state !== "INTENT"))
        throw new PhysicalRecoveryRequired(error instanceof Error ? error.message : "The move needs journal recovery.");
      throw error;
    }
  });
}
export async function journaledCreateFolder(owner: string, destination: string) {
  return withLocalStoreLock(journalPath(owner), async () => {
    const existing = await load(owner);
    if (existing) {
      if (existing.kind !== "CREATE_FOLDER" || existing.destination !== destination) throw new PhysicalRecoveryRequired("Folder journal authority changed.");
      if (existing.state === "COMPLETED") return existing;
      if (await statOrAbsent(destination)) throw new PhysicalRecoveryRequired("An interrupted folder creation needs explicit ownership recovery.");
    }
    const entry: Journal = { version: 1, owner, kind: "CREATE_FOLDER", source: null, destination, state: "INTENT", identity: null, created: false };
    await writeLocalJson(journalPath(owner), entry);
    try { await mkdir(destination); entry.created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stats = await lstat(destination, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new PhysicalRecoveryRequired("Folder destination is not a safe directory.");
    entry.identity = { dev: stats.dev.toString(), ino: stats.ino.toString(), checksum: "", encoding: "bigint-v1" }; entry.state = "COMPLETED";
    await syncDirectory(path.dirname(destination)); await writeLocalJson(journalPath(owner), entry);
    return entry;
  });
}
async function cleanupCompletedDirectoryRemoval(entry: Journal) {
  const capture = entry.directoryCapture;
  if (!capture || !usablePhysicalIdentity(entry.identity))
    throw new PhysicalRecoveryRequired("The completed folder capture needs cleanup inspection.");
  const remaining = await statOrAbsent(capture.directory);
  if (remaining) {
    if (!remaining.isDirectory() || remaining.isSymbolicLink() || !samePhysicalIdentity(remaining, capture) || (await readdir(capture.directory)).length)
      throw new PhysicalRecoveryRequired("The completed folder capture needs cleanup inspection.");
    // COMPLETED proves the approved folder was removed. Only its exact empty
    // private container may be cleaned; never revisit the public folder name.
    await rmdir(capture.directory);
  }
  // Also finish a replay interrupted after rmdir but before the parent sync.
  await syncDirectory(path.dirname(entry.destination));
  return entry;
}
async function finishDirectoryRemoval(entry: Journal) {
  const capture = entry.directoryCapture;
  const container = capture ? await statOrAbsent(capture.directory) : null;
  if (!capture || !container?.isDirectory() || container.isSymbolicLink() || !samePhysicalIdentity(container, capture) ||
      !usablePhysicalIdentity(entry.identity))
    throw new PhysicalRecoveryRequired("The private folder capture cannot establish ownership; preserve it for recovery.");
  const captured = path.join(capture.directory, "directory"), stats = await statOrAbsent(captured);
  if (stats) {
    if (!stats.isDirectory() || stats.isSymbolicLink() || !samePhysicalIdentity(stats, entry.identity) || (await readdir(captured)).length)
      throw new PhysicalRecoveryRequired("The captured folder is not the empty directory owned by this execution; preserve it for recovery.");
    // LINKED proves that the exact owned directory reached the private capture.
    // INTENT plus absence alone never proves that a removal occurred.
    entry.state = "LINKED"; await writeLocalJson(journalPath(entry.owner), entry);
    await rmdir(captured); await syncDirectory(capture.directory);
  } else if (entry.state !== "LINKED") {
    throw new PhysicalRecoveryRequired("The interrupted folder capture has no verified removal proof.");
  }
  entry.state = "COMPLETED"; await writeLocalJson(journalPath(entry.owner), entry);
  return cleanupCompletedDirectoryRemoval(entry);
}
export async function journaledRemoveFolder(owner: string, originalOwner: string, target: string,
  afterCaptureIntent?: () => Promise<void>, afterCaptured?: () => Promise<void>) {
  return withLocalStoreLock(journalPath(owner), async () => {
    const existing = await load(owner);
    if (existing && (existing.kind !== "REMOVE_FOLDER" || existing.source !== target || existing.destination !== target || existing.originalOwner !== originalOwner))
      throw new PhysicalRecoveryRequired("Folder removal journal authority changed.");
    if (existing?.state === "COMPLETED") return existing.directoryCapture ? cleanupCompletedDirectoryRemoval(existing) : existing;
    if (existing?.directoryCapture) return finishDirectoryRemoval(existing);
    const original = await load(originalOwner), stats = await statOrAbsent(target);
    if (!original?.created || original.state !== "COMPLETED" || original.kind !== "CREATE_FOLDER" || original.destination !== target ||
        !stats?.isDirectory() || stats.isSymbolicLink() || !samePhysicalIdentity(stats, original.identity) ||
        (await readdir(target)).length !== 0) throw new PhysicalRecoveryRequired("The empty folder is not the directory owned by this execution.");
    const directory = await mkdtemp(path.join(path.dirname(target), ".nsn-remove-"));
    const container = await lstat(directory, { bigint: true });
    const entry: Journal = { version: 1, owner, kind: "REMOVE_FOLDER", source: target, destination: target,
      identity: original.identity, originalOwner, created: false, state: "INTENT",
      directoryCapture: { directory, dev: container.dev.toString(), ino: container.ino.toString(), encoding: "bigint-v1" } };
    await syncDirectory(path.dirname(target)); await writeLocalJson(journalPath(owner), entry);
    await afterCaptureIntent?.();
    // Never rmdir the public name after a check: capture first, then verify what
    // rename actually captured. A raced unrelated folder remains intact inside
    // the private capture and explicitly unresolved, never deleted/restored over
    // another public entry. Directory hard links cannot provide safe restoration.
    await rename(target, path.join(directory, "directory"));
    await syncDirectory(path.dirname(target)); await syncDirectory(directory);
    await afterCaptured?.();
    return finishDirectoryRemoval(entry);
  });
}
// This path records only already-owned outcomes; it cannot admit a new effect.
export type PhysicalActionBinding = { kind: Journal["kind"]; source: string | null; destination: string; checksum?: string | null; originalOwner?: string };
export function physicalActionBinding(rootPath: string, action: { actionType: string; sourceRelativePath?: string | null; destinationRelativePath: string; sourceChecksum?: string | null }, originalOwner?: string): PhysicalActionBinding {
  const absolute = (relative: string) => path.normalize(path.resolve(rootPath, ...normalizeRelativePath(relative).split("/")));
  const destination = absolute(action.destinationRelativePath);
  return { kind: action.actionType === "CREATE_FOLDER" ? "CREATE_FOLDER" : action.actionType === "REMOVE_FOLDER" ? "REMOVE_FOLDER" : "MOVE",
    source: action.actionType === "REMOVE_FOLDER" ? destination : action.sourceRelativePath ? absolute(action.sourceRelativePath) : null,
    destination, checksum: action.sourceChecksum, originalOwner };
}
export async function recoverPhysicalAction(owner: string, expected?: PhysicalActionBinding) {
  return withLocalStoreLock(journalPath(owner), async () => {
    const entry = await load(owner);
    if (entry && expected && (entry.kind !== expected.kind || entry.source !== expected.source || entry.destination !== expected.destination ||
        (expected.kind === "MOVE" && (!expected.checksum || entry.identity?.checksum !== expected.checksum)) ||
        (expected.kind === "REMOVE_FOLDER" && entry.originalOwner !== expected.originalOwner)))
      throw new PhysicalRecoveryRequired("Historical physical journal authority does not match this action.");
    if (!entry) return entry;
    if (entry.state === "COMPLETED") return entry.kind === "REMOVE_FOLDER" && entry.directoryCapture ? cleanupCompletedDirectoryRemoval(entry) : entry;
    if (entry.kind === "MOVE") return recoverMove(entry, false);
    if (entry.kind === "REMOVE_FOLDER" && entry.directoryCapture) return finishDirectoryRemoval(entry);
    throw new PhysicalRecoveryRequired("The interrupted folder action needs ownership recovery.");
  });
}
