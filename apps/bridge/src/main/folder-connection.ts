import {
  registerRootFromSelection,
  type FolderSelectionOptions,
} from "../../../../bridge-app/src/main/registry";
import {
  BridgeAppError,
  type BridgePermissions,
  type BridgeRootSummary,
} from "../../../../bridge-app/src/types";

export type FolderConnectionIpcResult =
  | {
      cloudSyncStatus: "NOT_ATTEMPTED" | "PENDING" | "SYNCED";
      message: string;
      ok: true;
      roots: BridgeRootSummary[];
      safeCloudErrorCategory?: string | null;
    }
  | {
      code: string;
      message: string;
      ok: false;
    };

export type ConnectedBridgeFoldersResult = Extract<
  FolderConnectionIpcResult,
  { ok: true }
>;

type BridgePairingStateForConnection =
  | {
      status: "COMPLETE";
    }
  | {
      safeErrorCategory?: string;
      status: "INCOMPLETE" | "UNAVAILABLE" | "UNUSABLE";
    };

type FolderSyncAttemptResult =
  | {
      ok: boolean;
      safeErrorCategory?: string | null;
    }
  | null
  | undefined;

type ConnectFoldersInput = {
  folders: unknown;
  getBridgePairingState?: () => Promise<BridgePairingStateForConnection>;
  getPairedBridgeDeviceId?: () => Promise<string | null>;
  permissions?: Partial<BridgePermissions>;
  registerRoot?: typeof registerRootFromSelection;
  syncRoots?: () => Promise<FolderSyncAttemptResult>;
  validationOptions?: FolderSelectionOptions;
};

const safeMessages: Record<string, string> = {
  BRIDGE_NOT_PAIRED: "Pair this Mac before connecting folders.",
  KEYCHAIN_UNAVAILABLE:
    "NSN Bridge could not access its saved pairing credentials.",
  PAIRING_INCOMPLETE:
    "NSN Bridge cannot access its saved device credentials. Pair this Mac again.",
  PRIVATE_KEY_INVALID:
    "NSN Bridge cannot use its saved device credentials. Pair this Mac again.",
  REQUEST_SIGNING_FAILED:
    "NSN Bridge cannot use its saved device credentials. Pair this Mac again.",
  SECRET_READ_FAILED:
    "NSN Bridge could not access its saved pairing credentials.",
  FOLDER_SELECTION_PERSISTENCE_FAILED:
    "The Bridge could not save this connected folder locally.",
  FOLDER_UNREADABLE: "The selected folder could no longer be read.",
  MISSING_SELECTION_TOKEN: "Choose a folder before connecting it.",
  ROOT_REGISTRATION_FAILED:
    "The selected folder could not be connected safely.",
  SELECTION_EXPIRED: "That folder selection expired. Choose the folder again.",
  UNSAFE_APPLICATION_DIRECTORY:
    "Choose a personal folder instead of an NSN application folder.",
  UNSAFE_SYMLINK: "Choose a real folder instead of a symlink.",
  UNSAFE_SYSTEM_DIRECTORY:
    "Choose a personal folder instead of a system folder.",
  UNSAFE_SYSTEM_ROOT:
    "Choose a personal folder instead of the whole computer or drive.",
};

function safeConnectionCode(code: string) {
  if (code === "UNREADABLE_ROOT") {
    return "FOLDER_UNREADABLE";
  }

  return code.trim() || "ROOT_REGISTRATION_FAILED";
}

export function safeFolderConnectionMessage(code: string) {
  return (
    safeMessages[safeConnectionCode(code)] ??
    "The selected folder could not be connected safely."
  );
}

export function folderConnectionFailureFromError(
  error: unknown,
): BridgeAppError {
  if (error instanceof BridgeAppError) {
    const code = safeConnectionCode(error.code);

    return new BridgeAppError(
      safeFolderConnectionMessage(code),
      code,
      error.statusCode,
    );
  }

  return new BridgeAppError(
    safeFolderConnectionMessage("ROOT_REGISTRATION_FAILED"),
    "ROOT_REGISTRATION_FAILED",
    500,
  );
}

function folderSelectionToken(folder: unknown) {
  if (
    typeof folder === "object" &&
    folder !== null &&
    typeof (folder as { selectionToken?: unknown }).selectionToken === "string"
  ) {
    return (folder as { selectionToken: string }).selectionToken;
  }

  return "";
}

function logConnectionDiagnostic(stage: string, code?: string) {
  const payload = code ? ` stage=${stage} code=${code}` : ` stage=${stage}`;

  console.info(`[NSN Bridge] connect-folders${payload}`);
}

