import type { BridgePermissions } from "../types";

export const defaultBridgePermissions: BridgePermissions = {
  createFolderPermission: false,
  moveFilePermission: false,
  organizationPlanPermission: true,
  readPermission: true,
  recommendationPermission: true,
  renameFilePermission: false,
  watchPermission: false,
};

export const bridgePermissionKeys = Object.keys(
  defaultBridgePermissions,
) as Array<keyof BridgePermissions>;

export function permissionsFromInput(
  input: Partial<BridgePermissions> = {},
): BridgePermissions {
  return {
    createFolderPermission:
      input.createFolderPermission ??
      defaultBridgePermissions.createFolderPermission,
    moveFilePermission:
      input.moveFilePermission ?? defaultBridgePermissions.moveFilePermission,
    organizationPlanPermission:
      input.organizationPlanPermission ??
      defaultBridgePermissions.organizationPlanPermission,
    readPermission:
      input.readPermission ?? defaultBridgePermissions.readPermission,
    recommendationPermission:
      input.recommendationPermission ??
      defaultBridgePermissions.recommendationPermission,
    renameFilePermission:
      input.renameFilePermission ??
      defaultBridgePermissions.renameFilePermission,
    watchPermission:
      input.watchPermission ?? defaultBridgePermissions.watchPermission,
  };
}

export function permissionPatchFromInput(input: Record<string, unknown>) {
  const patch: Partial<BridgePermissions> = {};

  for (const key of bridgePermissionKeys) {
    if (typeof input[key] === "boolean") {
      patch[key] = input[key];
    }
  }

  return patch;
}
