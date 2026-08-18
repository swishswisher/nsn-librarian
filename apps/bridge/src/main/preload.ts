type NsnBridgeApi = {
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
  getStatus: () => Promise<unknown>;
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

const runtimeRequire = eval("require") as NodeRequire;
const { contextBridge, ipcRenderer } = runtimeRequire("electron") as {
  contextBridge: {
    exposeInMainWorld: (key: string, api: NsnBridgeApi) => void;
  };
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
};

function safeBridgeError(message: string, code: string) {
  const error = new Error(message);

  Object.assign(error, { code });

  return error;
}

contextBridge.exposeInMainWorld("nsnBridge", {
  checkForUpdates: () => ipcRenderer.invoke("nsn-bridge:check-updates"),
  chooseFolders: async () => {
    const response = (await ipcRenderer.invoke(
      "nsn-bridge:choose-folders",
    )) as FolderSelectionIpcResult;

    if (Array.isArray(response)) {
      return response;
    }

    if (response && typeof response === "object" && response.ok === false) {
      throw safeBridgeError(
        typeof response.message === "string"
          ? response.message
          : "The selected folder could not be chosen safely.",
        typeof response.code === "string"
          ? response.code
          : "FOLDER_SELECTION_FAILED",
      );
    }

    if (response && typeof response === "object" && response.ok === true) {
      return Array.isArray(response.selections) ? response.selections : [];
    }

    return [];
  },
  connectSelectedFolders: (folders: unknown[]) =>
    ipcRenderer.invoke("nsn-bridge:connect-folders", folders),
  getStatus: () => ipcRenderer.invoke("nsn-bridge:status"),
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
