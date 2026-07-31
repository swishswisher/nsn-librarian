import type { BridgeDeviceSummary } from "../../../packages/bridge-protocol/src";

import type { LocalBridgeHealth } from "./local-bridge-client";

const onlineWindowMs = 90_000;

export function cloudBridgeHealth(
  devices: BridgeDeviceSummary[],
  now = new Date(),
): LocalBridgeHealth {
  const activeDevices = devices
    .filter((device) => device.status !== "REVOKED")
    .sort((left, right) =>
      (right.lastSeenAt ?? "").localeCompare(left.lastSeenAt ?? ""),
    );
  const device = activeDevices[0];

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

  const lastSeenAt = device.lastSeenAt
    ? new Date(device.lastSeenAt).getTime()
    : Number.NaN;
  const online =
    device.status === "ONLINE" &&
    Number.isFinite(lastSeenAt) &&
    now.getTime() - lastSeenAt <= onlineWindowMs;

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
