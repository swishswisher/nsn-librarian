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
  type BridgeRootSummary,
} from "../../../../bridge-app/src/types";

import {
  readBridgeSecret,
  readBridgeSecretState,
  saveBridgeSecret,
  type BridgeSecretReadResult,
} from "./keychain";

let runtimeAppVersion = process.env.NSN_BRIDGE_APP_VERSION ?? "0.1.0";
type BridgeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
let bridgeFetch: BridgeFetch = (input, init) => fetch(input, init);

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
) {
  const pairedIdentity = identity ?? (await requireCompletePairedBridgeIdentity());

  return {
    ...createBridgeDeviceRequestHeaders({
      bodyText,
      bridgeDeviceId: pairedIdentity.bridgeDeviceId,
      method,
      pathname: pathName,
      privateKey: pairedIdentity.privateKey,
    }),
    "X-NSN-Bridge-Client": "nsn-macos-bridge",
  };
}

async function postJson<T>(
  pathName: string,
  body: Record<string, unknown>,
  options: { authenticated?: boolean; identity?: CompleteBridgeIdentity } = {},
) {
  const bodyText = JSON.stringify(body);
  const response = await bridgeFetch(`${appUrl()}${pathName}`, {
    body: bodyText,
    headers: {
      "Content-Type": "application/json",
      "X-NSN-Bridge-Client": "nsn-macos-bridge",
      ...(options.authenticated
        ? await authenticatedHeaders(
            "POST",
            pathName,
            bodyText,
            options.identity,
          )
        : {}),
    },
    method: "POST",
  });
  const payload = (await response.json().catch(() => null)) as T | null;

  if (!response.ok || !payload) {
    throw new Error("BRIDGE_CLOUD_REQUEST_FAILED");
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
    { authenticated: true, identity },
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
    { authenticated: true, identity },
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
  const response = await bridgeFetch(`${appUrl()}${pathName}`, {
    headers: await authenticatedHeaders("GET", pathName, "", identity),
    method: "GET",
  });
  const payload = (await response.json().catch(() => null)) as
    | { commands?: BridgeCommandEnvelope[]; ok?: boolean }
    | null;

  if (!response.ok || !payload?.ok || !Array.isArray(payload.commands)) {
    throw new Error("BRIDGE_COMMAND_FETCH_FAILED");
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
