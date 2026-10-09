import { retireRootReadWork } from "./command-lifecycle";
import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import { BridgeCloudError } from "@/lib/bridge/cloud-coordinator";
import { lockAuthorityOwner } from "@/lib/db/authority";
import { reconcileConnectedLibraryFingerprintInTransaction } from "./connected-libraries";
import {
  bridgePermissionSnapshot,
  logBridgePermissionDiagnostic,
} from "@/lib/bridge/permission-diagnostics";
import type { ConnectedLibraryPermissions } from "@/lib/bridge/types";

type BridgeRootSyncInput = {
  connectionRevision: number;
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
  updatedAt: string | null;
  watcherState: "WATCHING" | "PAUSED" | "STOPPED" | "NEEDS_ATTENTION";
  watchPermission: boolean;
};

type PermissionSnapshot = ConnectedLibraryPermissions;

const permissionKeys: Array<keyof ConnectedLibraryPermissions> = [
  "readPermission",
  "watchPermission",
  "recommendationPermission",
  "organizationPlanPermission",
  "createFolderPermission",
  "moveFilePermission",
  "renameFilePermission",
];

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

function objectValue(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function permissionSnapshotFromRoot(root: BridgeRootSyncInput): PermissionSnapshot {
  return {
    createFolderPermission: root.createFolderPermission,
    moveFilePermission: root.moveFilePermission,
    organizationPlanPermission: root.organizationPlanPermission,
    readPermission: root.readPermission,
    recommendationPermission: root.recommendationPermission,
    renameFilePermission: root.renameFilePermission,
    watchPermission: root.watchPermission,
  };
}

function permissionSnapshotFromCommandResult(result: Prisma.JsonValue | null) {
  const value = objectValue(result);
  const permissionsValue = objectValue(value?.permissions);

  if (!value || !permissionsValue) {
    return null;
  }

  const permissions: Partial<PermissionSnapshot> = {};

  for (const key of permissionKeys) {
    if (typeof permissionsValue[key] === "boolean") {
      permissions[key] = permissionsValue[key];
    }
  }

  if (permissionKeys.some((key) => typeof permissions[key] !== "boolean")) {
    return null;
  }

  return {
    permissions: permissions as PermissionSnapshot,
    rootUpdatedAt:
      typeof value.rootUpdatedAt === "string" ? value.rootUpdatedAt : null,
  };
}

async function latestConfirmedPermissionUpdate(
  prisma: Prisma.TransactionClient,
  input: {
    bridgeDeviceId: string;
    bridgeRootId: string;
  },
) {
  const command = await prisma.bridgeCommand.findFirst({
    orderBy: {
      completedAt: "desc",
    },
    where: {
      bridgeDeviceId: input.bridgeDeviceId,
      bridgeRootId: input.bridgeRootId,
      commandType: "UPDATE_ROOT_PERMISSIONS",
      status: "COMPLETED",
    },
  });

  return command ? permissionSnapshotFromCommandResult(command.result) : null;
}

function stalePermissionSync(input: {
  confirmedRootUpdatedAt: string | null;
  incomingRootUpdatedAt: string | null;
}) {
  const confirmed = dateOrNull(input.confirmedRootUpdatedAt);

  if (!confirmed) {
    return false;
  }

  const incoming = dateOrNull(input.incomingRootUpdatedAt);

  return !incoming || incoming.getTime() < confirmed.getTime();
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
    connectionRevision: Number.isSafeInteger(root.connectionRevision) && (root.connectionRevision as number) > 0
      ? root.connectionRevision as number : 0,
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
    updatedAt: typeof root.updatedAt === "string" ? root.updatedAt : null,
    watcherState,
    watchPermission: root.watchPermission === true,
  };
}

