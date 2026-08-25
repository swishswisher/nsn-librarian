import { constants as fsConstants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import {
  BridgeCloudError,
  createBridgeCloudCommand,
} from "@/lib/bridge/cloud-coordinator";
import {
  bridgePermissionSnapshot,
  logBridgePermissionDiagnostic,
} from "@/lib/bridge/permission-diagnostics";

import type {
  ConnectedLibraryPermissions,
  ConnectedLibraryPlatform,
  ConnectedLibraryStatus,
  ConnectedLibrarySummary,
} from "./types";
import {
  disconnectLocalBridgeRoot,
  getLocalBridgeHealth,
  type LocalBridgeRootSummary,
  updateLocalBridgeRoot,
} from "./local-bridge-client";

export type ConnectedLibraryPermission = keyof ConnectedLibraryPermissions;

type StoredConnectedLibrary = {
  bridgeDeviceId: string | null;
  bridgeRootId: string | null;
  canonicalConnectedLibraryId: string | null;
  connectedAt: Date;
  createFolderPermission: boolean;
  disconnectedAt: Date | null;
  displayName: string;
  folderFingerprint: string | null;
  hiddenFromActiveListAt: Date | null;
  id: string;
  isEnabled: boolean;
  isLegacyConnection: boolean;
  lastMonitoringAt: Date | null;
  lastBridgeCheckAt: Date | null;
  lastScanAt: Date | null;
  legacyReason: string | null;
  localPath: string;
  mergedAt: Date | null;
  monitoringErrorCategory: string | null;
  monitoringHeartbeatAt: Date | null;
  monitoringLastCheckAt: Date | null;
  monitoringLastSuccessfulCheckAt: Date | null;
  monitoringPausedAt: Date | null;
  monitoringStartedAt: Date | null;
  monitoringState: string;
  monitoringStoppedAt: Date | null;
  moveFilePermission: boolean;
  organizationPlanPermission: boolean;
  platform: string;
  readPermission: boolean;
  recommendationPermission: boolean;
  renameFilePermission: boolean;
  safeLocalLocation: string | null;
  status: string;
  watchPermission: boolean;
  _count?: {
    monitoringEvents?: number;
    scanSessions?: number;
  };
};

type ConnectLibraryInput = Partial<ConnectedLibraryPermissions> & {
  displayName?: string;
  localPath: string;
};

type ConnectBridgeLibraryInput = {
  root: LocalBridgeRootSummary;
  updateExistingPermissions?: boolean;
};

export type ConnectedLibraryConnectionAction =
  | "CONNECTED"
  | "RECONNECTED"
  | "ALREADY_CONNECTED";

export type ConnectedLibraryConnectionResult = {
  action: ConnectedLibraryConnectionAction;
  alreadyConnected: boolean;
  library: ConnectedLibrarySummary;
};

type UpdateLibraryInput = Partial<ConnectedLibraryPermissions> & {
  displayName?: string;
  status?: ConnectedLibraryStatus;
};

type ConnectedLibraryUpdateResult = {
  action: "UPDATED";
  library: ConnectedLibrarySummary;
  permissionUpdate?: {
    commandId: string;
    status: "PENDING";
  };
};

export class ConnectedLibraryError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ConnectedLibraryError";
    this.statusCode = statusCode;
  }
}

export const defaultConnectedLibraryPermissions: ConnectedLibraryPermissions = {
  createFolderPermission: false,
  moveFilePermission: false,
  organizationPlanPermission: true,
  readPermission: true,
  recommendationPermission: true,
  renameFilePermission: false,
  watchPermission: false,
};

const connectedLibraryStatuses = new Set<ConnectedLibraryStatus>([
  "CONNECTED",
  "PAUSED",
  "NEEDS_ATTENTION",
  "DISCONNECTED",
  "MERGED",
  "HIDDEN_FROM_ACTIVE_LIST",
]);

function displayNameForFolder(folderPath: string) {
  return path.basename(folderPath) || folderPath;
}

function platformForLocalPath(): ConnectedLibraryPlatform {
  if (process.platform === "win32") {
    return "WINDOWS";
  }

  if (process.platform === "darwin") {
    return "MACOS";
  }

  if (process.platform === "linux") {
    return "LINUX";
  }

  return "UNKNOWN";
}

function bridgeRootUri(rootId: string) {
  return `bridge://${rootId}`;
}

function bridgeRootIdFromUri(value: string) {
  const match = /^bridge:\/\/([^/]+)(?:\/.*)?$/.exec(value);

  return match?.[1] ?? null;
}

export function stableFolderFingerprintForLocalPath(localPath: string) {
  const normalized = path.normalize(path.resolve(localPath));
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const hash = createHash("sha256").update(key).digest("hex");

  return `root_${hash.slice(0, 24)}`;
}

function localBridgeRootIdForKnownPath(localPath: string) {
  return stableFolderFingerprintForLocalPath(localPath);
}

function folderFingerprintForStoredLibrary(
  library: Pick<
    StoredConnectedLibrary,
    "bridgeRootId" | "folderFingerprint" | "localPath"
  >,
) {
  if (library.folderFingerprint) {
    return library.folderFingerprint;
  }

  if (library.bridgeRootId) {
    return library.bridgeRootId;
  }

  if (library.localPath.startsWith("bridge://")) {
    return bridgeRootIdFromUri(library.localPath);
  }

  try {
    return localBridgeRootIdForKnownPath(library.localPath);
  } catch {
    return null;
  }
}

