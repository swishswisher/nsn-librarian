import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  selectFoldersFromDialog,
  folderSelectionIpcResult,
} from "../../apps/bridge/src/main/folder-selection";
import { validateRootPath } from "../src/filesystem/safety";
import { createFolderSelection } from "../src/main/registry";
import { BridgeAppError } from "../src/types";

let tempRoot: string;
let previousDataDir: string | undefined;

async function makeFolder(...parts: string[]) {
  const folder = path.join(tempRoot, ...parts);

  await mkdir(folder, { recursive: true });

  return folder;
}

function appPathOptions(appPath: string) {
  return {
    forbiddenApplicationPaths: [appPath, path.dirname(appPath)],
  };
}

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "nsn-folder-safety-"));
  previousDataDir = process.env.NSN_BRIDGE_DATA_DIR;
  process.env.NSN_BRIDGE_DATA_DIR = path.join(tempRoot, ".nsn-bridge");
});

afterEach(async () => {
  if (previousDataDir === undefined) {
    delete process.env.NSN_BRIDGE_DATA_DIR;
  } else {
    process.env.NSN_BRIDGE_DATA_DIR = previousDataDir;
  }

  await rm(tempRoot, { force: true, recursive: true });
});

describe("Bridge folder-selection safety", () => {
  it("does not reject a normal folder when cwd is the filesystem root", async () => {
    const previousCwd = process.cwd();
    const userFolder = await makeFolder(
      "Users",
      "test",
      "NSN_Librarian_E2E_Test_Pack",
      "SCAN_ROOT_A_GENERAL_INBOX",
    );
    const appPath = await makeFolder("Applications", "NSN Bridge.app");

    process.chdir(path.parse(tempRoot).root);

    try {
      const selections = await selectFoldersFromDialog({
        ...appPathOptions(appPath),
        showOpenDialog: async () => ({
          canceled: false,
          filePaths: [userFolder],
        }),
      });

      assert.equal(selections.length, 1);
      assert.equal(selections[0]?.suggestedDisplayName, "SCAN_ROOT_A_GENERAL_INBOX");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("rejects the actual NSN application directory", async () => {
    const appPath = await makeFolder("Applications", "NSN Bridge.app");

    await assert.rejects(
      () => validateRootPath(appPath, appPathOptions(appPath)),
      (error) =>
        error instanceof BridgeAppError &&
        error.code === "UNSAFE_APPLICATION_DIRECTORY",
    );
  });

  it("rejects a folder containing the actual NSN application", async () => {
    const parent = await makeFolder("Installers");
    const appPath = path.join(parent, "NSN Bridge.app");

    await mkdir(appPath, { recursive: true });

    await assert.rejects(
      () => validateRootPath(parent, appPathOptions(appPath)),
      (error) =>
        error instanceof BridgeAppError &&
        error.code === "UNSAFE_APPLICATION_DIRECTORY",
    );
  });

  it("rejects the filesystem root", async () => {
    await assert.rejects(
      () => validateRootPath(path.parse(tempRoot).root),
      (error) =>
        error instanceof BridgeAppError &&
        error.code === "UNSAFE_SYSTEM_ROOT",
    );
  });

  it("accepts normal user Documents and Desktop folders", async () => {
    const documents = await makeFolder("Users", "test", "Documents", "NSN Test");
    const desktop = await makeFolder("Users", "test", "Desktop", "NSN Test");

    assert.equal(await validateRootPath(documents), path.normalize(documents));
    assert.equal(await validateRootPath(desktop), path.normalize(desktop));
  });

  it("returns FOLDER_UNREADABLE for an unreadable or missing folder", async () => {
    const missingFolder = path.join(tempRoot, "Users", "test", "Missing");

    await assert.rejects(
      () => validateRootPath(missingFolder),
      (error) =>
        error instanceof BridgeAppError && error.code === "FOLDER_UNREADABLE",
    );
  });

  it("rejects a symlink folder root", async (t) => {
    const target = await makeFolder("Users", "test", "Documents", "Real");
    const linkPath = path.join(tempRoot, "Users", "test", "Documents", "Linked");

    try {
      await symlink(target, linkPath, "dir");
    } catch {
      t.skip("This Windows account cannot create symlinks.");
      return;
    }

    await assert.rejects(
      () => validateRootPath(linkPath),
      (error) =>
        error instanceof BridgeAppError && error.code === "UNSAFE_SYMLINK",
    );
  });

  it("treats picker cancel as a successful empty selection", async () => {
    const result = await folderSelectionIpcResult(() =>
      selectFoldersFromDialog({
        showOpenDialog: async () => ({
          canceled: true,
          filePaths: [],
        }),
      }),
    );

    assert.deepEqual(result, { ok: true, selections: [] });
  });

  it("returns FOLDER_PICKER_FAILED for native picker failures", async () => {
    const result = await folderSelectionIpcResult(() =>
      selectFoldersFromDialog({
        showOpenDialog: async () => {
          throw new Error("native dialog failed with private details");
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "FOLDER_PICKER_FAILED");
    assert.equal(
      result.ok ? null : result.message,
      "The macOS folder picker could not open.",
    );
  });

  it("does not report validation failure as picker failure", async () => {
    const appPath = await makeFolder("Applications", "NSN Bridge.app");
    const result = await folderSelectionIpcResult(() =>
      selectFoldersFromDialog({
        ...appPathOptions(appPath),
        showOpenDialog: async () => ({
          canceled: false,
          filePaths: [appPath],
        }),
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "UNSAFE_APPLICATION_DIRECTORY");
    assert.equal(
      result.ok ? "" : result.message.includes("picker"),
      false,
    );
  });

  it("returns FOLDER_SELECTION_PERSISTENCE_FAILED for registry write failures", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Registry");
    const blocker = path.join(tempRoot, "not-a-directory");

    await writeFile(blocker, "blocks registry directory creation");
    process.env.NSN_BRIDGE_DATA_DIR = path.join(blocker, "child");

    const result = await folderSelectionIpcResult(() =>
      selectFoldersFromDialog({
        showOpenDialog: async () => ({
          canceled: false,
          filePaths: [folder],
        }),
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? null : result.code,
      "FOLDER_SELECTION_PERSISTENCE_FAILED",
    );
  });

  it("returns a cloud-safe selection without the absolute local path", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Private Folder");
    const selection = await createFolderSelection(folder);
    const serialized = JSON.stringify(selection);

    assert.equal("actualPath" in selection, false);
    assert.equal(serialized.includes(folder), false);
    assert.equal(selection.safeLocation.includes("Private Folder"), true);
  });
});
