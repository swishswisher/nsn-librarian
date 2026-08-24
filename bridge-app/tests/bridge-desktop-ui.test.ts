import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import vm from "node:vm";

import { bridgeRendererHtml } from "../../apps/bridge/src/main/renderer-html";

type EventHandler = (event: { preventDefault: () => void }) => unknown;

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  disabled = false;
  focused = false;
  hidden = false;
  textContent = "";
  value = "";

  private readonly listeners = new Map<string, EventHandler[]>();

  constructor(readonly id: string) {}

  set innerHTML(_value: string) {
    this.children = [];
  }

  appendChild(child: FakeElement) {
    this.children.push(child);
  }

  addEventListener(type: string, handler: EventHandler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  focus() {
    this.focused = true;
  }

  async dispatch(type: string) {
    for (const handler of this.listeners.get(type) ?? []) {
      await handler({ preventDefault: () => undefined });
    }
  }
}

type RendererHarness = {
  connectSelectedFoldersCalls: () => unknown[][];
  elements: Record<string, FakeElement>;
  fallbackRefreshMs: () => number | null;
  runFallbackRefresh: () => Promise<void>;
  openDownloadedUpdateCalls: () => number;
  pairWithCodeCalls: string[];
  statusCallCount: () => number;
  statusChangedSubscriptionRemoved: () => boolean;
  triggerStatusChanged: () => Promise<void>;
  unload: () => Promise<void>;
};

async function settleRenderer() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function rendererScript() {
  const html = bridgeRendererHtml();
  const match = /<script>([\s\S]*)<\/script>/.exec(html);

  assert.ok(match, "Bridge renderer HTML should contain one inline script.");

  return match[1];
}

