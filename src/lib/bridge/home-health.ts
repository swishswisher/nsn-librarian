import type { BridgeDeviceSummary } from "../../../packages/bridge-protocol/src";

import { selectCloudBridgeHealthDevice } from "./effective-health";
import type { LocalBridgeHealth } from "./local-bridge-client";

export type BridgeHomeHealthDisplay = {
  badgeLabel: "Bridge ready" | "Bridge unavailable" | "Bridge not paired";
  badgeTone: "approved" | "pending";
  deviceLabel: string;
  thisMacLabel:
    | "This Mac is online"
    | "NSN Bridge is offline"
    | "No paired Mac yet";
  versionLabel: string;
};

export function bridgeHomeHealthDisplay({
  bridgeHealth,
  devices,
  formatLastSeen,
}: {
  bridgeHealth: LocalBridgeHealth;
  devices: BridgeDeviceSummary[];
  formatLastSeen: (value: string) => string;
}): BridgeHomeHealthDisplay {
  const device = selectCloudBridgeHealthDevice(devices);
  const badgeLabel = bridgeHealth.ok
    ? "Bridge ready"
    : bridgeHealth.paired
      ? "Bridge unavailable"
      : "Bridge not paired";
  const thisMacLabel = bridgeHealth.ok
    ? "This Mac is online"
    : bridgeHealth.paired
      ? "NSN Bridge is offline"
      : "No paired Mac yet";

  return {
    badgeLabel,
    badgeTone: bridgeHealth.ok ? "approved" : "pending",
    deviceLabel:
      device?.deviceDisplayName ??
      (bridgeHealth.paired ? "This Mac" : "No paired Mac yet"),
    thisMacLabel,
    versionLabel: device
      ? `${device.appVersion}, last seen ${
          device.lastSeenAt ? formatLastSeen(device.lastSeenAt) : "not yet"
        }`
      : bridgeHealth.version
        ? bridgeHealth.version
        : bridgeHealth.paired
          ? "Version unavailable"
          : "Pair a Mac to begin",
  };
}
