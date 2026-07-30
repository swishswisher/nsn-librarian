export const bridgeFilesystemActionOrder = [
  "CREATE_FOLDER",
  "RENAME_FOLDER",
  "MOVE_FILE",
  "RENAME_FILE",
  "MOVE_AND_RENAME_FILE",
  "WEBSITE_ACTION",
] as const;

export type BridgeFilesystemActionType =
  (typeof bridgeFilesystemActionOrder)[number];

export function normalizeBridgeRelativePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\/+/, "").trim();
}

export function validateBridgeRelativePath(value: string) {
  const normalized = normalizeBridgeRelativePath(value);

  if (!normalized) {
    return {
      ok: false,
      path: normalized,
      reason: "EMPTY_PATH",
    } as const;
  }

  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")) {
    return {
      ok: false,
      path: normalized,
      reason: "ABSOLUTE_PATH",
    } as const;
  }

  if (normalized.split("/").some((part) => part === "..")) {
    return {
      ok: false,
      path: normalized,
      reason: "PATH_TRAVERSAL",
    } as const;
  }

  return {
    ok: true,
    path: normalized,
    reason: null,
  } as const;
}

export function bridgeFilesystemActionSortKey(
  actionType: BridgeFilesystemActionType,
) {
  const index = bridgeFilesystemActionOrder.indexOf(actionType);

  return index === -1 ? bridgeFilesystemActionOrder.length : index;
}
