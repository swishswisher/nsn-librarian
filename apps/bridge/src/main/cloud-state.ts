import { BridgeAppError } from "../../../../bridge-app/src/types";

export type BridgeCloudConnectionState =
  | "AUTH_UNAVAILABLE"
  | "NETWORK_UNAVAILABLE"
  | "ONLINE"
  | "ROOT_SYNC_FAILED"
  | "UNKNOWN";

export type BridgeCloudRuntimeState = {
  cloudConnectionState: BridgeCloudConnectionState;
  lastSuccessfulHeartbeatAt: string | null;
  lastSuccessfulRootSyncAt: string | null;
  latestSafeCloudErrorCategory: string | null;
};

function nowIso(now: () => Date) {
  return now().toISOString();
}

export function safeCloudErrorCategory(error: unknown) {
  if (error instanceof BridgeAppError) {
    if (
      error.code === "BRIDGE_NOT_PAIRED" ||
      error.code === "KEYCHAIN_UNAVAILABLE" ||
      error.code === "PAIRING_INCOMPLETE" ||
      error.code === "SECRET_READ_FAILED"
    ) {
      return "AUTH_UNAVAILABLE";
    }

    if (error.code === "ROOT_SYNC_FAILED") {
      return "ROOT_SYNC_FAILED";
    }
  }

  return "NETWORK_UNAVAILABLE";
}

export function createBridgeCloudState(now: () => Date = () => new Date()) {
  let state: BridgeCloudRuntimeState = {
    cloudConnectionState: "UNKNOWN",
    lastSuccessfulHeartbeatAt: null,
    lastSuccessfulRootSyncAt: null,
    latestSafeCloudErrorCategory: null,
  };

  return {
    getState() {
      return { ...state };
    },
    recordAuthenticationUnavailable(safeErrorCategory = "AUTH_UNAVAILABLE") {
      state = {
        ...state,
        cloudConnectionState: "AUTH_UNAVAILABLE",
        latestSafeCloudErrorCategory: safeErrorCategory,
      };
    },
    recordCloudFailure(error: unknown) {
      const safeErrorCategory = safeCloudErrorCategory(error);

      state = {
        ...state,
        cloudConnectionState: safeErrorCategory,
        latestSafeCloudErrorCategory: safeErrorCategory,
      };
    },
    recordHeartbeatFailure(error: unknown) {
      const safeErrorCategory = safeCloudErrorCategory(error);

      state = {
        ...state,
        cloudConnectionState: safeErrorCategory,
        latestSafeCloudErrorCategory: safeErrorCategory,
      };
    },
    recordHeartbeatSuccess() {
      state = {
        ...state,
        cloudConnectionState: "ONLINE",
        lastSuccessfulHeartbeatAt: nowIso(now),
        latestSafeCloudErrorCategory: null,
      };
    },
    recordRootSyncFailure(error: unknown) {
      const safeErrorCategory = safeCloudErrorCategory(error);

      state = {
        ...state,
        cloudConnectionState:
          safeErrorCategory === "AUTH_UNAVAILABLE"
            ? "AUTH_UNAVAILABLE"
            : "ROOT_SYNC_FAILED",
        latestSafeCloudErrorCategory:
          safeErrorCategory === "AUTH_UNAVAILABLE"
            ? safeErrorCategory
            : "ROOT_SYNC_FAILED",
      };
    },
    recordRootSyncSuccess() {
      state = {
        ...state,
        cloudConnectionState: "ONLINE",
        lastSuccessfulRootSyncAt: nowIso(now),
        latestSafeCloudErrorCategory: null,
      };
    },
  };
}
