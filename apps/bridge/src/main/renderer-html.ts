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
        --danger: #8b3131;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-width: 320px;
        background: var(--bg);
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main { display: grid; gap: 16px; padding: 20px; }
      header, section {
        min-width: 0;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--card);
        padding: 16px;
      }
      h1, h2, p { margin: 0; overflow-wrap: anywhere; }
      h1 { font-size: clamp(28px, 6vw, 44px); line-height: 1.08; }
      h2 { font-size: 18px; }
      p { color: var(--muted); line-height: 1.6; }
      .actions, .folder-list, .status-grid { display: grid; gap: 10px; }
      .pairing-form {
        display: grid;
        gap: 10px;
        margin-top: 12px;
      }
      .pairing-form[hidden] { display: none; }
      .field { display: grid; gap: 6px; }
      label {
        color: var(--ink);
        font-size: 13px;
        font-weight: 800;
      }
      input {
        min-height: 44px;
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: white;
        color: var(--ink);
        font: inherit;
        padding: 10px 12px;
      }
      input:disabled { cursor: not-allowed; opacity: 0.55; }
      .notice {
        min-height: 24px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }
      .notice.error { color: var(--danger); }
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
      button.primary { border-color: var(--teal); background: var(--teal); color: white; }
      button:hover { border-color: var(--teal-dark); }
      button:disabled { cursor: not-allowed; opacity: 0.55; }
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
      .badge.warning { background: #fff2db; color: var(--warning); }
      .folder {
        border: 1px solid var(--border);
        border-radius: 6px;
        display: grid;
        gap: 4px;
        padding: 10px;
      }
      .folder strong { overflow-wrap: anywhere; }
      .folder small { color: var(--muted); overflow-wrap: anywhere; }
      @media (min-width: 720px) {
        main { padding: 28px; }
        .actions, .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        button { width: fit-content; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <span class="badge warning" id="statusBadge">Checking</span>
        <h1>NSN Bridge</h1>
        <p id="stateCopy">Checking this Mac's connection to NSN Librarian.</p>
      </header>

      <section>
        <h2>Connection</h2>
        <p id="connectionCopy">The Bridge works only with folders Deanne explicitly chooses.</p>
        <div class="actions">
          <button class="primary" id="pairButton">Pair This Mac</button>
          <button id="openWebButton">Open NSN Librarian</button>
        </div>
        <form class="pairing-form" id="pairingForm" hidden>
          <div class="field">
            <label for="pairingCodeInput">Pairing code</label>
            <input
              id="pairingCodeInput"
              name="pairingCode"
              type="text"
              autocomplete="off"
              spellcheck="false"
              maxlength="16"
            />
          </div>
          <div class="actions">
            <button class="primary" id="pairSubmitButton" type="submit">Pair This Mac</button>
            <button id="pairCancelButton" type="button">Cancel</button>
          </div>
        </form>
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
        <p id="watchingCopy">Watching remains read-only. File changes still require an approved plan.</p>
        <div class="actions">
          <button id="pauseButton">Pause All Watching</button>
          <button id="resumeButton">Resume Watching</button>
        </div>
      </section>

      <section>
        <h2>Recent Activity</h2>
        <p class="notice" id="notice">The Bridge is ready.</p>
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
      let connectedRoots = [];
      const folderList = document.getElementById("folderList");
      const connectButton = document.getElementById("connectButton");
      const statusBadge = document.getElementById("statusBadge");
      const stateCopy = document.getElementById("stateCopy");
      const watchingCopy = document.getElementById("watchingCopy");
      const notice = document.getElementById("notice");
      const pairButton = document.getElementById("pairButton");
      const pairingForm = document.getElementById("pairingForm");
      const pairingCodeInput = document.getElementById("pairingCodeInput");
      const pairSubmitButton = document.getElementById("pairSubmitButton");
      const pairCancelButton = document.getElementById("pairCancelButton");
      let pairingFormDismissed = false;

      function showNotice(message, isError) {
        notice.textContent = message;
        notice.className = isError ? "notice error" : "notice";
      }

      function clearPairingCode() {
        pairingCodeInput.value = "";
      }

      function showPairingForm(shouldFocus) {
        pairingFormDismissed = false;
        pairingForm.hidden = false;
        pairButton.hidden = true;
        if (shouldFocus) {
          pairingCodeInput.focus();
        }
      }

      function hidePairingForm() {
        pairingForm.hidden = true;
        pairButton.hidden = false;
        clearPairingCode();
      }

      function setPairingControlsDisabled(disabled) {
        pairButton.disabled = disabled;
        pairSubmitButton.disabled = disabled;
        pairCancelButton.disabled = disabled;
        pairingCodeInput.disabled = disabled;
      }

      function renderFolders() {
        folderList.innerHTML = "";
        selectedFolders.forEach((folder) => {
          const item = document.createElement("div");
          item.className = "folder";
          const title = document.createElement("strong");
          title.textContent = folder.suggestedDisplayName || folder.displayName || "Selected folder";
          const detail = document.createElement("small");
          detail.textContent = folder.safeLocation || "Folder selected on this Mac";
          item.appendChild(title);
          item.appendChild(detail);
          folderList.appendChild(item);
        });
        connectedRoots.forEach((root) => {
          const item = document.createElement("div");
          item.className = "folder";
          const title = document.createElement("strong");
          title.textContent = root.displayName;
          const detail = document.createElement("small");
          detail.textContent = (root.safeLocation || "Connected folder") + " · " + root.watcherState;
          item.appendChild(title);
          item.appendChild(detail);
          folderList.appendChild(item);
        });
        connectButton.disabled = selectedFolders.length === 0;
      }

      async function refreshStatus() {
        try {
          const status = await window.nsnBridge.getStatus();
          connectedRoots = status && Array.isArray(status.roots) ? status.roots : [];
          const watchingCount = connectedRoots.filter((root) => root.watcherState === "WATCHING").length;
          if (status && status.paired) {
            statusBadge.textContent = "Paired and ready";
            statusBadge.className = "badge";
            stateCopy.textContent = connectedRoots.length === 0
              ? "This Mac is paired. Choose folders when Deanne is ready."
              : "This Mac is paired with " + connectedRoots.length + " connected folder" + (connectedRoots.length === 1 ? "." : "s.");
            pairButton.textContent = "Pair Again";
            pairingFormDismissed = false;
            hidePairingForm();
          } else {
            statusBadge.textContent = "Not paired";
            statusBadge.className = "badge warning";
            stateCopy.textContent = "Pair this Mac with NSN Librarian.";
            pairButton.textContent = "Pair This Mac";
            if (!pairingFormDismissed) {
              showPairingForm(false);
            }
          }
          watchingCopy.textContent = watchingCount > 0
            ? "Watching " + watchingCount + " connected folder" + (watchingCount === 1 ? "." : "s.")
            : "Watching is paused or has not been enabled for any connected folder.";
          renderFolders();
        } catch {
          showNotice("The Bridge could not refresh its local status.", true);
        }
      }

      document.getElementById("chooseButton").addEventListener("click", async () => {
        try {
          const result = await window.nsnBridge.chooseFolders();
          if (result && result.length) {
            selectedFolders.push(...result);
            renderFolders();
            showNotice("Review the selected folders, then connect them.", false);
          }
        } catch {
          showNotice("The folder picker could not open.", true);
        }
      });

      connectButton.addEventListener("click", async () => {
        try {
          await window.nsnBridge.connectSelectedFolders(selectedFolders);
          selectedFolders.splice(0, selectedFolders.length);
          await refreshStatus();
          showNotice("The selected folders are connected. Nothing will move without approval.", false);
        } catch {
          showNotice("The selected folders could not be connected safely.", true);
        }
      });

      pairButton.addEventListener("click", () => {
        showPairingForm(true);
      });

      pairCancelButton.addEventListener("click", () => {
        pairingFormDismissed = true;
        hidePairingForm();
      });

      pairingForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const code = pairingCodeInput.value.trim();
        if (!code) {
          showNotice("Enter the pairing code shown by NSN Librarian.", true);
          pairingCodeInput.focus();
          return;
        }

        setPairingControlsDisabled(true);
        try {
          await window.nsnBridge.pairWithCode(code);
          clearPairingCode();
          await refreshStatus();
          showNotice("This Mac is paired with NSN Librarian.", false);
        } catch {
          showNotice("That pairing code could not be verified. Generate a new code in NSN Librarian and try again.", true);
        } finally {
          setPairingControlsDisabled(false);
        }
      });

      document.getElementById("openWebButton").addEventListener("click", () => window.nsnBridge.openLibrarian());
      document.getElementById("pauseButton").addEventListener("click", async () => {
        await window.nsnBridge.pauseWatching();
        await refreshStatus();
        showNotice("Watching is paused. Local files were not changed.", false);
      });
      document.getElementById("resumeButton").addEventListener("click", async () => {
        await window.nsnBridge.resumeWatching();
        await refreshStatus();
        showNotice("Watching resumed for folders that permit it.", false);
      });
      document.getElementById("updatesButton").addEventListener("click", async () => {
        await window.nsnBridge.checkForUpdates();
        showNotice("The Bridge checked for an available update.", false);
      });
      document.getElementById("quitButton").addEventListener("click", () => window.nsnBridge.quit());
      refreshStatus();
    </script>
  </body>
</html>`;
}
