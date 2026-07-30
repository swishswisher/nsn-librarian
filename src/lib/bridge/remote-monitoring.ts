import { getPrismaClient } from "@/lib/db/prisma";
import {
  BridgeCloudError,
  createBridgeCloudCommand,
} from "@/lib/bridge/cloud-coordinator";

import { getConnectedLibraries } from "./connected-libraries";

type RemoteMonitoringAction = "start" | "pause" | "resume";

const onlineWindowMs = 90_000;

function commandTypeFor(action: RemoteMonitoringAction) {
  if (action === "pause") {
    return "PAUSE_WATCHING" as const;
  }

  return action === "resume"
    ? "RESUME_WATCHING" as const
    : "START_WATCHING" as const;
}

export async function queueRemoteMonitoringAction(
  connectedLibraryId: string,
  action: RemoteMonitoringAction,
) {
  const prisma = getPrismaClient();
  const library = await prisma.connectedLibrary.findUnique({
    include: { bridgeDevice: true },
    where: { id: connectedLibraryId },
  });

  if (!library || !library.isEnabled || library.status === "DISCONNECTED") {
    throw new BridgeCloudError(
      "Reconnect this folder before changing watching.",
      409,
    );
  }

  if (!library.bridgeDeviceId || !library.bridgeRootId || !library.bridgeDevice) {
    throw new BridgeCloudError(
      "Pair and reconnect this Mac before changing watching.",
      409,
    );
  }

  if (!library.readPermission || !library.watchPermission) {
    throw new BridgeCloudError(
      "Read and Watch permissions are required before watching can start.",
      403,
    );
  }

  const lastSeenAt = library.bridgeDevice.lastSeenAt?.getTime() ?? Number.NaN;
  const online =
    library.bridgeDevice.status === "ONLINE" &&
    Number.isFinite(lastSeenAt) &&
    Date.now() - lastSeenAt <= onlineWindowMs;

  if (!online) {
    throw new BridgeCloudError(
      "Open NSN Bridge on this Mac before changing watching.",
      409,
    );
  }

  const command = await createBridgeCloudCommand({
    authorizationContext: {
      initiatedBy: "Deanne",
      purpose:
        action === "pause"
          ? "Pause read-only watching for this connected folder."
          : "Use read-only watching for this connected folder.",
    },
    bridgeDeviceId: library.bridgeDeviceId,
    bridgeRootId: library.bridgeRootId,
    commandType: commandTypeFor(action),
    connectedLibraryId,
    idempotencyKey: `monitor:${connectedLibraryId}:${action}:${Date.now()}`,
    payload: {},
  });
  const now = new Date();
  const monitoringState = action === "pause" ? "PAUSED" : "WATCHING";

  await prisma.connectedLibrary.update({
    data: {
      monitoringHeartbeatAt:
        action === "pause" ? library.monitoringHeartbeatAt : now,
      monitoringPausedAt: action === "pause" ? now : null,
      monitoringStartedAt:
        action === "start" ? now : library.monitoringStartedAt ?? now,
      monitoringState,
      monitoringStoppedAt: null,
      status: action === "pause" ? "PAUSED" : "CONNECTED",
    },
    where: { id: connectedLibraryId },
  });
  const libraries = await getConnectedLibraries();
  const updatedLibrary = libraries.find(
    (item) => item.id === connectedLibraryId,
  );

  if (!updatedLibrary) {
    throw new BridgeCloudError(
      "The Librarian could not refresh this connected folder.",
      500,
    );
  }

  return {
    commandId: command.commandId,
    library: {
      ...updatedLibrary,
      bridgeReachable: true,
    },
    message:
      action === "pause"
        ? "Watching pause sent to this Mac."
        : action === "resume"
          ? "Watching resume sent to this Mac."
          : "Watching start sent to this Mac.",
  };
}
