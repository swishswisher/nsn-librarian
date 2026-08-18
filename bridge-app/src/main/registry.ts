import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defaultBridgePermissions,
  permissionsFromInput,
} from "../permissions/defaults";
import {
  BridgeAppError,
  type BridgePermissions,
  type BridgeRootRecord,
  type BridgeRootSummary,
  type FolderSelectionRecord,
  type FolderSelectionResult,
} from "../types";
import {
  bridgePlatform,
  displayNameForFolder,
  pathKey,
  type RootPathValidationOptions,
  safeLocationDescription,
  validateRootPath,
} from "../filesystem/safety";
import { bridgeDataDir } from "../security/pairing";

type RegistryFile = {
  roots: BridgeRootRecord[];
  selections: FolderSelectionRecord[];
};

export type FolderSelectionOptions = RootPathValidationOptions;

const folderSelectionTtlMs = 10 * 60 * 1000;

function registryPath() {
  return path.join(bridgeDataDir(), "registry.json");
}

async function readRegistry(): Promise<RegistryFile> {
  try {
    const parsed = JSON.parse(await readFile(registryPath(), "utf8")) as Partial<RegistryFile>;

    return {
      roots: Array.isArray(parsed.roots) ? parsed.roots : [],
      selections: Array.isArray(parsed.selections) ? parsed.selections : [],
    };
  } catch {
    return {
      roots: [],
      selections: [],
    };
  }
}

async function writeRegistry(registry: RegistryFile) {
  const filePath = registryPath();
  const tmpPath = `${filePath}.tmp`;

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmpPath, filePath);
}

function rootIdForPath(actualPath: string) {
  const hash = createHash("sha256").update(pathKey(actualPath)).digest("hex");

  return `root_${hash.slice(0, 24)}`;
}

function ancestorRootIdsForPath(actualPath: string) {
  const parsed = path.parse(actualPath);
  const rootKey = pathKey(path.normalize(parsed.root));
  const ancestors: string[] = [];
  let current = path.dirname(actualPath);

  while (pathKey(path.normalize(current)) !== rootKey) {
    ancestors.push(rootIdForPath(current));
    const next = path.dirname(current);

    if (pathKey(next) === pathKey(current)) {
      break;
    }

    current = next;
  }

  return ancestors;
}

function nowIso() {
  return new Date().toISOString();
}

function removeExpiredSelections(registry: RegistryFile) {
  const now = Date.now();

  registry.selections = registry.selections.filter(
    (selection) => new Date(selection.expiresAt).getTime() > now,
  );
}

export function summarizeBridgeRoot(root: BridgeRootRecord): BridgeRootSummary {
  return {
    connectedAt: root.connectedAt,
    createFolderPermission: root.createFolderPermission,
    displayName: root.displayName,
    id: root.id,
    lastScanAt: root.lastScanAt,
    lastWatchingAt: root.lastWatchingAt,
    moveFilePermission: root.moveFilePermission,
    organizationPlanPermission: root.organizationPlanPermission,
    platform: root.platform,
    readPermission: root.readPermission,
    recommendationPermission: root.recommendationPermission,
    renameFilePermission: root.renameFilePermission,
    safeLocation: root.safeLocation,
    status: root.status,
    updatedAt: root.updatedAt,
    watcherState: root.watcherState,
    watchPermission: root.watchPermission,
  };
}

export async function createFolderSelection(
  folderPath: string,
  options: RootPathValidationOptions = {},
): Promise<FolderSelectionResult> {
  const actualPath = await validateRootPath(folderPath, options);
  const rootId = rootIdForPath(actualPath);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + folderSelectionTtlMs).toISOString();
  const selection: FolderSelectionRecord = {
    ancestorRootIds: ancestorRootIdsForPath(actualPath),
    actualPath,
    createdAt,
    expiresAt,
    platform: bridgePlatform(),
    rootId,
    safeLocation: safeLocationDescription(actualPath),
    suggestedDisplayName: displayNameForFolder(actualPath),
    token: randomBytes(24).toString("hex"),
  };
  const registry = await readRegistry();

  removeExpiredSelections(registry);
  registry.selections.push(selection);
  await writeRegistry(registry).catch(() => {
    throw new BridgeAppError(
      "The Bridge could not save that folder selection locally.",
      "FOLDER_SELECTION_PERSISTENCE_FAILED",
      500,
    );
  });

  return {
    ancestorRootIds: selection.ancestorRootIds,
    expiresAt: selection.expiresAt,
    platform: selection.platform,
    rootId: selection.rootId,
    safeLocation: selection.safeLocation,
    selectionToken: selection.token,
    suggestedDisplayName: selection.suggestedDisplayName,
  };
}