function normalizePairingCode(
  state: BridgePairingStateForConnection | null,
) {
  if (!state) {
    return "BRIDGE_NOT_PAIRED";
  }

  if (state.status === "COMPLETE") {
    return null;
  }

  return state.safeErrorCategory === "KEYCHAIN_UNAVAILABLE" ||
    state.safeErrorCategory === "PRIVATE_KEY_INVALID" ||
    state.safeErrorCategory === "REQUEST_SIGNING_FAILED" ||
    state.safeErrorCategory === "SECRET_READ_FAILED"
    ? state.safeErrorCategory
    : "PAIRING_INCOMPLETE";
}

async function requireConnectionPairing(input: ConnectFoldersInput) {
  if (input.getBridgePairingState) {
    const state = await input.getBridgePairingState();
    const code = normalizePairingCode(state);

    if (code) {
      throw new BridgeAppError(safeFolderConnectionMessage(code), code, 401);
    }

    return;
  }

  const bridgeDeviceId = await input.getPairedBridgeDeviceId?.();

  if (!bridgeDeviceId) {
    throw new BridgeAppError(
      safeFolderConnectionMessage("BRIDGE_NOT_PAIRED"),
      "BRIDGE_NOT_PAIRED",
      401,
    );
  }
}

function connectionSuccessMessage(
  roots: BridgeRootSummary[],
  cloudSyncStatus: ConnectedBridgeFoldersResult["cloudSyncStatus"],
) {
  if (cloudSyncStatus === "SYNCED") {
    return "The selected folders are connected to NSN Librarian. Nothing will move without approval.";
  }

  const subject = roots.length === 1 ? "The folder is" : "The selected folders are";

  return `${subject} connected on this Mac, but NSN Librarian has not received ${
    roots.length === 1 ? "it" : "them"
  } yet. The Bridge will keep trying.`;
}

export async function connectSelectedBridgeFolders({
  folders,
  getBridgePairingState,
  getPairedBridgeDeviceId,
  permissions,
  registerRoot = registerRootFromSelection,
  syncRoots,
  validationOptions,
}: ConnectFoldersInput) {
  try {
    await requireConnectionPairing({
      folders,
      getBridgePairingState,
      getPairedBridgeDeviceId,
    });
  } catch (error) {
    const safeError = folderConnectionFailureFromError(error);

    logConnectionDiagnostic("paired-check", safeError.code);
    throw safeError;
  }

  const selectedFolders = Array.isArray(folders) ? folders : [];

  if (selectedFolders.length === 0) {
    logConnectionDiagnostic("input-check", "MISSING_SELECTION_TOKEN");
    throw new BridgeAppError(
      safeFolderConnectionMessage("MISSING_SELECTION_TOKEN"),
      "MISSING_SELECTION_TOKEN",
      400,
    );
  }

  const roots: BridgeRootSummary[] = [];

  for (const folder of selectedFolders) {
    const selectionToken = folderSelectionToken(folder).trim();

    if (!selectionToken) {
      logConnectionDiagnostic("input-check", "MISSING_SELECTION_TOKEN");
      throw new BridgeAppError(
        safeFolderConnectionMessage("MISSING_SELECTION_TOKEN"),
        "MISSING_SELECTION_TOKEN",
        400,
      );
    }

    try {
      logConnectionDiagnostic("register-start");
      roots.push(
        await registerRoot({
          permissions,
          selectionToken,
          validationOptions,
        }),
      );
      logConnectionDiagnostic("register-complete");
    } catch (error) {
      const safeError = folderConnectionFailureFromError(error);

      logConnectionDiagnostic("register-failed", safeError.code);
      throw safeError;
    }
  }

  let cloudSyncStatus: ConnectedBridgeFoldersResult["cloudSyncStatus"] =
    syncRoots ? "PENDING" : "NOT_ATTEMPTED";
  let safeCloudErrorCategory: string | null = null;

  if (syncRoots) {
    try {
      const syncResult = await syncRoots();

      if (syncResult && syncResult.ok === true) {
        cloudSyncStatus = "SYNCED";
      } else {
        cloudSyncStatus = "PENDING";
        safeCloudErrorCategory =
          syncResult?.safeErrorCategory ?? "ROOT_SYNC_FAILED";
        logConnectionDiagnostic("sync-pending", safeCloudErrorCategory);
      }
    } catch {
      cloudSyncStatus = "PENDING";
      safeCloudErrorCategory = "ROOT_SYNC_FAILED";
      logConnectionDiagnostic("sync-failed", safeCloudErrorCategory);
    }
  }

  return {
    cloudSyncStatus,
    message: connectionSuccessMessage(roots, cloudSyncStatus),
    ok: true as const,
    roots,
    safeCloudErrorCategory,
  };
}

export async function folderConnectionIpcResult(
  connectFolders: () => Promise<ConnectedBridgeFoldersResult>,
): Promise<FolderConnectionIpcResult> {
  try {
    return await connectFolders();
  } catch (error) {
    const safeError = folderConnectionFailureFromError(error);

    return {
      code: safeError.code,
      message: safeError.message,
      ok: false,
    };
  }
}
