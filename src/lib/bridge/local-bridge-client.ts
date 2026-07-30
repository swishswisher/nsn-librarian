import type {
  BridgeFolderScanResult,
  BridgeReadPreview,
  ConnectedLibraryPermissions,
  ConnectedLibraryPlatform,
  OrganizationPlanActionType,
} from "./types";
import { getOrCreateLocalBridgePairingSecret } from "./local-bridge-pairing";

export type LocalBridgeHealth = {
  ok: boolean;
  paired: boolean;
  status:
    | "BRIDGE_UNAVAILABLE"
    | "BRIDGE_READY"
    | "FOLDER_SELECTION_IN_PROGRESS";
  platform: string | null;
  version: string | null;
  message: string;
};

export type LocalBridgeFolderSelection = {
  ancestorRootIds: string[];
  selectionToken: string;
  rootId: string;
  suggestedDisplayName: string;
  platform: ConnectedLibraryPlatform;
  safeLocation: string;
  expiresAt: string;
};

export type LocalBridgeRootSummary = ConnectedLibraryPermissions & {
  id: string;
  displayName: string;
  safeLocation: string;
  platform: ConnectedLibraryPlatform;
  status: "CONNECTED" | "PAUSED" | "NEEDS_ATTENTION" | "DISCONNECTED";
  connectedAt: string;
  updatedAt: string;
  lastScanAt: string | null;
  lastWatchingAt: string | null;
  watcherState: "WATCHING" | "PAUSED" | "STOPPED" | "NEEDS_ATTENTION";
};

export type LocalBridgeChangeEvent = {
  detectedAt: string;
  eventType:
    | "FILE_ADDED"
    | "FILE_MODIFIED"
    | "FILE_RENAMED"
    | "FILE_MOVED"
    | "FILE_DELETED"
    | "FOLDER_ADDED"
    | "FOLDER_RENAMED"
    | "FOLDER_MOVED"
    | "FOLDER_DELETED";
  id: string;
  relativePath: string;
  rootId: string;
};

export type LocalBridgeExecutionActionInput = {
  id: string;
  actionType: Extract<
    OrganizationPlanActionType,
    "CREATE_FOLDER" | "MOVE_FILE" | "RENAME_FILE" | "MOVE_AND_RENAME_FILE"
  >;
  sourceRelativePath?: string | null;
  sourceChecksum?: string | null;
  sourceLastModified?: string | null;
  sourceSizeBytes?: string | null;
  destinationRelativePath: string;
};

export type LocalBridgeExecutionIssue = {
  actionId: string | null;
  category: string;
  message: string;
};

export type LocalBridgeExecutionPreview = {
  canExecute: boolean;
  issues: LocalBridgeExecutionIssue[];
  rootId: string;
  totalActions: number;
};

export type LocalBridgeExecutionResult = {
  actions: Array<{
    actionId: string;
    actionType: LocalBridgeExecutionActionInput["actionType"];
    createdFilesystemItem: boolean;
    destinationChecksumAfter: string | null;
    destinationRelativePath: string;
    lastModified: string | null;
    safeErrorCategory: string | null;
    sizeBytes: string | null;
    sourceChecksumBefore: string | null;
    sourceRelativePath: string | null;
    status: "COMPLETED" | "FAILED" | "PENDING";
  }>;
  completedActions: number;
  failedActions: number;
  rootId: string;
  status: "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED";
  totalActions: number;
};

export type LocalBridgeUndoActionInput = {
  id: string;
  actionType: "REMOVE_FOLDER" | "MOVE_FILE" | "RENAME_FILE";
  sourceRelativePath: string;
  sourceChecksum?: string | null;
  sourceLastModified?: string | null;
  sourceSizeBytes?: string | null;
  destinationRelativePath: string;
};

export type LocalBridgeUndoPreview = {
  canUndo: boolean;
  issues: LocalBridgeExecutionIssue[];
  rootId: string;
  totalActions: number;
};

export type LocalBridgeUndoResult = {
  actions: Array<{
    actionId: string;
    actionType: LocalBridgeUndoActionInput["actionType"];
    destinationChecksumAfter: string | null;
    destinationRelativePath: string;
    lastModified: string | null;
    safeErrorCategory: string | null;
    sizeBytes: string | null;
    sourceChecksumBefore: string | null;
    sourceRelativePath: string;
    status: "COMPLETED" | "FAILED" | "PENDING";
  }>;
  completedActions: number;
  failedActions: number;
  rootId: string;
  status: "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED";
  totalActions: number;
};

export type LocalBridgeResolvedFile = {
  fileName: string;
  lastModified: Date;
  localPath: string;
  relativePath: string;
  sizeBytes: bigint;
  sourceCreatedAt: Date | null;
};

