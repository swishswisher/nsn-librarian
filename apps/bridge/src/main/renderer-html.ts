export function bridgeRendererHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src https:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NSN Bridge</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f1e8;
        --card: #fffaf2;
        --border: #ddcfc0;
        --ink: #17313b;
        --muted: #5d6b70;
        --teal: #17706f;
        --teal-dark: #0f5554;
        --warning: #8a5a1f;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-width: 320px;
        background: var(--bg);
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        display: grid;
        gap: 16px;
        padding: 20px;
      }
      header,
      section {
        min-width: 0;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--card);
        padding: 16px;
      }
      h1,
      h2,
      p {
        margin: 0;
        overflow-wrap: anywhere;
      }
      h1 {
        font-size: clamp(28px, 6vw, 44px);
        line-height: 1.08;
      }
      h2 {
        font-size: 18px;
      }
      p {
        color: var(--muted);
        line-height: 1.6;
      }
      .actions,
      .folder-list,
      .status-grid {
        display: grid;
        gap: 10px;
      }
      button {
        min-height: 44px;
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: white;
        color: var(--ink);
        cursor: pointer;
        font: inherit;
        font-weight: 700;
        padding: 10px 14px;
      }
      button.primary {
        border-color: var(--teal);
        background: var(--teal);
        color: white;
      }
      button:hover {
        border-color: var(--teal-dark);
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      .badge {
        display: inline-flex;
        width: fit-content;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: #edf6f4;
        color: var(--teal-dark);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.04em;
        padding: 5px 8px;
        text-transform: uppercase;
      }
      .folder {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 10px;
      }
      @media (min-width: 720px) {
        main {
          padding: 28px;
        }
        .actions,
        .status-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        button {
          width: fit-content;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <span class="badge" id="statusBadge">Not paired</span>
        <h1>NSN Bridge</h1>
        <p id="stateCopy">Pair this Mac with NSN Librarian.</p>
      </header>

      <section>
        <h2>Connection</h2>
        <p id="connectionCopy">The Bridge works only with folders Deanne explicitly chooses.</p>
        <div class="actions">
          <button class="primary" id="pairButton">Pair This Mac</button>
          <button id="openWebButton">Open NSN Librarian</button>
        </div>
      </section>

      <section>
        <h2>Connected Folders</h2>
        <p>Choose folders through the native macOS picker. No manual path entry is shown here.</p>
        <div class="actions">
          <button id="chooseButton">Choose Folders</button>
          <button id="connectButton" disabled>Connect Selected Folders</button>
        </div>
        <div class="folder-list" id="folderList"></div>
      </section>

      <section>
        <h2>Watching</h2>
        <div class="actions">
          <button id="pauseButton">Pause All Watching</button>
          <button id="resumeButton">Resume Watching</button>
        </div>
      </section>

      <section>
        <h2>Updates</h2>
        <div class="actions">
          <button id="updatesButton">Check for Updates</button>
          <button id="quitButton">Quit Bridge</button>
        </div>
      </section>
    </main>
    <script>
      const selectedFolders = [];
      const folderList = document.getElementById("folderList");
      const connectButton = document.getElementById("connectButton");

      function renderFolders() {
        folderList.innerHTML = "";
        selectedFolders.forEach((folder) => {
          const item = document.createElement("div");
          item.className = "folder";
          item.textContent = folder.safeLocation || folder.displayName;
          folderList.appendChild(item);
        });
        connectButton.disabled = selectedFolders.length === 0;
      }

      document.getElementById("chooseButton").addEventListener("click", async () => {
        const result = await window.nsnBridge.chooseFolders();
        if (result && result.length) {
          selectedFolders.push(...result);
          renderFolders();
        }
      });

      document.getElementById("connectButton").addEventListener("click", async () => {
        await window.nsnBridge.connectSelectedFolders(selectedFolders);
        selectedFolders.splice(0, selectedFolders.length);
        renderFolders();
      });

      document.getElementById("pairButton").addEventListener("click", async () => {
        const code = window.prompt("Enter the pairing code shown by NSN Librarian.");
        if (code) {
          await window.nsnBridge.pairWithCode(code);
        }
      });

      document.getElementById("openWebButton").addEventListener("click", () => {
        window.nsnBridge.openLibrarian();
      });
      document.getElementById("pauseButton").addEventListener("click", () => window.nsnBridge.pauseWatching());
      document.getElementById("resumeButton").addEventListener("click", () => window.nsnBridge.resumeWatching());
      document.getElementById("updatesButton").addEventListener("click", () => window.nsnBridge.checkForUpdates());
      document.getElementById("quitButton").addEventListener("click", () => window.nsnBridge.quit());
    </script>
  </body>
</html>`;
}
