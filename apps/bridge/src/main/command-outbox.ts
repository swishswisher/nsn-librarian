import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BridgeCommandReport } from "../../../../packages/bridge-protocol/src";

export type PendingBridgeCommandReport = {
  queuedAt: string;
  replayKey: string;
  report: BridgeCommandReport;
};

function dataDirectory() {
  return (
    process.env.NSN_BRIDGE_DATA_DIR?.trim() ||
    path.join(os.homedir(), ".nsn-bridge")
  );
}

function outboxPath() {
  return path.join(dataDirectory(), "command-outbox.json");
}

async function writeOutbox(entries: PendingBridgeCommandReport[]) {
  await mkdir(dataDirectory(), { recursive: true, mode: 0o700 });
  const target = outboxPath();
  const temporary = `${target}.${process.pid}.tmp`;

  await writeFile(temporary, `${JSON.stringify(entries)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

export async function loadBridgeCommandOutbox() {
  try {
    const parsed = JSON.parse(await readFile(outboxPath(), "utf8")) as unknown;

    if (!Array.isArray(parsed)) {
      return [] as PendingBridgeCommandReport[];
    }

    return parsed.filter(
      (item): item is PendingBridgeCommandReport =>
        typeof item === "object" &&
        item !== null &&
        typeof item.queuedAt === "string" &&
        typeof item.replayKey === "string" &&
        typeof item.report === "object" &&
        item.report !== null &&
        typeof item.report.commandId === "string" &&
        (item.report.status === "COMPLETED" ||
          item.report.status === "FAILED" ||
          item.report.status === "REJECTED"),
    );
  } catch {
    return [];
  }
}

export async function queueBridgeCommandReport(
  replayKey: string,
  report: BridgeCommandReport,
) {
  const current = await loadBridgeCommandOutbox();
  const next = [
    ...current.filter((item) => item.report.commandId !== report.commandId),
    {
      queuedAt: new Date().toISOString(),
      replayKey,
      report,
    },
  ];

  await writeOutbox(next);
}

export async function removeBridgeCommandReport(commandId: string) {
  const current = await loadBridgeCommandOutbox();
  const next = current.filter((item) => item.report.commandId !== commandId);

  if (next.length !== current.length) {
    await writeOutbox(next);
  }
}