function developerFallbackEnabled() {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK === "true"
  );
}

function normalizeRootPath(folderPath: string) {
  const trimmedPath = folderPath.trim();

  if (!trimmedPath) {
    throw new ConnectedLibraryError("Choose a readable folder first.");
  }

  return path.normalize(path.resolve(trimmedPath));
}

export async function validateConnectedLibraryPath(folderPath: string) {
  const normalizedPath = normalizeRootPath(folderPath);

  try {
    const folderStats = await lstat(normalizedPath);

    if (!folderStats.isDirectory() || folderStats.isSymbolicLink()) {
      throw new ConnectedLibraryError(
        "Choose a readable folder before connecting it.",
      );
    }

    await access(normalizedPath, fsConstants.R_OK);
  } catch (error) {
    if (error instanceof ConnectedLibraryError) {
      throw error;
    }

    throw new ConnectedLibraryError(
      "The Librarian could not read that folder safely.",
    );
  }

  return normalizedPath;
}

function permissionInput(
  input: Partial<ConnectedLibraryPermissions>,
): ConnectedLibraryPermissions {
  return {
    createFolderPermission:
      input.createFolderPermission ??
      defaultConnectedLibraryPermissions.createFolderPermission,
    moveFilePermission:
      input.moveFilePermission ??
      defaultConnectedLibraryPermissions.moveFilePermission,
    organizationPlanPermission:
      input.organizationPlanPermission ??
      defaultConnectedLibraryPermissions.organizationPlanPermission,
    readPermission:
      input.readPermission ?? defaultConnectedLibraryPermissions.readPermission,
    recommendationPermission:
      input.recommendationPermission ??
      defaultConnectedLibraryPermissions.recommendationPermission,
    renameFilePermission:
      input.renameFilePermission ??
      defaultConnectedLibraryPermissions.renameFilePermission,
    watchPermission:
      input.watchPermission ?? defaultConnectedLibraryPermissions.watchPermission,
  };
}

function permissionUpdateInput(input: Partial<ConnectedLibraryPermissions>) {
  const data: Partial<ConnectedLibraryPermissions> = {};

  for (const permission of Object.keys(
    defaultConnectedLibraryPermissions,
  ) as ConnectedLibraryPermission[]) {
    if (typeof input[permission] === "boolean") {
      data[permission] = input[permission];
    }
  }

  return data;
}

function hasPermissionChanges(input: Partial<ConnectedLibraryPermissions>) {
  return (Object.keys(
    defaultConnectedLibraryPermissions,
  ) as ConnectedLibraryPermission[]).some(
    (permission) => typeof input[permission] === "boolean",
  );
}

function onlineBridgeDevice(device: { lastSeenAt: Date | null; status: string } | null) {
  if (!device || device.status !== "ONLINE" || !device.lastSeenAt) {
    return false;
  }

  return Date.now() - device.lastSeenAt.getTime() <= 90_000;
}

function safePermissionCommandPayload(
  bridgeRootId: string,
  input: Partial<ConnectedLibraryPermissions>,
) {
  const permissions = permissionUpdateInput(input);

  if (input.readPermission === false) {
    permissions.watchPermission = false;
  }

  return {
    bridgeRootId,
    ...permissions,
  };
}

function safeLocation(localPath: string) {
  if (localPath.startsWith("bridge://")) {
    return "Connected through the local Bridge";
  }

  const normalized = path.normalize(localPath);
  const parsed = path.parse(normalized);
  const relative = normalized.slice(parsed.root.length);
  const parts = relative.split(path.sep).filter(Boolean);

  if (parts.length <= 2) {
    return normalized;
  }

  return path.join(parsed.root, "...", ...parts.slice(-2));
}

function normalizeStatus(value: string): ConnectedLibraryStatus {
  return connectedLibraryStatuses.has(value as ConnectedLibraryStatus)
    ? (value as ConnectedLibraryStatus)
    : "NEEDS_ATTENTION";
}

function normalizePlatform(value: string): ConnectedLibraryPlatform {
  if (
    value === "WINDOWS" ||
    value === "MACOS" ||
    value === "LINUX" ||
    value === "UNKNOWN"
  ) {
    return value;
  }

  return "UNKNOWN";
}

