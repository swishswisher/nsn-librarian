import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  connectSelectedBridgeFolders,
  folderConnectionIpcResult,
} from "../../apps/bridge/src/main/folder-connection";
import { selectFoldersFromDialog } from "../../apps/bridge/src/main/folder-selection";
import { validateRootPath } from "../src/filesystem/safety";
import {
  createFolderSelection,
  listRoots,
  registerRootFromSelection,
} from "../src/main/registry";
import { BridgeAppError, type FolderSelectionRecord } from "../src/types";

let tempRoot: string;
let previousDataDir: string | undefined;

async function makeFolder(...parts: string[]) {
  const folder = path.join(tempRoot, ...parts);

  await mkdir(folder, { recursive: true });

  return folder;
}

function dataDir() {
  return process.env.NSN_BRIDGE_DATA_DIR as string;
}

function registryPath() {
  return path.join(dataDir(), "registry.json");
}

function appPathOptions(appPath: string) {
  return {
    forbiddenApplicationPaths: [appPath, path.dirname(appPath)],
  };
}

async function expectBridgeCode(
  action: () => Promise<unknown>,
  code: string,
) {
  await assert.rejects(
    action,
    (error) => error instanceof BridgeAppError && error.code === code,
  );
}

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "nsn-folder-connect-"));
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

