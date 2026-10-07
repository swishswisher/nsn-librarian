import { createHash } from "node:crypto";
import { mkdir, readdir, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readLocalJson, writeLocalJson } from "../../../../bridge-app/src/main/local-json-store";
import { hashBridgeCommandPayload, type BridgeCommandEnvelope } from "../../../../packages/bridge-protocol/src";
import { syncDirectory } from "../../../../bridge-app/src/filesystem/safe-move";

type CommandJournal = { version: 1; command: BridgeCommandEnvelope; delivered: boolean };
function directory() { return path.join(process.env.NSN_BRIDGE_DATA_DIR?.trim() || path.join(os.homedir(), ".nsn-bridge"), "physical-commands"); }
function target(commandId: string) { return path.join(directory(), `${createHash("sha256").update(commandId).digest("hex")}.json`); }
function validate(value: unknown): CommandJournal {
  const entry = value as CommandJournal;
  if (!entry || entry.version !== 1 || typeof entry.delivered !== "boolean" || !entry.command ||
      typeof entry.command.commandId !== "string" || typeof entry.command.bridgeDeviceId !== "string" ||
      !["EXECUTE_PLAN", "EXECUTE_UNDO"].includes(entry.command.commandType) ||
      hashBridgeCommandPayload(entry.command.payload) !== entry.command.payloadHash)
    throw new Error("The physical command journal needs recovery; preserve its bytes.");
  return entry;
}
export async function preparePhysicalCommand(command: BridgeCommandEnvelope) {
  const existing = await readLocalJson(target(command.commandId), () => null as CommandJournal | null, validate) ??
    await readLocalJson(path.join(directory(), "history", path.basename(target(command.commandId))), () => null as CommandJournal | null, validate);
  if (existing) {
    if (existing.command.payloadHash !== command.payloadHash || existing.command.signature !== command.signature)
      throw new Error("Physical command journal authority changed.");
    return;
  }
  await writeLocalJson(target(command.commandId), { version: 1, command, delivered: false });
}
export async function markPhysicalCommandDelivered(command: BridgeCommandEnvelope) {
  await writeLocalJson(target(command.commandId), { version: 1, command, delivered: true });
  const history = path.join(directory(), "history");
  await mkdir(history, { recursive: true, mode: 0o700 });
  await rename(target(command.commandId), path.join(history, path.basename(target(command.commandId))));
  await syncDirectory(directory()); await syncDirectory(history);
}
export async function unfinishedPhysicalCommands(deviceId: string) {
  let names: string[];
  try { names = await readdir(directory()); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const commands: BridgeCommandEnvelope[] = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const entry = await readLocalJson(path.join(directory(), name), () => null as CommandJournal | null, validate);
    if (entry && !entry.delivered && entry.command.bridgeDeviceId === deviceId) commands.push(entry.command);
  }
  return commands;
}