export async function syncBridgeDeviceRoots(
  bridgeDeviceId: string,
  input: unknown,
  expectedPublicKey?: string,
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
    const library = await prisma.$transaction(async (tx) => {
      const prisma = tx;
      const devices = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "BridgeDevice"
        WHERE "bridgeDeviceId" = ${bridgeDeviceId} AND status <> 'REVOKED' AND "revokedAt" IS NULL FOR SHARE`;
      if (!devices.length) throw new BridgeCloudError("This Bridge device is not available.", 403);
      if (expectedPublicKey && (await tx.bridgeDevice.findUniqueOrThrow({ where: { bridgeDeviceId } })).publicKey !== expectedPublicKey)
        throw new BridgeCloudError("This request belongs to an older device key.", 401);
      const canonical = await reconcileConnectedLibraryFingerprintInTransaction(tx, root.id, bridgeDeviceId);
      let existing = canonical ? await tx.connectedLibrary.findUniqueOrThrow({ where: { id: canonical.id } }) : null;
      if (existing) {
        await lockAuthorityOwner(tx, "ConnectedFolder", existing.id);
        existing = await tx.connectedLibrary.findUniqueOrThrow({ where: { id: existing.id } });
        if (existing.bridgeDeviceId && existing.bridgeDeviceId !== bridgeDeviceId) {
          throw new BridgeCloudError("This folder identity is already bound to another paired Mac.", 409, "ROOT_DEVICE_MISMATCH");
        }
      }
      const explicitlyReconnected = Boolean(existing && root.connectionRevision > existing.nativeConnectionRevision);
      if (existing && explicitlyReconnected) await retireRootReadWork(tx, existing.id);
      const lifecycleDenied = Boolean(existing && (!existing.isEnabled || existing.status !== "CONNECTED" ||
        existing.disconnectedAt || existing.hiddenFromActiveListAt || existing.mergedAt || existing.canonicalConnectedLibraryId));
      const incomingUpdatedAt = dateOrNull(root.updatedAt);
      const staleState = Boolean(existing && (root.connectionRevision < existing.nativeConnectionRevision ||
        (existing.nativeRootUpdatedAt && (!incomingUpdatedAt || incomingUpdatedAt < existing.nativeRootUpdatedAt))));
    const confirmedPermissionUpdate = await latestConfirmedPermissionUpdate(
      prisma,
      {
        bridgeDeviceId,
        bridgeRootId: root.id,
      },
    );
    const rootPermissions = permissionSnapshotFromRoot(root);
    const stalePermissions = confirmedPermissionUpdate
      ? stalePermissionSync({
          confirmedRootUpdatedAt: confirmedPermissionUpdate.rootUpdatedAt,
          incomingRootUpdatedAt: root.updatedAt,
        })
      : false;
    const effectivePermissions = stalePermissions
      ? confirmedPermissionUpdate?.permissions ?? rootPermissions
      : rootPermissions;

    logBridgePermissionDiagnostic({
      bridgeRootId: root.id,
      commandType: "UPDATE_ROOT_PERMISSIONS",
      confirmedRootUpdatedAt:
        confirmedPermissionUpdate?.rootUpdatedAt ?? null,
      event: "root-sync",
      ignoredBecause: stalePermissions ? "STALE_ROOT_SYNC" : null,
      permissions: bridgePermissionSnapshot(effectivePermissions),
      rootUpdatedAt: root.updatedAt,
    });

    const nextMonitoringState = monitoringState(root);
    const previousMonitoringState = existing?.monitoringState ?? "STOPPED";
    const nativeWatching = nextMonitoringState === "WATCHING";
    const transitionIntoWatching =
      nativeWatching && previousMonitoringState !== "WATCHING";
    const lastWatchingAt = dateOrNull(root.lastWatchingAt);
    const monitoringStartedAt = nativeWatching
      ? transitionIntoWatching
        ? lastWatchingAt ?? now
        : existing?.monitoringStartedAt ?? lastWatchingAt ?? now
      : existing?.monitoringStartedAt ?? null;
    const monitoringPausedAt =
      nextMonitoringState === "PAUSED"
        ? previousMonitoringState === "PAUSED"
          ? existing?.monitoringPausedAt ?? now
          : now
        : nativeWatching
          ? null
          : existing?.monitoringPausedAt ?? null;
    const monitoringStoppedAt =
      nextMonitoringState === "STOPPED"
        ? previousMonitoringState === "STOPPED"
          ? existing?.monitoringStoppedAt ?? now
          : now
        : nativeWatching || nextMonitoringState === "PAUSED"
          ? null
          : existing?.monitoringStoppedAt ?? null;
    const commonData = {
      bridgeDeviceId,
      bridgeRootId: root.id,
      canonicalConnectedLibraryId: null,
      createFolderPermission: effectivePermissions.createFolderPermission,
      disconnectedAt:
        root.status === "DISCONNECTED" ? now : null,
      displayName: root.displayName,
      folderFingerprint: root.id,
      hiddenFromActiveListAt: null,
      isEnabled: root.status !== "DISCONNECTED",
      isLegacyConnection: false,
      lastBridgeCheckAt: now,
      lastMonitoringAt: nativeWatching
        ? lastWatchingAt ?? now
        : existing?.lastMonitoringAt ?? null,
      lastScanAt: dateOrNull(root.lastScanAt),
      legacyReason: null,
      localPath: bridgeRootUri(root.id),
      mergedAt: null,
      monitoringHeartbeatAt:
        nativeWatching ? now : null,
      monitoringLastCheckAt: now,
      monitoringLastSuccessfulCheckAt: now,
      monitoringPausedAt,
      monitoringStartedAt,
      monitoringState: nextMonitoringState,
      monitoringStoppedAt,
      moveFilePermission: effectivePermissions.moveFilePermission,
      organizationPlanPermission:
        effectivePermissions.organizationPlanPermission,
      platform: root.platform,
      readPermission: effectivePermissions.readPermission,
      recommendationPermission: effectivePermissions.recommendationPermission,
      renameFilePermission: effectivePermissions.renameFilePermission,
      safeLocalLocation: root.safeLocation,
      status: connectedLibraryStatus(root),
      watchPermission: effectivePermissions.watchPermission,
      nativeConnectionRevision: Math.max(existing?.nativeConnectionRevision ?? 0, root.connectionRevision),
      nativeRootUpdatedAt: staleState ? existing?.nativeRootUpdatedAt : incomingUpdatedAt,
    } satisfies Prisma.ConnectedLibraryUncheckedUpdateInput;

    if (existing && (staleState || existing.mergedAt || existing.canonicalConnectedLibraryId || (lifecycleDenied && !explicitlyReconnected))) {
      // A scan/watch heartbeat cannot clear a human lifecycle decision. Merged
      // aliases never become independent roots through native synchronization.
      Object.assign(commonData, {
        canonicalConnectedLibraryId: existing.canonicalConnectedLibraryId,
        disconnectedAt: existing.disconnectedAt,
        hiddenFromActiveListAt: existing.hiddenFromActiveListAt,
        mergedAt: existing.mergedAt,
        isEnabled: existing.isEnabled,
        status: existing.status,
        monitoringState: existing.monitoringState,
        monitoringHeartbeatAt: existing.monitoringHeartbeatAt,
        ...Object.fromEntries(permissionKeys.map((key) => [key, existing[key]])),
      });
    }

    return existing
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
    });

    synced.push({
      bridgeRootId: library.bridgeRootId,
      displayName: library.displayName,
      id: library.id,
      monitoringState: library.monitoringState,
      status: library.status,
    });

  }

  return synced;
}
