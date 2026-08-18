import { BridgeAppError } from "../types";
import { createFolderSelection } from "../main/registry";
import type { RootPathValidationOptions } from "../filesystem/safety";
import { openMacosFolderPicker } from "./macos-picker";
import { openWindowsFolderPicker } from "./windows-picker";

export async function openNativeFolderSelection(options: {
  developmentPath?: string | null;
  validationOptions?: RootPathValidationOptions;
} = {}) {
  const developmentPath = options.developmentPath?.trim();

  if (
    developmentPath &&
    process.env.NSN_BRIDGE_ALLOW_DEVELOPER_PATH === "true"
  ) {
    return createFolderSelection(developmentPath, options.validationOptions);
  }

  let selectedPath: string;

  if (process.platform === "win32") {
    selectedPath = await openWindowsFolderPicker().catch((error) => {
      if (
        error instanceof BridgeAppError &&
        error.code === "FOLDER_SELECTION_CANCELLED"
      ) {
        throw error;
      }

      throw new BridgeAppError(
        "The native folder picker could not open.",
        "FOLDER_PICKER_FAILED",
        503,
      );
    });
  } else if (process.platform === "darwin") {
    selectedPath = await openMacosFolderPicker().catch((error) => {
      if (
        error instanceof BridgeAppError &&
        error.code === "FOLDER_PICKER_CANCELLED"
      ) {
        throw error;
      }

      throw new BridgeAppError(
        "The macOS folder picker could not open.",
        "FOLDER_PICKER_FAILED",
        503,
      );
    });
  } else {
    throw new BridgeAppError(
      "The native folder picker is not available on this platform yet.",
      "FOLDER_PICKER_UNAVAILABLE",
      501,
    );
  }

  return createFolderSelection(selectedPath, options.validationOptions);
}