function permissionsWithReadInvariant(
  permissions: Partial<BridgePermissions>,
) {
  const nextPermissions = permissionsFromInput(permissions);

  if (nextPermissions.watchPermission && !nextPermissions.readPermission) {
    throw new BridgeAppError(
      "Watching requires permission to read files.",
      "WATCH_REQUIRES_READ",
      403,
    );
  }

  return nextPermissions;
}

export async function registerRootFromSelection(input: {
  validationOptions?: RootPathValidationOptions;
  displayName?: string;
  permissions?: Partial<BridgePermissions>;
  selectionToken: string;
}) {
  const token = input.selectionToken.trim();

  if (!token) {
    throw new BridgeAppError(
      "Choose a folder before connecting it.",
      "MISSING_SELECTION_TOKEN",
      400,
    );
  }

  const registry = await readRegistry();
  removeExpiredSelections(registry);

  const selectionIndex = registry.selections.findIndex(
    (selection) => selection.token === token,
  );
  const selection = registry.selections[selectionIndex];

  if (!selection) {
    await writeRegistry(registry);
    throw new BridgeAppError(
      "That folder selection expired. Choose the folder again.",
      "SELECTION_EXPIRED",
      410,
    );
  }

  registry.selections.splice(selectionIndex, 1);

  const actualPath = await validateRootPath(
    selection.actualPath,
    input.validationOptions,
  );
  const rootId = rootIdForPath(actualPath);
  const permissions = permissionsWithReadInvariant(input.permissions ?? {});
  const displayName =
    input.displayName?.trim() || selection.suggestedDisplayName;
  const existingRoot = registry.roots.find((root) => root.id === rootId);
  const timestamp = nowIso();
  let root: BridgeRootRecord;

  if (existingRoot) {
    Object.assign(existingRoot, {
      ...permissions,
      actualPath,
      displayName,
      platform: selection.platform,
      safeLocation: safeLocationDescription(actualPath),
      status: "CONNECTED" as const,
      updatedAt: timestamp,
      watcherState: permissions.watchPermission
        ? existingRoot.watcherState
        : ("PAUSED" as const),
    });
    root = existingRoot;
  } else {
    root = {
      ...defaultBridgePermissions,
      ...permissions,
      actualPath,
      connectedAt: timestamp,
      displayName,
      id: rootId,
      lastScanAt: null,
      lastWatchingAt: null,
      platform: selection.platform,
      safeLocation: safeLocationDescription(actualPath),
      status: "CONNECTED",
      updatedAt: timestamp,
      watcherState: permissions.watchPermission ? "PAUSED" : "STOPPED",
    };
    registry.roots.push(root);
  }

  await writeRegistry(registry).catch(() => {
    throw new BridgeAppError(
      "The Bridge could not save that connected folder locally.",
      "FOLDER_SELECTION_PERSISTENCE_FAILED",
      500,
    );
  });

  return summarizeBridgeRoot(root);
}

export async function getRoot(rootId: string) {
  const registry = await readRegistry();
  const root = registry.roots.find((item) => item.id === rootId);

  if (!root) {
    throw new BridgeAppError(
      "The NSN Bridge could not find that connected folder.",
      "ROOT_NOT_FOUND",
      404,
    );
  }

  return root;
}

export async function getRootSummary(rootId: string) {
  return summarizeBridgeRoot(await getRoot(rootId));
}

export async function listRoots() {
  const registry = await readRegistry();

  return registry.roots.map(summarizeBridgeRoot);
}

