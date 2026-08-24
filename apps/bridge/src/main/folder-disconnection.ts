import {
  disconnectRoot,
  getRootSummary,
} from "../../../../bridge-app/src/main/registry";
import { stopBridgeWatcher } from "../../../../bridge-app/src/watcher/watcher";
import {
  BridgeAppError,
  type BridgeRootSummary,
} from "../../../../bridge-app/src/types";

export type FolderDisconnectionIpcResult =
  | {
      cancelled?: boolean;
      cloudSyncStatus: "NOT_ATTEMPTED" | "PENDING" | "SYNCED";
      message: string;
      ok: true;
      root: BridgeRootSummary;
      safeCloudErrorCategory?: string | null;
    }
  | {
      code: string;
      message: string;
      ok: false;
    };

type FolderSyncAttemptResult =
  | {
      ok: boolean;
      safeErrorCategory?: string | null;
    }
  | null
  | undefined;

type DisconnectFolderInput = {
  confirmDisconnect?: (root: BridgeRootSummary) => Promise<boolean>;
  disconnectRootById?: typeof disconnectRoot;
  getRoot?: typeof getRootSummary;
  rootId: unknown;
  stopWatcher?: typeof stopBridgeWatcher;
  syncRoots?: () => Promise<FolderSyncAttemptResult>;
};

const safeDisconnectMessages: Record<string, string> = {
  INVALID_ROOT_ID: "The Bridge could not find that connected folder.",
  ROOT_NOT_FOUND: "The Bridge could not find that connected folder.",
  ROOT_DISCONNECT_FAILED:
    "The Bridge could not disconnect that folder safely.",
};

function normalizedRootId(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const rootId = value.trim();

  return /^root_[a-f0-9]{24}$/iu.test(rootId) ? rootId : null;
}

export function safeFolderDisconnectMessage(code: string) {
  return (
    safeDisconnectMessages[code] ??
    "The Bridge could not disconnect that folder safely."
  );
}

function folderDisconnectFailureFromError(error: unknown): BridgeAppError {
  if (error instanceof BridgeAppError) {
    const code = error.code.trim() || "ROOT_DISCONNECT_FAILED";

    return new BridgeAppError(
      safeFolderDisconnectMessage(code),
      code,
      error.statusCode,
    );
  }

  return new BridgeAppError(
    safeFolderDisconnectMessage("ROOT_DISCONNECT_FAILED"),
    "ROOT_DISCONNECT_FAILED",
    500,
  );
}

function disconnectSuccessMessage(
  cloudSyncStatus: Extract<FolderDisconnectionIpcResult, { ok: true }>["cloudSyncStatus"],
) {
  if (cloudSyncStatus === "SYNCED") {
    return "The folder is disconnected from NSN Librarian. No local files were deleted.";
  }

  return "The folder is disconnected on this Mac. NSN Librarian will receive the update when the Bridge can sync.";
}

export async function disconnectBridgeFolder({
  confirmDisconnect = async () => true,
  disconnectRootById = disconnectRoot,
  getRoot = getRootSummary,
  rootId,
  stopWatcher = stopBridgeWatcher,
  syncRoots,
}: DisconnectFolderInput): Promise<FolderDisconnectionIpcResult> {
  const normalized = normalizedRootId(rootId);

  if (!normalized) {
    return {
      code: "INVALID_ROOT_ID",
      message: safeFolderDisconnectMessage("INVALID_ROOT_ID"),
      ok: false,
    };
  }

  try {
    const root = await getRoot(normalized);
    const confirmed = await confirmDisconnect(root);

    if (!confirmed) {
      return {
        cancelled: true,
        cloudSyncStatus: "NOT_ATTEMPTED",
        message: "The folder remains connected.",
        ok: true,
        root,
      };
    }

    if (root.watcherState === "WATCHING") {
      await stopWatcher(normalized);
    }

    const disconnectedRoot = await disconnectRootById(normalized);
    let cloudSyncStatus: Extract<
      FolderDisconnectionIpcResult,
      { ok: true }
    >["cloudSyncStatus"] = syncRoots ? "PENDING" : "NOT_ATTEMPTED";
    let safeCloudErrorCategory: string | null = null;

    if (syncRoots) {
      try {
        const syncResult = await syncRoots();

        if (syncResult?.ok) {
          cloudSyncStatus = "SYNCED";
        } else {
          safeCloudErrorCategory =
            syncResult?.safeErrorCategory ?? "ROOT_SYNC_FAILED";
        }
      } catch {
        safeCloudErrorCategory = "ROOT_SYNC_FAILED";
      }
    }

    return {
      cloudSyncStatus,
      message: disconnectSuccessMessage(cloudSyncStatus),
      ok: true,
      root: disconnectedRoot,
      safeCloudErrorCategory,
    };
  } catch (error) {
    const safeError = folderDisconnectFailureFromError(error);

    return {
      code: safeError.code,
      message: safeError.message,
      ok: false,
    };
  }
}