async function createRendererHarness(options: {
  chooseFolders?: () => Promise<unknown>;
  checkForUpdates?: () => Promise<unknown>;
  connectSelectedFolders?: (folders: unknown[]) => Promise<unknown>;
  downloadUpdate?: () => Promise<unknown>;
  getUpdateStatus?: () => Promise<unknown>;
  openDownloadedUpdate?: () => Promise<unknown>;
  pairFails?: boolean;
  pairedInitially?: boolean;
  statusOverride?: () => Promise<Record<string, unknown>>;
} = {}): Promise<RendererHarness> {
  const ids = [
    "chooseButton",
    "connectButton",
    "cancelUpdateButton",
    "downloadUpdateButton",
    "folderList",
    "notice",
    "openUpdateButton",
    "openWebButton",
    "pairButton",
    "pairCancelButton",
    "pairingCodeInput",
    "pairingForm",
    "pairSubmitButton",
    "pauseButton",
    "quitButton",
    "resumeButton",
    "stateCopy",
    "statusBadge",
    "updateBadge",
    "updateCopy",
    "updateNotes",
    "updateSteps",
    "updatesButton",
    "watchingCopy",
  ];
  const elements = Object.fromEntries(
    ids.map((id) => [id, new FakeElement(id)]),
  ) as Record<string, FakeElement>;
  const pairWithCodeCalls: string[] = [];
  const connectSelectedFoldersCalls: unknown[][] = [];
  const statusChangedListeners: Array<(payload: unknown) => unknown> = [];
  const windowListeners = new Map<string, Array<() => unknown>>();
  let openDownloadedUpdateCalls = 0;
  let paired = options.pairedInitially === true;
  let statusCallCount = 0;
  let fallbackRefreshCallback: (() => unknown) | null = null;
  let fallbackRefreshMs: number | null = null;
  let statusChangedSubscriptionRemoved = false;
  const document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    getElementById: (id: string) => {
      elements[id] ??= new FakeElement(id);
      return elements[id];
    },
  };
  const context = {
    document,
    window: {
      nsnBridge: {
        cancelDownloadedUpdate: async () => ({
          message: "The downloaded update was removed.",
          state: "UPDATE_AVAILABLE",
        }),
        checkForUpdates:
          options.checkForUpdates ??
          (async () => ({
            currentVersion: "0.1.0",
            latestVersion: "0.1.0",
            releaseNotes: [],
            state: "UP_TO_DATE",
          })),
        chooseFolders: options.chooseFolders ?? (async () => []),
        connectSelectedFolders:
          options.connectSelectedFolders ??
          (async (folders: unknown[]) => {
            connectSelectedFoldersCalls.push(folders);
            return { ok: true, roots: [] };
          }),
        downloadUpdate:
          options.downloadUpdate ??
          (async () => ({
            currentVersion: "0.1.0",
            latestVersion: "0.1.1",
            releaseNotes: [],
            state: "READY_TO_OPEN",
          })),
        getStatus: async () => {
          statusCallCount += 1;

          if (options.statusOverride) {
            return options.statusOverride();
          }

          return {
            cloud: {
              cloudConnectionState: paired ? "ONLINE" : "UNKNOWN",
              lastSuccessfulHeartbeatAt: paired
                ? "2026-08-19T10:00:00.000Z"
                : null,
              lastSuccessfulRootSyncAt: paired
                ? "2026-08-19T10:00:00.000Z"
                : null,
              latestSafeCloudErrorCategory: null,
            },
            paired,
            pairingState: paired ? "PAIRED_AND_READY" : "NOT_PAIRED",
            roots: [],
          };
        },
        getUpdateStatus:
          options.getUpdateStatus ??
          (async () => ({
            currentVersion: "0.1.0",
            latestVersion: "0.1.0",
            releaseNotes: [],
            state: "IDLE",
          })),
        onStatusChanged: (listener: (payload: unknown) => unknown) => {
          statusChangedListeners.push(listener);

          return () => {
            statusChangedSubscriptionRemoved = true;
            const index = statusChangedListeners.indexOf(listener);

            if (index >= 0) {
              statusChangedListeners.splice(index, 1);
            }
          };
        },
        onUpdateStatus: () => undefined,
        openDownloadedUpdate:
          options.openDownloadedUpdate ??
          (async () => {
            openDownloadedUpdateCalls += 1;

            return {
              currentVersion: "0.1.0",
              latestVersion: "0.1.1",
              releaseNotes: [],
              state: "READY_TO_OPEN",
            };
          }),
        openLibrarian: () => undefined,
        pairWithCode: async (code: string) => {
          pairWithCodeCalls.push(code);

          if (options.pairFails) {
            throw new Error("raw server detail should stay hidden");
          }

          paired = true;
        },
        pauseWatching: async () => undefined,
        quit: () => undefined,
        resumeWatching: async () => undefined,
      },
      addEventListener: (type: string, listener: () => unknown) => {
        windowListeners.set(type, [
          ...(windowListeners.get(type) ?? []),
          listener,
        ]);
      },
      clearInterval: () => {
        fallbackRefreshCallback = null;
      },
      setInterval: (listener: () => unknown, ms: number) => {
        fallbackRefreshCallback = listener;
        fallbackRefreshMs = ms;

        return 1;
      },
    },
  };

  vm.runInNewContext(rendererScript(), context);
  await settleRenderer();

  return {
    connectSelectedFoldersCalls: () => connectSelectedFoldersCalls,
    elements,
    fallbackRefreshMs: () => fallbackRefreshMs,
    runFallbackRefresh: async () => {
      await fallbackRefreshCallback?.();
      await settleRenderer();
    },
    openDownloadedUpdateCalls: () => openDownloadedUpdateCalls,
    pairWithCodeCalls,
    statusCallCount: () => statusCallCount,
    statusChangedSubscriptionRemoved: () => statusChangedSubscriptionRemoved,
    triggerStatusChanged: async () => {
      for (const listener of statusChangedListeners) {
        await listener({ cloudConnectionState: "ONLINE" });
      }
      await settleRenderer();
    },
    unload: async () => {
      for (const listener of windowListeners.get("beforeunload") ?? []) {
        await listener();
      }
      await settleRenderer();
    },
  };
}

