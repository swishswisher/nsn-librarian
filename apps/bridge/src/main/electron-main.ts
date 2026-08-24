import type { Server } from "node:http";
import path from "node:path";

import { createBridgeServer } from "../../../../bridge-app/src/api/server";
import { listRoots } from "../../../../bridge-app/src/main/registry";
import {
  pauseBridgeWatcher,
  resumeBridgeWatcher,
} from "../../../../bridge-app/src/watcher/watcher";
import { processPendingBridgeCommands } from "./command-runner";
import { bridgeRendererHtml } from "./renderer-html";
import { loadElectronRuntime } from "./electron-runtime";
import {
  bridgeIdentityCanAuthenticate,
  bridgeRuntimeAppVersion,
  getCompletePairedBridgeIdentity,
  pairBridgeWithCloud,
  sendBridgeHeartbeat,
  setBridgeRuntimeAppVersion,
  syncBridgeRoots,
} from "./cloud-client";
import {
  createBridgeCloudState,
  safeCloudErrorCategory,
} from "./cloud-state";
import { createBridgeUpdateManager } from "./update-manager";
import {
  folderSelectionIpcResult,
  selectFoldersFromDialog,
} from "./folder-selection";
import {
  connectSelectedBridgeFolders,
  folderConnectionIpcResult,
} from "./folder-connection";
import { disconnectBridgeFolder } from "./folder-disconnection";

let localServer: Server | null = null;
const currentDir = __dirname;
const rootSyncIntervalMs = 60_000;
const updateCheckIntervalMs = 6 * 60 * 60 * 1000;

