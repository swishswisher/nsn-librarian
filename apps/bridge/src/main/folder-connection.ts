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
      ok: true;
      roots: BridgeRootSummary[];
    }
  | {
      code: string;
      message: string;
      ok: false;
    };

type ConnectFoldersInput = {
  folders: unknown;
  getPairedBridgeDeviceId: () => Promise<string | null>;
  permissions?: Partial<BridgePermissions>;
  registerRoot?: typeof registerRootFromSelection;
  syncRoots?: () => Promise<unknown>;
  validationOptions?: FolderSelectionOptions;
};

const safeMessages: Record<string, string> = {
  BRIDGE_NOT_PAIRED: "Pair this Mac before connecting folders.",
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

export async function connectSelectedBridgeFolders({
  folders,
  getPairedBridgeDeviceId,
  permissions,
  registerRoot = registerRootFromSelection,
  syncRoots,
  validationOptions,
}: ConnectFoldersInput) {
  const bridgeDeviceId = await getPairedBridgeDeviceId();

  if (!bridgeDeviceId) {
    logConnectionDiagnostic("paired-check", "BRIDGE_NOT_PAIRED");
    throw new BridgeAppError(
      safeFolderConnectionMessage("BRIDGE_NOT_PAIRED"),
      "BRIDGE_NOT_PAIRED",
      401,
    );
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

  await syncRoots?.().catch(() => {
    logConnectionDiagnostic("sync-failed", "ROOT_SYNC_FAILED");
    return null;
  });

  return roots;
}

export async function folderConnectionIpcResult(
  connectFolders: () => Promise<BridgeRootSummary[]>,
): Promise<FolderConnectionIpcResult> {
  try {
    return {
      ok: true,
      roots: await connectFolders(),
    };
  } catch (error) {
    const safeError = folderConnectionFailureFromError(error);

    return {
      code: safeError.code,
      message: safeError.message,
      ok: false,
    };
  }
}