describe("Bridge desktop renderer", () => {
  it("uses inline pairing UI without window.prompt", () => {
    const html = bridgeRendererHtml();

    assert.equal(html.includes("window.prompt"), false);
    assert.match(html, /<label for="pairingCodeInput">Pairing code<\/label>/);
    assert.match(html, /id="pairingCodeInput"/);
    assert.match(html, /autocomplete="off"/);
    assert.match(html, /spellcheck="false"/);
    assert.match(html, /maxlength="16"/);
    assert.equal(html.includes("localStorage"), false);
    assert.equal(html.includes("sessionStorage"), false);
  });

  it("submits a typed pairing code to pairWithCode", async () => {
    const harness = await createRendererHarness();

    harness.elements.pairingCodeInput.value = "  ABCD-EFGH  ";
    await harness.elements.pairingForm.dispatch("submit");

    assert.deepEqual(harness.pairWithCodeCalls, ["ABCD-EFGH"]);
  });

  it("does not submit an empty pairing code", async () => {
    const harness = await createRendererHarness();

    harness.elements.pairingCodeInput.value = "   ";
    await harness.elements.pairingForm.dispatch("submit");

    assert.deepEqual(harness.pairWithCodeCalls, []);
    assert.equal(
      harness.elements.notice.textContent,
      "Enter the pairing code shown by NSN Librarian.",
    );
  });

  it("shows a safe message when pairing fails", async () => {
    const harness = await createRendererHarness({ pairFails: true });

    harness.elements.pairingCodeInput.value = "ABCD-EFGH";
    await harness.elements.pairingForm.dispatch("submit");

    assert.deepEqual(harness.pairWithCodeCalls, ["ABCD-EFGH"]);
    assert.equal(
      harness.elements.notice.textContent,
      "That pairing code could not be verified. Generate a new code in NSN Librarian and try again.",
    );
    assert.equal(
      harness.elements.notice.textContent.includes("raw server detail"),
      false,
    );
    assert.equal(harness.elements.pairSubmitButton.disabled, false);
  });

  it("clears the code and refreshes status after successful pairing", async () => {
    const harness = await createRendererHarness();
    const initialStatusCalls = harness.statusCallCount();

    harness.elements.pairingCodeInput.value = "ABCD-EFGH";
    await harness.elements.pairingForm.dispatch("submit");

    assert.equal(harness.elements.pairingCodeInput.value, "");
    assert.equal(harness.statusCallCount(), initialStatusCalls + 1);
    assert.equal(
      harness.elements.notice.textContent,
      "This Mac is paired and connected to NSN Librarian.",
    );
    assert.equal(harness.elements.statusBadge.textContent, "Paired and ready");
  });

  it("shows pairing attention when saved credentials are incomplete", async () => {
    const harness = await createRendererHarness({
      statusOverride: async () => ({
        cloud: {
          cloudConnectionState: "AUTH_UNAVAILABLE",
          latestSafeCloudErrorCategory: "PAIRING_INCOMPLETE",
        },
        paired: false,
        pairingState: "PAIRING_NEEDS_ATTENTION",
        roots: [],
      }),
    });

    assert.equal(harness.elements.statusBadge.textContent, "Pairing needs attention");
    assert.equal(harness.elements.pairButton.textContent, "Pair Again");
    assert.equal(
      harness.elements.stateCopy.textContent,
      "NSN Bridge cannot access its saved device credentials. Pair this Mac again.",
    );
  });

  it("shows folder sync pending when heartbeat succeeds but root sync fails", async () => {
    const harness = await createRendererHarness({
      statusOverride: async () => ({
        cloud: {
          cloudConnectionState: "ROOT_SYNC_FAILED",
          lastSuccessfulHeartbeatAt: "2026-08-19T10:00:00.000Z",
          latestSafeCloudErrorCategory: "SERVER_ERROR",
        },
        paired: true,
        pairingState: "PAIRED_AND_READY",
        roots: [
          {
            displayName: "Inbox",
            watcherState: "STOPPED",
          },
        ],
      }),
    });

    assert.equal(
      harness.elements.statusBadge.textContent,
      "Connected, folder sync pending",
    );
    assert.match(
      harness.elements.stateCopy.textContent,
      /Folder sync is still pending/,
    );
  });

  it("shows clock guidance when signed Bridge requests are expired", async () => {
    const harness = await createRendererHarness({
      statusOverride: async () => ({
        cloud: {
          cloudConnectionState: "AUTH_UNAVAILABLE",
          latestSafeCloudErrorCategory: "REQUEST_EXPIRED",
        },
        paired: true,
        pairingState: "PAIRED_AND_READY",
        roots: [],
      }),
    });

    assert.equal(
      harness.elements.statusBadge.textContent,
      "Paired, check Mac clock",
    );
    assert.match(
      harness.elements.stateCopy.textContent,
      /date or time appears out of sync/,
    );
  });

  it("refreshes from checking to ready when the main process reports cloud recovery", async () => {
    let cloudConnectionState = "UNKNOWN";
    const harness = await createRendererHarness({
      pairedInitially: true,
      statusOverride: async () => ({
        cloud: {
          cloudConnectionState,
          latestSafeCloudErrorCategory: null,
        },
        paired: true,
        pairingState: "PAIRED_AND_READY",
        roots: [],
      }),
    });

    assert.equal(
      harness.elements.statusBadge.textContent,
      "Paired, checking connection",
    );

    cloudConnectionState = "ONLINE";
    await harness.triggerStatusChanged();

    assert.equal(harness.elements.statusBadge.textContent, "Paired and ready");
    assert.equal(
      harness.elements.stateCopy.textContent,
      "This Mac is paired. Choose folders when Deanne is ready.",
    );
  });

  it("refreshes from ready to unavailable when heartbeat fails", async () => {
    let cloudConnectionState = "ONLINE";
    const harness = await createRendererHarness({
      pairedInitially: true,
      statusOverride: async () => ({
        cloud: {
          cloudConnectionState,
          latestSafeCloudErrorCategory: null,
        },
        paired: true,
        pairingState: "PAIRED_AND_READY",
        roots: [],
      }),
    });

    assert.equal(harness.elements.statusBadge.textContent, "Paired and ready");

    cloudConnectionState = "NETWORK_UNAVAILABLE";
    await harness.triggerStatusChanged();

    assert.equal(
      harness.elements.statusBadge.textContent,
      "Paired, connection unavailable",
    );
  });

  it("refreshes from unavailable back to ready when heartbeat recovers", async () => {
    let cloudConnectionState = "NETWORK_UNAVAILABLE";
    const harness = await createRendererHarness({
      pairedInitially: true,
      statusOverride: async () => ({
        cloud: {
          cloudConnectionState,
          latestSafeCloudErrorCategory: null,
        },
        paired: true,
        pairingState: "PAIRED_AND_READY",
        roots: [],
      }),
    });

    assert.equal(
      harness.elements.statusBadge.textContent,
      "Paired, connection unavailable",
    );

    cloudConnectionState = "ONLINE";
    await harness.triggerStatusChanged();

    assert.equal(harness.elements.statusBadge.textContent, "Paired and ready");
  });

  it("uses a low-frequency fallback refresh and removes listeners on unload", async () => {
    let cloudConnectionState = "UNKNOWN";
    const harness = await createRendererHarness({
      pairedInitially: true,
      statusOverride: async () => ({
        cloud: {
          cloudConnectionState,
          latestSafeCloudErrorCategory: null,
        },
        paired: true,
        pairingState: "PAIRED_AND_READY",
        roots: [],
      }),
    });

    assert.equal(harness.fallbackRefreshMs(), 20_000);
    assert.equal(
      harness.elements.statusBadge.textContent,
      "Paired, checking connection",
    );

    cloudConnectionState = "ONLINE";
    await harness.runFallbackRefresh();

    assert.equal(harness.elements.statusBadge.textContent, "Paired and ready");

    await harness.unload();

    assert.equal(harness.statusChangedSubscriptionRemoved(), true);
  });

  it("clears and hides the pairing code on cancellation", async () => {
    const harness = await createRendererHarness();

    harness.elements.pairingCodeInput.value = "ABCD-EFGH";
    await harness.elements.pairCancelButton.dispatch("click");

    assert.equal(harness.elements.pairingCodeInput.value, "");
    assert.equal(harness.elements.pairingForm.hidden, true);
    assert.deepEqual(harness.pairWithCodeCalls, []);
  });

  it("does not show a folder-picker error when selection is cancelled", async () => {
    const harness = await createRendererHarness({
      chooseFolders: async () => [],
    });

    await harness.elements.chooseButton.dispatch("click");

    assert.equal(harness.elements.notice.textContent, "No folder was selected.");
    assert.equal(harness.elements.notice.className, "notice");
  });

  it("shows validation errors without calling them picker failures", async () => {
    const error = new Error("private absolute path detail");

    Object.assign(error, { code: "UNSAFE_APPLICATION_DIRECTORY" });

    const harness = await createRendererHarness({
      chooseFolders: async () => {
        throw error;
      },
    });

    await harness.elements.chooseButton.dispatch("click");

    assert.equal(
      harness.elements.notice.textContent,
      "Choose a personal folder instead of an NSN application folder.",
    );
    assert.equal(harness.elements.notice.textContent.includes("picker"), false);
    assert.equal(harness.elements.notice.textContent.includes("private"), false);
    assert.equal(harness.elements.notice.className, "notice error");
  });

  it("shows expired-selection connection errors without dropping the selected folder", async () => {
    const error = new Error("raw token detail should stay hidden");

    Object.assign(error, { code: "SELECTION_EXPIRED" });

    const harness = await createRendererHarness({
      chooseFolders: async () => [
        {
          safeLocation: "Documents/Inbox",
          selectionToken: "selection-token",
          suggestedDisplayName: "Inbox",
        },
      ],
      connectSelectedFolders: async () => {
        throw error;
      },
    });

    await harness.elements.chooseButton.dispatch("click");
    await harness.elements.connectButton.dispatch("click");

    assert.equal(
      harness.elements.notice.textContent,
      "That folder selection expired. Choose the folder again.",
    );
    assert.equal(harness.elements.notice.textContent.includes("token"), false);
    assert.equal(harness.elements.folderList.children.length, 1);
    assert.equal(harness.elements.connectButton.disabled, false);
  });

  it("shows local persistence connection errors safely", async () => {
    const error = new Error("raw filesystem detail should stay hidden");

    Object.assign(error, { code: "FOLDER_SELECTION_PERSISTENCE_FAILED" });

    const harness = await createRendererHarness({
      chooseFolders: async () => [
        {
          safeLocation: "Documents/Inbox",
          selectionToken: "selection-token",
          suggestedDisplayName: "Inbox",
        },
      ],
      connectSelectedFolders: async () => {
        throw error;
      },
    });

    await harness.elements.chooseButton.dispatch("click");
    await harness.elements.connectButton.dispatch("click");

    assert.equal(
      harness.elements.notice.textContent,
      "The Bridge could not save this connected folder locally.",
    );
    assert.equal(harness.elements.notice.textContent.includes("filesystem"), false);
    assert.equal(harness.elements.notice.className, "notice error");
  });

  it("clears selected folders after a successful safe connection result", async () => {
    const harness = await createRendererHarness({
      chooseFolders: async () => [
        {
          safeLocation: "Documents/Inbox",
          selectionToken: "selection-token",
          suggestedDisplayName: "Inbox",
        },
      ],
    });

    await harness.elements.chooseButton.dispatch("click");
    await harness.elements.connectButton.dispatch("click");

    assert.equal(harness.connectSelectedFoldersCalls().length, 1);
    assert.equal(harness.elements.folderList.children.length, 0);
    assert.equal(
      harness.elements.notice.textContent,
      "The selected folders are connected to NSN Librarian. Nothing will move without approval.",
    );
  });

  it("renders an up-to-date manual update check", async () => {
    const harness = await createRendererHarness({
      checkForUpdates: async () => ({
        currentVersion: "0.1.98",
        latestVersion: "0.1.98",
        releaseNotes: [],
        state: "UP_TO_DATE",
      }),
    });

    await harness.elements.updatesButton.dispatch("click");

    assert.equal(harness.elements.updateBadge.textContent, "Up to date");
    assert.equal(
      harness.elements.updateCopy.textContent,
      "NSN Bridge 0.1.98 is the latest version.",
    );
    assert.equal(harness.elements.downloadUpdateButton.hidden, true);
    assert.equal(harness.elements.notice.textContent, "NSN Bridge is up to date.");
  });

  it("renders an available update without exposing raw release internals", async () => {
    const harness = await createRendererHarness({
      checkForUpdates: async () => ({
        currentVersion: "0.1.97",
        latestVersion: "0.1.98",
        releaseNotes: ["Fixed packaged Mac folder selection."],
        state: "UPDATE_AVAILABLE",
      }),
    });

    await harness.elements.updatesButton.dispatch("click");

    assert.equal(harness.elements.updateBadge.textContent, "Update available");
    assert.equal(harness.elements.updateCopy.textContent, "Version 0.1.98 is available.");
    assert.equal(harness.elements.downloadUpdateButton.hidden, false);
    assert.equal(harness.elements.openUpdateButton.hidden, true);
    assert.equal(harness.elements.updateCopy.textContent.includes("SHA"), false);
  });

  it("does not claim success when update checking fails", async () => {
    const harness = await createRendererHarness({
      checkForUpdates: async () => ({
        message: "Update information is not available right now.",
        releaseNotes: [],
        state: "FAILED",
      }),
    });

    await harness.elements.updatesButton.dispatch("click");

    assert.equal(harness.elements.updateBadge.textContent, "Update unavailable");
    assert.equal(
      harness.elements.notice.textContent,
      "Update information is not available right now.",
    );
    assert.equal(harness.elements.notice.className, "notice error");
  });

  it("opens only the verified downloaded update action", async () => {
    const harness = await createRendererHarness({
      downloadUpdate: async () => ({
        currentVersion: "0.1.97",
        latestVersion: "0.1.98",
        releaseNotes: [],
        state: "READY_TO_OPEN",
      }),
    });

    await harness.elements.downloadUpdateButton.dispatch("click");
    await harness.elements.openUpdateButton.dispatch("click");

    assert.equal(harness.elements.openUpdateButton.hidden, false);
    assert.equal(harness.elements.updateSteps.hidden, false);
    assert.equal(harness.openDownloadedUpdateCalls(), 1);
  });
});

