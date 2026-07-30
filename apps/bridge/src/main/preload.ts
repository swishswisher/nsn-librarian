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

const runtimeRequire = eval("require") as NodeRequire;
const { contextBridge, ipcRenderer } = runtimeRequire("electron") as {
  contextBridge: {
    exposeInMainWorld: (key: string, api: NsnBridgeApi) => void;
  };
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
};

contextBridge.exposeInMainWorld("nsnBridge", {
  checkForUpdates: () => ipcRenderer.invoke("nsn-bridge:check-updates"),
  chooseFolders: () =>
    ipcRenderer.invoke("nsn-bridge:choose-folders") as Promise<
      Array<{
        displayName?: string;
        expiresAt: string;
        rootId: string;
        safeLocation: string;
        selectionToken: string;
        suggestedDisplayName?: string;
      }>
    >,
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
