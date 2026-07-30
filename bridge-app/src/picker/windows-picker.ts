import { spawn } from "node:child_process";

import { BridgeAppError } from "../types";

const pickerScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Choose a folder for the NSN Librarian"
$dialog.ShowNewFolderButton = $false
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`;

export async function openWindowsFolderPicker() {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", pickerScript],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      },
    );
    let stdout = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => {
      reject(
        new BridgeAppError(
          "The NSN Bridge could not open the Windows folder picker.",
          "FOLDER_PICKER_UNAVAILABLE",
          503,
        ),
      );
    });
    child.on("close", (code) => {
      const selectedPath = stdout.trim();

      if (code !== 0) {
        reject(
          new BridgeAppError(
            "The NSN Bridge could not open the Windows folder picker.",
            "FOLDER_PICKER_UNAVAILABLE",
            503,
          ),
        );
        return;
      }

      if (!selectedPath) {
        reject(
          new BridgeAppError(
            "Folder selection was cancelled.",
            "FOLDER_SELECTION_CANCELLED",
            400,
          ),
        );
        return;
      }

      resolve(selectedPath);
    });
  });
}