function librarySummary(
  library: StoredConnectedLibrary,
  itemsNeedingAttention = 0,
  bridgeReachable = false,
  lastDetectedChangeAt: Date | null = null,
): ConnectedLibrarySummary {
  const hasBridgeRoot = Boolean(library.bridgeRootId);
  const normalizedStatus = normalizeStatus(library.status);
  const isMergedDuplicate =
    normalizedStatus === "MERGED" ||
    Boolean(library.canonicalConnectedLibraryId && library.mergedAt);
  const isHiddenFromActiveList =
    normalizedStatus === "HIDDEN_FROM_ACTIVE_LIST" ||
    Boolean(library.hiddenFromActiveListAt);
  const requiresReconnect =
    !isMergedDuplicate &&
    !isHiddenFromActiveList &&
    (library.isLegacyConnection ||
      !hasBridgeRoot ||
      !library.isEnabled ||
      normalizedStatus === "DISCONNECTED");

  return {
    bridgeReachable,
    bridgeDeviceId: library.bridgeDeviceId,
    bridgeRootId: library.bridgeRootId,
    canonicalConnectedLibraryId: library.canonicalConnectedLibraryId,
    connectedAt: library.connectedAt.toISOString(),
    createFolderPermission: library.createFolderPermission,
    disconnectedAt: library.disconnectedAt?.toISOString() ?? null,
    displayName: library.displayName,
    hiddenFromActiveListAt:
      library.hiddenFromActiveListAt?.toISOString() ?? null,
    id: library.id,
    isEnabled: library.isEnabled,
    isHiddenFromActiveList,
    isLegacyConnection: library.isLegacyConnection,
    isMergedDuplicate,
    itemsNeedingAttention,
    lastBridgeCheckAt: library.lastBridgeCheckAt?.toISOString() ?? null,
    lastDetectedChangeAt: lastDetectedChangeAt?.toISOString() ?? null,
    lastMonitoringAt: library.lastMonitoringAt?.toISOString() ?? null,
    lastScanAt: library.lastScanAt?.toISOString() ?? null,
    legacyReason: library.legacyReason,
    mergedAt: library.mergedAt?.toISOString() ?? null,
    monitoringErrorCategory: library.monitoringErrorCategory,
    monitoringHeartbeatAt:
      library.monitoringHeartbeatAt?.toISOString() ?? null,
    monitoringLastCheckAt:
      library.monitoringLastCheckAt?.toISOString() ?? null,
    monitoringLastSuccessfulCheckAt:
      library.monitoringLastSuccessfulCheckAt?.toISOString() ?? null,
    monitoringPausedAt: library.monitoringPausedAt?.toISOString() ?? null,
    monitoringStartedAt: library.monitoringStartedAt?.toISOString() ?? null,
    monitoringState:
      library.monitoringState === "WATCHING" ||
      library.monitoringState === "PAUSED" ||
      library.monitoringState === "NEEDS_ATTENTION" ||
      library.monitoringState === "STOPPED" ||
      library.monitoringState === "NOT_CONNECTED"
        ? library.monitoringState
        : "NEEDS_ATTENTION",
    monitoringStoppedAt: library.monitoringStoppedAt?.toISOString() ?? null,
    moveFilePermission: library.moveFilePermission,
    organizationPlanPermission: library.organizationPlanPermission,
    platform: normalizePlatform(library.platform),
    readPermission: library.readPermission,
    recentChangeCount: library._count?.monitoringEvents ?? 0,
    recommendationPermission: library.recommendationPermission,
    renameFilePermission: library.renameFilePermission,
    requiresReconnect,
    safeLocalLocation:
      library.safeLocalLocation?.trim() || safeLocation(library.localPath),
    scanSessionCount: library._count?.scanSessions ?? 0,
    status: normalizedStatus,
    watchPermission: library.watchPermission,
  };
}

async function attentionCountsByLibraryId(libraryIds: string[]) {
  if (libraryIds.length === 0) {
    return new Map<string, number>();
  }

  const prisma = getPrismaClient();
  const rows = await prisma.scannedFile.groupBy({
    by: ["sessionId"],
    _count: {
      _all: true,
    },
    where: {
      OR: [
        { processingStage: "FAILED" },
        { readStatus: "FAILED" },
        { readingStatus: "FAILED" },
        { extractionStatus: "FAILED" },
        { sourceUnavailableAt: { not: null } },
      ],
      scanSession: {
        connectedFolderId: {
          in: libraryIds,
        },
      },
    },
  });
  const sessions = await prisma.scanSession.findMany({
    select: {
      connectedFolderId: true,
      id: true,
    },
    where: {
      id: {
        in: rows.map((row) => row.sessionId),
      },
    },
  });
  const libraryBySession = new Map(
    sessions.map((session) => [session.id, session.connectedFolderId]),
  );
  const counts = new Map<string, number>();

  for (const row of rows) {
    const libraryId = libraryBySession.get(row.sessionId);

    if (!libraryId) {
      continue;
    }

    counts.set(libraryId, (counts.get(libraryId) ?? 0) + row._count._all);
  }

  return counts;
}

async function latestDetectedChangesByLibraryId(libraryIds: string[]) {
  if (libraryIds.length === 0) {
    return new Map<string, Date>();
  }

  const prisma = getPrismaClient();
  const rows = await prisma.monitoringEvent.groupBy({
    by: ["connectedFolderId"],
    _max: {
      detectedAt: true,
    },
    where: {
      connectedFolderId: {
        in: libraryIds,
      },
    },
  });
  const dates = new Map<string, Date>();

  for (const row of rows) {
    if (row._max.detectedAt) {
      dates.set(row.connectedFolderId, row._max.detectedAt);
    }
  }

  return dates;
}

function isMergedOrHiddenStatus(status: string) {
  return status === "MERGED" || status === "HIDDEN_FROM_ACTIVE_LIST";
}

function visibleConnectedLibraryWhere(): Prisma.ConnectedLibraryWhereInput {
  return {
    hiddenFromActiveListAt: null,
    mergedAt: null,
    status: {
      notIn: ["MERGED", "HIDDEN_FROM_ACTIVE_LIST"],
    },
  };
}

