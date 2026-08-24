import { createHash, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import type {
  BridgeReleaseAsset,
  BridgeReleaseManifest,
} from "../../../../packages/bridge-protocol/src";
import {
  bridgeReleaseVersionIsNewer,
  selectBridgeReleaseAsset,
  validateBridgeReleaseManifest,
} from "../../../../packages/bridge-protocol/src";

export type BridgeUpdateState =
  | "IDLE"
  | "CHECKING"
  | "UP_TO_DATE"
  | "UPDATE_AVAILABLE"
  | "DOWNLOADING"
  | "VERIFYING"
  | "READY_TO_OPEN"
  | "FAILED";

export type BridgeUpdateResult = {
  architecture: "arm64" | "x64" | "unsupported";
  available: boolean;
  currentVersion: string;
  downloadedBytes: number | null;
  downloadProgressPercent: number | null;
  fileName: string | null;
  latestVersion: string;
  message: string;
  releaseNotes: string[];
  sizeBytes: number | null;
  state: BridgeUpdateState;
};

type UpdateCandidate = {
  asset: BridgeReleaseAsset;
  manifest: BridgeReleaseManifest;
};

type UpdateManagerOptions = {
  appUrl?: string;
  architecture?: string;
  currentVersion?: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  onStateChange?: (result: BridgeUpdateResult) => void;
  openPath?: (filePath: string) => Promise<string | void>;
  updateDirectory?: string;
};

const staleUpdateMaxAgeMs = 3 * 24 * 60 * 60 * 1000;
const updateFilePattern =
  /^NSN-Bridge-v\d+\.\d+\.\d+-mac-(?:arm64|x64)(?:-unsigned)?\.dmg(?:\.download)?$/u;

// macOS true automatic installation requires a signed app. Current unsigned
// internal builds use verified assisted DMG installation instead.
function appUrl() {
  return (
    process.env.NSN_LIBRARIAN_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function defaultCurrentVersion() {
  return process.env.NSN_BRIDGE_APP_VERSION ?? "0.1.0";
}

function architectureForProcess(value: string): "arm64" | "x64" | "unsupported" {
  return value === "arm64" || value === "x64" ? value : "unsupported";
}

function defaultUpdateDirectory() {
  return path.join(os.tmpdir(), "nsn-bridge-updates");
}

function initialResult(options: {
  architecture: "arm64" | "x64" | "unsupported";
  currentVersion: string;
}): BridgeUpdateResult {
  return {
    architecture: options.architecture,
    available: false,
    currentVersion: options.currentVersion,
    downloadedBytes: null,
    downloadProgressPercent: null,
    fileName: null,
    latestVersion: options.currentVersion,
    message: "Update information has not been checked yet.",
    releaseNotes: [],
    sizeBytes: null,
    state: "IDLE",
  };
}

function safeUpdateFileName(fileName: string) {
  const trimmed = fileName.trim();

  return (
    trimmed === fileName &&
    path.basename(trimmed) === trimmed &&
    updateFilePattern.test(trimmed)
  );
}

function safeHttpsUrl(value: string | null) {
  if (!value) {
    return false;
  }

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function createResult(
  options: {
    candidate?: UpdateCandidate | null;
    downloadedBytes?: number | null;
    message: string;
    progress?: number | null;
    state: BridgeUpdateState;
  },
  base: {
    architecture: "arm64" | "x64" | "unsupported";
    currentVersion: string;
  },
): BridgeUpdateResult {
  const candidate = options.candidate ?? null;

  return {
    architecture: base.architecture,
    available: Boolean(candidate),
    currentVersion: base.currentVersion,
    downloadedBytes: options.downloadedBytes ?? null,
    downloadProgressPercent: options.progress ?? null,
    fileName: candidate?.asset.fileName ?? null,
    latestVersion: candidate?.manifest.version ?? base.currentVersion,
    message: options.message,
    releaseNotes: candidate?.manifest.releaseNotes ?? [],
    sizeBytes: candidate?.asset.sizeBytes ?? null,
    state: options.state,
  };
}

function constantTimeSha256Equals(left: string, right: string) {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();

  if (!/^[a-f0-9]{64}$/u.test(normalizedLeft) || !/^[a-f0-9]{64}$/u.test(normalizedRight)) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(normalizedLeft, "hex"),
    Buffer.from(normalizedRight, "hex"),
  );
}

async function safeRemoveFile(filePath: string | null) {
  if (!filePath) {
    return;
  }

  await unlink(filePath).catch(() => undefined);
}

async function cleanupStaleUpdates(updateDirectory: string) {
  await mkdir(updateDirectory, { recursive: true });

  const entries = await readdir(updateDirectory, { withFileTypes: true }).catch(
    () => [],
  );
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isFile() || !updateFilePattern.test(entry.name)) {
      continue;
    }

    const filePath = path.join(updateDirectory, entry.name);

    if (entry.name.endsWith(".download")) {
      await safeRemoveFile(filePath);
      continue;
    }

    const fileStat = await stat(filePath).catch(() => null);

    if (fileStat && now - fileStat.mtimeMs > staleUpdateMaxAgeMs) {
      await safeRemoveFile(filePath);
    }
  }
}

async function writeResponseBodyToFile(
  response: Response,
  filePath: string,
  onProgress: (progress: {
    downloadedBytes: number;
    progress: number | null;
    totalBytes: number | null;
  }) => void,
) {
  const body = response.body;

  if (!body) {
    throw new Error("UPDATE_BODY_MISSING");
  }

  const expectedLength = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(expectedLength) && expectedLength > 0
    ? expectedLength
    : null;
  const hash = createHash("sha256");
  const file = createWriteStream(filePath, { flags: "wx" });
  let downloadedBytes = 0;
  const reader = body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const chunk = Buffer.from(value);

      downloadedBytes += chunk.length;
      hash.update(chunk);

      if (!file.write(chunk)) {
        await once(file, "drain");
      }

      onProgress({
        downloadedBytes,
        progress:
          totalBytes === null
            ? null
            : Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100)),
        totalBytes,
      });
    }
  } catch (error) {
    file.destroy();
    throw error;
  }

  file.end();
  await once(file, "finish");

  return hash.digest("hex");
}

