import type { BridgeDeviceSummary } from "../../../packages/bridge-protocol/src";

import { selectCloudBridgeHealthDevice } from "./effective-health";
import type { LocalBridgeHealth } from "./local-bridge-client";
import type { BridgeScanProcessingProgress } from "./types";

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

type BridgeHomeBadgeTone = BridgeHomeHealthDisplay["badgeTone"] | "migration" | "review";

type BridgeHomeCurrentPlanStatus = {
  latestExecution: {
    latestUndoRun: {
      status: string;
    } | null;
    status: string;
  } | null;
  plan: {
    status: string;
  };
} | null;

export type BridgeHomeShellStatus = {
  label:
    | BridgeHomeHealthDisplay["badgeLabel"]
    | "Needs attention"
    | "Ready"
    | "Reading library items"
    | "Scanning your library"
    | "Preparing observations"
    | "Preparing recommendations"
    | "Getting ready"
    | "Undo available"
    | "Waiting for final approval"
    | "Waiting for your approval";
  tone: BridgeHomeBadgeTone;
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

export function bridgeHomeScanStageLabel(
  status: BridgeScanProcessingProgress["currentStage"],
) {
  if (status === "SCANNING") {
    return "Scanning your library";
  }

  if (status === "READING") {
    return "Reading library items";
  }

  if (status === "EXAMINING") {
    return "Preparing observations";
  }

  if (status === "GENERATING_SUGGESTIONS") {
    return "Preparing recommendations";
  }

  if (status === "COMPLETED_WITH_ERRORS") {
    return "Needs attention";
  }

  if (status === "COMPLETED") {
    return "Ready";
  }

  if (status === "FAILED") {
    return "Needs attention";
  }

  return "Getting ready";
}

function bridgeHomeWorkflowStatus(
  activeProgress: BridgeScanProcessingProgress | null,
  currentPlan: BridgeHomeCurrentPlanStatus,
): BridgeHomeShellStatus | null {
  if (activeProgress?.isActive) {
    return {
      label: bridgeHomeScanStageLabel(activeProgress.currentStage),
      tone: "migration",
    };
  }

  const latestExecution = currentPlan?.latestExecution;
  const latestUndo = latestExecution?.latestUndoRun;

  if (
    latestUndo?.status === "FAILED" ||
    latestUndo?.status === "PARTIALLY_COMPLETED" ||
    latestUndo?.status === "BLOCKED" ||
    latestExecution?.status === "FAILED"
  ) {
    return {
      label: "Needs attention",
      tone: "review",
    };
  }

  if (latestUndo?.status === "COMPLETED") {
    return {
      label: "Ready",
      tone: "approved",
    };
  }

  if (
    latestExecution?.status === "COMPLETED" ||
    latestExecution?.status === "PARTIALLY_COMPLETED"
  ) {
    return {
      label: "Undo available",
      tone: "approved",
    };
  }

  if (currentPlan?.plan.status === "READY_FOR_EXECUTION") {
    return {
      label: "Waiting for final approval",
      tone: "approved",
    };
  }

  if (currentPlan?.plan.status === "DRAFT") {
    return {
      label: "Waiting for your approval",
      tone: "pending",
    };
  }

  return null;
}

export function bridgeHomeShellStatus({
  activeProgress,
  bridgeDisplay,
  currentPlan,
}: {
  activeProgress: BridgeScanProcessingProgress | null;
  bridgeDisplay: Pick<BridgeHomeHealthDisplay, "badgeLabel" | "badgeTone">;
  currentPlan: BridgeHomeCurrentPlanStatus;
}): BridgeHomeShellStatus {
  return (
    bridgeHomeWorkflowStatus(activeProgress, currentPlan) ?? {
      label: bridgeDisplay.badgeLabel,
      tone: bridgeDisplay.badgeTone,
    }
  );
}
