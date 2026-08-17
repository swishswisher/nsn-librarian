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
  pairFails?: boolean;
  pairedInitially?: boolean;
} = {}): Promise<RendererHarness> {
  const ids = [
    "chooseButton",
    "connectButton",
    "folderList",
    "notice",
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
    "updatesButton",
    "watchingCopy",
  ];
  const elements = Object.fromEntries(
    ids.map((id) => [id, new FakeElement(id)]),
  ) as Record<string, FakeElement>;
  const pairWithCodeCalls: string[] = [];
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
        checkForUpdates: async () => undefined,
        chooseFolders: async () => [],
        connectSelectedFolders: async () => undefined,
        getStatus: async () => {
          statusCallCount += 1;

          return {
            paired,
            roots: [],
          };
        },
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
});