describe("Bridge folder connection pipeline", () => {
  it("registers a selected normal folder immediately", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Inbox");
    const selection = await createFolderSelection(folder);
    const root = await registerRootFromSelection({
      selectionToken: selection.selectionToken,
    });

    assert.equal(root.displayName, "Inbox");
    assert.equal(root.status, "CONNECTED");
    assert.equal((await listRoots()).length, 1);
  });

  it("preserves the selection token through a renderer-style round trip", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Round Trip");
    const selection = await createFolderSelection(folder);
    const clonedSelection = JSON.parse(JSON.stringify(selection)) as unknown;
    const result = await connectSelectedBridgeFolders({
      folders: [clonedSelection],
      getPairedBridgeDeviceId: async () => "bridge-device-test",
    });

    assert.equal(result.roots.length, 1);
    assert.equal(result.roots[0]?.displayName, "Round Trip");
  });

  it("returns SELECTION_EXPIRED for a missing selection", async () => {
    const result = await folderConnectionIpcResult(() =>
      connectSelectedBridgeFolders({
        folders: [{ selectionToken: "missing-token" }],
        getPairedBridgeDeviceId: async () => "bridge-device-test",
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "SELECTION_EXPIRED");
  });

  it("keeps a valid selection after recoverable root persistence failure", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Recoverable");
    const selection = await createFolderSelection(folder);
    const tmpBlocker = `${registryPath()}.tmp`;

    await mkdir(tmpBlocker, { recursive: true });

    await expectBridgeCode(
      () =>
        registerRootFromSelection({
          selectionToken: selection.selectionToken,
        }),
      "FOLDER_SELECTION_PERSISTENCE_FAILED",
    );

    await rm(tmpBlocker, { force: true, recursive: true });

    const root = await registerRootFromSelection({
      selectionToken: selection.selectionToken,
    });

    assert.equal(root.displayName, "Recoverable");
  });

  it("consumes a selection exactly once after successful registration", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Once");
    const selection = await createFolderSelection(folder);

    await registerRootFromSelection({
      selectionToken: selection.selectionToken,
    });

    await expectBridgeCode(
      () =>
        registerRootFromSelection({
          selectionToken: selection.selectionToken,
        }),
      "SELECTION_EXPIRED",
    );
  });

  it("returns FOLDER_SELECTION_PERSISTENCE_FAILED through connect IPC result", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Write Failure");
    const selection = await createFolderSelection(folder);
    const tmpBlocker = `${registryPath()}.tmp`;

    await mkdir(tmpBlocker, { recursive: true });

    const result = await folderConnectionIpcResult(() =>
      connectSelectedBridgeFolders({
        folders: [selection],
        getPairedBridgeDeviceId: async () => "bridge-device-test",
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? null : result.code,
      "FOLDER_SELECTION_PERSISTENCE_FAILED",
    );
  });

  it("passes the same folder through selection and registration validation", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Validated");
    const appPath = await makeFolder("Applications", "NSN Bridge.app");
    const options = appPathOptions(appPath);
    const selection = await createFolderSelection(folder, options);
    const root = await registerRootFromSelection({
      selectionToken: selection.selectionToken,
      validationOptions: options,
    });

    assert.equal(await validateRootPath(folder, options), path.normalize(folder));
    assert.equal(root.displayName, "Validated");
  });

  it("rejects unpaired connection attempts", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Unpaired");
    const selection = await createFolderSelection(folder);
    const result = await folderConnectionIpcResult(() =>
      connectSelectedBridgeFolders({
        folders: [selection],
        getPairedBridgeDeviceId: async () => null,
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "BRIDGE_NOT_PAIRED");
  });

  it("returns safe root summaries without absolute actualPath", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Private Folder");
    const selection = await createFolderSelection(folder);
    const result = await folderConnectionIpcResult(() =>
      connectSelectedBridgeFolders({
        folders: [selection],
        getPairedBridgeDeviceId: async () => "bridge-device-test",
      }),
    );
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, true);
    assert.equal("actualPath" in (result.ok ? result.roots[0] ?? {} : {}), false);
    assert.equal(serialized.includes(folder), false);
    assert.equal(serialized.includes("Private Folder"), true);
  });

  it("reports full success when local connection and cloud sync both succeed", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Synced");
    const selection = await createFolderSelection(folder);
    const result = await connectSelectedBridgeFolders({
      folders: [selection],
      getBridgePairingState: async () => ({ status: "COMPLETE" }),
      syncRoots: async () => ({ ok: true }),
    });

    assert.equal(result.cloudSyncStatus, "SYNCED");
    assert.equal(result.roots.length, 1);
    assert.equal(
      result.message,
      "The selected folders are connected to NSN Librarian. Nothing will move without approval.",
    );
  });

  it("keeps the local root when cloud sync is temporarily unavailable", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Pending Sync");
    const selection = await createFolderSelection(folder);
    const result = await connectSelectedBridgeFolders({
      folders: [selection],
      getBridgePairingState: async () => ({ status: "COMPLETE" }),
      syncRoots: async () => {
        throw new Error("network detail stays local");
      },
    });

    assert.equal(result.cloudSyncStatus, "PENDING");
    assert.equal(result.safeCloudErrorCategory, "ROOT_SYNC_FAILED");
    assert.equal(result.roots[0]?.displayName, "Pending Sync");
    assert.equal((await listRoots()).length, 1);
    assert.match(result.message, /connected on this Mac/);
  });

  it("does not connect folders when pairing credentials are incomplete", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Needs Pairing");
    const selection = await createFolderSelection(folder);
    const result = await folderConnectionIpcResult(() =>
      connectSelectedBridgeFolders({
        folders: [selection],
        getBridgePairingState: async () => ({
          safeErrorCategory: "PAIRING_INCOMPLETE",
          status: "INCOMPLETE",
        }),
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "PAIRING_INCOMPLETE");
    assert.equal((await listRoots()).length, 0);
  });

  it("accepts packaged-style macOS user folders when cwd is filesystem root", async () => {
    const previousCwd = process.cwd();
    const folder = await makeFolder(
      "Users",
      "test",
      "NSN_Librarian_E2E_Test_Pack",
      "SCAN_ROOT_A_GENERAL_INBOX",
    );

    process.chdir(path.parse(tempRoot).root);

    try {
      const selection = await createFolderSelection(folder);
      const root = await registerRootFromSelection({
        selectionToken: selection.selectionToken,
      });

      assert.equal(root.displayName, "SCAN_ROOT_A_GENERAL_INBOX");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("uses an existing v0.1.101 registry selection safely", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "Old Registry");
    const now = new Date();
    const selection: FolderSelectionRecord = {
      ancestorRootIds: [],
      actualPath: folder,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      platform: "MACOS",
      rootId: "root_from_previous_build",
      safeLocation: "Old Registry",
      suggestedDisplayName: "Old Registry",
      token: "v101-selection-token",
    };

    await mkdir(dataDir(), { recursive: true });
    await writeFile(
      registryPath(),
      `${JSON.stringify({ roots: [], selections: [selection] }, null, 2)}\n`,
      "utf8",
    );

    const root = await registerRootFromSelection({
      selectionToken: selection.token,
    });

    assert.equal(root.displayName, "Old Registry");
    assert.equal((await listRoots()).length, 1);
  });

  it("chooses and connects a folder without changing files inside it", async () => {
    const folder = await makeFolder("Users", "test", "Documents", "End To End");
    const filePath = path.join(folder, "keep.txt");

    await writeFile(filePath, "do not move");

    const selections = await selectFoldersFromDialog({
      showOpenDialog: async () => ({
        canceled: false,
        filePaths: [folder],
      }),
    });
    const result = await connectSelectedBridgeFolders({
      folders: selections,
      getPairedBridgeDeviceId: async () => "bridge-device-test",
    });

    assert.equal(result.roots.length, 1);
    assert.equal((await listRoots()).length, 1);
    assert.equal(await readFile(filePath, "utf8"), "do not move");

    await expectBridgeCode(
      () =>
        registerRootFromSelection({
          selectionToken: selections[0]?.selectionToken ?? "",
        }),
      "SELECTION_EXPIRED",
    );
  });
});
