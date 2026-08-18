type BrowserWindowConstructor = new (options: Record<string, unknown>) => {
  focus: () => void;
  hide: () => void;
  isDestroyed: () => boolean;
  loadURL: (url: string) => Promise<void>;
  on: (eventName: string, listener: (...args: unknown[]) => void) => void;
  show: () => void;
  webContents: {
    send: (channel: string, payload?: unknown) => void;
  };
};

type ElectronMenu = {
  buildFromTemplate: (template: unknown[]) => unknown;
  setApplicationMenu: (menu: unknown) => void;
};

type ElectronTray = new (image: unknown) => {
  on: (eventName: string, listener: (...args: unknown[]) => void) => void;
  setContextMenu: (menu: unknown) => void;
  setToolTip: (tooltip: string) => void;
};

type ElectronNativeImage = {
  setTemplateImage: (isTemplate: boolean) => void;
};

export type ElectronRuntime = {
  BrowserWindow: BrowserWindowConstructor;
  Menu: ElectronMenu;
  Tray: ElectronTray;
  app: {
    dock?: {
      show: () => void;
    };
    getAppPath: () => string;
    getLoginItemSettings: () => { openAtLogin: boolean };
    getPath: (name: "exe" | "temp" | "userData") => string;
    getVersion: () => string;
    isPackaged: boolean;
    on: (eventName: string, listener: (...args: unknown[]) => void) => void;
    quit: () => void;
    requestSingleInstanceLock: () => boolean;
    setLoginItemSettings: (settings: { openAtLogin: boolean }) => void;
    whenReady: () => Promise<void>;
  };
  dialog: {
    showMessageBox: (
      window: unknown,
      options: Record<string, unknown>,
    ) => Promise<{ response: number }>;
    showOpenDialog: (
      window: unknown,
      options: Record<string, unknown>,
    ) => Promise<{ canceled: boolean; filePaths: string[] }>;
  };
  ipcMain: {
    handle: (
      channel: string,
      listener: (_event: unknown, ...args: unknown[]) => unknown,
    ) => void;
  };
  nativeImage: {
    createEmpty: () => ElectronNativeImage;
    createFromDataURL: (dataUrl: string) => ElectronNativeImage;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
    openPath: (filePath: string) => Promise<string>;
  };
};

export function loadElectronRuntime(): ElectronRuntime {
  const runtimeRequire = eval("require") as NodeRequire;

  return runtimeRequire("electron") as ElectronRuntime;
}
