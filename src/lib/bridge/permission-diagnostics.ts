import type { ConnectedLibraryPermissions } from "./types";

const permissionKeys: Array<keyof ConnectedLibraryPermissions> = [
  "readPermission",
  "watchPermission",
  "recommendationPermission",
  "organizationPlanPermission",
  "createFolderPermission",
  "moveFilePermission",
  "renameFilePermission",
];

type PermissionDiagnosticInput = {
  bridgeRootId?: string | null;
  commandId?: string | null;
  commandType?: string | null;
  confirmedRootUpdatedAt?: string | null;
  event: string;
  ignoredBecause?: string | null;
  permissions?: Partial<Record<keyof ConnectedLibraryPermissions, unknown>>;
  rootUpdatedAt?: string | null;
};

export function bridgePermissionSnapshot(
  value: Partial<Record<keyof ConnectedLibraryPermissions, unknown>> | null | undefined,
) {
  const permissions: Partial<Record<keyof ConnectedLibraryPermissions, boolean>> = {};

  if (!value) {
    return permissions;
  }

  for (const key of permissionKeys) {
    if (typeof value[key] === "boolean") {
      permissions[key] = value[key];
    }
  }

  return permissions;
}

export function logBridgePermissionDiagnostic(input: PermissionDiagnosticInput) {
  console.info("[NSN Bridge] permission-update", {
    bridgeRootId: input.bridgeRootId ?? null,
    commandId: input.commandId ?? null,
    commandType: input.commandType ?? null,
    confirmedRootUpdatedAt: input.confirmedRootUpdatedAt ?? null,
    event: input.event,
    ignoredBecause: input.ignoredBecause ?? null,
    permissions: bridgePermissionSnapshot(input.permissions),
    rootUpdatedAt: input.rootUpdatedAt ?? null,
  });
}