export function createBridgeUpdateManager(options: UpdateManagerOptions = {}) {
  const currentVersion = options.currentVersion?.trim() || defaultCurrentVersion();
  const architecture = architectureForProcess(options.architecture ?? process.arch);
  const updateDirectory = options.updateDirectory ?? defaultUpdateDirectory();
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = {
    architecture,
    currentVersion,
  };
  let lastResult = initialResult(base);
  let updateCandidate: UpdateCandidate | null = null;
  let verifiedDownloadPath: string | null = null;
  let partialDownloadPath: string | null = null;
  let lastNotifiedKey = "";
  let lastProgressNotificationAt = 0;

  function notifyStateChange(result: BridgeUpdateResult, stateChanged: boolean) {
    if (!options.onStateChange) {
      return;
    }

    const now = Date.now();
    const key = [
      result.state,
      result.downloadProgressPercent ?? "",
      result.downloadedBytes ?? "",
      result.fileName ?? "",
    ].join(":");
    const progressState = result.state === "DOWNLOADING";
    const hasProgressDetail =
      result.downloadedBytes !== null ||
      result.downloadProgressPercent !== null;
    const shouldThrottle =
      progressState &&
      hasProgressDetail &&
      !stateChanged &&
      lastProgressNotificationAt > 0 &&
      now - lastProgressNotificationAt < 500 &&
      result.downloadProgressPercent !== 100;

    if (key === lastNotifiedKey || shouldThrottle) {
      return;
    }

    lastNotifiedKey = key;

    if (progressState && hasProgressDetail) {
      lastProgressNotificationAt = now;
    }

    options.onStateChange(result);
  }

  async function fetchManifest() {
    const response = await fetchImpl(
      `${(options.appUrl ?? appUrl()).replace(/\/$/, "")}/api/download/bridge/manifest`,
      {
        headers: {
          "X-NSN-Bridge-Client": "nsn-macos-bridge",
        },
        method: "GET",
      },
    );
    const payload = (await response.json().catch(() => null)) as
      | { manifest?: BridgeReleaseManifest; ok?: boolean }
      | null;

    if (!response.ok || !payload?.ok || !payload.manifest) {
      throw new Error("UPDATE_MANIFEST_UNAVAILABLE");
    }

    return payload.manifest;
  }

  function setResult(result: BridgeUpdateResult) {
    const stateChanged = result.state !== lastResult.state;
    lastResult = result;
    notifyStateChange(result, stateChanged);
    return result;
  }

  async function checkForUpdates() {
    setResult(
      createResult(
        {
          message: "Checking for Bridge updates.",
          state: "CHECKING",
        },
        base,
      ),
    );

    if (architecture === "unsupported") {
      updateCandidate = null;
      return setResult(
        createResult(
          {
            message: "No Bridge update is available for this Mac.",
            state: "UP_TO_DATE",
          },
          base,
        ),
      );
    }

    let manifest: BridgeReleaseManifest;

    try {
      manifest = await fetchManifest();
    } catch {
      updateCandidate = null;
      return setResult(
        createResult(
          {
            message: "Update information is not available right now.",
            state: "FAILED",
          },
          base,
        ),
      );
    }

    const validation = validateBridgeReleaseManifest(manifest);

    if (!validation.ok) {
      updateCandidate = null;
      return setResult(
        createResult(
          {
            message: "Update information could not be verified.",
            state: "FAILED",
          },
          base,
        ),
      );
    }

    const asset = selectBridgeReleaseAsset(manifest, architecture);

    if (!asset) {
      updateCandidate = null;
      return setResult({
        ...createResult(
          {
            message: "No verified update is available for this Mac.",
            state: "UP_TO_DATE",
          },
          base,
        ),
        latestVersion: manifest.version,
        releaseNotes: manifest.releaseNotes,
      });
    }

    if (!bridgeReleaseVersionIsNewer(manifest.version, currentVersion)) {
      updateCandidate = null;
      return setResult({
        ...createResult(
          {
            message: "NSN Bridge is up to date.",
            state: "UP_TO_DATE",
          },
          base,
        ),
        latestVersion: manifest.version,
        releaseNotes: manifest.releaseNotes,
      });
    }

    updateCandidate = {
      asset,
      manifest,
    };

    return setResult(
      createResult(
        {
          candidate: updateCandidate,
          message: `Update available: NSN Bridge ${manifest.version}.`,
          state: "UPDATE_AVAILABLE",
        },
        base,
      ),
    );
  }

  async function downloadUpdate() {
    if (!updateCandidate) {
      const checked = await checkForUpdates();

      if (checked.state !== "UPDATE_AVAILABLE" || !updateCandidate) {
        return checked;
      }
    }

    const candidate = updateCandidate;

    if (
      !safeUpdateFileName(candidate.asset.fileName) ||
      !safeHttpsUrl(candidate.asset.url)
    ) {
      return setResult(
        createResult(
          {
            message: "Update information could not be verified.",
            state: "FAILED",
          },
          base,
        ),
      );
    }

    await cleanupStaleUpdates(updateDirectory);
    await safeRemoveFile(verifiedDownloadPath);
    await safeRemoveFile(partialDownloadPath);
    verifiedDownloadPath = null;

    const finalPath = path.join(updateDirectory, candidate.asset.fileName);
    const partialPath = `${finalPath}.download`;
    partialDownloadPath = partialPath;

    await rm(partialPath, { force: true });
    await rm(finalPath, { force: true });

    setResult(
      createResult(
        {
          candidate,
          message: "Downloading update.",
          state: "DOWNLOADING",
        },
        base,
      ),
    );

    let response: Response;

    try {
      response = await fetchImpl(candidate.asset.url ?? "", {
        headers: {
          "X-NSN-Bridge-Client": "nsn-macos-bridge",
        },
        method: "GET",
      });
    } catch {
      await safeRemoveFile(partialPath);
      return setResult(
        createResult(
          {
            candidate,
            message: "The update could not be downloaded right now.",
            state: "FAILED",
          },
          base,
        ),
      );
    }

    if (!response.ok) {
      await safeRemoveFile(partialPath);
      return setResult(
        createResult(
          {
            candidate,
            message: "The update could not be downloaded right now.",
            state: "FAILED",
          },
          base,
        ),
      );
    }

    try {
      const digest = await writeResponseBodyToFile(response, partialPath, (progress) => {
        setResult(
          createResult(
            {
              candidate,
              downloadedBytes: progress.downloadedBytes,
              message:
                progress.progress === null
                  ? "Downloading update."
                  : `Downloading update... ${progress.progress}%`,
              progress: progress.progress,
              state: "DOWNLOADING",
            },
            base,
          ),
        );
      });

      setResult(
        createResult(
          {
            candidate,
            message: "Verifying update.",
            progress: 100,
            state: "VERIFYING",
          },
          base,
        ),
      );

      if (!constantTimeSha256Equals(digest, candidate.asset.sha256)) {
        await safeRemoveFile(partialPath);
        partialDownloadPath = null;
        verifiedDownloadPath = null;

        return setResult(
          createResult(
            {
              candidate,
              message:
                "The downloaded update could not be verified and was not opened.",
              state: "FAILED",
            },
            base,
          ),
        );
      }

      await rename(partialPath, finalPath);
      partialDownloadPath = null;
      verifiedDownloadPath = finalPath;

      return setResult(
        createResult(
          {
            candidate,
            message: "Update downloaded and verified.",
            progress: 100,
            state: "READY_TO_OPEN",
          },
          base,
        ),
      );
    } catch {
      await safeRemoveFile(partialPath);
      partialDownloadPath = null;
      verifiedDownloadPath = null;

      return setResult(
        createResult(
          {
            candidate,
            message: "The update could not be downloaded right now.",
            state: "FAILED",
          },
          base,
        ),
      );
    }
  }

  async function openDownloadedUpdate() {
    if (!verifiedDownloadPath || lastResult.state !== "READY_TO_OPEN") {
      return setResult(
        createResult(
          {
            candidate: updateCandidate,
            message: "Download and verify the update before opening it.",
            state: "FAILED",
          },
          base,
        ),
      );
    }

    if (!options.openPath) {
      return setResult(
        createResult(
          {
            candidate: updateCandidate,
            message: "The verified update could not be opened right now.",
            state: "FAILED",
          },
          base,
        ),
      );
    }

    const openResult = await options.openPath(verifiedDownloadPath).catch(() =>
      "OPEN_FAILED",
    );

    if (typeof openResult === "string" && openResult.length > 0) {
      return setResult(
        createResult(
          {
            candidate: updateCandidate,
            message: "The verified update could not be opened right now.",
            state: "FAILED",
          },
          base,
        ),
      );
    }

    return setResult(
      createResult(
        {
          candidate: updateCandidate,
          message:
            "The verified update is open. Quit NSN Bridge, drag NSN Bridge to Applications, choose Replace if asked, then open NSN Bridge again.",
          progress: 100,
          state: "READY_TO_OPEN",
        },
        base,
      ),
    );
  }

  async function cancelDownloadedUpdate() {
    await safeRemoveFile(partialDownloadPath);
    await safeRemoveFile(verifiedDownloadPath);
    partialDownloadPath = null;
    verifiedDownloadPath = null;

    return setResult(
      updateCandidate
        ? createResult(
            {
              candidate: updateCandidate,
              message: "The downloaded update was removed.",
              state: "UPDATE_AVAILABLE",
            },
            base,
          )
        : createResult(
            {
              message: "No downloaded update is waiting.",
              state: "IDLE",
            },
            base,
          ),
    );
  }

  return {
    cancelDownloadedUpdate,
    checkForUpdates,
    downloadUpdate,
    getState: () => lastResult,
    openDownloadedUpdate,
  };
}

const defaultUpdateManager = createBridgeUpdateManager();

export async function checkBridgeUpdateManifest() {
  return defaultUpdateManager.checkForUpdates();
}
