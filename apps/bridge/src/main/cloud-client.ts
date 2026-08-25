import {
  createPrivateKey,
  sign as signPayload,
  verify as verifyPayload,
} from "node:crypto";
import os from "node:os";

import {
  createBridgeDeviceId,
  createBridgeDeviceRequestHeaders,
  createBridgeKeyPair,
  normalizeBridgePlatform,
  type BridgeCommandEnvelope,
  type BridgeCommandReport,
  type BridgeDeviceSummary,
} from "../../../../packages/bridge-protocol/src";
import {
  BridgeAppError,
  type BridgeChangeEvent,
  type BridgeRootSummary,
} from "../../../../bridge-app/src/types";

import {
  readBridgeSecret,
  readBridgeSecretState,
  saveBridgeSecret,
  type BridgeSecretReadResult,
} from "./keychain";

let runtimeAppVersion = process.env.NSN_BRIDGE_APP_VERSION ?? "0.1.0";
type BridgeCloudDiagnosticOperation =
  | "commands"
  | "heartbeat"
  | "root-sync"
  | "watch-events";
type BridgeCloudDiagnosticStage =
  | "COMPLETE_IDENTITY_LOADED"
  | "FETCH_RESPONSE_RECEIVED"
  | "FETCH_STARTED"
  | "HEARTBEAT_SUCCEEDED"
  | "PRIVATE_KEY_PARSE_FAILED"
  | "PRIVATE_KEY_PARSE_STARTED"
  | "PRIVATE_KEY_PARSE_SUCCEEDED"
  | "REQUEST_SIGNED"
  | "RESPONSE_REJECTED"
  | "SIGNING_FAILED";
type BridgeCloudDiagnosticDetails = {
  category?: string;
  stage: BridgeCloudDiagnosticStage;
  status?: number;
};
type BridgeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
let bridgeFetch: BridgeFetch = (input, init) => fetch(input, init);
let bridgeDiagnosticSink: ((message: string) => void) | null = (message) =>
  console.info(message);

export type CompleteBridgeIdentity = {
  bridgeDeviceId: string;
  privateKey: string;
  status: "COMPLETE";
};

export type SafeBridgePairingState =
  | {
      bridgeDeviceId: string | null;
      bridgeDeviceIdStatus: "MISSING" | "PRESENT";
      privateKeyStatus: "MISSING" | "PRESENT";
      safeErrorCategory: "PAIRING_INCOMPLETE";
      status: "INCOMPLETE";
    }
  | {
      bridgeDeviceId: string;
      bridgeDeviceIdStatus: "PRESENT";
      privateKeyStatus: "PRESENT";
      safeErrorCategory: "PRIVATE_KEY_INVALID" | "REQUEST_SIGNING_FAILED";
      status: "UNUSABLE";
    }
  | {
      bridgeDeviceId: string | null;
      bridgeDeviceIdStatus: BridgeSecretReadResult["status"];
      privateKeyStatus: BridgeSecretReadResult["status"];
      safeErrorCategory: "KEYCHAIN_UNAVAILABLE" | "SECRET_READ_FAILED";
      status: "UNAVAILABLE";
    };

export function setBridgeRuntimeAppVersion(version: string) {
  const trimmed = version.trim();

  if (trimmed) {
    runtimeAppVersion = trimmed;
  }
}

export function bridgeRuntimeAppVersion() {
  return runtimeAppVersion;
}

export function setBridgeCloudFetchForTests(fetcher?: BridgeFetch) {
  bridgeFetch = fetcher ?? ((input, init) => fetch(input, init));
}

export function setBridgeCloudDiagnosticSinkForTests(
  sink?: ((message: string) => void) | null,
) {
  bridgeDiagnosticSink = sink === undefined ? (message) => console.info(message) : sink;
}

type PairingResponse =
  | {
      device: BridgeDeviceSummary;
      ok: true;
    }
  | {
      error: string;
      ok: false;
    };

