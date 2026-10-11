import { readLocalJson, withLocalStoreLock, writeLocalJson } from "../../../../bridge-app/src/main/local-json-store";
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
  await writeLocalJson(outboxPath(), entries);
}

export async function loadBridgeCommandOutbox() {
  return readLocalJson(outboxPath(), () => [] as PendingBridgeCommandReport[], (parsed) => {
    if (!Array.isArray(parsed)) {
      throw new Error("The local command report outbox needs recovery.");
    }

    const valid = parsed.filter(
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
    if (valid.length !== parsed.length) throw new Error("The local command report outbox needs recovery.");
    return valid;
  });
}

export async function queueBridgeCommandReport(
  replayKey: string,
  report: BridgeCommandReport,
) {
  return withLocalStoreLock(outboxPath(), async () => {
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
  });
}

export async function removeBridgeCommandReport(commandId: string) {
  return withLocalStoreLock(outboxPath(), async () => {
  const current = await loadBridgeCommandOutbox();
  const next = current.filter((item) => item.report.commandId !== commandId);

  if (next.length !== current.length) {
    await writeOutbox(next);
  }
  });
}
