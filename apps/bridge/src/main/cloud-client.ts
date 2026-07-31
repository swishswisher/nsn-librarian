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
import type { BridgeRootSummary } from "../../../../bridge-app/src/types";

import { readBridgeSecret, saveBridgeSecret } from "./keychain";

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

async function pairedIdentity() {
  const [bridgeDeviceId, privateKey] = await Promise.all([
    readBridgeSecret("bridge-device-id"),
    readBridgeSecret("device-private-key"),
  ]);

  if (!bridgeDeviceId || !privateKey) {
    return null;
  }

  return {
    bridgeDeviceId,
    privateKey,
  };
}

async function authenticatedHeaders(
  method: string,
  pathName: string,
  bodyText = "",
) {
  const identity = await pairedIdentity();

  if (!identity) {
    throw new Error("BRIDGE_NOT_PAIRED");
  }

  return {
    ...createBridgeDeviceRequestHeaders({
      bodyText,
      bridgeDeviceId: identity.bridgeDeviceId,
      method,
      pathname: pathName,
      privateKey: identity.privateKey,
    }),
    "X-NSN-Bridge-Client": "nsn-macos-bridge",
  };
}

async function postJson<T>(
  pathName: string,
  body: Record<string, unknown>,
  options: { authenticated?: boolean } = {},
) {
  const bodyText = JSON.stringify(body);
  const response = await fetch(`${appUrl()}${pathName}`, {
    body: bodyText,
    headers: {
      "Content-Type": "application/json",
      "X-NSN-Bridge-Client": "nsn-macos-bridge",
      ...(options.authenticated
        ? await authenticatedHeaders("POST", pathName, bodyText)
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
  const bridgeDeviceId = createBridgeDeviceId();
  const keys = createBridgeKeyPair();
  const payload = await postJson<PairingResponse>(
    "/api/bridge/cloud/pairing-codes/redeem",
    {
      appVersion: process.env.NSN_BRIDGE_APP_VERSION ?? "0.1.0",
      architecture: os.arch(),
      bridgeDeviceId,
      deviceDisplayName: os.hostname() || "This Mac",
      pairingCode,
      platform: normalizeBridgePlatform(bridgePlatform()),
      publicKey: keys.publicKey,
    },
  );

  if (!payload.ok) {
    throw new Error("PAIRING_FAILED");
  }

  await saveBridgeSecret("device-private-key", keys.privateKey);
  await saveBridgeSecret("bridge-device-id", payload.device.bridgeDeviceId);

  return payload.device;
}

export async function getPairedBridgeDeviceId() {
  return readBridgeSecret("bridge-device-id");
}

export async function sendBridgeHeartbeat() {
  const bridgeDeviceId = await getPairedBridgeDeviceId();

  if (!bridgeDeviceId) {
    return null;
  }

  return postJson<{ ok: true }>(
    `/api/bridge/cloud/devices/${encodeURIComponent(bridgeDeviceId)}/heartbeat`,
    {
      appVersion: process.env.NSN_BRIDGE_APP_VERSION ?? "0.1.0",
      architecture: os.arch(),
      platform: bridgePlatform(),
    },
    { authenticated: true },
  );
}

export async function syncBridgeRoots(roots: BridgeRootSummary[]) {
  const bridgeDeviceId = await getPairedBridgeDeviceId();

  if (!bridgeDeviceId) {
    return null;
  }

  return postJson<{ libraries: unknown[]; ok: true }>(
    `/api/bridge/cloud/devices/${encodeURIComponent(bridgeDeviceId)}/roots/sync`,
    {
      roots,
    },
    { authenticated: true },
  );
}

export async function fetchPendingBridgeCommands() {
  const bridgeDeviceId = await getPairedBridgeDeviceId();

  if (!bridgeDeviceId) {
    return [] satisfies BridgeCommandEnvelope[];
  }

  const pathName = `/api/bridge/cloud/devices/${encodeURIComponent(
    bridgeDeviceId,
  )}/commands`;
  const response = await fetch(`${appUrl()}${pathName}`, {
    headers: await authenticatedHeaders("GET", pathName),
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
  const bridgeDeviceId = await getPairedBridgeDeviceId();

  if (!bridgeDeviceId) {
    throw new Error("BRIDGE_NOT_PAIRED");
  }

  return postJson<{ ok: true }>(
    `/api/bridge/cloud/devices/${encodeURIComponent(
      bridgeDeviceId,
    )}/commands/${encodeURIComponent(commandId)}/acknowledge`,
    {},
    { authenticated: true },
  );
}

export async function reportBridgeCommand(report: BridgeCommandReport) {
  const bridgeDeviceId = await getPairedBridgeDeviceId();

  if (!bridgeDeviceId) {
    throw new Error("BRIDGE_NOT_PAIRED");
  }

  return postJson<{ ok: true }>(
    `/api/bridge/cloud/devices/${encodeURIComponent(
      bridgeDeviceId,
    )}/commands/${encodeURIComponent(report.commandId)}/complete`,
    {
      result: report.result ?? null,
      safeErrorCategory: report.safeErrorCategory ?? null,
      status: report.status,
    },
    { authenticated: true },
  );
}
