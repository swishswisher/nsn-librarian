import {
  createFolderSelection,
  type FolderSelectionOptions,
} from "../../../../bridge-app/src/main/registry";
import {
  BridgeAppError,
  type FolderSelectionResult,
} from "../../../../bridge-app/src/types";

export type FolderSelectionDialogResult = {
  canceled: boolean;
  filePaths: string[];
};

export type FolderSelectionIpcResult =
  | {
      ok: true;
      selections: FolderSelectionResult[];
    }
  | {
      code: string;
      message: string;
      ok: false;
    };

type SelectFoldersInput = {
  createSelection?: (
    folderPath: string,
    options?: FolderSelectionOptions,
  ) => Promise<FolderSelectionResult>;
  forbiddenApplicationPaths?: string[];
  showOpenDialog: () => Promise<FolderSelectionDialogResult>;
};

const safeMessages: Record<string, string> = {
  FOLDER_PICKER_FAILED: "The macOS folder picker could not open.",
  FOLDER_SELECTION_PERSISTENCE_FAILED:
    "The Bridge could not save that folder selection locally.",
  FOLDER_UNREADABLE: "The selected folder could not be read.",
  UNSAFE_APPLICATION_DIRECTORY:
    "Choose a personal folder instead of an NSN application folder.",
  UNSAFE_SYMLINK: "Choose a real folder instead of a symlink.",
  UNSAFE_SYSTEM_DIRECTORY:
    "Choose a personal folder instead of a system folder.",
  UNSAFE_SYSTEM_ROOT:
    "Choose a personal folder instead of the whole computer or drive.",
};

function safeFolderSelectionCode(code: string) {
  return code === "UNREADABLE_ROOT" ? "FOLDER_UNREADABLE" : code;
}

export function safeFolderSelectionMessage(code: string) {
  return (
    safeMessages[safeFolderSelectionCode(code)] ??
    "The selected folder could not be chosen safely."
  );
}

export function folderSelectionFailureFromError(
  error: unknown,
  fallbackCode = "FOLDER_SELECTION_PERSISTENCE_FAILED",
): BridgeAppError {
  if (error instanceof BridgeAppError) {
    const code = safeFolderSelectionCode(error.code);

    return new BridgeAppError(
      safeFolderSelectionMessage(code),
      code,
      error.statusCode,
    );
  }

  return new BridgeAppError(
    safeFolderSelectionMessage(fallbackCode),
    fallbackCode,
    500,
  );
}

export async function selectFoldersFromDialog({
  createSelection = createFolderSelection,
  forbiddenApplicationPaths = [],
  showOpenDialog,
}: SelectFoldersInput): Promise<FolderSelectionResult[]> {
  const result = await showOpenDialog().catch(() => {
    throw new BridgeAppError(
      safeFolderSelectionMessage("FOLDER_PICKER_FAILED"),
      "FOLDER_PICKER_FAILED",
      503,
    );
  });

  if (result.canceled) {
    return [];
  }

  const selections: FolderSelectionResult[] = [];

  for (const filePath of result.filePaths) {
    try {
      selections.push(
        await createSelection(filePath, {
          forbiddenApplicationPaths,
        }),
      );
    } catch (error) {
      throw folderSelectionFailureFromError(error);
    }
  }

  return selections;
}

export async function folderSelectionIpcResult(
  selectFolders: () => Promise<FolderSelectionResult[]>,
): Promise<FolderSelectionIpcResult> {
  try {
    return {
      ok: true,
      selections: await selectFolders(),
    };
  } catch (error) {
    const safeError = folderSelectionFailureFromError(error);

    return {
      code: safeError.code,
      message: safeError.message,
      ok: false,
    };
  }
}
