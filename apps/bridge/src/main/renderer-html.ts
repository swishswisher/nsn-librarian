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
      .update-panel { display: grid; gap: 10px; }
      .update-notes, .update-steps {
        display: grid;
        gap: 6px;
        margin: 0;
        padding-left: 18px;
        color: var(--muted);
        line-height: 1.5;
      }
      .update-notes:empty, .update-steps[hidden] { display: none; }
      .update-notes li, .update-steps li { overflow-wrap: anywhere; }
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
        <div class="update-panel">
          <span class="badge warning" id="updateBadge">Not checked</span>
          <p id="updateCopy">NSN Bridge can check for a verified update.</p>
          <ul class="update-notes" id="updateNotes"></ul>
          <ol class="update-steps" id="updateSteps" hidden>
            <li>Quit NSN Bridge.</li>
            <li>Drag NSN Bridge to Applications.</li>
            <li>Choose Replace if macOS asks.</li>
            <li>Open NSN Bridge again.</li>
            <li>If macOS blocks the unsigned build, use System Settings -&gt; Privacy &amp; Security -&gt; Open Anyway.</li>
          </ol>
        </div>
        <div class="actions">
          <button id="updatesButton">Check for Updates</button>
          <button class="primary" id="downloadUpdateButton" hidden>Download Update</button>
          <button class="primary" id="openUpdateButton" hidden>Open Update</button>
          <button id="cancelUpdateButton" hidden>Cancel / Remove Download</button>
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
      const updateBadge = document.getElementById("updateBadge");
      const updateCopy = document.getElementById("updateCopy");
      const updateNotes = document.getElementById("updateNotes");
      const updateSteps = document.getElementById("updateSteps");
      const updatesButton = document.getElementById("updatesButton");
      const downloadUpdateButton = document.getElementById("downloadUpdateButton");
      const openUpdateButton = document.getElementById("openUpdateButton");
      const cancelUpdateButton = document.getElementById("cancelUpdateButton");
      let pairingFormDismissed = false;
      let removeStatusChangedListener = null;
      let statusRefreshInterval = null;
      const statusFallbackRefreshMs = 20 * 1000;

      function showNotice(message, isError) {
        notice.textContent = message;
        notice.className = isError ? "notice error" : "notice";
      }

      function safeFolderSelectionMessage(error) {
        const code = error && typeof error === "object" && typeof error.code === "string"
          ? error.code
          : "FOLDER_SELECTION_FAILED";
        if (code === "FOLDER_PICKER_FAILED") {
          return "The macOS folder picker could not open.";
        }
        if (code === "FOLDER_UNREADABLE") {
          return "The selected folder could not be read.";
        }
        if (code === "UNSAFE_SYSTEM_ROOT") {
          return "Choose a personal folder instead of the whole computer or drive.";
        }
        if (code === "UNSAFE_SYSTEM_DIRECTORY") {
          return "Choose a personal folder instead of a system folder.";
        }
        if (code === "UNSAFE_APPLICATION_DIRECTORY") {
          return "Choose a personal folder instead of an NSN application folder.";
        }
        if (code === "UNSAFE_SYMLINK") {
          return "Choose a real folder instead of a symlink.";
        }
        if (code === "FOLDER_SELECTION_PERSISTENCE_FAILED") {
          return "The Bridge could not save that folder selection locally.";
        }

        return "The selected folder could not be chosen safely.";
      }

      function safeFolderConnectionMessage(error) {
        const code = error && typeof error === "object" && typeof error.code === "string"
          ? error.code
          : "ROOT_REGISTRATION_FAILED";
        if (code === "SELECTION_EXPIRED") {
          return "That folder selection expired. Choose the folder again.";
        }
        if (code === "MISSING_SELECTION_TOKEN") {
          return "Choose a folder before connecting it.";
        }
        if (code === "FOLDER_UNREADABLE") {
          return "The selected folder could no longer be read.";
        }
        if (code === "UNSAFE_SYSTEM_ROOT") {
          return "Choose a personal folder instead of the whole computer or drive.";
        }
        if (code === "UNSAFE_SYSTEM_DIRECTORY") {
          return "Choose a personal folder instead of a system folder.";
        }
        if (code === "UNSAFE_APPLICATION_DIRECTORY") {
          return "Choose a personal folder instead of an NSN application folder.";
        }
        if (code === "UNSAFE_SYMLINK") {
          return "Choose a real folder instead of a symlink.";
        }
        if (code === "FOLDER_SELECTION_PERSISTENCE_FAILED") {
          return "The Bridge could not save this connected folder locally.";
        }
        if (code === "BRIDGE_NOT_PAIRED") {
          return "Pair this Mac before connecting folders.";
        }
        if (code === "PAIRING_INCOMPLETE") {
          return "NSN Bridge cannot access its saved device credentials. Pair this Mac again.";
        }
        if (code === "KEYCHAIN_UNAVAILABLE" || code === "SECRET_READ_FAILED") {
          return "NSN Bridge could not access its saved pairing credentials.";
        }

        return "The selected folder could not be connected safely.";
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

      function updateBadgeLabel(state) {
        if (state === "UP_TO_DATE") {
          return "Up to date";
        }
        if (state === "UPDATE_AVAILABLE") {
          return "Update available";
        }
        if (state === "DOWNLOADING") {
          return "Downloading";
        }
        if (state === "VERIFYING") {
          return "Verifying";
        }
        if (state === "READY_TO_OPEN") {
          return "Update ready";
        }
        if (state === "FAILED") {
          return "Update unavailable";
        }
        if (state === "CHECKING") {
          return "Checking";
        }

        return "Not checked";
      }

      function updateMessage(result) {
        if (!result || typeof result !== "object") {
          return "NSN Bridge can check for a verified update.";
        }

        if (result.state === "UP_TO_DATE") {
          return "NSN Bridge " + result.currentVersion + " is the latest version.";
        }
        if (result.state === "UPDATE_AVAILABLE") {
          return "Version " + result.latestVersion + " is available.";
        }
        if (result.state === "DOWNLOADING") {
          return typeof result.downloadProgressPercent === "number"
            ? "Downloading update... " + result.downloadProgressPercent + "%"
            : "Downloading update...";
        }
        if (result.state === "VERIFYING") {
          return "Verifying the downloaded update.";
        }
        if (result.state === "READY_TO_OPEN") {
          return "Version " + result.latestVersion + " has been downloaded and verified.";
        }
        if (typeof result.message === "string" && result.message.length > 0) {
          return result.message;
        }

        return "Update information is not available right now.";
      }

      function renderUpdateResult(result) {
        const state = result && typeof result === "object" && typeof result.state === "string"
          ? result.state
          : "IDLE";
        updateBadge.textContent = updateBadgeLabel(state);
        updateBadge.className = state === "FAILED" ? "badge warning" : "badge";
        updateCopy.textContent = updateMessage(result);
        updateNotes.innerHTML = "";

        if (result && Array.isArray(result.releaseNotes)) {
          result.releaseNotes.slice(0, 6).forEach((note) => {
            if (typeof note !== "string" || note.trim().length === 0) {
              return;
            }

            const item = document.createElement("li");
            item.textContent = note;
            updateNotes.appendChild(item);
          });
        }

        updatesButton.disabled = state === "CHECKING" || state === "DOWNLOADING" || state === "VERIFYING";
        downloadUpdateButton.hidden = state !== "UPDATE_AVAILABLE";
        downloadUpdateButton.disabled = state === "DOWNLOADING" || state === "VERIFYING";
        openUpdateButton.hidden = state !== "READY_TO_OPEN";
        cancelUpdateButton.hidden = state !== "READY_TO_OPEN" && state !== "DOWNLOADING" && state !== "VERIFYING";
        updateSteps.hidden = state !== "READY_TO_OPEN";
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

      function statusPairingState(status) {
        return status && typeof status === "object" && typeof status.pairingState === "string"
          ? status.pairingState
          : status && status.paired
            ? "PAIRED_AND_READY"
            : "NOT_PAIRED";
      }

      function statusCloudState(status) {
        return status &&
          typeof status === "object" &&
          status.cloud &&
          typeof status.cloud === "object" &&
          typeof status.cloud.cloudConnectionState === "string"
          ? status.cloud.cloudConnectionState
          : "UNKNOWN";
      }

      function statusLatestCloudErrorCategory(status) {
        return status &&
          typeof status === "object" &&
          status.cloud &&
          typeof status.cloud === "object" &&
          typeof status.cloud.latestSafeCloudErrorCategory === "string"
          ? status.cloud.latestSafeCloudErrorCategory
          : null;
      }

      function pairedStateCopy(rootCount, cloudConnectionState, latestSafeCloudErrorCategory) {
        if (latestSafeCloudErrorCategory === "REQUEST_EXPIRED") {
          return "This Mac is paired, but its date or time appears out of sync. Check Date & Time, then try again.";
        }

        if (cloudConnectionState === "ROOT_SYNC_FAILED") {
          return rootCount === 0
            ? "This Mac is connected to NSN Librarian. Folder sync is still pending."
            : "This Mac is connected to NSN Librarian with " + rootCount + " connected folder" + (rootCount === 1 ? ". Folder sync is still pending." : "s. Folder sync is still pending.");
        }

        if (cloudConnectionState === "NETWORK_UNAVAILABLE") {
          return rootCount === 0
            ? "This Mac is paired, but NSN Librarian has not heard from it yet."
            : "This Mac is paired with " + rootCount + " connected folder" + (rootCount === 1 ? ", but NSN Librarian has not received the latest folder update." : "s, but NSN Librarian has not received the latest folder update.");
        }

        if (cloudConnectionState === "AUTH_UNAVAILABLE") {
          return "NSN Bridge cannot use its saved device credentials. Pair this Mac again.";
        }

        if (cloudConnectionState === "UNKNOWN") {
          return rootCount === 0
            ? "This Mac is paired. Checking its connection to NSN Librarian."
            : "This Mac is paired with " + rootCount + " connected folder" + (rootCount === 1 ? ". Checking its connection to NSN Librarian." : "s. Checking its connection to NSN Librarian.");
        }

        return rootCount === 0
          ? "This Mac is paired. Choose folders when Deanne is ready."
          : "This Mac is paired with " + rootCount + " connected folder" + (rootCount === 1 ? "." : "s.");
      }

      async function refreshStatus() {
        try {
          const status = await window.nsnBridge.getStatus();
          connectedRoots = status && Array.isArray(status.roots) ? status.roots : [];
          const watchingCount = connectedRoots.filter((root) => root.watcherState === "WATCHING").length;
          const pairingState = statusPairingState(status);
          const cloudConnectionState = statusCloudState(status);
          const latestSafeCloudErrorCategory = statusLatestCloudErrorCategory(status);
          if (pairingState === "PAIRED_AND_READY") {
            if (cloudConnectionState === "ONLINE") {
              statusBadge.textContent = "Paired and ready";
              statusBadge.className = "badge";
            } else if (cloudConnectionState === "UNKNOWN") {
              statusBadge.textContent = "Paired, checking connection";
              statusBadge.className = "badge warning";
            } else if (latestSafeCloudErrorCategory === "REQUEST_EXPIRED") {
              statusBadge.textContent = "Paired, check Mac clock";
              statusBadge.className = "badge warning";
            } else if (cloudConnectionState === "ROOT_SYNC_FAILED") {
              statusBadge.textContent = "Connected, folder sync pending";
              statusBadge.className = "badge warning";
            } else {
              statusBadge.textContent = "Paired, connection unavailable";
              statusBadge.className = "badge warning";
            }
            stateCopy.textContent = pairedStateCopy(connectedRoots.length, cloudConnectionState, latestSafeCloudErrorCategory);
            pairButton.textContent = "Pair Again";
            pairingFormDismissed = false;
            hidePairingForm();
          } else if (pairingState === "PAIRING_NEEDS_ATTENTION") {
            statusBadge.textContent = "Pairing needs attention";
            statusBadge.className = "badge warning";
            stateCopy.textContent = "NSN Bridge cannot access its saved device credentials. Pair this Mac again.";
            pairButton.textContent = "Pair Again";
            if (!pairingFormDismissed) {
              showPairingForm(false);
            }
          } else if (pairingState === "KEYCHAIN_UNAVAILABLE") {
            statusBadge.textContent = "Keychain unavailable";
            statusBadge.className = "badge warning";
            stateCopy.textContent = "NSN Bridge could not access its saved pairing credentials.";
            pairButton.textContent = "Pair Again";
            if (!pairingFormDismissed) {
              showPairingForm(false);
            }
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
          return status;
        } catch {
          showNotice("The Bridge could not refresh its local status.", true);
          return null;
        }
      }

      document.getElementById("chooseButton").addEventListener("click", async () => {
        try {
          const result = await window.nsnBridge.chooseFolders();
          if (result && result.length) {
            selectedFolders.push(...result);
            renderFolders();
            showNotice("Review the selected folders, then connect them.", false);
          } else {
            showNotice("No folder was selected.", false);
          }
        } catch (error) {
          showNotice(safeFolderSelectionMessage(error), true);
        }
      });

      connectButton.addEventListener("click", async () => {
        try {
          const result = await window.nsnBridge.connectSelectedFolders(selectedFolders);
          selectedFolders.splice(0, selectedFolders.length);
          await refreshStatus();
          showNotice(
            result && typeof result === "object" && typeof result.message === "string"
              ? result.message
              : "The selected folders are connected to NSN Librarian. Nothing will move without approval.",
            false,
          );
        } catch (error) {
          showNotice(safeFolderConnectionMessage(error), true);
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
          const status = await refreshStatus();
          const cloudConnectionState = statusCloudState(status);
          const latestSafeCloudErrorCategory = statusLatestCloudErrorCategory(status);

          if (cloudConnectionState === "ONLINE") {
            showNotice("This Mac is paired and connected to NSN Librarian.", false);
          } else if (latestSafeCloudErrorCategory === "REQUEST_EXPIRED") {
            showNotice("This Mac is paired, but its date or time appears out of sync. Check Date & Time, then try again.", true);
          } else {
            showNotice("This Mac is paired. It is still checking its connection to NSN Librarian.", false);
          }
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
      updatesButton.addEventListener("click", async () => {
        renderUpdateResult({ state: "CHECKING", currentVersion: "", latestVersion: "", releaseNotes: [] });
        try {
          const result = await window.nsnBridge.checkForUpdates();
          renderUpdateResult(result);
          if (result && result.state === "UP_TO_DATE") {
            showNotice("NSN Bridge is up to date.", false);
          } else if (result && result.state === "UPDATE_AVAILABLE") {
            showNotice("A Bridge update is available.", false);
          } else if (result && result.state === "FAILED") {
            showNotice(result.message || "Update information is not available right now.", true);
          }
        } catch {
          renderUpdateResult({ state: "FAILED", message: "Update information is not available right now.", releaseNotes: [] });
          showNotice("Update information is not available right now.", true);
        }
      });
      downloadUpdateButton.addEventListener("click", async () => {
        renderUpdateResult({ state: "DOWNLOADING", releaseNotes: [] });
        try {
          renderUpdateResult(await window.nsnBridge.downloadUpdate());
        } catch {
          renderUpdateResult({ state: "FAILED", message: "The update could not be downloaded right now.", releaseNotes: [] });
        }
      });
      openUpdateButton.addEventListener("click", async () => {
        try {
          renderUpdateResult(await window.nsnBridge.openDownloadedUpdate());
          showNotice("The verified update is open. Follow the installation steps shown above.", false);
        } catch {
          showNotice("The verified update could not be opened right now.", true);
        }
      });
      cancelUpdateButton.addEventListener("click", async () => {
        try {
          renderUpdateResult(await window.nsnBridge.cancelDownloadedUpdate());
          showNotice("The downloaded update was removed.", false);
        } catch {
          showNotice("The downloaded update could not be removed right now.", true);
        }
      });
      document.getElementById("quitButton").addEventListener("click", () => window.nsnBridge.quit());
      if (typeof window.nsnBridge.onUpdateStatus === "function") {
        window.nsnBridge.onUpdateStatus(renderUpdateResult);
      }
      if (typeof window.nsnBridge.onStatusChanged === "function") {
        removeStatusChangedListener = window.nsnBridge.onStatusChanged(() => {
          refreshStatus();
        });
      }
      if (typeof window.nsnBridge.getUpdateStatus === "function") {
        window.nsnBridge.getUpdateStatus()
          .then(renderUpdateResult)
          .catch(() => undefined);
      }
      if (typeof window.setInterval === "function") {
        statusRefreshInterval = window.setInterval(() => {
          refreshStatus();
        }, statusFallbackRefreshMs);
      }
      if (typeof window.addEventListener === "function") {
        window.addEventListener("beforeunload", () => {
          if (statusRefreshInterval !== null && typeof window.clearInterval === "function") {
            window.clearInterval(statusRefreshInterval);
          }
          if (typeof removeStatusChangedListener === "function") {
            removeStatusChangedListener();
          }
        });
      }
      refreshStatus();
    </script>
  </body>
</html>`;
}
