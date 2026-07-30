import os from "node:os";

import {
  createBridgeDeviceId,
  createBridgeKeyPair,
  normalizeBridgePlatform,
  type BridgeCommandEnvelope,
  type BridgeDeviceSummary,
} from "../../../../packages/bridge-protocol/src";

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

async function postJson<T>(pathName: string, body: Record<string, unknown>) {
  const response = await fetch(`${appUrl()}${pathName}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "X-NSN-Bridge-Client": "nsn-macos-bridge",
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

export async function sendBridgeHeartbeat() {
  const bridgeDeviceId = await readBridgeSecret("bridge-device-id");

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
  );
}

export async function fetchPendingBridgeCommands() {
  const bridgeDeviceId = await readBridgeSecret("bridge-device-id");

  if (!bridgeDeviceId) {
    return [] satisfies BridgeCommandEnvelope[];
  }

  const response = await fetch(
    `${appUrl()}/api/bridge/cloud/devices/${encodeURIComponent(
      bridgeDeviceId,
    )}/commands`,
    {
      headers: {
        "X-NSN-Bridge-Client": "nsn-macos-bridge",
      },
      method: "GET",
    },
  );
  const payload = (await response.json().catch(() => null)) as
    | { commands?: BridgeCommandEnvelope[]; ok?: boolean }
    | null;

  return payload?.ok && Array.isArray(payload.commands)
    ? payload.commands
    : [];
}