describe("Bridge desktop app lifecycle", () => {
  it("reopens a hidden macOS window through app activation", async () => {
    const source = await readFile("apps/bridge/src/main/electron-main.ts", "utf8");

    assert.match(source, /electron\.app\.on\("activate", createMainWindow\);/);
    assert.match(source, /electron\.app\.on\("second-instance", createMainWindow\);/);
    assert.match(source, /mainWindow\.show\(\);/);
    assert.match(source, /mainWindow\.focus\(\);/);
  });

  it("keeps close-to-hide and explicit quit behavior", async () => {
    const source = await readFile("apps/bridge/src/main/electron-main.ts", "utf8");

    assert.match(source, /buttons: \["Keep Running", "Quit Bridge"\]/);
    assert.match(source, /mainWindow\?\.hide\(\);/);
    assert.match(source, /isQuitting = true;/);
    assert.match(source, /localServer\?\.close\(\);/);
    assert.match(source, /electron\.app\.quit\(\);/);
  });

  it("uses the packaged Electron version as the reported Bridge version", async () => {
    const source = await readFile("apps/bridge/src/main/electron-main.ts", "utf8");

    assert.match(source, /setBridgeRuntimeAppVersion\(electron\.app\.getVersion\(\)\);/);
    assert.match(source, /appVersion: bridgeRuntimeAppVersion\(\)/);
  });

  it("keeps assisted update IPC narrow", async () => {
    const preloadSource = await readFile("apps/bridge/src/main/preload.ts", "utf8");
    const mainSource = await readFile("apps/bridge/src/main/electron-main.ts", "utf8");

    assert.match(preloadSource, /downloadUpdate: \(\) =>/);
    assert.match(preloadSource, /openDownloadedUpdate: \(\) =>/);
    assert.match(mainSource, /"nsn-bridge:download-update"/);
    assert.match(mainSource, /"nsn-bridge:open-downloaded-update"/);
    assert.equal(preloadSource.includes("openPath"), false);
    assert.equal(preloadSource.includes("downloadUrl"), false);
  });

  it("keeps folder connection IPC structured and safe", async () => {
    const preloadSource = await readFile("apps/bridge/src/main/preload.ts", "utf8");
    const mainSource = await readFile("apps/bridge/src/main/electron-main.ts", "utf8");

    assert.match(preloadSource, /connectSelectedFolders: async/);
    assert.match(preloadSource, /ROOT_REGISTRATION_FAILED/);
    assert.match(mainSource, /folderConnectionIpcResult/);
    assert.match(mainSource, /getCompletePairedBridgeIdentity/);
    assert.equal(preloadSource.includes("actualPath"), false);
  });

  it("keeps native status-change IPC narrow and renderer-driven", async () => {
    const preloadSource = await readFile("apps/bridge/src/main/preload.ts", "utf8");
    const mainSource = await readFile("apps/bridge/src/main/electron-main.ts", "utf8");
    const rendererSource = bridgeRendererHtml();
    const statusEventPayload =
      /mainWindow\.webContents\.send\("nsn-bridge:status-changed", \{[\s\S]*?\}\);/.exec(
        mainSource,
      )?.[0] ?? "";

    assert.match(preloadSource, /onStatusChanged/);
    assert.match(preloadSource, /"nsn-bridge:status-changed"/);
    assert.match(preloadSource, /removeListener\("nsn-bridge:status-changed"/);
    assert.match(rendererSource, /window\.nsnBridge\.onStatusChanged/);
    assert.match(rendererSource, /onStatusChanged\(\(\) => \{\s+refreshStatus\(\);/);
    assert.match(mainSource, /sendBridgeStatusChanged\("heartbeat-success"\)/);
    assert.match(mainSource, /sendBridgeStatusChanged\("heartbeat-failure"\)/);
    assert.match(
      mainSource,
      /sendBridgeStatusChanged\("authentication-unavailable"\)/,
    );
    assert.match(mainSource, /sendBridgeStatusChanged\("root-sync-success"\)/);
    assert.match(mainSource, /sendBridgeStatusChanged\("root-sync-failure"\)/);
    assert.match(mainSource, /sendBridgeStatusChanged\("pairing-complete"/);
    assert.equal(statusEventPayload.includes("privateKey"), false);
    assert.equal(statusEventPayload.includes("secret"), false);
    assert.equal(statusEventPayload.includes("bridgeDeviceId"), false);
    assert.equal(statusEventPayload.includes("desktopStatus"), false);
  });

  it("uses a slow fallback status refresh without leaving renderer timers behind", () => {
    const rendererSource = bridgeRendererHtml();

    assert.match(rendererSource, /statusFallbackRefreshMs = 20 \* 1000/);
    assert.match(rendererSource, /window\.setInterval\(\(\) => \{\s+refreshStatus\(\);/);
    assert.match(rendererSource, /window\.addEventListener\("beforeunload"/);
    assert.match(rendererSource, /window\.clearInterval\(statusRefreshInterval\)/);
    assert.match(rendererSource, /removeStatusChangedListener\(\)/);
  });

  it("recovers cloud heartbeat and root sync immediately on startup", async () => {
    const source = await readFile("apps/bridge/src/main/electron-main.ts", "utf8");

    assert.match(source, /void recoverCloudConnection\(true\)/);
    assert.match(source, /await sendBridgeHeartbeat\(\);/);
    assert.match(source, /cloudState\.recordHeartbeatSuccess\(\);/);
    assert.match(source, /return syncLocalRoots\(forceRootSync\);/);
  });

  it("pairs again without clearing existing local roots", async () => {
    const source = await readFile("apps/bridge/src/main/electron-main.ts", "utf8");
    const pairHandler =
      /ipcMain\.handle\("nsn-bridge:pair"[\s\S]*?return device;\s+\}\);/;
    const match = pairHandler.exec(source);

    assert.ok(match, "Pair handler should remain present.");
    assert.match(match[0], /pairBridgeWithCloud\(code\)/);
    assert.match(match[0], /recoverCloudConnection\(true\)/);
    assert.equal(match[0].includes("disconnectRoot"), false);
    assert.equal(match[0].includes("registerRootFromSelection"), false);
  });

  it("does not expose private keys through desktop status or renderer copy", async () => {
    const mainSource = await readFile("apps/bridge/src/main/electron-main.ts", "utf8");
    const rendererSource = bridgeRendererHtml();

    assert.equal(/privateKey/.test(rendererSource), false);
    assert.equal(/privateKey/.test(mainSource.replace(/identity\.privateKey/g, "")), false);
  });

  it("checks for updates after startup without automatically downloading", async () => {
    const source = await readFile("apps/bridge/src/main/electron-main.ts", "utf8");
    const startupCheck = /setTimeout\(\(\) => \{\s+void checkForUpdatesAndNotify\(\)\.catch\(\(\) => undefined\);\s+\}, 5_000\);/s;

    assert.match(source, startupCheck);
    assert.equal(/setTimeout[\s\S]*downloadUpdate/.test(source), false);
  });

  it("keeps unsigned updates as assisted DMG installation only", async () => {
    const managerSource = await readFile("apps/bridge/src/main/update-manager.ts", "utf8");
    const packageSource = await readFile("package.json", "utf8");

    assert.equal(packageSource.includes("electron-updater"), false);
    assert.equal(managerSource.includes("autoUpdater"), false);
    assert.equal(managerSource.includes("Keychain"), false);
    assert.equal(managerSource.includes(".nsn-bridge"), false);
  });

  it("stamps one release version into both macOS architecture builds", async () => {
    const workflow = await readFile(".github/workflows/release-bridge-macos.yml", "utf8");
    const packageScript = await readFile("scripts/package-bridge-mac.mjs", "utf8");

    assert.match(workflow, /version="0\.1\.\$\{RUN_NUMBER\}"/);
    assert.match(workflow, /echo "tag=bridge-v\$\{version\}"/);
    assert.match(workflow, /NSN_BRIDGE_RELEASE_VERSION: \$\{\{ steps\.bridge_version\.outputs\.version \}\}/);
    assert.match(packageScript, /NSN_BRIDGE_RELEASE_VERSION/);
    assert.match(packageScript, /bridgePackage\.version = releaseVersion/);
  });
});