function activeCanonicalLibrary(library: StoredConnectedLibrary) {
  const status = normalizeStatus(library.status);

  return (
    library.isEnabled &&
    !library.isLegacyConnection &&
    Boolean(library.bridgeRootId || library.folderFingerprint) &&
    status !== "DISCONNECTED" &&
    status !== "MERGED" &&
    status !== "HIDDEN_FROM_ACTIVE_LIST"
  );
}

function canonicalSortKey(library: StoredConnectedLibrary) {
  const status = normalizeStatus(library.status);
  const activeWeight = activeCanonicalLibrary(library) ? 0 : 1;
  const identityWeight =
    library.folderFingerprint || library.bridgeRootId ? 0 : 1;
  const legacyWeight = library.isLegacyConnection ? 1 : 0;
  const hiddenWeight =
    status === "HIDDEN_FROM_ACTIVE_LIST" || library.hiddenFromActiveListAt
      ? 1
      : 0;

  return [
    activeWeight,
    identityWeight,
    legacyWeight,
    hiddenWeight,
    library.connectedAt.getTime(),
    library.id,
  ] as const;
}

function chooseCanonicalLibrary(libraries: StoredConnectedLibrary[]) {
  return [...libraries].sort((left, right) => {
    const leftKey = canonicalSortKey(left);
    const rightKey = canonicalSortKey(right);

    for (let index = 0; index < leftKey.length; index += 1) {
      const leftValue = leftKey[index];
      const rightValue = rightKey[index];

      if (leftValue < rightValue) {
        return -1;
      }

      if (leftValue > rightValue) {
        return 1;
      }
    }

    return 0;
  })[0] ?? null;
}

async function relinkConnectedLibraryHistory(
  tx: Prisma.TransactionClient,
  duplicateId: string,
  canonicalId: string,
) {
  await tx.scanSession.updateMany({
    data: {
      connectedFolderId: canonicalId,
    },
    where: {
      connectedFolderId: duplicateId,
    },
  });
  await tx.monitoringBatch.updateMany({
    data: {
      connectedFolderId: canonicalId,
    },
    where: {
      connectedFolderId: duplicateId,
    },
  });
  await tx.monitoringEvent.updateMany({
    data: {
      connectedFolderId: canonicalId,
    },
    where: {
      connectedFolderId: duplicateId,
    },
  });
}

async function mergeDuplicateConnectedLibraries(
  tx: Prisma.TransactionClient,
  canonicalId: string,
  duplicates: StoredConnectedLibrary[],
) {
  if (duplicates.length === 0) {
    return 0;
  }

  const now = new Date();
  let merged = 0;

  for (const duplicate of duplicates) {
    if (duplicate.id === canonicalId) {
      continue;
    }

    await relinkConnectedLibraryHistory(tx, duplicate.id, canonicalId);
    await tx.connectedLibrary.update({
      data: {
        bridgeRootId: null,
        canonicalConnectedLibraryId: canonicalId,
        folderFingerprint: null,
        isEnabled: false,
        isLegacyConnection: false,
        legacyReason: "Merged into the canonical connected library record.",
        mergedAt: duplicate.mergedAt ?? now,
        monitoringState: "STOPPED",
        monitoringStoppedAt: now,
        status: "MERGED",
        watchPermission: false,
      },
      where: {
        id: duplicate.id,
      },
    });
    merged += 1;
  }

  return merged;
}

async function candidateLibrariesForFingerprint(
  tx: Prisma.TransactionClient,
  fingerprint: string,
) {
  const directMatches = await tx.connectedLibrary.findMany({
    where: {
      OR: [
        { bridgeRootId: fingerprint },
        { folderFingerprint: fingerprint },
        { localPath: bridgeRootUri(fingerprint) },
      ],
    },
  });
  const directIds = new Set(directMatches.map((library) => library.id));
  const pathCandidates = await tx.connectedLibrary.findMany({
    where: {
      id: {
        notIn: [...directIds],
      },
      OR: [
        { bridgeRootId: null },
        { folderFingerprint: null },
        { localPath: { startsWith: "bridge://" } },
      ],
    },
  });
  const legacyMatches = pathCandidates.filter(
    (library) => folderFingerprintForStoredLibrary(library) === fingerprint,
  );

  return [...directMatches, ...legacyMatches] as StoredConnectedLibrary[];
}

async function reconcileFingerprint(
  tx: Prisma.TransactionClient,
  fingerprint: string,
) {
  const candidates = await candidateLibrariesForFingerprint(tx, fingerprint);
  const canonical = chooseCanonicalLibrary(candidates);

  if (!canonical) {
    return null;
  }

  const duplicates = candidates.filter((library) => library.id !== canonical.id);
  await mergeDuplicateConnectedLibraries(tx, canonical.id, duplicates);

  return canonical;
}

export async function reconcileConnectedLibraryFingerprint(
  fingerprint: string,
): Promise<{ id: string } | null> {
  const prisma = getPrismaClient();

  const canonical = await prisma.$transaction((tx) =>
    reconcileFingerprint(tx, fingerprint),
  );

  return canonical ? { id: canonical.id } : null;
}