export class LocalBridgeClientError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, code = "LOCAL_BRIDGE_ERROR", statusCode = 503) {
    super(message);
    this.name = "LocalBridgeClientError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const defaultBridgeUrl = "http://127.0.0.1:4777";
const defaultTimeoutMs = 8_000;

function bridgeBaseUrl() {
  return (process.env.NSN_LOCAL_BRIDGE_URL?.trim() || defaultBridgeUrl).replace(
    /\/$/,
    "",
  );
}

function serializeBody(body: unknown) {
  return JSON.stringify(body, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

async function fetchWithTimeout(
  path: string,
  options: RequestInit & { authenticated?: boolean; timeoutMs?: number } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? defaultTimeoutMs,
  );

  try {
    const headers = new Headers(options.headers);

    headers.set("Content-Type", "application/json");
    headers.set("X-NSN-Bridge-Client", "nsn-web");

    if (options.authenticated) {
      const secret = await getOrCreateLocalBridgePairingSecret();
      headers.set("Authorization", `Bearer ${secret}`);
    }

    return await fetch(`${bridgeBaseUrl()}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
  } catch {
    throw new LocalBridgeClientError(
      "The NSN Bridge is not running on this computer.",
      "BRIDGE_UNAVAILABLE",
      503,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function readPayload<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string; code?: string })
    | null;

  if (!response.ok || !payload) {
    throw new LocalBridgeClientError(
      payload?.error ?? "The NSN Bridge could not complete that request.",
      payload?.code ?? "LOCAL_BRIDGE_ERROR",
      response.status || 500,
    );
  }

  return payload;
}

export async function getLocalBridgeHealth(): Promise<LocalBridgeHealth> {
  try {
    const response = await fetchWithTimeout("/bridge/v1/health", {
      method: "GET",
      timeoutMs: 2_000,
    });
    const payload = await readPayload<{
      ok: true;
      paired: boolean;
      platform: string;
      status: "BRIDGE_READY";
      version: string;
    }>(response);

    return {
      message: "Bridge ready",
      ok: true,
      paired: payload.paired,
      platform: payload.platform,
      status: payload.status,
      version: payload.version,
    };
  } catch {
    return {
      message:
        "Open the NSN Bridge on this computer to choose and watch local folders.",
      ok: false,
      paired: false,
      platform: null,
      status: "BRIDGE_UNAVAILABLE",
      version: null,
    };
  }
}

export async function chooseFolderWithLocalBridge() {
  const response = await fetchWithTimeout("/bridge/v1/folder-selections", {
    authenticated: true,
    body: serializeBody({}),
    method: "POST",
    timeoutMs: 120_000,
  });
  const payload = await readPayload<{
    ok: true;
    selection: LocalBridgeFolderSelection;
  }>(response);

  return payload.selection;
}

export async function registerLocalBridgeRoot(input: {
  displayName?: string;
  permissions: Partial<ConnectedLibraryPermissions>;
  selectionToken: string;
}) {
  const response = await fetchWithTimeout("/bridge/v1/roots", {
    authenticated: true,
    body: serializeBody(input),
    method: "POST",
  });
  const payload = await readPayload<{
    ok: true;
    root: LocalBridgeRootSummary;
  }>(response);

  return payload.root;
}

export async function updateLocalBridgeRoot(
  bridgeRootId: string,
  body: Record<string, unknown>,
) {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}`,
    {
      authenticated: true,
      body: serializeBody(body),
      method: "PATCH",
    },
  );
  const payload = await readPayload<{
    ok: true;
    root: LocalBridgeRootSummary;
  }>(response);

  return payload.root;
}

export async function disconnectLocalBridgeRoot(bridgeRootId: string) {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}/disconnect`,
    {
      authenticated: true,
      body: serializeBody({}),
      method: "POST",
    },
  );
  const payload = await readPayload<{
    ok: true;
    root: LocalBridgeRootSummary;
  }>(response);

  return payload.root;
}

export async function scanLocalBridgeRoot(bridgeRootId: string) {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}/scan`,
    {
      authenticated: true,
      body: serializeBody({}),
      method: "POST",
      timeoutMs: 120_000,
    },
  );
  const payload = await readPayload<{
    ok: true;
    scan: Omit<BridgeFolderScanResult, "completedAt" | "files" | "startedAt"> & {
      completedAt: string;
      files: Array<
        Omit<
          BridgeFolderScanResult["files"][number],
          "lastModified" | "sizeBytes" | "sourceCreatedAt"
        > & {
          lastModified: string | null;
          sizeBytes: string | null;
          sourceCreatedAt?: string | null;
        }
      >;
      startedAt: string;
    };
  }>(response);

  return {
    ...payload.scan,
    completedAt: new Date(payload.scan.completedAt),
    files: payload.scan.files.map((file) => ({
      ...file,
      lastModified: file.lastModified ? new Date(file.lastModified) : null,
      sizeBytes: file.sizeBytes === null ? null : BigInt(file.sizeBytes),
      sourceCreatedAt: file.sourceCreatedAt
        ? new Date(file.sourceCreatedAt)
        : null,
    })),
    startedAt: new Date(payload.scan.startedAt),
  } satisfies BridgeFolderScanResult;
}

export async function readLocalBridgeFile(
  bridgeRootId: string,
  relativePath: string,
): Promise<Omit<BridgeReadPreview, "scannedFileId">> {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}/read`,
    {
      authenticated: true,
      body: serializeBody({ relativePath }),
      method: "POST",
      timeoutMs: 120_000,
    },
  );
  const payload = await readPayload<{
    ok: true;
    result: Omit<BridgeReadPreview, "scannedFileId">;
  }>(response);

  return payload.result;
}

export async function resolveLocalBridgeFile(
  bridgeRootId: string,
  relativePath: string,
): Promise<LocalBridgeResolvedFile> {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}/resolve-file`,
    {
      authenticated: true,
      body: serializeBody({ relativePath }),
      method: "POST",
      timeoutMs: 120_000,
    },
  );
  const payload = await readPayload<{
    file: Omit<
      LocalBridgeResolvedFile,
      "lastModified" | "sizeBytes" | "sourceCreatedAt"
    > & {
      lastModified: string;
      sizeBytes: string;
      sourceCreatedAt: string | null;
    };
    ok: true;
  }>(response);

  return {
    ...payload.file,
    lastModified: new Date(payload.file.lastModified),
    sizeBytes: BigInt(payload.file.sizeBytes),
    sourceCreatedAt: payload.file.sourceCreatedAt
      ? new Date(payload.file.sourceCreatedAt)
      : null,
  };
}

