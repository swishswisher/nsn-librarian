import { recoverMonitoringBatchesForDevice } from "./monitor";
import { expireUnstartedCommands } from "./command-lifecycle";
import type {
  BridgeCommandEnvelope,
  BridgeCommandType,
  BridgeJson,
} from "../../../packages/bridge-protocol/src";
import { getPrismaClient } from "@/lib/db/prisma";

import { authorizedBridgeCommands, recordBridgeHeartbeat, BridgeCloudError } from "./cloud-coordinator";
import { queueNextRemoteReadBatchForDevice } from "./remote-scan-queue";
import { expireRemoteReadCommandsForSession } from "./remote-read-commands";
import { recoverScanPublicationsForDevice } from "./scan-publication";
import { recoverAbandonedObservationFilesForDevice } from "./observation-recovery";
import { recoverPendingObservationMemory } from "@/lib/library/memory";
import { recoverRecommendationBatchesForDevice } from "./scan-recommendation-batch";

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

export async function fetchRecoverableBridgeCommands(bridgeDeviceId: string, expectedPublicKey?: string) {
  const prisma = getPrismaClient();
  const now = new Date();

  await recordBridgeHeartbeat(bridgeDeviceId, {}, expectedPublicKey);
  await recoverPendingObservationMemory();
  await recoverRecommendationBatchesForDevice(bridgeDeviceId, now);
  await recoverAbandonedObservationFilesForDevice(bridgeDeviceId, now);
  await recoverScanPublicationsForDevice(bridgeDeviceId, now);
  await recoverMonitoringBatchesForDevice(bridgeDeviceId);
  await (await import("./execution-reconciliation")).recoverExecutionReconciliations({ bridgeDeviceId });
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
  await expireUnstartedCommands(now, bridgeDeviceId);

  const rows = await prisma.bridgeCommand.findMany({
    orderBy: { issuedAt: "asc" },
    where: {
      bridgeDeviceId,
      OR: [{ expiresAt: { gt: now }, status: { in: ["PENDING", "ACKNOWLEDGED", "RUNNING"] } },
        { commandType: { in: ["EXECUTE_PLAN", "EXECUTE_UNDO"] }, status: { in: ["ACKNOWLEDGED", "RUNNING"] } }],
    },
  });

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${bridgeDeviceId} FOR SHARE`;
    const device = await tx.bridgeDevice.findUnique({ where: { bridgeDeviceId } });
    if (!device || device.revokedAt || device.status === "REVOKED" || (expectedPublicKey && device.publicKey !== expectedPublicKey))
      throw new BridgeCloudError("Device authority changed before command delivery.", 401);
    return (await authorizedBridgeCommands(rows, tx)).map(envelopeFromRow);
  });
}