export async function reconcileDuplicateConnectedLibraries() {
  const prisma = getPrismaClient();
  const libraries = await prisma.connectedLibrary.findMany();
  const groups = new Map<string, StoredConnectedLibrary[]>();

  for (const library of libraries as StoredConnectedLibrary[]) {
    if (
      isMergedOrHiddenStatus(library.status) &&
      !library.folderFingerprint &&
      !library.bridgeRootId
    ) {
      continue;
    }

    const fingerprint = folderFingerprintForStoredLibrary(library);

    if (!fingerprint) {
      continue;
    }

    groups.set(fingerprint, [...(groups.get(fingerprint) ?? []), library]);
  }

  let merged = 0;

  for (const [fingerprint, group] of groups.entries()) {
    if (group.length < 2) {
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const canonical = await reconcileFingerprint(tx, fingerprint);

      if (canonical) {
        merged += group.length - 1;
      }
    });
  }

  return merged;
}

async function markLegacyConnections() {
  const prisma = getPrismaClient();
  const legacyCandidates = await prisma.connectedLibrary.findMany({
    select: {
      bridgeRootId: true,
      id: true,
      isLegacyConnection: true,
      localPath: true,
      status: true,
    },
    where: {
      bridgeRootId: null,
      hiddenFromActiveListAt: null,
      isLegacyConnection: false,
      mergedAt: null,
      status: {
        notIn: ["MERGED", "HIDDEN_FROM_ACTIVE_LIST"],
      },
    },
  });

  const legacyIds = legacyCandidates
    .filter((library) => !library.localPath.startsWith("bridge://"))
    .map((library) => library.id);

  if (legacyIds.length === 0) {
    return;
  }

  await prisma.connectedLibrary.updateMany({
    data: {
      isEnabled: false,
      isLegacyConnection: true,
      legacyReason: "Legacy connection - reconnect required",
      monitoringState: "STOPPED",
      monitoringStoppedAt: new Date(),
      status: "NEEDS_ATTENTION",
      watchPermission: false,
    },
    where: {
      id: {
        in: legacyIds,
      },
    },
  });
}

async function bridgeReachability() {
  const health = await getLocalBridgeHealth();

  return health.ok && health.status === "BRIDGE_READY";
}

export async function getConnectedLibraries() {
  const prisma = getPrismaClient();
  await markLegacyConnections();
  await reconcileDuplicateConnectedLibraries();

  if (developerFallbackEnabled()) {
    await ensureDeveloperFallbackConnectedLibrary();
  }

  const bridgeReachable = await bridgeReachability();

  const libraries = await prisma.connectedLibrary.findMany({
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    where: visibleConnectedLibraryWhere(),
    include: {
      _count: {
        select: {
          monitoringEvents: true,
          scanSessions: true,
        },
      },
    },
  });
  const libraryIds = libraries.map((library) => library.id);
  const [attentionCounts, latestDetectedChanges] = await Promise.all([
    attentionCountsByLibraryId(libraryIds),
    latestDetectedChangesByLibraryId(libraryIds),
  ]);

  return libraries.map((library) =>
    librarySummary(
      library,
      attentionCounts.get(library.id) ?? 0,
      bridgeReachable && Boolean(library.bridgeRootId),
      latestDetectedChanges.get(library.id) ?? null,
    ),
  );
}

export async function getConnectedLibrary(libraryId: string) {
  const prisma = getPrismaClient();
  const library = await prisma.connectedLibrary.findUnique({
    include: {
      _count: {
        select: {
          monitoringEvents: true,
          scanSessions: true,
        },
      },
    },
    where: {
      id: libraryId,
    },
  });

  if (!library) {
    return null;
  }

  const [attentionCounts, latestDetectedChanges, bridgeReachable] =
    await Promise.all([
      attentionCountsByLibraryId([library.id]),
      latestDetectedChangesByLibraryId([library.id]),
      bridgeReachability(),
    ]);

  return librarySummary(
    library,
    attentionCounts.get(library.id) ?? 0,
    bridgeReachable && Boolean(library.bridgeRootId),
    latestDetectedChanges.get(library.id) ?? null,
  );
}

export async function getConnectedLibraryByFolderFingerprint(
  folderFingerprint: string,
) {
  const prisma = getPrismaClient();

  await reconcileDuplicateConnectedLibraries();

  const candidates = await prisma.connectedLibrary.findMany({
    include: {
      _count: {
        select: {
          monitoringEvents: true,
          scanSessions: true,
        },
      },
    },
    where: {
      mergedAt: null,
      status: {
        not: "MERGED",
      },
    },
  });
  const library = chooseCanonicalLibrary(
    candidates.filter(
      (candidate) =>
        folderFingerprintForStoredLibrary(candidate) === folderFingerprint,
    ) as StoredConnectedLibrary[],
  );

  if (!library) {
    return null;
  }

  const attentionCounts = await attentionCountsByLibraryId([library.id]);
  const bridgeReachable = await bridgeReachability();

  return librarySummary(
    library,
    attentionCounts.get(library.id) ?? 0,
    bridgeReachable && Boolean(library.bridgeRootId),
  );
}

