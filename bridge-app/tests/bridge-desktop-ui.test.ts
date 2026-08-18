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
  elements: Record<string, FakeElement>;
  openDownloadedUpdateCalls: () => number;
  pairWithCodeCalls: string[];
  statusCallCount: () => number;
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
  downloadUpdate?: () => Promise<unknown>;
  getUpdateStatus?: () => Promise<unknown>;
  openDownloadedUpdate?: () => Promise<unknown>;
  pairFails?: boolean;
  pairedInitially?: boolean;
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
  let openDownloadedUpdateCalls = 0;
  let paired = options.pairedInitially === true;
  let statusCallCount = 0;
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
        connectSelectedFolders: async () => undefined,
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

          return {
            paired,
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
    },
  };

  vm.runInNewContext(rendererScript(), context);
  await settleRenderer();

  return {
    elements,
    openDownloadedUpdateCalls: () => openDownloadedUpdateCalls,
    pairWithCodeCalls,
    statusCallCount: () => statusCallCount,
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
      "This Mac is paired with NSN Librarian.",
    );
    assert.equal(harness.elements.statusBadge.textContent, "Paired and ready");
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
