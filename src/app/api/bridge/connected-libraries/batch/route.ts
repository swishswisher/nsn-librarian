import {
  connectBridgeLibrary,
  ConnectedLibraryError,
  getConnectedLibraries,
  getConnectedLibrary,
} from "@/lib/bridge/connected-libraries";
import {
  duplicateSelectionRootIds,
  folderSelectionOverlaps,
} from "@/lib/bridge/folder-selection";
import {
  registerLocalBridgeRoot,
  LocalBridgeClientError,
} from "@/lib/bridge/local-bridge-client";
import { BridgeMonitoringError, startMonitoringForConnectedLibrary } from "@/lib/bridge/monitor";
import type {
  ConnectedLibraryBatchConnectionItem,
  ConnectedLibraryBatchConnectionResponse,
  ConnectedLibraryPermissions,
} from "@/lib/bridge/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const permissionKeys = [
  "readPermission",
  "watchPermission",
  "recommendationPermission",
  "organizationPlanPermission",
  "createFolderPermission",
  "moveFilePermission",
  "renameFilePermission",
] as const;

type BatchSelectionInput = {
  ancestorRootIds?: unknown;
  displayName?: unknown;
  permissions?: unknown;
  rootId?: unknown;
  safeLocation?: unknown;
  selectionToken?: unknown;
  suggestedDisplayName?: unknown;
};

function permissionsFromValue(value: unknown): Partial<ConnectedLibraryPermissions> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    permissionKeys
      .filter((key) => typeof (value as Record<string, unknown>)[key] === "boolean")
      .map((key) => [key, (value as Record<string, unknown>)[key]]),
  );
}

function safeErrorMessage(error: unknown) {
  if (error instanceof ConnectedLibraryError) {
    return error.message;
  }

  if (error instanceof LocalBridgeClientError) {
    return error.message;
  }

  if (error instanceof BridgeMonitoringError) {
    return error.message;
  }

  return "The Bridge could not connect this folder safely.";
}

function normalizeSelection(input: BatchSelectionInput) {
  return {
    ancestorRootIds: Array.isArray(input.ancestorRootIds)
      ? input.ancestorRootIds.filter((item): item is string => typeof item === "string")
      : [],
    displayName: typeof input.displayName === "string" ? input.displayName.trim() : "",
    permissions: permissionsFromValue(input.permissions),
    rootId: typeof input.rootId === "string" ? input.rootId.trim() : "",
    safeLocation:
      typeof input.safeLocation === "string" ? input.safeLocation.trim() : "",
    selectionToken:
      typeof input.selectionToken === "string" ? input.selectionToken.trim() : "",
    suggestedDisplayName:
      typeof input.suggestedDisplayName === "string"
        ? input.suggestedDisplayName.trim()
        : "",
  };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    allowOverlappingRoots?: unknown;
    selections?: unknown;
  } | null;
  const rawSelections = Array.isArray(body?.selections) ? body.selections : [];
  const selections = rawSelections
    .filter(
      (item): item is BatchSelectionInput =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
    .map(normalizeSelection)
    .filter((selection) => selection.selectionToken && selection.rootId);

  if (selections.length === 0) {
    return Response.json(
      {
        ok: false,
        error: "Choose at least one folder before connecting.",
      } satisfies ConnectedLibraryBatchConnectionResponse,
      { status: 400 },
    );
  }

  const duplicateRootIds = duplicateSelectionRootIds(selections);

  if (duplicateRootIds.length > 0) {
    return Response.json(
      {
        ok: false,
        error: "Remove duplicate folders from the selection before connecting.",
      } satisfies ConnectedLibraryBatchConnectionResponse,
      { status: 409 },
    );
  }

  const existingLibraries = await getConnectedLibraries();
  const overlaps = folderSelectionOverlaps(selections, existingLibraries);

  if (overlaps.length > 0 && body?.allowOverlappingRoots !== true) {
    return Response.json(
      {
        ok: false,
        error:
          "These folders overlap. Keep one folder, or explicitly confirm connecting both.",
      } satisfies ConnectedLibraryBatchConnectionResponse,
      { status: 409 },
    );
  }

  const results: ConnectedLibraryBatchConnectionItem[] = [];

  for (const selection of selections) {
    try {
      const root = await registerLocalBridgeRoot({
        displayName: selection.displayName || selection.suggestedDisplayName,
        permissions: selection.permissions,
        selectionToken: selection.selectionToken,
      });
      const connection = await connectBridgeLibrary({
        root,
        updateExistingPermissions: true,
      });
      let library = connection.library;
      let warning: string | undefined;

      if (root.watchPermission) {
        try {
          await startMonitoringForConnectedLibrary(library.id);
          library = (await getConnectedLibrary(library.id)) ?? library;
        } catch (error) {
          warning = safeErrorMessage(error);
          library = (await getConnectedLibrary(library.id)) ?? library;
        }
      }

      results.push({
        action: connection.action,
        alreadyConnected: connection.alreadyConnected,
        error: warning,
        library,
        ok: true,
        rootId: root.id,
        selectionToken: selection.selectionToken,
      });
    } catch (error) {
      results.push({
        error: safeErrorMessage(error),
        library: null,
        ok: false,
        rootId: selection.rootId,
        selectionToken: selection.selectionToken,
      });
    }
  }

  const libraries = await getConnectedLibraries();
  const connectedCount = results.filter(
    (result) => result.ok && result.action !== "ALREADY_CONNECTED" && !result.error,
  ).length;
  const alreadyConnectedCount = results.filter(
    (result) => result.ok && result.action === "ALREADY_CONNECTED" && !result.error,
  ).length;
  const needsAttentionCount = results.filter(
    (result) => !result.ok || Boolean(result.error),
  ).length;

  return Response.json({
    alreadyConnectedCount,
    connectedCount,
    libraries,
    needsAttentionCount,
    ok: true,
    results,
  } satisfies ConnectedLibraryBatchConnectionResponse);
}
