import { constants as fsConstants, watch, type FSWatcher } from "node:fs";
import { access, lstat } from "node:fs/promises";
import path from "node:path";

import {
  getRoot,
  listRootRecords,
  requireWatchPermission,
  updateRoot,
} from "../main/registry";
import {
  BridgeAppError,
  type BridgeChangeEvent,
  type BridgeRootSummary,
} from "../types";
import { pathKey } from "../filesystem/safety";
import {
  acknowledgeBridgeWatcherEvents,
  listBridgeWatcherEvents,
  queueBridgeWatcherEvent,
  takeBridgeWatcherEventsFromOutbox,
} from "./event-outbox";

type WatchHandle = {
  rootId: string;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  watcher: FSWatcher;
};

const watcherRegistry = new Map<string, WatchHandle>();
const debounceMs = 600;

function relativePathFor(rootPath: string, changedPath: string) {
  const relative = path.relative(rootPath, changedPath);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new BridgeAppError(
      "The Bridge ignored a change outside the connected folder.",
      "PATH_OUTSIDE_ROOT",
      403,
    );
  }

  return relative.split(path.sep).join(path.posix.sep);
}

async function classifyChange(
  rootId: string,
  rootPath: string,
  fileName: string,
  eventName: string,
) {
  const changedPath = path.resolve(rootPath, fileName);
  const relativePath = relativePathFor(rootPath, changedPath);
  const stats = await lstat(changedPath).catch(() => null);
  const addedEventType = stats?.isDirectory() ? "FOLDER_ADDED" : "FILE_ADDED";
  const modifiedEventType = stats?.isDirectory()
    ? "FOLDER_ADDED"
    : "FILE_MODIFIED";

  return {
    detectedAt: new Date().toISOString(),
    eventType: stats
      ? eventName === "rename"
        ? addedEventType
        : modifiedEventType
      : "FILE_DELETED",
    id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
    relativePath,
    rootId,
  } satisfies BridgeChangeEvent;
}

export async function startBridgeWatcher(rootId: string): Promise<BridgeRootSummary> {
  const root = await requireWatchPermission(rootId);

  if (watcherRegistry.has(root.id)) {
    return updateRoot(root.id, {
      lastWatchingAt: new Date().toISOString(),
      status: "CONNECTED",
      watcherState: "WATCHING",
    });
  }

  const rootStats = await lstat(root.actualPath).catch(() => null);

  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    await updateRoot(root.id, {
      status: "NEEDS_ATTENTION",
      watcherState: "NEEDS_ATTENTION",
    }).catch(() => undefined);
    throw new BridgeAppError(
      "The selected folder is not currently available.",
      "ROOT_UNAVAILABLE",
      422,
    );
  }

  await access(root.actualPath, fsConstants.R_OK).catch(() => {
    throw new BridgeAppError(
      "The selected folder is not currently available.",
      "ROOT_UNAVAILABLE",
      422,
    );
  });

  const handle: WatchHandle = {
    rootId: root.id,
    timers: new Map(),
    watcher: undefined as unknown as FSWatcher,
  };

  try {
    handle.watcher = watch(root.actualPath, { recursive: true }, (eventName, fileName) => {
      if (!fileName) {
        return;
      }

      const key = pathKey(String(fileName));
      const existingTimer = handle.timers.get(key);

      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      handle.timers.set(
        key,
        setTimeout(() => {
          handle.timers.delete(key);
          void classifyChange(root.id, root.actualPath, String(fileName), eventName)
            .then((event) => {
              void queueBridgeWatcherEvent(event);
            })
            .catch(() => undefined);
        }, debounceMs),
      );
    });
  } catch {
    await updateRoot(root.id, {
      status: "NEEDS_ATTENTION",
      watcherState: "NEEDS_ATTENTION",
    }).catch(() => undefined);
    throw new BridgeAppError(
      "The Bridge could not begin watching this folder.",
      "WATCHER_START_FAILED",
      500,
    );
  }

  handle.watcher.on("error", () => {
    watcherRegistry.delete(root.id);
    void updateRoot(root.id, {
      status: "NEEDS_ATTENTION",
      watcherState: "NEEDS_ATTENTION",
    });
  });

  watcherRegistry.set(root.id, handle);

  return updateRoot(root.id, {
    lastWatchingAt: new Date().toISOString(),
    status: "CONNECTED",
    watcherState: "WATCHING",
  });
}

function stopWatcherHandle(rootId: string) {
  const handle = watcherRegistry.get(rootId);

  if (!handle) {
    return;
  }

  for (const timer of handle.timers.values()) {
    clearTimeout(timer);
  }

  handle.watcher.close();
  watcherRegistry.delete(rootId);
}

export async function pauseBridgeWatcher(rootId: string) {
  await getRoot(rootId);
  stopWatcherHandle(rootId);

  return updateRoot(rootId, {
    watcherState: "PAUSED",
  });
}

export async function resumeBridgeWatcher(rootId: string) {
  return startBridgeWatcher(rootId);
}

export async function stopBridgeWatcher(rootId: string) {
  await getRoot(rootId);
  stopWatcherHandle(rootId);

  return updateRoot(rootId, {
    watcherState: "STOPPED",
  });
}

export async function takeBridgeWatcherEvents(rootId: string) {
  await requireWatchPermission(rootId);

  const handle = watcherRegistry.get(rootId);

  if (!handle) {
    return [] as BridgeChangeEvent[];
  }

  return takeBridgeWatcherEventsFromOutbox(rootId);
}

export function isWatching(rootId: string) {
  return watcherRegistry.has(rootId);
}

export { acknowledgeBridgeWatcherEvents, listBridgeWatcherEvents };

export async function restorePersistedBridgeWatchers() {
  const roots = await listRootRecords();
  const restored: BridgeRootSummary[] = [];

  for (const root of roots) {
    if (
      root.status !== "CONNECTED" ||
      root.watcherState !== "WATCHING" ||
      !root.readPermission ||
      !root.watchPermission ||
      watcherRegistry.has(root.id)
    ) {
      continue;
    }

    try {
      restored.push(await startBridgeWatcher(root.id));
    } catch {
      await updateRoot(root.id, {
        status: "NEEDS_ATTENTION",
        watcherState: "NEEDS_ATTENTION",
      }).catch(() => undefined);
    }
  }

  return restored;
}

export function resetBridgeWatcherRuntimeForTests() {
  for (const rootId of [...watcherRegistry.keys()]) {
    stopWatcherHandle(rootId);
  }
}
