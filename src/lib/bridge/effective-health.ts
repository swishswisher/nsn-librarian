import type { BridgeDeviceSummary } from "../../../packages/bridge-protocol/src";

import type { LocalBridgeHealth } from "./local-bridge-client";

const onlineWindowMs = 90_000;

export type BridgeDeviceHeartbeat = {
  lastSeenAt: Date | string | null;
  status: string;
};

export function bridgeDeviceIsOnline(
  device: BridgeDeviceHeartbeat | null | undefined,
  now = new Date(),
) {
  const lastSeenAt = device?.lastSeenAt
    ? new Date(device.lastSeenAt).getTime()
    : Number.NaN;

  return (
    device?.status === "ONLINE" &&
    Number.isFinite(lastSeenAt) &&
    now.getTime() - lastSeenAt <= onlineWindowMs
  );
}

export function selectCloudBridgeHealthDevice(devices: BridgeDeviceSummary[]) {
  return devices
    .filter((device) => device.status !== "REVOKED")
    .sort((left, right) =>
      (right.lastSeenAt ?? "").localeCompare(left.lastSeenAt ?? ""),
    )[0] ?? null;
}

export function effectiveBridgeHealth(
  localBridgeHealth: LocalBridgeHealth,
  devices: BridgeDeviceSummary[],
  now = new Date(),
): LocalBridgeHealth {
  return localBridgeHealth.ok
    ? localBridgeHealth
    : cloudBridgeHealth(devices, now);
}

export function cloudBridgeHealth(
  devices: BridgeDeviceSummary[],
  now = new Date(),
): LocalBridgeHealth {
  const device = selectCloudBridgeHealthDevice(devices);

  if (!device) {
    return {
      message: "Download NSN Bridge, open it on Deanne's Mac, and pair this Mac.",
      ok: false,
      paired: false,
      platform: null,
      status: "BRIDGE_UNAVAILABLE",
      version: null,
    };
  }

  const online = bridgeDeviceIsOnline(device, now);

  return {
    message: online
      ? `${device.deviceDisplayName} is online and ready.`
      : `${device.deviceDisplayName} is paired but currently offline. Open NSN Bridge on that Mac.`,
    ok: online,
    paired: true,
    platform: device.platform,
    status: online ? "BRIDGE_READY" : "BRIDGE_UNAVAILABLE",
    version: device.appVersion,
  };
}
