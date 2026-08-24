type NsnBridgeApi = {
  cancelDownloadedUpdate: () => Promise<unknown>;
  checkForUpdates: () => Promise<unknown>;
  chooseFolders: () => Promise<
    Array<{
      displayName?: string;
      expiresAt: string;
      rootId: string;
      safeLocation: string;
      selectionToken: string;
      suggestedDisplayName?: string;
    }>
  >;
  connectSelectedFolders: (folders: unknown[]) => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  getStatus: () => Promise<unknown>;
  getUpdateStatus: () => Promise<unknown>;
  onStatusChanged: (listener: (payload: unknown) => void) => () => void;
  onUpdateStatus: (listener: (payload: unknown) => void) => void;
  openDownloadedUpdate: () => Promise<unknown>;
  openLibrarian: () => Promise<unknown>;
  pairWithCode: (code: string) => Promise<unknown>;
  pauseWatching: () => Promise<unknown>;
  quit: () => Promise<unknown>;
  resumeWatching: () => Promise<unknown>;
};

type FolderSelectionIpcResult =
  | Awaited<ReturnType<NsnBridgeApi["chooseFolders"]>>
  | {
      code?: unknown;
      message?: unknown;
      ok: false;
    }
  | {
      ok: true;
      selections?: Awaited<ReturnType<NsnBridgeApi["chooseFolders"]>>;
    };

type FolderConnectionIpcResult =
  | {
      code?: unknown;
      message?: unknown;
      ok: false;
    }
  | {
      cloudSyncStatus?: unknown;
      message?: unknown;
      ok: true;
      roots?: unknown[];
      safeCloudErrorCategory?: unknown;
    };

const runtimeRequire = eval("require") as NodeRequire;
const { contextBridge, ipcRenderer } = runtimeRequire("electron") as {
  contextBridge: {
    exposeInMainWorld: (key: string, api: NsnBridgeApi) => void;
  };
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (
      channel: string,
      listener: (_event: unknown, payload: unknown) => void,
    ) => void;
    removeListener: (
      channel: string,
      listener: (_event: unknown, payload: unknown) => void,
    ) => void;
  };
};

function safeBridgeError(message: string, code: string) {
  const error = new Error(message);

  Object.assign(error, { code });

  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

contextBridge.exposeInMainWorld("nsnBridge", {
  cancelDownloadedUpdate: () =>
    ipcRenderer.invoke("nsn-bridge:cancel-downloaded-update"),
  checkForUpdates: () => ipcRenderer.invoke("nsn-bridge:check-updates"),
  chooseFolders: async () => {
    const response = (await ipcRenderer.invoke(
      "nsn-bridge:choose-folders",
    )) as FolderSelectionIpcResult;

    if (Array.isArray(response)) {
      return response;
    }

    if (isRecord(response) && response.ok === false) {
      throw safeBridgeError(
        typeof response.message === "string"
          ? response.message
          : "The selected folder could not be chosen safely.",
        typeof response.code === "string"
          ? response.code
          : "FOLDER_SELECTION_FAILED",
      );
    }

    if (isRecord(response) && response.ok === true) {
      return Array.isArray(response.selections) ? response.selections : [];
    }

    return [];
  },
  connectSelectedFolders: async (folders: unknown[]) => {
    const response = (await ipcRenderer.invoke(
      "nsn-bridge:connect-folders",
      folders,
    )) as FolderConnectionIpcResult | unknown;

    if (isRecord(response) && response.ok === false) {
      throw safeBridgeError(
        typeof response.message === "string"
          ? response.message
          : "The selected folder could not be connected safely.",
        typeof response.code === "string"
          ? response.code
          : "ROOT_REGISTRATION_FAILED",
      );
    }

    return response;
  },
  downloadUpdate: () => ipcRenderer.invoke("nsn-bridge:download-update"),
  getStatus: () => ipcRenderer.invoke("nsn-bridge:status"),
  getUpdateStatus: () => ipcRenderer.invoke("nsn-bridge:update-status"),
  onStatusChanged: (listener: (payload: unknown) => void) => {
    if (typeof listener !== "function") {
      return () => undefined;
    }

    const ipcListener = (_event: unknown, payload: unknown) => {
      listener(payload);
    };

    ipcRenderer.on("nsn-bridge:status-changed", ipcListener);

    return () => {
      ipcRenderer.removeListener("nsn-bridge:status-changed", ipcListener);
    };
  },
  onUpdateStatus: (listener: (payload: unknown) => void) => {
    if (typeof listener !== "function") {
      return;
    }

    ipcRenderer.on("nsn-bridge:update-status", (_event, payload) => {
      listener(payload);
    });
  },
  openDownloadedUpdate: () =>
    ipcRenderer.invoke("nsn-bridge:open-downloaded-update"),
  openLibrarian: () => ipcRenderer.invoke("nsn-bridge:open-librarian"),
  pairWithCode: (code: string) => ipcRenderer.invoke("nsn-bridge:pair", code),
  pauseWatching: () => ipcRenderer.invoke("nsn-bridge:pause-watching"),
  quit: () => ipcRenderer.invoke("nsn-bridge:quit"),
  resumeWatching: () => ipcRenderer.invoke("nsn-bridge:resume-watching"),
});

declare global {
  interface Window {
    nsnBridge: NsnBridgeApi;
  }
}

export {};