function processResourcesPath() {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

function readApplicationPath(readPath: () => string) {
  try {
    return readPath();
  } catch {
    return null;
  }
}

function bridgeApplicationPaths(electron: ReturnType<typeof loadElectronRuntime>) {
  const candidates = [
    readApplicationPath(() => electron.app.getAppPath()),
    processResourcesPath(),
    readApplicationPath(() => electron.app.getPath("exe")),
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );

  return [
    ...new Set(
      candidates.flatMap((candidate) => [
        candidate,
        path.dirname(candidate),
      ]),
    ),
  ];
}

function isMasBuild() {
  return (process as NodeJS.Process & { mas?: boolean }).mas === true;
}

async function startLocalBridgeServer() {
  if (localServer) {
    return localServer;
  }

  localServer = createBridgeServer();
  await new Promise<void>((resolve) => {
    localServer?.listen(
      Number(process.env.NSN_BRIDGE_PORT ?? 4777),
      "127.0.0.1",
      resolve,
    );
  });

  return localServer;
}

export async function startElectronBridgeApp() {
  const electron = loadElectronRuntime();

  if (!electron.app.requestSingleInstanceLock()) {
    electron.app.quit();
    return;
  }

  await electron.app.whenReady();
  setBridgeRuntimeAppVersion(electron.app.getVersion());
  await startLocalBridgeServer();

  const forbiddenApplicationPaths = bridgeApplicationPaths(electron);
  const updateManager = createBridgeUpdateManager({
    architecture: process.arch,
    currentVersion: bridgeRuntimeAppVersion(),
    onStateChange: (result) => {
      mainWindow?.webContents.send("nsn-bridge:update-status", result);
    },
    openPath: electron.shell.openPath,
    updateDirectory: path.join(electron.app.getPath("temp"), "nsn-bridge-updates"),
  });
  let mainWindow: InstanceType<typeof electron.BrowserWindow> | null = null;
  let isQuitting = false;
  let commandPollInFlight = false;
  let lastRootSyncAt = 0;
  let lastBridgeStatusEventKey = "";
  const cloudState = createBridgeCloudState();

  function sendBridgeStatusChanged(reason: string, options?: { force?: boolean }) {
    const state = cloudState.getState();
    const eventKey = [
      state.cloudConnectionState,
      state.latestSafeCloudErrorCategory ?? "",
    ].join(":");

    if (!options?.force && eventKey === lastBridgeStatusEventKey) {
      return;
    }

    lastBridgeStatusEventKey = eventKey;

    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    mainWindow.webContents.send("nsn-bridge:status-changed", {
      cloudConnectionState: state.cloudConnectionState,
      latestSafeCloudErrorCategory: state.latestSafeCloudErrorCategory,
      reason,
      statusChangedAt: new Date().toISOString(),
    });
  }

  function createMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      return mainWindow;
    }

    mainWindow = new electron.BrowserWindow({
      height: 760,
      minHeight: 620,
      minWidth: 320,
      show: false,
      title: "NSN Bridge",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(currentDir, "preload.cjs"),
        sandbox: true,
      },
      width: 920,
    });
    void mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(bridgeRendererHtml())}`,
    );
    mainWindow.on("ready-to-show", () => mainWindow?.show());
    mainWindow.on("close", (event: unknown) => {
      if (isQuitting) {
        return;
      }

      if (
        typeof event === "object" &&
        event !== null &&
        "preventDefault" in event &&
        typeof event.preventDefault === "function"
      ) {
        event.preventDefault();
      }

      void electron.dialog
        .showMessageBox(mainWindow, {
          buttons: ["Keep Running", "Quit Bridge"],
          defaultId: 0,
          message:
            "Closing this window can leave the Bridge running in the menu bar so connected folders can keep watching.",
          title: "Keep NSN Bridge running?",
          type: "question",
        })
        .then((choice: { response: number }) => {
          if (choice.response === 1) {
            isQuitting = true;
            localServer?.close();
            electron.app.quit();
            return;
          }

          mainWindow?.hide();
        });
    });

    return mainWindow;
  }

  async function chooseFolders() {
    const dialogOptions: Record<string, unknown> = {
      buttonLabel: "Add Selected Folders",
      message: "Choose folders for NSN Bridge",
      properties: ["openDirectory", "multiSelections", "createDirectory"],
      title: "Choose folders for NSN Bridge",
    };

    if (isMasBuild()) {
      dialogOptions.securityScopedBookmarks = true;
    }

    return selectFoldersFromDialog({
      forbiddenApplicationPaths,
      showOpenDialog: () =>
        electron.dialog.showOpenDialog(createMainWindow(), dialogOptions),
    });
  }

  async function syncLocalRoots(force = false) {
    if (!force && Date.now() - lastRootSyncAt < rootSyncIntervalMs) {
      return { ok: true, skipped: true };
    }

    const roots = await listRoots();

    try {
      await syncBridgeRoots(roots);
      lastRootSyncAt = Date.now();
      cloudState.recordRootSyncSuccess();
      sendBridgeStatusChanged("root-sync-success");

      return { ok: true };
    } catch (error) {
      cloudState.recordRootSyncFailure(error);
      sendBridgeStatusChanged("root-sync-failure");

      return {
        ok: false,
        safeErrorCategory: safeCloudErrorCategory(error),
      };
    }
  }

  async function safeBridgePairingStateForConnection() {
    const identity = await getCompletePairedBridgeIdentity();

    if (bridgeIdentityCanAuthenticate(identity)) {
      return { status: "COMPLETE" as const };
    }

    return {
      safeErrorCategory:
        identity.status === "UNAVAILABLE" || identity.status === "UNUSABLE"
          ? identity.safeErrorCategory
          : "PAIRING_INCOMPLETE",
      status: identity.status,
    };
  }

  function safeDesktopPairingState(
    identity: Awaited<ReturnType<typeof getCompletePairedBridgeIdentity>>,
  ) {
    if (bridgeIdentityCanAuthenticate(identity)) {
      return "PAIRED_AND_READY";
    }

    if (identity.status === "UNAVAILABLE") {
      return "KEYCHAIN_UNAVAILABLE";
    }

    if (
      identity.bridgeDeviceId ||
      identity.bridgeDeviceIdStatus === "PRESENT" ||
      identity.privateKeyStatus === "PRESENT"
    ) {
      return "PAIRING_NEEDS_ATTENTION";
    }

    return "NOT_PAIRED";
  }

  async function desktopStatus() {
    const [identity, roots] = await Promise.all([
      getCompletePairedBridgeIdentity(),
      listRoots(),
    ]);
    const bridgeDeviceId = bridgeIdentityCanAuthenticate(identity)
      ? identity.bridgeDeviceId
      : identity.bridgeDeviceId;

    return {
      appVersion: bridgeRuntimeAppVersion(),
      bridgeDeviceId,
      cloud: cloudState.getState(),
      paired: bridgeIdentityCanAuthenticate(identity),
      pairingState: safeDesktopPairingState(identity),
      roots,
    };
  }

  function sendUpdateStatus(payload = updateManager.getState()) {
    mainWindow?.webContents.send("nsn-bridge:update-status", payload);
  }

  async function checkForUpdatesAndNotify() {
    const result = await updateManager.checkForUpdates();

    sendUpdateStatus(result);
    return result;
  }

  async function pauseAllWatching() {
    const roots = await listRoots();
    const results = [];

    for (const root of roots) {
      if (!root.watchPermission || root.watcherState === "STOPPED") {
        continue;
      }

      results.push(await pauseBridgeWatcher(root.id));
    }

    await syncLocalRoots(true);
    return results;
  }

  async function resumeAllWatching() {
    const roots = await listRoots();
    const results = [];

    for (const root of roots) {
      if (!root.watchPermission || root.status === "DISCONNECTED") {
        continue;
      }

      results.push(await resumeBridgeWatcher(root.id));
    }

    await syncLocalRoots(true);
    return results;
  }

  async function confirmFolderDisconnect(root: { displayName: string }) {
    const choice = await electron.dialog.showMessageBox(createMainWindow(), {
      buttons: ["Cancel", "Disconnect Folder"],
      cancelId: 0,
      defaultId: 0,
      message:
        `${root.displayName} will stop scanning and watching in NSN Librarian. No local files will be deleted. Scan and history records remain available, and the folder can be reconnected later.`,
      title: "Disconnect this folder from NSN Librarian?",
      type: "question",
    });

    return choice.response === 1;
  }

  async function recoverCloudConnection(forceRootSync = false) {
    const identity = await getCompletePairedBridgeIdentity();

    if (!bridgeIdentityCanAuthenticate(identity)) {
      cloudState.recordAuthenticationUnavailable(
        identity.status === "UNAVAILABLE" || identity.status === "UNUSABLE"
          ? identity.safeErrorCategory
          : "PAIRING_INCOMPLETE",
      );
      sendBridgeStatusChanged("authentication-unavailable");

      return {
        ok: false,
        safeErrorCategory:
          identity.status === "UNAVAILABLE" || identity.status === "UNUSABLE"
            ? identity.safeErrorCategory
            : "PAIRING_INCOMPLETE",
      };
    }

    try {
      await sendBridgeHeartbeat();
      cloudState.recordHeartbeatSuccess();
      sendBridgeStatusChanged("heartbeat-success");
    } catch (error) {
      cloudState.recordHeartbeatFailure(error);
      sendBridgeStatusChanged("heartbeat-failure");

      return {
        ok: false,
        safeErrorCategory: safeCloudErrorCategory(error),
      };
    }

    return syncLocalRoots(forceRootSync);
  }

  async function pollCloud() {
    if (commandPollInFlight) {
      return [];
    }

    commandPollInFlight = true;

    try {
      const recovery = await recoverCloudConnection(false);

      if (!recovery.ok) {
        return [];
      }

      let reports: Awaited<ReturnType<typeof processPendingBridgeCommands>> = [];

      try {
        reports = await processPendingBridgeCommands({
          selectFolders: chooseFolders,
        });
      } catch (error) {
        cloudState.recordCloudFailure(error);
        sendBridgeStatusChanged("command-poll-failure");
        return [];
      }

      if (reports.length > 0) {
        await syncLocalRoots(true);
        mainWindow?.webContents.send("nsn-bridge:commands-completed", reports);
      }

      return reports;
    } finally {
      commandPollInFlight = false;
    }
  }

  const trayImage = electron.nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path fill="black" d="M3 2h8l4 4v10H3z"/><path fill="white" d="M10 2v5h5"/><circle cx="7" cy="11" r="2" fill="white"/></svg>',
    ).toString("base64")}`,
  );
  trayImage.setTemplateImage(true);
  const tray = new electron.Tray(trayImage);

  function buildMenu() {
    const menu = electron.Menu.buildFromTemplate([
      { enabled: false, label: "NSN Bridge status: Ready" },
      { click: createMainWindow, label: "Open Bridge" },
      {
        click: () =>
          void electron.shell.openExternal(
            process.env.NSN_LIBRARIAN_APP_URL ?? "http://localhost:3000",
          ),
        label: "Open NSN Librarian",
      },
      {
        click: () => void pauseAllWatching(),
        label: "Pause Watching",
      },
      {
        click: () => void resumeAllWatching(),
        label: "Resume Watching",
      },
      {
        click: () => void checkForUpdatesAndNotify(),
        label: "Check for Updates",
      },
      {
        click: () => {
          isQuitting = true;
          localServer?.close();
          electron.app.quit();
        },
        label: "Quit",
      },
    ]);

    electron.Menu.setApplicationMenu(menu);
    tray.setContextMenu(menu);
    tray.setToolTip("NSN Bridge");
    tray.on("click", createMainWindow);
  }

  electron.ipcMain.handle("nsn-bridge:pair", async (_event: unknown, code: unknown) => {
    if (typeof code !== "string") {
      return null;
    }

    const device = await pairBridgeWithCloud(code);
    await recoverCloudConnection(true);
    sendBridgeStatusChanged("pairing-complete", { force: true });
    void pollCloud();
    return device;
  });
  electron.ipcMain.handle("nsn-bridge:status", desktopStatus);
  electron.ipcMain.handle("nsn-bridge:heartbeat", sendBridgeHeartbeat);
  electron.ipcMain.handle("nsn-bridge:commands", pollCloud);
  electron.ipcMain.handle("nsn-bridge:update-status", () =>
    updateManager.getState(),
  );
  electron.ipcMain.handle("nsn-bridge:check-updates", checkForUpdatesAndNotify);
  electron.ipcMain.handle("nsn-bridge:download-update", async () => {
    const result = await updateManager.downloadUpdate();

    sendUpdateStatus(result);
    return result;
  });
  electron.ipcMain.handle("nsn-bridge:open-downloaded-update", async () => {
    const result = await updateManager.openDownloadedUpdate();

    sendUpdateStatus(result);
    return result;
  });
  electron.ipcMain.handle("nsn-bridge:cancel-downloaded-update", async () => {
    const result = await updateManager.cancelDownloadedUpdate();

    sendUpdateStatus(result);
    return result;
  });
  electron.ipcMain.handle("nsn-bridge:pause-watching", pauseAllWatching);
  electron.ipcMain.handle("nsn-bridge:resume-watching", resumeAllWatching);
  electron.ipcMain.handle(
    "nsn-bridge:disconnect-folder",
    async (_event: unknown, rootId: unknown) =>
      disconnectBridgeFolder({
        confirmDisconnect: confirmFolderDisconnect,
        rootId,
        syncRoots: () => syncLocalRoots(true),
      }),
  );
  electron.ipcMain.handle("nsn-bridge:open-librarian", () =>
    electron.shell.openExternal(
      process.env.NSN_LIBRARIAN_APP_URL ?? "http://localhost:3000",
    ),
  );
  electron.ipcMain.handle("nsn-bridge:choose-folders", () =>
    folderSelectionIpcResult(chooseFolders),
  );
  electron.ipcMain.handle(
    "nsn-bridge:connect-folders",
    async (_event: unknown, folders: unknown) => {
      return folderConnectionIpcResult(() =>
        connectSelectedBridgeFolders({
          folders,
          getBridgePairingState: safeBridgePairingStateForConnection,
          permissions: {
            organizationPlanPermission: true,
            readPermission: true,
            recommendationPermission: true,
            watchPermission: false,
          },
          syncRoots: () => syncLocalRoots(true),
          validationOptions: {
            forbiddenApplicationPaths,
          },
        }),
      );
    },
  );
  electron.ipcMain.handle("nsn-bridge:login-item", (_event: unknown, enabled: unknown) => {
    electron.app.setLoginItemSettings({ openAtLogin: enabled === true });
    return electron.app.getLoginItemSettings();
  });
  electron.ipcMain.handle("nsn-bridge:quit", () => {
    isQuitting = true;
    localServer?.close();
    electron.app.quit();
  });

  electron.app.on("second-instance", createMainWindow);
  electron.app.on("activate", createMainWindow);
  buildMenu();
  createMainWindow();

  void recoverCloudConnection(true)
    .then(() => pollCloud())
    .catch(() => undefined);
  setTimeout(() => {
    void checkForUpdatesAndNotify().catch(() => undefined);
  }, 5_000);
  const pollInterval = setInterval(() => {
    void pollCloud().catch(() => undefined);
  }, 15_000);
  const updateCheckInterval = setInterval(() => {
    void checkForUpdatesAndNotify().catch(() => undefined);
  }, updateCheckIntervalMs);

  electron.app.on("before-quit", () => {
    isQuitting = true;
    clearInterval(pollInterval);
    clearInterval(updateCheckInterval);
    localServer?.close();
  });
}
