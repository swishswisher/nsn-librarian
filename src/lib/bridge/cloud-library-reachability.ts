import type { BridgeDeviceSummary } from "../../../packages/bridge-protocol/src";

import type { ConnectedLibrarySummary } from "./types";

const onlineWindowMs = 90_000;

function onlineDeviceIds(devices: BridgeDeviceSummary[], now = new Date()) {
  return new Set(
    devices
      .filter((device) => {
        if (device.status !== "ONLINE" || !device.lastSeenAt) {
          return false;
        }

        const lastSeenAt = new Date(device.lastSeenAt).getTime();
        return (
          Number.isFinite(lastSeenAt) &&
          now.getTime() - lastSeenAt <= onlineWindowMs
        );
      })
      .map((device) => device.bridgeDeviceId),
  );
}

export function applyCloudBridgeReachability(
  libraries: ConnectedLibrarySummary[],
  devices: BridgeDeviceSummary[],
  now = new Date(),
) {
  const online = onlineDeviceIds(devices, now);

  return libraries.map((library) => ({
    ...library,
    bridgeReachable:
      library.bridgeReachable ||
      Boolean(library.bridgeDeviceId && online.has(library.bridgeDeviceId)),
  }));
}
