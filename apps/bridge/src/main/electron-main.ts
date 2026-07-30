import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createBridgeServer } from "../../../../bridge-app/src/api/server";
import {
  createFolderSelection,
  registerRootFromSelection,
} from "../../../../bridge-app/src/main/registry";
import { bridgeRendererHtml } from "./renderer-html";
import { loadElectronRuntime } from "./electron-runtime";
import {
  fetchPendingBridgeCommands,
  pairBridgeWithCloud,
  sendBridgeHeartbeat,
} from "./cloud-client";
import { checkBridgeUpdateManifest } from "./update-manager";

let localServer: Server | null = null;
const currentDir = path.dirname(fileURLToPath(import.meta.url));

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
  await startLocalBridgeServer();

  let mainWindow: InstanceType<typeof electron.BrowserWindow> | null = null;
  let isQuitting = false;

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
      if (!isQuitting) {
        if (
          typeof event === "object" &&
          event !== null &&
          "preventDefault" in event &&
          typeof event.preventDefault === "function"
        ) {
          event.preventDefault();
        }
        void electron.dialog.showMessageBox(mainWindow, {
          buttons: ["Keep Running", "Quit Bridge"],
          defaultId: 0,
          message:
            "Closing this window can leave the Bridge running in the menu bar so connected folders can keep watching.",
          title: "Keep NSN Bridge running?",
          type: "question",
        });
      }
    });

    return mainWindow;
  }

  const tray = new electron.Tray(electron.nativeImage.createEmpty());

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
        enabled: false,
        label: "Watching status: controlled by folder permissions",
      },
      {
        click: () => mainWindow?.webContents.send("nsn-bridge:pause-watching"),
        label: "Pause Watching",
      },
      {
        click: () => mainWindow?.webContents.send("nsn-bridge:resume-watching"),
        label: "Resume Watching",
      },
      {
        click: () => mainWindow?.webContents.send("nsn-bridge:check-updates"),
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
  }

  electron.ipcMain.handle("nsn-bridge:pair", async (_event: unknown, code: unknown) => {
    if (typeof code !== "string") {
      return null;
    }

    return pairBridgeWithCloud(code);
  });
  electron.ipcMain.handle("nsn-bridge:heartbeat", sendBridgeHeartbeat);
  electron.ipcMain.handle("nsn-bridge:commands", fetchPendingBridgeCommands);
  electron.ipcMain.handle("nsn-bridge:check-updates", checkBridgeUpdateManifest);
  electron.ipcMain.handle("nsn-bridge:open-librarian", () =>
    electron.shell.openExternal(
      process.env.NSN_LIBRARIAN_APP_URL ?? "http://localhost:3000",
    ),
  );
  electron.ipcMain.handle("nsn-bridge:choose-folders", async () => {
    const result = await electron.dialog.showOpenDialog(createMainWindow(), {
      buttonLabel: "Add Selected Folders",
      message: "Choose folders for NSN Bridge",
      properties: ["openDirectory", "multiSelections", "createDirectory"],
      securityScopedBookmarks: true,
      title: "Choose folders for NSN Bridge",
    });

    if (result.canceled) {
      return [];
    }

    return Promise.all(
      result.filePaths.map(async (filePath: string) => {
        const selection = await createFolderSelection(filePath);

        return {
          displayName: selection.suggestedDisplayName,
          expiresAt: selection.expiresAt,
          rootId: selection.rootId,
          safeLocation: selection.safeLocation,
          selectionToken: selection.selectionToken,
        };
      }),
    );
  });
  electron.ipcMain.handle(
    "nsn-bridge:connect-folders",
    async (_event: unknown, folders: unknown) => {
    const selectedFolders = Array.isArray(folders) ? folders : [];
    const roots = [];

    for (const folder of selectedFolders) {
      if (
        typeof folder !== "object" ||
        folder === null ||
        typeof (folder as { selectionToken?: unknown }).selectionToken !==
          "string"
      ) {
        continue;
      }

      roots.push(
        await registerRootFromSelection({
          permissions: {
            organizationPlanPermission: true,
            readPermission: true,
            recommendationPermission: true,
            watchPermission: false,
          },
          selectionToken: (folder as { selectionToken: string })
            .selectionToken,
        }),
      );
    }

    return {
      ok: true,
      roots,
    };
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

  buildMenu();
  createMainWindow();

  const pollInterval = setInterval(() => {
    void sendBridgeHeartbeat();
    void fetchPendingBridgeCommands().then((commands: unknown[]) => {
      if (commands.length > 0) {
        mainWindow?.webContents.send("nsn-bridge:commands-ready", commands);
      }
    });
  }, 15_000);

  electron.app.on("before-quit", () => {
    clearInterval(pollInterval);
    localServer?.close();
  });
}
