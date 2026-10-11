import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readLocalJson, withLocalStoreLock, writeLocalJson } from "./local-json-store";
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

export function createFolderSelection(...args: Parameters<typeof createFolderSelectionUnlocked>): ReturnType<typeof createFolderSelectionUnlocked> {
  return withLocalStoreLock(registryPath(), () => createFolderSelectionUnlocked(...args));
}
export async function registerRootFromSelection(...args: Parameters<typeof registerRootFromSelectionUnlocked>): ReturnType<typeof registerRootFromSelectionUnlocked> {
  const selection = (await readRegistry()).selections.find((item) => item.token === args[0].selectionToken.trim());
  if (!selection) return withLocalStoreLock(registryPath(), () => registerRootFromSelectionUnlocked(...args));
  return withRootAuthority(rootIdForPath(selection.actualPath), () => withLocalStoreLock(registryPath(), () => registerRootFromSelectionUnlocked(...args)));
}
export function updateRoot(...args: Parameters<typeof updateRootUnlocked>): ReturnType<typeof updateRootUnlocked> {
  return withRootAuthority(args[0], () => withLocalStoreLock(registryPath(), () => updateRootUnlocked(...args)));
}

// Physical operations and native grant changes serialize on the same root.
// Registry mutation is nested inside this lock, never the reverse order.
const rootAuthorityScopes = new AsyncLocalStorage<Set<string>>();
export function withRootAuthority<T>(rootId: string, operation: () => Promise<T>) {
  const key = path.join(bridgeDataDir(), `root-authority-${createHash("sha256").update(rootId).digest("hex")}`);
  const held = rootAuthorityScopes.getStore();
  if (held?.has(key)) return operation();
  return withLocalStoreLock(key, () => rootAuthorityScopes.run(new Set([...(held ?? []), key]), operation));
}

function registryPath() {
  return path.join(bridgeDataDir(), "registry.json");
}

async function readRegistry(): Promise<RegistryFile> {
  return readLocalJson(registryPath(), () => ({ roots: [], selections: [] }), (value) => {
    const parsed = value as Partial<RegistryFile> | null;
    if (!parsed || !Array.isArray(parsed.roots) || !Array.isArray(parsed.selections) ||
        parsed.roots.some((root) => !root || typeof root.id !== "string" || typeof root.actualPath !== "string") ||
        parsed.selections.some((selection) => !selection || typeof selection.token !== "string" || typeof selection.actualPath !== "string")) {
      throw new BridgeAppError("The local folder registry needs recovery.", "REGISTRY_CORRUPT", 503);
    }
    return { roots: parsed.roots, selections: parsed.selections };
  });
}

async function writeRegistry(registry: RegistryFile) {
  await writeLocalJson(registryPath(), registry);
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
    connectionRevision: root.connectionRevision ?? 0,
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

async function createFolderSelectionUnlocked(
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

async function registerRootFromSelectionUnlocked(input: {
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
    await writeRegistry(registry).catch(() => undefined);
    throw new BridgeAppError(
      "That folder selection expired. Choose the folder again.",
      "SELECTION_EXPIRED",
      410,
    );
  }

  const actualPath = await validateRootPath(
    selection.actualPath,
    input.validationOptions,
  );
  const rootId = rootIdForPath(actualPath);
  const permissions = permissionsWithReadInvariant(input.permissions ?? {});
  const displayName =
    input.displayName?.trim() || selection.suggestedDisplayName;
  const nextRegistry: RegistryFile = {
    roots: registry.roots.map((root) => ({ ...root })),
    selections: registry.selections.filter(
      (_selection, index) => index !== selectionIndex,
    ),
  };
  const existingRoot = nextRegistry.roots.find((root) => root.id === rootId);
  const timestamp = new Date(Math.max(Date.now(), existingRoot ? new Date(existingRoot.updatedAt).getTime() + 1 : 0)).toISOString();
  let root: BridgeRootRecord;

  if (existingRoot) {
    Object.assign(existingRoot, {
      ...permissions,
      connectionRevision: (existingRoot.connectionRevision ?? 0) + 1,
      connectedAt: timestamp,
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
      connectionRevision: 1,
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
    nextRegistry.roots.push(root);
  }

  await writeRegistry(nextRegistry).catch(() => {
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

export async function listRootRecords() {
  const registry = await readRegistry();

  return registry.roots.map((root) => ({ ...root }));
}

export async function getRootSummary(rootId: string) {
  return summarizeBridgeRoot(await getRoot(rootId));
}

export async function listRoots() {
  const registry = await readRegistry();

  return registry.roots.map(summarizeBridgeRoot);
}

async function updateRootUnlocked(rootId: string, input: {
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

  root.updatedAt = new Date(Math.max(Date.now(), new Date(root.updatedAt).getTime() + 1)).toISOString();
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

  if (root.status === "DISCONNECTED" || root.status === "NEEDS_ATTENTION") {
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