function appUrl() {
  return (
    process.env.NSN_LIBRARIAN_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function bridgePlatform() {
  if (process.platform === "darwin") {
    return "MACOS";
  }

  if (process.platform === "win32") {
    return "WINDOWS";
  }

  if (process.platform === "linux") {
    return "LINUX";
  }

  return "UNKNOWN";
}

function secretValue(result: BridgeSecretReadResult) {
  return result.status === "PRESENT" ? result.value : null;
}

function logCloudDiagnostic(
  operation: BridgeCloudDiagnosticOperation | undefined,
  details: BridgeCloudDiagnosticDetails,
) {
  if (!operation || !bridgeDiagnosticSink) {
    return;
  }

  const pieces = [`[NSN Bridge] ${operation}`, `stage=${details.stage}`];

  if (typeof details.status === "number") {
    pieces.push(`status=${details.status}`);
  }

  if (details.category) {
    pieces.push(`category=${details.category}`);
  }

  bridgeDiagnosticSink(pieces.join(" "));
}

export function assertBridgePrivateKeyCanSign(input: {
  privateKey: string;
  publicKey?: string;
}) {
  let parsedPrivateKey: ReturnType<typeof createPrivateKey>;

  try {
    parsedPrivateKey = createPrivateKey(input.privateKey);
  } catch {
    throw new BridgeAppError(
      "NSN Bridge could not use its saved device credentials.",
      "PRIVATE_KEY_INVALID",
      401,
    );
  }

  try {
    const challenge = Buffer.from("nsn-bridge-private-key-check", "utf8");
    const signature = signPayload(null, challenge, parsedPrivateKey);

    if (
      input.publicKey &&
      !verifyPayload(null, challenge, input.publicKey, signature)
    ) {
      throw new BridgeAppError(
        "NSN Bridge could not verify its saved device credentials.",
        "PRIVATE_KEY_INVALID",
        401,
      );
    }
  } catch (error) {
    if (error instanceof BridgeAppError) {
      throw error;
    }

    throw new BridgeAppError(
      "NSN Bridge could not sign with its saved device credentials.",
      "REQUEST_SIGNING_FAILED",
      401,
    );
  }
}

function unavailableCategory(
  bridgeDeviceId: BridgeSecretReadResult,
  privateKey: BridgeSecretReadResult,
) {
  if (
    bridgeDeviceId.status === "UNAVAILABLE" &&
    bridgeDeviceId.safeErrorCategory === "KEYCHAIN_UNAVAILABLE"
  ) {
    return "KEYCHAIN_UNAVAILABLE";
  }

  if (
    privateKey.status === "UNAVAILABLE" &&
    privateKey.safeErrorCategory === "KEYCHAIN_UNAVAILABLE"
  ) {
    return "KEYCHAIN_UNAVAILABLE";
  }

  return "SECRET_READ_FAILED";
}

export async function getCompletePairedBridgeIdentity(): Promise<
  CompleteBridgeIdentity | SafeBridgePairingState
> {
  const [bridgeDeviceId, privateKey] = await Promise.all([
    readBridgeSecretState("bridge-device-id"),
    readBridgeSecretState("device-private-key"),
  ]);
  const safeBridgeDeviceId = secretValue(bridgeDeviceId);

  if (
    bridgeDeviceId.status === "UNAVAILABLE" ||
    privateKey.status === "UNAVAILABLE"
  ) {
    return {
      bridgeDeviceId: safeBridgeDeviceId,
      bridgeDeviceIdStatus: bridgeDeviceId.status,
      privateKeyStatus: privateKey.status,
      safeErrorCategory: unavailableCategory(bridgeDeviceId, privateKey),
      status: "UNAVAILABLE",
    };
  }

  if (bridgeDeviceId.status === "PRESENT" && privateKey.status === "PRESENT") {
    try {
      assertBridgePrivateKeyCanSign({ privateKey: privateKey.value });
    } catch (error) {
      return {
        bridgeDeviceId: bridgeDeviceId.value,
        bridgeDeviceIdStatus: "PRESENT",
        privateKeyStatus: "PRESENT",
        safeErrorCategory:
          error instanceof BridgeAppError &&
          error.code === "REQUEST_SIGNING_FAILED"
            ? "REQUEST_SIGNING_FAILED"
            : "PRIVATE_KEY_INVALID",
        status: "UNUSABLE",
      };
    }

    return {
      bridgeDeviceId: bridgeDeviceId.value,
      privateKey: privateKey.value,
      status: "COMPLETE",
    };
  }

  return {
    bridgeDeviceId: safeBridgeDeviceId,
    bridgeDeviceIdStatus: bridgeDeviceId.status,
    privateKeyStatus: privateKey.status,
    safeErrorCategory: "PAIRING_INCOMPLETE",
    status: "INCOMPLETE",
  };
}

export function bridgeIdentityCanAuthenticate(
  identity: CompleteBridgeIdentity | SafeBridgePairingState,
): identity is CompleteBridgeIdentity {
  return identity.status === "COMPLETE";
}

function bridgeIdentityError(
  identity: CompleteBridgeIdentity | SafeBridgePairingState,
) {
  if (identity.status === "UNAVAILABLE") {
    return new BridgeAppError(
      "NSN Bridge could not access its saved pairing credentials.",
      identity.safeErrorCategory,
      503,
    );
  }

  if (identity.status === "UNUSABLE") {
    return new BridgeAppError(
      "NSN Bridge could not use its saved device credentials.",
      identity.safeErrorCategory,
      401,
    );
  }

  return new BridgeAppError(
    "Pair this Mac again before the Bridge can contact NSN Librarian.",
    "BRIDGE_NOT_PAIRED",
    401,
  );
}

async function requireCompletePairedBridgeIdentity() {
  const identity = await getCompletePairedBridgeIdentity();

  if (!bridgeIdentityCanAuthenticate(identity)) {
    throw bridgeIdentityError(identity);
  }

  return identity;
}

async function authenticatedHeaders(
  method: string,
  pathName: string,
  bodyText = "",
  identity?: CompleteBridgeIdentity,
  diagnosticOperation?: BridgeCloudDiagnosticOperation,
) {
  const pairedIdentity = identity ?? (await requireCompletePairedBridgeIdentity());
  logCloudDiagnostic(diagnosticOperation, {
    stage: "COMPLETE_IDENTITY_LOADED",
  });

  try {
    logCloudDiagnostic(diagnosticOperation, {
      stage: "PRIVATE_KEY_PARSE_STARTED",
    });
    assertBridgePrivateKeyCanSign({ privateKey: pairedIdentity.privateKey });
    logCloudDiagnostic(diagnosticOperation, {
      stage: "PRIVATE_KEY_PARSE_SUCCEEDED",
    });
  } catch (error) {
    logCloudDiagnostic(diagnosticOperation, {
      category:
        error instanceof BridgeAppError ? error.code : "PRIVATE_KEY_INVALID",
      stage: "PRIVATE_KEY_PARSE_FAILED",
    });
    throw error;
  }

  try {
    const headers = {
      ...createBridgeDeviceRequestHeaders({
        bodyText,
        bridgeDeviceId: pairedIdentity.bridgeDeviceId,
        method,
        pathname: pathName,
        privateKey: pairedIdentity.privateKey,
      }),
      "X-NSN-Bridge-Client": "nsn-macos-bridge",
    };

    logCloudDiagnostic(diagnosticOperation, {
      stage: "REQUEST_SIGNED",
    });

    return headers;
  } catch {
    logCloudDiagnostic(diagnosticOperation, {
      category: "REQUEST_SIGNING_FAILED",
      stage: "SIGNING_FAILED",
    });
    throw new BridgeAppError(
      "NSN Bridge could not sign its request.",
      "REQUEST_SIGNING_FAILED",
      401,
    );
  }
}

type SafeCloudResponsePayload = {
  code?: unknown;
  error?: unknown;
  ok?: unknown;
};

function safeErrorCategoryFromPayload(
  response: Response,
  payload: SafeCloudResponsePayload | null,
) {
  if (typeof payload?.code === "string" && payload.code.trim().length > 0) {
    return payload.code.trim();
  }

  const message =
    typeof payload?.error === "string" ? payload.error.toLowerCase() : "";

  if (response.status === 401) {
    if (message.includes("expired")) {
      return "REQUEST_EXPIRED";
    }

    if (message.includes("signature")) {
      return "REQUEST_SIGNATURE_INVALID";
    }

    if (message.includes("not paired")) {
      return "DEVICE_NOT_PAIRED";
    }

    return "BRIDGE_AUTH_REJECTED";
  }

  if (response.status >= 500) {
    return "SERVER_ERROR";
  }

  return "BRIDGE_CLOUD_REQUEST_FAILED";
}

function safeErrorMessageForCategory(category: string) {
  if (category === "REQUEST_EXPIRED") {
    return "NSN Bridge could not contact NSN Librarian because this Mac's clock appears out of sync.";
  }

  if (
    category === "REQUEST_SIGNATURE_INVALID" ||
    category === "BRIDGE_AUTH_REJECTED" ||
    category === "DEVICE_NOT_PAIRED"
  ) {
    return "NSN Bridge could not authenticate with NSN Librarian.";
  }

  if (category === "SERVER_ERROR") {
    return "NSN Librarian could not complete the Bridge request right now.";
  }

  return "NSN Bridge could not contact NSN Librarian right now.";
}

async function postJson<T>(
  pathName: string,
  body: Record<string, unknown>,
  options: {
    authenticated?: boolean;
    diagnosticOperation?: BridgeCloudDiagnosticOperation;
    identity?: CompleteBridgeIdentity;
  } = {},
) {
  const bodyText = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json",
    "X-NSN-Bridge-Client": "nsn-macos-bridge",
    ...(options.authenticated
      ? await authenticatedHeaders(
          "POST",
          pathName,
          bodyText,
          options.identity,
          options.diagnosticOperation,
        )
      : {}),
  };
  let response: Response;

  logCloudDiagnostic(options.diagnosticOperation, {
    stage: "FETCH_STARTED",
  });

  try {
    response = await bridgeFetch(`${appUrl()}${pathName}`, {
      body: bodyText,
      headers,
      method: "POST",
    });
  } catch {
    logCloudDiagnostic(options.diagnosticOperation, {
      category: "NETWORK_UNAVAILABLE",
      stage: "RESPONSE_REJECTED",
    });
    throw new BridgeAppError(
      "NSN Bridge could not reach NSN Librarian.",
      "NETWORK_UNAVAILABLE",
      503,
    );
  }

  logCloudDiagnostic(options.diagnosticOperation, {
    stage: "FETCH_RESPONSE_RECEIVED",
    status: response.status,
  });

  const payload = (await response.json().catch(() => null)) as
    | (T & SafeCloudResponsePayload)
    | null;

  if (!response.ok || !payload) {
    const category = safeErrorCategoryFromPayload(response, payload);

    logCloudDiagnostic(options.diagnosticOperation, {
      category,
      stage: "RESPONSE_REJECTED",
      status: response.status,
    });
    throw new BridgeAppError(
      safeErrorMessageForCategory(category),
      category,
      response.status,
    );
  }

  if (options.diagnosticOperation === "heartbeat") {
    logCloudDiagnostic(options.diagnosticOperation, {
      stage: "HEARTBEAT_SUCCEEDED",
    });
  }

  return payload;
}

export async function pairBridgeWithCloud(pairingCode: string) {
  const previousIdentity = await getCompletePairedBridgeIdentity();
  const bridgeDeviceId = createBridgeDeviceId();
  const keys = createBridgeKeyPair();
  const payload = await postJson<PairingResponse>(
    "/api/bridge/cloud/pairing-codes/redeem",
    {
      appVersion: bridgeRuntimeAppVersion(),
      architecture: os.arch(),
      bridgeDeviceId,
      deviceDisplayName: os.hostname() || "This Mac",
      pairingCode,
      platform: normalizeBridgePlatform(bridgePlatform()),
      publicKey: keys.publicKey,
    },
  );

  if (!payload.ok) {
    throw new BridgeAppError(
      "That pairing code could not be verified.",
      "PAIRING_FAILED",
      401,
    );
  }

  try {
    await saveBridgeSecret("device-private-key", keys.privateKey);
    await saveBridgeSecret("bridge-device-id", payload.device.bridgeDeviceId);

    const savedIdentity = await getCompletePairedBridgeIdentity();

    if (
      !bridgeIdentityCanAuthenticate(savedIdentity) ||
      savedIdentity.bridgeDeviceId !== payload.device.bridgeDeviceId
    ) {
      throw new BridgeAppError(
        "NSN Bridge could not save its pairing credentials securely.",
        "PAIRING_PERSISTENCE_FAILED",
        503,
      );
    }

    try {
      assertBridgePrivateKeyCanSign({
        privateKey: savedIdentity.privateKey,
        publicKey: keys.publicKey,
      });
    } catch {
      throw new BridgeAppError(
        "NSN Bridge could not verify its saved pairing credentials.",
        "PAIRING_PRIVATE_KEY_INVALID",
        503,
      );
    }
  } catch (error) {
    if (bridgeIdentityCanAuthenticate(previousIdentity)) {
      await Promise.allSettled([
        saveBridgeSecret("device-private-key", previousIdentity.privateKey),
        saveBridgeSecret("bridge-device-id", previousIdentity.bridgeDeviceId),
      ]);
    }

    if (error instanceof BridgeAppError) {
      throw error;
    }

    throw new BridgeAppError(
      "NSN Bridge could not save its pairing credentials securely.",
      "PAIRING_PERSISTENCE_FAILED",
      503,
    );
  }

  return payload.device;
}

export async function getPairedBridgeDeviceId() {
  return readBridgeSecret("bridge-device-id");
}

export async function sendBridgeHeartbeat() {
  const identity = await requireCompletePairedBridgeIdentity();

  return postJson<{ ok: true }>(
    `/api/bridge/cloud/devices/${encodeURIComponent(
      identity.bridgeDeviceId,
    )}/heartbeat`,
    {
      appVersion: bridgeRuntimeAppVersion(),
      architecture: os.arch(),
      platform: bridgePlatform(),
    },
    { authenticated: true, diagnosticOperation: "heartbeat", identity },
  );
}

export async function syncBridgeRoots(roots: BridgeRootSummary[]) {
  const identity = await requireCompletePairedBridgeIdentity();

  return postJson<{ libraries: unknown[]; ok: true }>(
    `/api/bridge/cloud/devices/${encodeURIComponent(
      identity.bridgeDeviceId,
    )}/roots/sync`,
    {
      roots,
    },
    { authenticated: true, diagnosticOperation: "root-sync", identity },
  );
}

export async function sendBridgeWatchEvents(events: BridgeChangeEvent[]) {
  if (events.length === 0) {
    return {
      acceptedEventIds: [],
      duplicateEventIds: [],
      ok: true,
    };
  }

  const identity = await requireCompletePairedBridgeIdentity();

  return postJson<{
    acceptedEventIds: string[];
    duplicateEventIds: string[];
    ok: true;
  }>(
    `/api/bridge/cloud/devices/${encodeURIComponent(
      identity.bridgeDeviceId,
    )}/watch-events`,
    {
      events,
    },
    { authenticated: true, diagnosticOperation: "watch-events", identity },
  );
}

export async function fetchPendingBridgeCommands() {
  const identity = await getCompletePairedBridgeIdentity();

  if (!bridgeIdentityCanAuthenticate(identity)) {
    return [] satisfies BridgeCommandEnvelope[];
  }

  const pathName = `/api/bridge/cloud/devices/${encodeURIComponent(
    identity.bridgeDeviceId,
  )}/commands`;
  const headers = await authenticatedHeaders(
    "GET",
    pathName,
    "",
    identity,
    "commands",
  );
  let response: Response;

  logCloudDiagnostic("commands", {
    stage: "FETCH_STARTED",
  });

  try {
    response = await bridgeFetch(`${appUrl()}${pathName}`, {
      headers,
      method: "GET",
    });
  } catch {
    logCloudDiagnostic("commands", {
      category: "NETWORK_UNAVAILABLE",
      stage: "RESPONSE_REJECTED",
    });
    throw new BridgeAppError(
      "NSN Bridge could not reach NSN Librarian.",
      "NETWORK_UNAVAILABLE",
      503,
    );
  }

  logCloudDiagnostic("commands", {
    stage: "FETCH_RESPONSE_RECEIVED",
    status: response.status,
  });

  const payload = (await response.json().catch(() => null)) as
    | ({ commands?: BridgeCommandEnvelope[]; ok?: boolean } & SafeCloudResponsePayload)
    | null;

  if (!response.ok || !payload?.ok || !Array.isArray(payload.commands)) {
    const category = safeErrorCategoryFromPayload(response, payload);

    logCloudDiagnostic("commands", {
      category,
      stage: "RESPONSE_REJECTED",
      status: response.status,
    });
    throw new BridgeAppError(
      safeErrorMessageForCategory(category),
      category,
      response.status,
    );
  }

  return payload.commands;
}

export async function acknowledgeBridgeCommand(commandId: string) {
  const identity = await requireCompletePairedBridgeIdentity();

  return postJson<{ ok: true }>(
    `/api/bridge/cloud/devices/${encodeURIComponent(
      identity.bridgeDeviceId,
    )}/commands/${encodeURIComponent(commandId)}/acknowledge`,
    {},
    { authenticated: true, identity },
  );
}

export async function reportBridgeCommand(report: BridgeCommandReport) {
  const identity = await requireCompletePairedBridgeIdentity();

  return postJson<{ ok: true }>(
    `/api/bridge/cloud/devices/${encodeURIComponent(
      identity.bridgeDeviceId,
    )}/commands/${encodeURIComponent(report.commandId)}/complete`,
    {
      result: report.result ?? null,
      safeErrorCategory: report.safeErrorCategory ?? null,
      status: report.status,
    },
    { authenticated: true, identity },
  );
}
