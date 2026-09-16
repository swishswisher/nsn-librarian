import type { BridgeDeviceSummary } from "../../../packages/bridge-protocol/src";

import type { ConnectedLibrarySummary } from "./types";
import { bridgeDeviceIsOnline } from "./effective-health";

function onlineDeviceIds(devices: BridgeDeviceSummary[], now = new Date()) {
  return new Set(
    devices
      .filter((device) => {
        return bridgeDeviceIsOnline(device, now);
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
