import type {
  BridgeCommandEnvelope,
  BridgeCommandType,
  BridgeJson,
} from "../../../packages/bridge-protocol/src";
import { getPrismaClient } from "@/lib/db/prisma";

import { recordBridgeHeartbeat } from "./cloud-coordinator";
import { queueNextRemoteReadBatchForDevice } from "./remote-scan-queue";
import { expireRemoteReadCommandsForSession } from "./remote-read-commands";
import { recoverAbandonedObservationFilesForDevice } from "./observation-recovery";

function bridgeJson(value: unknown): BridgeJson {
  return JSON.parse(JSON.stringify(value)) as BridgeJson;
}

function envelopeFromRow(row: {
  authorizationContext: unknown;
  bridgeDeviceId: string;
  bridgeRootId: string | null;
  commandId: string;
  commandType: string;
  connectedLibraryId: string | null;
  expiresAt: Date;
  idempotencyKey: string;
  issuedAt: Date;
  payload: unknown;
  payloadHash: string;
  signature: string;
}): BridgeCommandEnvelope {
  return {
    authorizationContext: bridgeJson(row.authorizationContext),
    bridgeDeviceId: row.bridgeDeviceId,
    bridgeRootId: row.bridgeRootId,
    commandId: row.commandId,
    commandType: row.commandType as BridgeCommandType,
    connectedLibraryId: row.connectedLibraryId,
    expiresAt: row.expiresAt.toISOString(),
    idempotencyKey: row.idempotencyKey,
    issuedAt: row.issuedAt.toISOString(),
    payload: bridgeJson(row.payload),
    payloadHash: row.payloadHash,
    signature: row.signature,
  };
}

export async function fetchRecoverableBridgeCommands(bridgeDeviceId: string) {
  const prisma = getPrismaClient();
  const now = new Date();

  await recordBridgeHeartbeat(bridgeDeviceId).catch(() => undefined);
  await recoverAbandonedObservationFilesForDevice(bridgeDeviceId, now);
  const expiredReads = await prisma.bridgeCommand.findMany({
    select: { payload: true },
    where: {
      bridgeDeviceId,
      commandType: "READ_FILE_TEMPORARILY",
      expiresAt: { lte: now },
      status: { in: ["PENDING", "ACKNOWLEDGED", "RUNNING"] },
    },
  });
  const expiredSessions = new Set<string>();

  for (const command of expiredReads) {
    const payload = command.payload;

    if (typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
        typeof (payload as Record<string, unknown>).scanSessionId === "string") {
      expiredSessions.add((payload as Record<string, string>).scanSessionId);
    }
  }

  for (const sessionId of expiredSessions) {
    await expireRemoteReadCommandsForSession(sessionId, now, false);
  }

  await queueNextRemoteReadBatchForDevice(bridgeDeviceId).catch(() => undefined);
  await prisma.bridgeCommand.updateMany({
    data: { status: "EXPIRED" },
    where: {
      bridgeDeviceId,
      commandType: { not: "READ_FILE_TEMPORARILY" },
      expiresAt: { lte: now },
      status: { in: ["PENDING", "ACKNOWLEDGED", "RUNNING"] },
    },
  });

  const rows = await prisma.bridgeCommand.findMany({
    orderBy: { issuedAt: "asc" },
    where: {
      bridgeDeviceId,
      expiresAt: { gt: now },
      status: { in: ["PENDING", "ACKNOWLEDGED", "RUNNING"] },
    },
  });

  return rows.map(envelopeFromRow);
}