export async function startLocalBridgeWatcher(bridgeRootId: string) {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}/watch/start`,
    {
      authenticated: true,
      body: serializeBody({}),
      method: "POST",
    },
  );
  const payload = await readPayload<{
    ok: true;
    root: LocalBridgeRootSummary;
  }>(response);

  return payload.root;
}

export async function pauseLocalBridgeWatcher(bridgeRootId: string) {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}/watch/pause`,
    {
      authenticated: true,
      body: serializeBody({}),
      method: "POST",
    },
  );
  const payload = await readPayload<{
    ok: true;
    root: LocalBridgeRootSummary;
  }>(response);

  return payload.root;
}

export async function resumeLocalBridgeWatcher(bridgeRootId: string) {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}/watch/resume`,
    {
      authenticated: true,
      body: serializeBody({}),
      method: "POST",
    },
  );
  const payload = await readPayload<{
    ok: true;
    root: LocalBridgeRootSummary;
  }>(response);

  return payload.root;
}

export async function stopLocalBridgeWatcher(bridgeRootId: string) {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}/watch/stop`,
    {
      authenticated: true,
      body: serializeBody({}),
      method: "POST",
    },
  );
  const payload = await readPayload<{
    ok: true;
    root: LocalBridgeRootSummary;
  }>(response);

  return payload.root;
}

export async function takeLocalBridgeWatcherEvents(bridgeRootId: string) {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}/events`,
    {
      authenticated: true,
      body: serializeBody({}),
      method: "POST",
    },
  );
  const payload = await readPayload<{
    events: LocalBridgeChangeEvent[];
    ok: true;
  }>(response);

  return payload.events;
}

export async function previewLocalBridgeExecution(
  bridgeRootId: string,
  actions: LocalBridgeExecutionActionInput[],
) {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}/execution-preview`,
    {
      authenticated: true,
      body: serializeBody({ actions }),
      method: "POST",
      timeoutMs: 120_000,
    },
  );
  const payload = await readPayload<{
    ok: true;
    preview: LocalBridgeExecutionPreview;
  }>(response);

  return payload.preview;
}

export async function executeLocalBridgeActions(
  bridgeRootId: string,
  actions: LocalBridgeExecutionActionInput[],
) {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}/execute`,
    {
      authenticated: true,
      body: serializeBody({ actions }),
      method: "POST",
      timeoutMs: 120_000,
    },
  );
  const payload = await readPayload<{
    execution: LocalBridgeExecutionResult;
    ok: true;
  }>(response);

  return payload.execution;
}

export async function previewLocalBridgeUndo(
  bridgeRootId: string,
  actions: LocalBridgeUndoActionInput[],
) {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}/undo-preview`,
    {
      authenticated: true,
      body: serializeBody({ actions }),
      method: "POST",
      timeoutMs: 120_000,
    },
  );
  const payload = await readPayload<{
    ok: true;
    preview: LocalBridgeUndoPreview;
  }>(response);

  return payload.preview;
}

export async function executeLocalBridgeUndoActions(
  bridgeRootId: string,
  actions: LocalBridgeUndoActionInput[],
) {
  const response = await fetchWithTimeout(
    `/bridge/v1/roots/${encodeURIComponent(bridgeRootId)}/undo`,
    {
      authenticated: true,
      body: serializeBody({ actions }),
      method: "POST",
      timeoutMs: 120_000,
    },
  );
  const payload = await readPayload<{
    ok: true;
    undo: LocalBridgeUndoResult;
  }>(response);

  return payload.undo;
}

export function isLocalBridgeUnavailable(error: unknown) {
  return (
    error instanceof LocalBridgeClientError &&
    error.code === "BRIDGE_UNAVAILABLE"
  );
}
