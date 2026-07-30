import { BridgeAppError } from "../types";
import { createFolderSelection } from "../main/registry";
import { openMacosFolderPicker } from "./macos-picker";
import { openWindowsFolderPicker } from "./windows-picker";

export async function openNativeFolderSelection(options: {
  developmentPath?: string | null;
} = {}) {
  const developmentPath = options.developmentPath?.trim();

  if (
    developmentPath &&
    process.env.NSN_BRIDGE_ALLOW_DEVELOPER_PATH === "true"
  ) {
    return createFolderSelection(developmentPath);
  }

  if (process.platform === "win32") {
    return createFolderSelection(await openWindowsFolderPicker());
  }

  if (process.platform === "darwin") {
    return createFolderSelection(await openMacosFolderPicker());
  }

  throw new BridgeAppError(
    "The native folder picker is not available on this platform yet.",
    "FOLDER_PICKER_UNAVAILABLE",
    501,
  );
}
