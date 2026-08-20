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

const authenticationErrorCategories = new Set([
  "BRIDGE_AUTH_REJECTED",
  "BRIDGE_NOT_PAIRED",
  "DEVICE_NOT_PAIRED",
  "KEYCHAIN_UNAVAILABLE",
  "PAIRING_INCOMPLETE",
  "PAIRING_PRIVATE_KEY_INVALID",
  "PRIVATE_KEY_INVALID",
  "REQUEST_EXPIRED",
  "REQUEST_SIGNATURE_INVALID",
  "REQUEST_SIGNING_FAILED",
  "SECRET_READ_FAILED",
]);

export function safeCloudErrorCategory(error: unknown) {
  if (error instanceof BridgeAppError) {
    if (authenticationErrorCategories.has(error.code)) {
      return error.code;
    }

    if (error.code === "ROOT_SYNC_FAILED") {
      return "ROOT_SYNC_FAILED";
    }

    if (error.code === "SERVER_ERROR") {
      return "SERVER_ERROR";
    }
  }

  return "NETWORK_UNAVAILABLE";
}

function cloudConnectionStateForCategory(
  safeErrorCategory: string,
): BridgeCloudConnectionState {
  if (authenticationErrorCategories.has(safeErrorCategory)) {
    return "AUTH_UNAVAILABLE";
  }

  if (safeErrorCategory === "ROOT_SYNC_FAILED") {
    return "ROOT_SYNC_FAILED";
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
        cloudConnectionState:
          cloudConnectionStateForCategory(safeErrorCategory),
        latestSafeCloudErrorCategory: safeErrorCategory,
      };
    },
    recordHeartbeatFailure(error: unknown) {
      const safeErrorCategory = safeCloudErrorCategory(error);

      state = {
        ...state,
        cloudConnectionState:
          cloudConnectionStateForCategory(safeErrorCategory),
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
      const cloudConnectionState =
        cloudConnectionStateForCategory(safeErrorCategory);

      state = {
        ...state,
        cloudConnectionState:
          cloudConnectionState === "AUTH_UNAVAILABLE"
            ? "AUTH_UNAVAILABLE"
            : "ROOT_SYNC_FAILED",
        latestSafeCloudErrorCategory: safeErrorCategory,
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