export async function connectDeveloperLibrary(input: ConnectLibraryInput) {
  const prisma = getPrismaClient();
  const localPath = await validateConnectedLibraryPath(input.localPath);
  const permissions = permissionInput(input);
  const displayName =
    input.displayName?.trim() || displayNameForFolder(localPath);
  const fingerprint = localBridgeRootIdForKnownPath(localPath);
  const library = await prisma.connectedLibrary.upsert({
    create: {
      ...permissions,
      canonicalConnectedLibraryId: null,
      connectedAt: new Date(),
      disconnectedAt: null,
      displayName,
      folderFingerprint: fingerprint,
      hiddenFromActiveListAt: null,
      isLegacyConnection: false,
      isEnabled: true,
      legacyReason: null,
      localPath,
      mergedAt: null,
      platform: platformForLocalPath(),
      safeLocalLocation: safeLocation(localPath),
      status: "CONNECTED",
    },
    update: {
      ...permissionUpdateInput(input),
      canonicalConnectedLibraryId: null,
      disconnectedAt: null,
      displayName,
      folderFingerprint: fingerprint,
      hiddenFromActiveListAt: null,
      isLegacyConnection: false,
      isEnabled: true,
      legacyReason: null,
      mergedAt: null,
      platform: platformForLocalPath(),
      safeLocalLocation: safeLocation(localPath),
      status: "CONNECTED",
    },
    where: {
      localPath,
    },
  });

  return librarySummary(library);
}

function uniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function monitoringStateForBridgeRoot(root: LocalBridgeRootSummary) {
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

async function connectBridgeLibraryInTransaction(
  tx: Prisma.TransactionClient,
  root: LocalBridgeRootSummary,
  options: { updateExistingPermissions?: boolean } = {},
): Promise<ConnectedLibraryConnectionResult> {
  const fingerprint = root.id;
  const permissions = permissionInput(root);
  const now = new Date();
  const candidates = await candidateLibrariesForFingerprint(tx, fingerprint);
  const canonical = chooseCanonicalLibrary(candidates);

  if (canonical) {
    const action: ConnectedLibraryConnectionAction = activeCanonicalLibrary(
      canonical,
    )
      ? "ALREADY_CONNECTED"
      : "RECONNECTED";
    const duplicates = candidates.filter(
      (library) => library.id !== canonical.id,
    );

    await mergeDuplicateConnectedLibraries(tx, canonical.id, duplicates);

    const updateExistingPermissions = options.updateExistingPermissions === true;
    const updateData: Prisma.ConnectedLibraryUpdateInput =
      action === "ALREADY_CONNECTED"
        ? {
            ...(updateExistingPermissions ? permissions : {}),
            bridgeDevice: {
              disconnect: true,
            },
            bridgeRootId: root.id,
            canonicalConnectedLibraryId: null,
            ...(updateExistingPermissions ? { displayName: root.displayName } : {}),
            folderFingerprint: fingerprint,
            lastBridgeCheckAt: now,
            localPath: bridgeRootUri(root.id),
            mergedAt: null,
          }
        : {
            ...permissions,
            bridgeDevice: {
              disconnect: true,
            },
            bridgeRootId: root.id,
            canonicalConnectedLibraryId: null,
            disconnectedAt: null,
            displayName: root.displayName,
            folderFingerprint: fingerprint,
            hiddenFromActiveListAt: null,
            isEnabled: true,
            isLegacyConnection: false,
            lastBridgeCheckAt: now,
            legacyReason: null,
            localPath: bridgeRootUri(root.id),
            mergedAt: null,
            monitoringState: monitoringStateForBridgeRoot(root),
            platform: root.platform,
            safeLocalLocation: root.safeLocation,
            status: root.status,
          };
    const library = await tx.connectedLibrary.update({
      data: updateData,
      where: {
        id: canonical.id,
      },
    });

    return {
      action,
      alreadyConnected: action === "ALREADY_CONNECTED",
      library: librarySummary(library, 0, true),
    };
  }

  const library = await tx.connectedLibrary.create({
    data: {
      ...permissions,
      bridgeRootId: root.id,
      canonicalConnectedLibraryId: null,
      connectedAt: new Date(root.connectedAt),
      disconnectedAt: null,
      displayName: root.displayName,
      folderFingerprint: fingerprint,
      hiddenFromActiveListAt: null,
      isEnabled: true,
      isLegacyConnection: false,
      lastBridgeCheckAt: now,
      legacyReason: null,
      localPath: bridgeRootUri(root.id),
      mergedAt: null,
      monitoringState: monitoringStateForBridgeRoot(root),
      platform: root.platform,
      safeLocalLocation: root.safeLocation,
      status: root.status,
    },
  });

  return {
    action: "CONNECTED",
    alreadyConnected: false,
    library: librarySummary(library, 0, true),
  };
}

export async function connectBridgeLibrary(
  input: ConnectBridgeLibraryInput,
): Promise<ConnectedLibraryConnectionResult> {
  const prisma = getPrismaClient();

  try {
    return await prisma.$transaction((tx) =>
      connectBridgeLibraryInTransaction(tx, input.root, {
        updateExistingPermissions: input.updateExistingPermissions,
      }),
    );
  } catch (error) {
    if (!uniqueConstraintError(error)) {
      throw error;
    }

    return prisma.$transaction((tx) =>
      connectBridgeLibraryInTransaction(tx, input.root, {
        updateExistingPermissions: input.updateExistingPermissions,
      }),
    );
  }
}

export async function ensureDeveloperFallbackConnectedLibrary() {
  const configuredPath = process.env.NSN_BRIDGE_TEST_FOLDER?.trim();

  if (!configuredPath || !developerFallbackEnabled()) {
    return null;
  }

  try {
    return await connectDeveloperLibrary({
      displayName: displayNameForFolder(configuredPath),
      localPath: configuredPath,
    });
  } catch {
    return null;
  }
}

function missingPermissionMessage(actionLabel: string) {
  return `Deanne has not given the Librarian permission to ${actionLabel} in this connected library.`;
}

export async function requireConnectedLibraryPermission(
  libraryId: string,
  permission: ConnectedLibraryPermission,
  actionLabel: string,
) {
  const prisma = getPrismaClient();
  const library = await prisma.connectedLibrary.findUnique({
    where: {
      id: libraryId,
    },
  });

  if (!library) {
    throw new ConnectedLibraryError(
      "The Librarian could not find that connected library.",
      404,
    );
  }

  if (!library.isEnabled || library.status === "DISCONNECTED") {
    throw new ConnectedLibraryError(
      "This connected library is disconnected. Reconnect it before using the Bridge.",
      403,
    );
  }

  if (library.isLegacyConnection || (!library.bridgeRootId && !developerFallbackEnabled())) {
    throw new ConnectedLibraryError(
      "This is a legacy connection. Reconnect this folder through the NSN Bridge before using it.",
      403,
    );
  }

  if (library.status === "PAUSED") {
    throw new ConnectedLibraryError(
      "This connected library is paused. Resume access before using the Bridge.",
      403,
    );
  }

  if (!library[permission]) {
    throw new ConnectedLibraryError(
      missingPermissionMessage(actionLabel),
      403,
    );
  }

  return library;
}

export async function requireScanSessionPermission(
  scanSessionId: string,
  permission: ConnectedLibraryPermission,
  actionLabel: string,
) {
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findUnique({
    select: {
      connectedFolderId: true,
    },
    where: {
      id: scanSessionId,
    },
  });

  if (!session) {
    throw new ConnectedLibraryError(
      "The Librarian could not find that scan session.",
      404,
    );
  }

  return requireConnectedLibraryPermission(
    session.connectedFolderId,
    permission,
    actionLabel,
  );
}

export async function requireScannedFilePermission(
  scannedFileId: string,
  permission: ConnectedLibraryPermission,
  actionLabel: string,
) {
  const prisma = getPrismaClient();
  const file = await prisma.scannedFile.findUnique({
    select: {
      scanSession: {
        select: {
          connectedFolderId: true,
        },
      },
    },
    where: {
      id: scannedFileId,
    },
  });

  if (!file) {
    throw new ConnectedLibraryError(
      "The Librarian could not find that scanned file.",
      404,
    );
  }

  return requireConnectedLibraryPermission(
    file.scanSession.connectedFolderId,
    permission,
    actionLabel,
  );
}

export async function rootForConnectedLibrary(
  libraryId: string,
  permission: ConnectedLibraryPermission,
  actionLabel: string,
) {
  const library = await requireConnectedLibraryPermission(
    libraryId,
    permission,
    actionLabel,
  );

  if (library.bridgeRootId) {
    throw new ConnectedLibraryError(
      "The local Bridge owns this folder path. Use the Bridge operation for this request.",
      409,
    );
  }

  return validateConnectedLibraryPath(library.localPath);
}

export async function updateConnectedLibrary(
  libraryId: string,
  input: UpdateLibraryInput,
): Promise<ConnectedLibraryUpdateResult> {
  const prisma = getPrismaClient();
  const normalizedInput = {
    ...input,
  };

  if (normalizedInput.readPermission === false) {
    normalizedInput.watchPermission = false;
  }

  const existing = await prisma.connectedLibrary.findUnique({
    include: {
      bridgeDevice: {
        select: {
          lastSeenAt: true,
          status: true,
        },
      },
    },
    where: {
      id: libraryId,
    },
  });

  if (!existing) {
    throw new ConnectedLibraryError(
      "The Librarian could not find that connected library.",
      404,
    );
  }

  const permissionChangesRequested = hasPermissionChanges(normalizedInput);

  if (existing.bridgeRootId && existing.bridgeDeviceId && permissionChangesRequested) {
    if (
      normalizedInput.watchPermission === true &&
      normalizedInput.readPermission !== true &&
      !existing.readPermission
    ) {
      throw new ConnectedLibraryError(
        "Reading permission is required before this folder can be watched.",
        400,
      );
    }

    if (!onlineBridgeDevice(existing.bridgeDevice)) {
      throw new ConnectedLibraryError(
        "Open NSN Bridge on the paired Mac before changing this permission.",
        409,
      );
    }

    const commandPayload = safePermissionCommandPayload(
      existing.bridgeRootId,
      normalizedInput,
    );
    let command;

    try {
      command = await createBridgeCloudCommand({
        authorizationContext: {
          approvedBy: "Deanne",
          reason: "Connected library permission update",
        },
        bridgeDeviceId: existing.bridgeDeviceId,
        bridgeRootId: existing.bridgeRootId,
        commandType: "UPDATE_ROOT_PERMISSIONS",
        connectedLibraryId: existing.id,
        payload: commandPayload,
      });
    } catch (error) {
      if (error instanceof BridgeCloudError) {
        throw new ConnectedLibraryError(error.message, error.statusCode);
      }

      throw error;
    }

    logBridgePermissionDiagnostic({
      bridgeRootId: existing.bridgeRootId,
      commandId: command.commandId,
      commandType: "UPDATE_ROOT_PERMISSIONS",
      event: "queued",
      permissions: bridgePermissionSnapshot(commandPayload),
    });

    return {
      action: "UPDATED",
      library: librarySummary(existing, 0, true),
      permissionUpdate: {
        commandId: command.commandId,
        status: "PENDING",
      },
    };
  }

  if (existing.bridgeRootId) {
    try {
      await updateLocalBridgeRoot(existing.bridgeRootId, {
        ...permissionUpdateInput(normalizedInput),
        displayName:
          typeof normalizedInput.displayName === "string"
            ? normalizedInput.displayName
            : undefined,
        status: normalizedInput.status,
      });
    } catch (error) {
      throw new ConnectedLibraryError(
        error instanceof Error
          ? error.message
          : "The local Bridge could not update this connected folder.",
        503,
      );
    }
  }

  const data: Prisma.ConnectedLibraryUpdateInput = {};

  if (
    typeof normalizedInput.displayName === "string" &&
    normalizedInput.displayName.trim()
  ) {
    data.displayName = normalizedInput.displayName.trim();
  }

  if (
    normalizedInput.status &&
    connectedLibraryStatuses.has(normalizedInput.status)
  ) {
    data.status = normalizedInput.status;
    data.isEnabled = normalizedInput.status !== "DISCONNECTED";

    if (normalizedInput.status === "DISCONNECTED") {
      data.disconnectedAt = new Date();
      data.monitoringState = "STOPPED";
      data.monitoringStoppedAt = new Date();
      data.watchPermission = false;
    } else if (
      normalizedInput.status === "CONNECTED" ||
      normalizedInput.status === "PAUSED" ||
      normalizedInput.status === "NEEDS_ATTENTION"
    ) {
      data.disconnectedAt = null;
      data.hiddenFromActiveListAt = null;
      data.mergedAt = null;
    }
  }

  for (const permission of Object.keys(
    defaultConnectedLibraryPermissions,
  ) as ConnectedLibraryPermission[]) {
    if (typeof normalizedInput[permission] === "boolean") {
      data[permission] = normalizedInput[permission];
    }
  }

  if (
    normalizedInput.watchPermission === false ||
    normalizedInput.readPermission === false
  ) {
    data.monitoringState = "STOPPED";
    data.monitoringStoppedAt = new Date();
    data.monitoringErrorCategory =
      normalizedInput.readPermission === false
        ? "READ_PERMISSION_REQUIRED"
        : null;
  }

  const library = await prisma.connectedLibrary.update({
    data,
    where: {
      id: libraryId,
    },
  });

  return {
    action: "UPDATED",
    library: librarySummary(library, 0, Boolean(existing.bridgeRootId)),
  };
}

export async function getConnectedLibraryPermissionUpdateStatus(
  libraryId: string,
  commandId: string,
) {
  const prisma = getPrismaClient();
  const command = await prisma.bridgeCommand.findUnique({
    where: {
      commandId,
    },
  });

  if (
    !command ||
    command.connectedLibraryId !== libraryId ||
    command.commandType !== "UPDATE_ROOT_PERMISSIONS"
  ) {
    throw new ConnectedLibraryError(
      "The Librarian could not find that permission update.",
      404,
    );
  }

  const library = await getConnectedLibrary(libraryId);

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
      error: "The Bridge could not update that permission. The previous setting is still in place.",
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

export async function disconnectConnectedLibrary(libraryId: string) {
  const prisma = getPrismaClient();
  const existing = await prisma.connectedLibrary.findUnique({
    where: {
      id: libraryId,
    },
  });

  if (!existing) {
    throw new ConnectedLibraryError(
      "The Librarian could not find that connected library.",
      404,
    );
  }

  if (existing.bridgeRootId) {
    await disconnectLocalBridgeRoot(existing.bridgeRootId).catch(() => undefined);
  }

  const now = new Date();
  const library = await prisma.connectedLibrary.update({
    data: {
      disconnectedAt: now,
      isEnabled: false,
      monitoringState: "STOPPED",
      monitoringStoppedAt: now,
      status: "DISCONNECTED",
      watchPermission: false,
    },
    where: {
      id: libraryId,
    },
  });

  return librarySummary(library);
}

export async function hideConnectedLibrary(libraryId: string) {
  const prisma = getPrismaClient();
  const existing = await prisma.connectedLibrary.findUnique({
    where: {
      id: libraryId,
    },
  });

  if (!existing) {
    throw new ConnectedLibraryError(
      "The Librarian could not find that connected library.",
      404,
    );
  }

  const canHide =
    !existing.isEnabled ||
    existing.isLegacyConnection ||
    existing.status === "DISCONNECTED" ||
    existing.status === "HIDDEN_FROM_ACTIVE_LIST";

  if (!canHide) {
    throw new ConnectedLibraryError(
      "Disconnect this folder before removing it from the active list.",
      409,
    );
  }

  if (existing.bridgeRootId) {
    await disconnectLocalBridgeRoot(existing.bridgeRootId).catch(() => undefined);
  }

  const now = new Date();
  const library = await prisma.connectedLibrary.update({
    data: {
      hiddenFromActiveListAt: now,
      isEnabled: false,
      monitoringState: "STOPPED",
      monitoringStoppedAt: now,
      status: "HIDDEN_FROM_ACTIVE_LIST",
      watchPermission: false,
    },
    where: {
      id: libraryId,
    },
  });

  return librarySummary(library);
}

export function platformHomeLabel() {
  if (process.platform === "win32") {
    return safeLocation(os.homedir());
  }

  return "this computer";
}
