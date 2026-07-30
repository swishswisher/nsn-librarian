import { spawn } from "node:child_process";

import { BridgeAppError } from "../types";

export async function openMacosFolderPicker(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new BridgeAppError(
      "The macOS folder picker is only available on a Mac.",
      "FOLDER_PICKER_UNAVAILABLE",
      501,
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Choose a folder for NSN Bridge")',
    ]);
    const output: Buffer[] = [];
    const errors: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", () => {
      reject(
        new BridgeAppError(
          "The Bridge could not open the macOS folder picker.",
          "FOLDER_PICKER_UNAVAILABLE",
          501,
        ),
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errors).toString("utf8").toLowerCase();
        reject(
          new BridgeAppError(
            stderr.includes("user canceled")
              ? "Folder selection was cancelled."
              : "The Bridge could not choose that folder safely.",
            stderr.includes("user canceled")
              ? "FOLDER_PICKER_CANCELLED"
              : "FOLDER_PICKER_UNAVAILABLE",
            stderr.includes("user canceled") ? 400 : 501,
          ),
        );
        return;
      }

      const selectedPath = Buffer.concat(output).toString("utf8").trim();

      if (!selectedPath) {
        reject(
          new BridgeAppError(
            "Choose a folder before connecting it.",
            "FOLDER_PICKER_CANCELLED",
            400,
          ),
        );
        return;
      }

      resolve(selectedPath);
    });
  });
}
