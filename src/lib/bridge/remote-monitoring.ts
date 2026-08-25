import { getPrismaClient } from "@/lib/db/prisma";
import {
  BridgeCloudError,
  createBridgeCloudCommand,
} from "@/lib/bridge/cloud-coordinator";

import { getConnectedLibraries, getConnectedLibrary } from "./connected-libraries";

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

export async function getRemoteMonitoringActionStatus(
  connectedLibraryId: string,
  commandId: string,
) {
  const prisma = getPrismaClient();
  const command = await prisma.bridgeCommand.findUnique({
    where: { commandId },
  });

  if (
    !command ||
    command.connectedLibraryId !== connectedLibraryId ||
    (command.commandType !== "START_WATCHING" &&
      command.commandType !== "PAUSE_WATCHING" &&
      command.commandType !== "RESUME_WATCHING" &&
      command.commandType !== "STOP_WATCHING")
  ) {
    throw new BridgeCloudError(
      "The Librarian could not find that watching update.",
      404,
    );
  }

  const library = await getConnectedLibrary(connectedLibraryId);

  if (command.status === "COMPLETED") {
    return {
      done: true,
      library,
      status: "COMPLETED" as const,
    };
  }

  if (
    command.status === "FAILED" ||
    command.status === "REJECTED" ||
    command.status === "EXPIRED" ||
    command.status === "CANCELLED"
  ) {
    return {
      done: true,
      error:
        "The Bridge could not update watching. The previous confirmed state is still in place.",
      library,
      status: command.status,
    };
  }

  return {
    done: false,
    library,
    status: command.status,
  };
}
