import type {
  ConnectedLibraryPermissions,
  ConnectedLibrarySummary,
} from "./types";

export type PermissionKey = keyof ConnectedLibraryPermissions;

export type PendingPermissionState = {
  status: "updating";
  value: boolean;
};

export type PermissionFeedbackState = {
  message: "Could not update" | "Saved";
  status: "failed" | "saved";
};

export type PendingPermissionMap = Partial<
  Record<PermissionKey, PendingPermissionState>
>;

export type PermissionFeedbackMap = Partial<
  Record<PermissionKey, PermissionFeedbackState>
>;

export type ScanAvailability = {
  available: boolean;
  message: string;
  reason:
    | "AVAILABLE"
    | "BRIDGE_UNAVAILABLE"
    | "NOT_CONNECTED"
    | "READ_PERMISSION_REQUIRED"
    | "RECONNECT_REQUIRED"
    | "UPDATING";
};

export const permissionKeys: PermissionKey[] = [
  "readPermission",
  "watchPermission",
  "recommendationPermission",
  "organizationPlanPermission",
  "createFolderPermission",
  "moveFilePermission",
  "renameFilePermission",
];

export function permissionPatchFromBody(body: Record<string, unknown>) {
  const patch: Partial<ConnectedLibraryPermissions> = {};

  for (const key of permissionKeys) {
    if (typeof body[key] === "boolean") {
      patch[key] = body[key] as boolean;
    }
  }

  if (patch.readPermission === false) {
    patch.watchPermission = false;
  }

  return patch;
}

export function permissionPatchKeys(
  patch: Partial<ConnectedLibraryPermissions>,
) {
  return permissionKeys.filter((key) => typeof patch[key] === "boolean");
}

export function pendingPermissionsWithPatch(
  current: PendingPermissionMap,
  patch: Partial<ConnectedLibraryPermissions>,
) {
  const next = { ...current };

  for (const key of permissionPatchKeys(patch)) {
    next[key] = {
      status: "updating",
      value: patch[key] as boolean,
    };
  }

  return next;
}

export function visiblePermissionValue(input: {
  confirmed: ConnectedLibraryPermissions;
  key: PermissionKey;
  pending: PendingPermissionMap;
}) {
  return input.pending[input.key]?.value ?? input.confirmed[input.key];
}

export function disabledPermissionKeys(input: {
  pending: PendingPermissionMap;
  requiresReconnect: boolean;
}) {
  const disabled = new Set<PermissionKey>();

  if (input.requiresReconnect) {
    for (const key of permissionKeys) {
      disabled.add(key);
    }

    return disabled;
  }

  for (const key of permissionKeys) {
    if (input.pending[key]) {
      disabled.add(key);
    }
  }

  if (input.pending.readPermission) {
    disabled.add("watchPermission");
  }

  if (input.pending.watchPermission) {
    disabled.add("readPermission");
  }

  return disabled;
}

export function permissionInlineStatus(input: {
  feedback: PermissionFeedbackMap;
  key: PermissionKey;
  pending: PendingPermissionMap;
}) {
  const pending = input.pending[input.key];

  if (pending) {
    return pending.value ? "Turning on..." : "Turning off...";
  }

  return input.feedback[input.key]?.message ?? null;
}

export function confirmedCanStartWatching(input: {
  confirmed: Pick<
    ConnectedLibraryPermissions,
    "readPermission" | "watchPermission"
  >;
  pending: PendingPermissionMap;
}) {
  if (!input.confirmed.readPermission || !input.confirmed.watchPermission) {
    return false;
  }

  if (input.pending.readPermission?.value === false) {
    return false;
  }

  if (input.pending.watchPermission?.value === false) {
    return false;
  }

  return true;
}

export function scanAvailability(input: {
  library: Pick<
    ConnectedLibrarySummary,
    | "bridgeReachable"
    | "isEnabled"
    | "readPermission"
    | "requiresReconnect"
    | "status"
  >;
  pending: PendingPermissionMap;
}): ScanAvailability {
  if (input.pending.readPermission) {
    return {
      available: false,
      message: "Read permission is being updated. Scan Now will return when the Bridge confirms it.",
      reason: "UPDATING",
    };
  }

  if (input.library.requiresReconnect) {
    return {
      available: false,
      message: "Reconnect this folder through the NSN Bridge before scanning.",
      reason: "RECONNECT_REQUIRED",
    };
  }

  if (!input.library.bridgeReachable) {
    return {
      available: false,
      message: "The paired Bridge is not reachable right now. Open the NSN Bridge and try again.",
      reason: "BRIDGE_UNAVAILABLE",
    };
  }

  if (!input.library.isEnabled || input.library.status !== "CONNECTED") {
    return {
      available: false,
      message: "This connected folder is not ready to scan yet.",
      reason: "NOT_CONNECTED",
    };
  }

  if (!input.library.readPermission) {
    return {
      available: false,
      message: "Turn on read permission for this folder before scanning.",
      reason: "READ_PERMISSION_REQUIRED",
    };
  }

  return {
    available: true,
    message: "Ready to scan this connected folder.",
    reason: "AVAILABLE",
  };
}