export async function updateRoot(rootId: string, input: {
  displayName?: string;
  permissions?: Partial<BridgePermissions>;
  status?: BridgeRootRecord["status"];
  watcherState?: BridgeRootRecord["watcherState"];
  lastScanAt?: string | null;
  lastWatchingAt?: string | null;
}) {
  const registry = await readRegistry();
  const root = registry.roots.find((item) => item.id === rootId);

  if (!root) {
    throw new BridgeAppError(
      "The NSN Bridge could not find that connected folder.",
      "ROOT_NOT_FOUND",
      404,
    );
  }

  if (input.displayName?.trim()) {
    root.displayName = input.displayName.trim();
  }

  if (input.permissions) {
    const nextPermissions = {
      createFolderPermission:
        input.permissions.createFolderPermission ??
        root.createFolderPermission,
      moveFilePermission:
        input.permissions.moveFilePermission ?? root.moveFilePermission,
      organizationPlanPermission:
        input.permissions.organizationPlanPermission ??
        root.organizationPlanPermission,
      readPermission: input.permissions.readPermission ?? root.readPermission,
      recommendationPermission:
        input.permissions.recommendationPermission ??
        root.recommendationPermission,
      renameFilePermission:
        input.permissions.renameFilePermission ?? root.renameFilePermission,
      watchPermission: input.permissions.watchPermission ?? root.watchPermission,
    };

    if (nextPermissions.watchPermission && !nextPermissions.readPermission) {
      throw new BridgeAppError(
        "Watching requires permission to read files.",
        "WATCH_REQUIRES_READ",
        403,
      );
    }

    Object.assign(root, nextPermissions);

    if (!root.watchPermission && root.watcherState === "WATCHING") {
      root.watcherState = "PAUSED";
    }
  }

  if (input.status) {
    root.status = input.status;
  }

  if (input.watcherState) {
    root.watcherState = input.watcherState;
  }

  if (input.lastScanAt !== undefined) {
    root.lastScanAt = input.lastScanAt;
  }

  if (input.lastWatchingAt !== undefined) {
    root.lastWatchingAt = input.lastWatchingAt;
  }

  root.updatedAt = nowIso();
  await writeRegistry(registry);

  return summarizeBridgeRoot(root);
}

export async function disconnectRoot(rootId: string) {
  return updateRoot(rootId, {
    permissions: {
      watchPermission: false,
    },
    status: "DISCONNECTED",
    watcherState: "STOPPED",
  });
}

export async function requireRootPermission(
  rootId: string,
  permission: keyof BridgePermissions,
  actionLabel: string,
) {
  const root = await getRoot(rootId);

  if (root.status === "DISCONNECTED") {
    throw new BridgeAppError(
      "This folder is disconnected. Reconnect it before using the Bridge.",
      "ROOT_DISCONNECTED",
      403,
    );
  }

  if (root.status === "PAUSED") {
    throw new BridgeAppError(
      "This folder is paused. Resume it before using the Bridge.",
      "ROOT_PAUSED",
      403,
    );
  }

  if (!root[permission]) {
    throw new BridgeAppError(
      `Deanne has not given the Bridge permission to ${actionLabel} in this folder.`,
      "PERMISSION_DENIED",
      403,
    );
  }

  return root;
}

export async function requireWatchPermission(rootId: string) {
  await requireRootPermission(rootId, "readPermission", "read files");
  return requireRootPermission(rootId, "watchPermission", "watch changes");
}

export async function requireExecutionPermissions(
  rootId: string,
  actions: Array<{
    actionType:
      | "CREATE_FOLDER"
      | "MOVE_FILE"
      | "RENAME_FILE"
      | "MOVE_AND_RENAME_FILE";
  }>,
) {
  for (const action of actions) {
    if (action.actionType === "CREATE_FOLDER") {
      await requireRootPermission(
        rootId,
        "createFolderPermission",
        "create folders after approval",
      );
    } else if (action.actionType === "MOVE_FILE") {
      await requireRootPermission(
        rootId,
        "moveFilePermission",
        "move files after approval",
      );
    } else if (action.actionType === "RENAME_FILE") {
      await requireRootPermission(
        rootId,
        "renameFilePermission",
        "rename files after approval",
      );
    } else if (action.actionType === "MOVE_AND_RENAME_FILE") {
      await requireRootPermission(
        rootId,
        "moveFilePermission",
        "move files after approval",
      );
      await requireRootPermission(
        rootId,
        "renameFilePermission",
        "rename files after approval",
      );
    }
  }
}
