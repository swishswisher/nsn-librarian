import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import { BridgeCloudError } from "@/lib/bridge/cloud-coordinator";
import { reconcileConnectedLibraryFingerprint } from "@/lib/bridge/connected-libraries";

type BridgeRootSyncInput = {
  connectedAt: string;
  createFolderPermission: boolean;
  displayName: string;
  id: string;
  lastScanAt: string | null;
  lastWatchingAt: string | null;
  moveFilePermission: boolean;
  organizationPlanPermission: boolean;
  platform: "WINDOWS" | "MACOS" | "LINUX" | "UNKNOWN";
  readPermission: boolean;
  recommendationPermission: boolean;
  renameFilePermission: boolean;
  safeLocation: string;
  status: "CONNECTED" | "PAUSED" | "NEEDS_ATTENTION" | "DISCONNECTED";
  watcherState: "WATCHING" | "PAUSED" | "STOPPED" | "NEEDS_ATTENTION";
  watchPermission: boolean;
};

function bridgeRootUri(rootId: string) {
  return `bridge://${rootId}`;
}

function validRootId(value: string) {
  return /^root_[a-f0-9]{24}$/u.test(value);
}

function connectedLibraryStatus(root: BridgeRootSyncInput) {
  if (root.status === "DISCONNECTED") {
    return "DISCONNECTED" as const;
  }

  if (root.status === "PAUSED") {
    return "PAUSED" as const;
  }

  if (root.status === "NEEDS_ATTENTION") {
    return "NEEDS_ATTENTION" as const;
  }

  return "CONNECTED" as const;
}

function monitoringState(root: BridgeRootSyncInput) {
  if (root.watcherState === "WATCHING") {
    return "WATCHING" as const;
  }

  if (root.watcherState === "PAUSED") {
    return "PAUSED" as const;
  }

  if (root.watcherState === "NEEDS_ATTENTION") {
    return "NEEDS_ATTENTION" as const;
  }

  return "STOPPED" as const;
}

function dateOrNull(value: string | null) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validatedRoot(value: unknown): BridgeRootSyncInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const root = value as Record<string, unknown>;
  const platform =
    root.platform === "WINDOWS" ||
    root.platform === "MACOS" ||
    root.platform === "LINUX" ||
    root.platform === "UNKNOWN"
      ? root.platform
      : "UNKNOWN";
  const status =
    root.status === "CONNECTED" ||
    root.status === "PAUSED" ||
    root.status === "NEEDS_ATTENTION" ||
    root.status === "DISCONNECTED"
      ? root.status
      : null;
  const watcherState =
    root.watcherState === "WATCHING" ||
    root.watcherState === "PAUSED" ||
    root.watcherState === "STOPPED" ||
    root.watcherState === "NEEDS_ATTENTION"
      ? root.watcherState
      : null;

  if (
    typeof root.id !== "string" ||
    !validRootId(root.id) ||
    typeof root.displayName !== "string" ||
    !root.displayName.trim() ||
    typeof root.safeLocation !== "string" ||
    !root.safeLocation.trim() ||
    typeof root.connectedAt !== "string" ||
    !status ||
    !watcherState
  ) {
    return null;
  }

  return {
    connectedAt: root.connectedAt,
    createFolderPermission: root.createFolderPermission === true,
    displayName: root.displayName.trim().slice(0, 200),
    id: root.id,
    lastScanAt: typeof root.lastScanAt === "string" ? root.lastScanAt : null,
    lastWatchingAt:
      typeof root.lastWatchingAt === "string" ? root.lastWatchingAt : null,
    moveFilePermission: root.moveFilePermission === true,
    organizationPlanPermission: root.organizationPlanPermission === true,
    platform,
    readPermission: root.readPermission === true,
    recommendationPermission: root.recommendationPermission === true,
    renameFilePermission: root.renameFilePermission === true,
    safeLocation: root.safeLocation.trim().slice(0, 500),
    status,
    watcherState,
    watchPermission: root.watchPermission === true,
  };
}

export async function syncBridgeDeviceRoots(
  bridgeDeviceId: string,
  input: unknown,
) {
  const roots = Array.isArray(input)
    ? input.map(validatedRoot).filter((root): root is BridgeRootSyncInput => Boolean(root))
    : [];

  if (roots.length > 100) {
    throw new BridgeCloudError(
      "Too many connected folders were included in one Bridge update.",
      413,
    );
  }

  const prisma = getPrismaClient();
  const now = new Date();
  const synced = [];

  for (const root of roots) {
    const canonical = await reconcileConnectedLibraryFingerprint(root.id);
    const existing =
      canonical ??
      (await prisma.connectedLibrary.findFirst({
        where: {
          OR: [
            { bridgeRootId: root.id },
            { folderFingerprint: root.id },
            { localPath: bridgeRootUri(root.id) },
          ],
        },
      }));
    const commonData = {
      bridgeDeviceId,
      bridgeRootId: root.id,
      canonicalConnectedLibraryId: null,
      createFolderPermission: root.createFolderPermission,
      disconnectedAt:
        root.status === "DISCONNECTED" ? now : null,
      displayName: root.displayName,
      folderFingerprint: root.id,
      hiddenFromActiveListAt: null,
      isEnabled: root.status !== "DISCONNECTED",
      isLegacyConnection: false,
      lastBridgeCheckAt: now,
      lastMonitoringAt: dateOrNull(root.lastWatchingAt),
      lastScanAt: dateOrNull(root.lastScanAt),
      legacyReason: null,
      localPath: bridgeRootUri(root.id),
      mergedAt: null,
      monitoringHeartbeatAt:
        root.watcherState === "WATCHING" ? now : null,
      monitoringLastCheckAt: dateOrNull(root.lastWatchingAt),
      monitoringLastSuccessfulCheckAt: dateOrNull(root.lastWatchingAt),
      monitoringPausedAt:
        root.watcherState === "PAUSED" ? now : null,
      monitoringStartedAt:
        root.watcherState === "WATCHING" ? now : null,
      monitoringState: monitoringState(root),
      monitoringStoppedAt:
        root.watcherState === "STOPPED" ? now : null,
      moveFilePermission: root.moveFilePermission,
      organizationPlanPermission: root.organizationPlanPermission,
      platform: root.platform,
      readPermission: root.readPermission,
      recommendationPermission: root.recommendationPermission,
      renameFilePermission: root.renameFilePermission,
      safeLocalLocation: root.safeLocation,
      status: connectedLibraryStatus(root),
      watchPermission: root.watchPermission,
    } satisfies Prisma.ConnectedLibraryUncheckedUpdateInput;

    const library = existing
      ? await prisma.connectedLibrary.update({
          data: commonData,
          where: { id: existing.id },
        })
      : await prisma.connectedLibrary.create({
          data: {
            ...commonData,
            connectedAt: dateOrNull(root.connectedAt) ?? now,
          },
        });

    synced.push({
      bridgeRootId: library.bridgeRootId,
      displayName: library.displayName,
      id: library.id,
      monitoringState: library.monitoringState,
      status: library.status,
    });

    await reconcileConnectedLibraryFingerprint(root.id);
  }

  return synced;
}
