"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { BridgeScanControl } from "@/components/library/BridgeScanControl";
import { ConnectedLibraryBatchPanel } from "@/components/library/ConnectedLibraryBatchPanel";
import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnButton } from "@/components/library/NsnButton";
import { NsnCard } from "@/components/library/NsnCard";
import {
  duplicateSelectionRootIds,
  folderSelectionOverlaps,
  selectionHasBlockingOverlaps,
} from "@/lib/bridge/folder-selection";
import {
  getBridgeMonitoringRoute,
  getScanSessionsRoute,
} from "@/lib/library/routes";
import type {
  ConnectedLibraryBatchConnectionResponse,
  ConnectedLibraryListResponse,
  ConnectedLibraryMutationResponse,
  ConnectedLibraryPermissions,
  ConnectedLibrarySummary,
  BridgeMonitoringApiResponse,
} from "@/lib/bridge/types";
import type {
  LocalBridgeFolderSelection,
  LocalBridgeHealth,
} from "@/lib/bridge/local-bridge-client";

type ConnectedLibrariesManagerProps = {
  initialBridgeHealth: LocalBridgeHealth;
  initialLibraries: ConnectedLibrarySummary[];
};

type PermissionKey = keyof ConnectedLibraryPermissions;

type SelectionState = {
  displayName: string;
  existingLibrary: ConnectedLibrarySummary | null;
  mode: "connect" | "reconnect" | "already-connected";
  permissions: ConnectedLibraryPermissions;
  selection: LocalBridgeFolderSelection;
};

const defaultPermissions: ConnectedLibraryPermissions = {
  createFolderPermission: false,
  moveFilePermission: false,
  organizationPlanPermission: true,
  readPermission: true,
  recommendationPermission: true,
  renameFilePermission: false,
  watchPermission: false,
};

const permissionSections: Array<{
  title: "Observe" | "Think" | "Act";
  permissions: Array<{
    description: string;
    key: PermissionKey;
    label: string;
  }>;
}> = [
  {
    title: "Observe",
    permissions: [
      {
        description: "Required for scanning and temporary examination.",
        key: "readPermission",
        label: "Read files",
      },
      {
        description:
          "Allows the Librarian to notice new, modified, renamed, moved, and deleted files.",
        key: "watchPermission",
        label: "Watch for changes",
      },
    ],
  },
  {
    title: "Think",
    permissions: [
      {
        description: "Allows provisional organization recommendations.",
        key: "recommendationPermission",
        label: "Prepare recommendations",
      },
      {
        description:
          "Allows reviewed recommendations to become a proposed Organization Plan.",
        key: "organizationPlanPermission",
        label: "Prepare Organization Plans",
      },
    ],
  },
  {
    title: "Act",
    permissions: [
      {
        description: "Allows approved execution to create folders.",
        key: "createFolderPermission",
        label: "Create folders after approval",
      },
      {
        description: "Allows approved execution to move files.",
        key: "moveFilePermission",
        label: "Move files after approval",
      },
      {
        description: "Allows approved execution to rename files.",
        key: "renameFilePermission",
        label: "Rename files after approval",
      },
    ],
  },
];

const permissionGroups = permissionSections.flatMap(
  (section) => section.permissions,
);

function statusLabel(library: ConnectedLibrarySummary) {
  if (library.isMergedDuplicate) {
    return "Merged into another connection";
  }

  if (library.isHiddenFromActiveList) {
    return "Hidden from active list";
  }

  if (library.isLegacyConnection) {
    return "Legacy connection - reconnect required";
  }

  if (!library.isEnabled || library.status === "DISCONNECTED") {
    return "Disconnected";
  }

  if (!library.bridgeReachable) {
    return "Bridge unavailable";
  }

  if (library.status === "PAUSED") {
    return "Paused";
  }

  if (library.status === "NEEDS_ATTENTION") {
    return "Needs attention";
  }

  return "Connected";
}

function statusTone(library: ConnectedLibrarySummary): NsnBadgeTone {
  if (
    library.requiresReconnect ||
    library.isHiddenFromActiveList ||
    library.isMergedDuplicate ||
    !library.bridgeReachable
  ) {
    return "pending";
  }

  if (library.status === "NEEDS_ATTENTION") {
    return "review";
  }

  if (library.status === "PAUSED") {
    return "pending";
  }

  return "approved";
}

function monitoringLabel(library: ConnectedLibrarySummary) {
  if (library.requiresReconnect) {
    return "Reconnect required";
  }

  if (!library.watchPermission) {
    return "Not watching";
  }

  if (library.monitoringState === "WATCHING") {
    return "Watching for changes";
  }

  if (library.monitoringState === "NEEDS_ATTENTION") {
    return "Needs attention";
  }

  if (library.monitoringState === "PAUSED") {
    return "Paused";
  }

  return "Not watching";
}

function permissionSummary(library: ConnectedLibrarySummary) {
  const enabled = permissionGroups
    .filter((permission) => library[permission.key])
    .map((permission) => permission.label);

  return enabled.length > 0 ? enabled.join(", ") : "No active permissions";
}

function isCurrentConnectedLibrary(library: ConnectedLibrarySummary) {
  return (
    library.isEnabled &&
    !library.isHiddenFromActiveList &&
    !library.isLegacyConnection &&
    !library.isMergedDuplicate &&
    (library.status === "CONNECTED" ||
      library.status === "PAUSED" ||
      library.status === "NEEDS_ATTENTION")
  );
}

function isActiveConnectedLibrary(library: ConnectedLibrarySummary) {
  return library.bridgeReachable && isCurrentConnectedLibrary(library);
}

function isPreviousConnection(library: ConnectedLibrarySummary) {
  return (
    !library.isHiddenFromActiveList &&
    !library.isMergedDuplicate &&
    !isCurrentConnectedLibrary(library)
  );
}

function currentLibraryIdentity(library: ConnectedLibrarySummary) {
  return library.bridgeRootId ?? library.id;
}

function uniqueCurrentLibraries(libraries: ConnectedLibrarySummary[]) {
  const seen = new Set<string>();
  const unique: ConnectedLibrarySummary[] = [];

  for (const library of libraries) {
    const identity = currentLibraryIdentity(library);

    if (seen.has(identity)) {
      continue;
    }

    seen.add(identity);
    unique.push(library);
  }

  return unique;
}

function permissionsFromLibrary(
  library: ConnectedLibrarySummary,
): ConnectedLibraryPermissions {
  return {
    createFolderPermission: library.createFolderPermission,
    moveFilePermission: library.moveFilePermission,
    organizationPlanPermission: library.organizationPlanPermission,
    readPermission: library.readPermission,
    recommendationPermission: library.recommendationPermission,
    renameFilePermission: library.renameFilePermission,
    watchPermission: library.watchPermission,
  };
}

function isPermissionPatch(body: Record<string, unknown>) {
  return permissionGroups.some((permission) => permission.key in body);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function readPermissionUpdateStatus(response: Response) {
  try {
    return (await response.json()) as
      | {
          done: boolean;
          library: ConnectedLibrarySummary | null;
          ok: true;
          status: string;
        }
      | {
          done: boolean;
          error: string;
          library: ConnectedLibrarySummary | null;
          ok: false;
          status: string;
        };
  } catch {
    return {
      done: true,
      error: "The Bridge could not read the permission update response.",
      library: null,
      ok: false,
      status: "FAILED",
    } as const;
  }
}

async function readLibraryMutation(response: Response) {
  try {
    return (await response.json()) as ConnectedLibraryMutationResponse;
  } catch {
    return {
      ok: false,
      error: "The Bridge could not read the connected library response.",
    } satisfies ConnectedLibraryMutationResponse;
  }
}

async function readBatchConnection(response: Response) {
  try {
    return (await response.json()) as ConnectedLibraryBatchConnectionResponse;
  } catch {
    return {
      ok: false,
      error: "The Bridge could not read the folder connection response.",
    } satisfies ConnectedLibraryBatchConnectionResponse;
  }
}

async function readLibraryList(response: Response) {
  try {
    return (await response.json()) as ConnectedLibraryListResponse;
  } catch {
    return {
      ok: false,
      error: "The Bridge could not read connected libraries.",
    } satisfies ConnectedLibraryListResponse;
  }
}

async function readMonitoringCommandResponse(response: Response) {
  try {
    return (await response.json()) as BridgeMonitoringApiResponse;
  } catch {
    return {
      ok: false,
      error: "The Bridge could not read the monitoring response.",
    } satisfies BridgeMonitoringApiResponse;
  }
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "Not recorded yet";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function monitoringErrorLabel(category: string | null) {
  if (category === "BRIDGE_UNAVAILABLE") {
    return "The NSN Bridge is not currently available.";
  }

  if (
    category === "ROOT_NOT_REGISTERED" ||
    category === "ROOT_NOT_FOUND" ||
    category === "ROOT_DISCONNECTED" ||
    category === "ROOT_PAUSED"
  ) {
    return "This folder needs to be reconnected before watching can begin.";
  }

  if (category === "READ_PERMISSION_REQUIRED") {
    return "Reading permission is required before this folder can be watched.";
  }

  if (category === "WATCH_PERMISSION_REQUIRED") {
    return "Watching permission is not enabled for this folder.";
  }

  if (category === "ROOT_UNAVAILABLE") {
    return "The selected folder is not currently available.";
  }

  return category ? "The Librarian could not begin watching this folder." : null;
}

export function ConnectedLibrariesManager({
  initialBridgeHealth,
  initialLibraries,
}: ConnectedLibrariesManagerProps) {
  const router = useRouter();
  const [bridgeHealth, setBridgeHealth] = useState(initialBridgeHealth);
  const [libraries, setLibraries] = useState(initialLibraries);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [monitoringAction, setMonitoringAction] = useState<{
    action: "pause" | "resume" | "start";
    libraryId: string;
  } | null>(null);
  const [selectionBasket, setSelectionBasket] = useState<SelectionState[]>([]);
  const [sharedSelectionPermissions, setSharedSelectionPermissions] =
    useState<ConnectedLibraryPermissions>(defaultPermissions);
  const [confirmedOverlapRootIds, setConfirmedOverlapRootIds] = useState<
    string[]
  >([]);
  const [disconnectCandidate, setDisconnectCandidate] =
    useState<ConnectedLibrarySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const disconnectCancelRef = useRef<HTMLButtonElement>(null);
  const lastFocusedControlRef = useRef<HTMLElement | null>(null);

  const visibleLibraries = libraries.filter(
    (library) => !library.isHiddenFromActiveList && !library.isMergedDuplicate,
  );
  const currentLibraries = uniqueCurrentLibraries(
    visibleLibraries.filter(isCurrentConnectedLibrary),
  );
  const activeLibraries = currentLibraries.filter(isActiveConnectedLibrary);
  const watchingLibraries = currentLibraries.filter(
    (library) => library.monitoringState === "WATCHING",
  );
  const historicalLibraries = visibleLibraries.filter(isPreviousConnection);
  const selectedFolders = selectionBasket.map((item) => item.selection);
  const duplicateSelectionRoots = duplicateSelectionRootIds(selectedFolders);
  const confirmedOverlapRootIdSet = new Set(confirmedOverlapRootIds);
  const selectionOverlaps = folderSelectionOverlaps(
    selectedFolders,
    currentLibraries,
  );
  const hasBlockingSelectionOverlaps = selectionHasBlockingOverlaps(
    selectedFolders,
    confirmedOverlapRootIdSet,
    currentLibraries,
  );

  useEffect(() => {
    if (disconnectCandidate) {
      disconnectCancelRef.current?.focus();
      return;
    }

    lastFocusedControlRef.current?.focus();
  }, [disconnectCandidate]);

  function replaceLibrary(nextLibrary: ConnectedLibrarySummary) {
    setLibraries((current) => {
      if (nextLibrary.isHiddenFromActiveList || nextLibrary.isMergedDuplicate) {
        return current.filter((library) => library.id !== nextLibrary.id);
      }

      const existing = current.some((library) => library.id === nextLibrary.id);

      if (!existing) {
        return [nextLibrary, ...current];
      }

      return current.map((library) =>
        library.id === nextLibrary.id ? nextLibrary : library,
      );
    });
  }

  async function refreshBridgeStatus() {
    setBusyId("status");
    setError(null);

    try {
      const [statusResponse, librariesResponse] = await Promise.all([
        fetch("/api/bridge/status"),
        fetch("/api/bridge/connected-libraries"),
      ]);
      const statusPayload = (await statusResponse.json().catch(() => null)) as
        | { bridge?: LocalBridgeHealth }
        | null;
      const listPayload = await readLibraryList(librariesResponse);

      if (statusPayload?.bridge) {
        setBridgeHealth(statusPayload.bridge);
      }

      if (librariesResponse.ok && listPayload.ok) {
        setLibraries(listPayload.libraries);
      }
    } catch {
      setBridgeHealth({
        message:
          "Open the NSN Bridge on this computer to choose and watch local folders.",
        ok: false,
        paired: false,
        platform: null,
        status: "BRIDGE_UNAVAILABLE",
        version: null,
      });
      setError("The Bridge status could not be checked right now.");
    } finally {
      setBusyId(null);
    }
  }

  async function chooseFolder() {
    setBusyId("picker");
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        "/api/bridge/connected-libraries/folder-picker",
        {
          method: "POST",
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | {
            existingLibrary: ConnectedLibrarySummary | null;
            ok: true;
            selection: LocalBridgeFolderSelection;
          }
        | {
            ok: false;
            error: string;
          }
        | null;

      if (!response.ok || !payload?.ok) {
        setError(
          payload && "error" in payload
            ? payload.error
            : "The NSN Bridge could not open the folder picker.",
        );
        await refreshBridgeStatus();
        return;
      }

      setBridgeHealth((current) => ({
        ...current,
        ok: true,
        status: "FOLDER_SELECTION_IN_PROGRESS",
      }));
      const existingLibrary = payload.existingLibrary ?? null;
      const selection = {
        ...payload.selection,
        ancestorRootIds: Array.isArray(payload.selection.ancestorRootIds)
          ? payload.selection.ancestorRootIds
          : [],
      };
      const mode =
        existingLibrary && isActiveConnectedLibrary(existingLibrary)
          ? "already-connected"
          : existingLibrary
            ? "reconnect"
            : "connect";

      let wasAlreadyInBasket = false;

      setSelectionBasket((current) => {
        wasAlreadyInBasket = current.some(
          (item) => item.selection.rootId === selection.rootId,
        );

        if (wasAlreadyInBasket) {
          return current;
        }

        return [
          ...current,
          {
            displayName:
              existingLibrary?.displayName ?? selection.suggestedDisplayName,
            existingLibrary,
            mode,
            permissions: existingLibrary
              ? permissionsFromLibrary(existingLibrary)
              : defaultPermissions,
            selection,
          },
        ];
      });

      if (wasAlreadyInBasket) {
        setNotice("This folder is already in the selection basket.");
        return;
      }

      setNotice(
        mode === "already-connected"
          ? "This folder is already connected. You can update its permissions from the basket."
          : "Folder added. Add another folder or review the selected folders.",
      );
    } catch {
      setError("The NSN Bridge could not open the folder picker right now.");
    } finally {
      setBusyId(null);
    }
  }

  function removeSelectedFolder(rootId: string) {
    setSelectionBasket((current) =>
      current.filter((item) => item.selection.rootId !== rootId),
    );
    setConfirmedOverlapRootIds((current) =>
      current.filter((id) => id !== rootId),
    );
  }

  function updateSelectedFolder(
    rootId: string,
    updater: (item: SelectionState) => SelectionState,
  ) {
    setSelectionBasket((current) =>
      current.map((item) =>
        item.selection.rootId === rootId ? updater(item) : item,
      ),
    );
  }

  function applySharedSelectionPermissions() {
    setSelectionBasket((current) =>
      current.map((item) => ({
        ...item,
        permissions: sharedSelectionPermissions,
      })),
    );
    setNotice("Shared permissions applied. You can still adjust folders one at a time.");
  }

  function confirmAllOverlaps() {
    const ids = new Set(confirmedOverlapRootIds);

    for (const overlap of selectionOverlaps) {
      ids.add(overlap.parentRootId);
      ids.add(overlap.childRootId);
    }

    setConfirmedOverlapRootIds([...ids]);
    setNotice("Overlapping folders will be connected separately only because you confirmed it.");
  }

  async function connectSelectedFolders() {
    if (selectionBasket.length === 0) {
      return;
    }

    if (duplicateSelectionRoots.length > 0) {
      setError("Remove duplicate folders from the selection before connecting.");
      return;
    }

    if (hasBlockingSelectionOverlaps) {
      setError(
        "These folders overlap. Keep one folder, or explicitly confirm connecting both.",
      );
      return;
    }

    setBusyId("connect");
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/bridge/connected-libraries/batch", {
        body: JSON.stringify({
          allowOverlappingRoots: selectionOverlaps.length > 0,
          selections: selectionBasket.map((item) => ({
            ancestorRootIds: item.selection.ancestorRootIds,
            displayName: item.displayName,
            permissions: item.permissions,
            rootId: item.selection.rootId,
            safeLocation: item.selection.safeLocation,
            selectionToken: item.selection.selectionToken,
            suggestedDisplayName: item.selection.suggestedDisplayName,
          })),
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = await readBatchConnection(response);

      if (!response.ok || !payload.ok) {
        setError(
          payload.ok
            ? "The Bridge could not connect the selected folders."
            : payload.error,
        );
        return;
      }

      setLibraries(payload.libraries);
      setSelectionBasket([]);
      setConfirmedOverlapRootIds([]);
      setBridgeHealth((current) => ({
        ...current,
        ok: true,
        status: "BRIDGE_READY",
      }));
      setNotice(
        `${payload.connectedCount} folders connected. ${payload.alreadyConnectedCount} folders already connected. ${payload.needsAttentionCount} folders need attention.`,
      );
      router.refresh();
    } catch {
      setError("The Bridge could not connect the selected folders right now.");
    } finally {
      setBusyId(null);
    }
  }

  function clearSelectionBasket() {
    setSelectionBasket([]);
    setConfirmedOverlapRootIds([]);
    setNotice(null);
    setError(null);
  }

  function selectionAvailabilityLabel(item: SelectionState) {
    if (item.existingLibrary && isActiveConnectedLibrary(item.existingLibrary)) {
      return "Already connected";
    }

    if (item.mode === "reconnect") {
      return "Can reconnect existing history";
    }

    return "Ready to connect";
  }

  function selectionBadgeTone(item: SelectionState): NsnBadgeTone {
    if (item.mode === "already-connected") {
      return "approved";
    }

    if (item.mode === "reconnect") {
      return "pending";
    }

    return "review";
  }

  function keepParentOnly(parentRootId: string, childRootId: string) {
    removeSelectedFolder(childRootId);
    setConfirmedOverlapRootIds((current) =>
      current.filter((id) => id !== childRootId && id !== parentRootId),
    );
    setNotice("The child folder was removed from the selection.");
  }

  function keepChildOnly(parentRootId: string, childRootId: string) {
    const parentIsSelected = selectionBasket.some(
      (item) => item.selection.rootId === parentRootId,
    );

    if (parentIsSelected) {
      removeSelectedFolder(parentRootId);
      setNotice("The parent folder was removed from the selection.");
      return;
    }

    setConfirmedOverlapRootIds((current) =>
      current.filter((id) => id !== childRootId && id !== parentRootId),
    );
    setNotice(
      "The existing parent folder remains connected. Remove the child if you do not want both.",
    );
  }

  async function patchLibrary(
    libraryId: string,
    body: Record<string, unknown>,
    successMessage: string,
  ) {
    const updatesPermissions = isPermissionPatch(body);
    setBusyId(libraryId);
    setError(null);
    setNotice(updatesPermissions ? "Updating permission..." : null);

    try {
      const response = await fetch(
        `/api/bridge/connected-libraries/${encodeURIComponent(libraryId)}`,
        {
          body: JSON.stringify(body),
          headers: {
            "Content-Type": "application/json",
          },
          method: "PATCH",
        },
      );
      const payload = await readLibraryMutation(response);

      if (!response.ok || !payload.ok) {
        setError(payload.ok ? "The Bridge could not update this folder." : payload.error);
        return;
      }

      replaceLibrary(payload.library);

      if (payload.permissionUpdate?.status === "PENDING") {
        for (let attempt = 0; attempt < 24; attempt += 1) {
          await wait(2_000);

          const statusResponse = await fetch(
            `/api/bridge/connected-libraries/${encodeURIComponent(
              libraryId,
            )}/permission-updates/${encodeURIComponent(
              payload.permissionUpdate.commandId,
            )}`,
          );
          const statusPayload = await readPermissionUpdateStatus(statusResponse);

          if (statusPayload.library) {
            replaceLibrary(statusPayload.library);
          }

          if (!statusResponse.ok || !statusPayload.ok) {
            setError(
              "error" in statusPayload
                ? statusPayload.error
                : "The Bridge could not update that permission.",
            );
            return;
          }

          if (statusPayload.done) {
            setNotice(successMessage);
            router.refresh();
            return;
          }
        }

        setError(
          "The permission update is still waiting for the Bridge. Refresh this page in a moment.",
        );
        return;
      }

      setNotice(successMessage);
      router.refresh();
    } catch {
      setError("The Bridge could not update this folder right now.");
    } finally {
      setBusyId(null);
    }
  }

  async function monitoringCommand(
    library: ConnectedLibrarySummary,
    endpoint: string,
    message: string,
    action: "pause" | "resume" | "start",
  ) {
    setBusyId(library.id);
    setMonitoringAction({
      action,
      libraryId: library.id,
    });
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(endpoint, {
        body: JSON.stringify({
          connectedLibraryId: library.id,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = await readMonitoringCommandResponse(response);

      if (!response.ok || !payload.ok) {
        setError(
          payload.ok ? "The Bridge could not update monitoring." : payload.error,
        );
        return;
      }

      if (payload.library) {
        replaceLibrary(payload.library);
      }

      setNotice(payload.message ?? message);
      router.refresh();
    } catch {
      setError("The Bridge could not update monitoring right now.");
    } finally {
      setBusyId(null);
      setMonitoringAction(null);
    }
  }

  function openDisconnectDialog(library: ConnectedLibrarySummary) {
    lastFocusedControlRef.current = document.activeElement as HTMLElement | null;
    setDisconnectCandidate(library);
  }

  function closeDisconnectDialog() {
    setDisconnectCandidate(null);
  }

  async function disconnectLibrary(library: ConnectedLibrarySummary) {
    closeDisconnectDialog();

    setBusyId(library.id);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/bridge/connected-libraries/${encodeURIComponent(
          library.id,
        )}/disconnect`,
        {
          method: "POST",
        },
      );
      const payload = await readLibraryMutation(response);

      if (!response.ok || !payload.ok) {
        setError(payload.ok ? "The Bridge could not disconnect this folder." : payload.error);
        return;
      }

      replaceLibrary(payload.library);
      setNotice("Folder disconnected. Local files were not changed.");
      router.refresh();
    } catch {
      setError("The Bridge could not disconnect this folder right now.");
    } finally {
      setBusyId(null);
    }
  }

  async function hideHistoricalConnection(library: ConnectedLibrarySummary) {
    if (
      !window.confirm(
        "Keep history and remove this connection from the normal list?",
      )
    ) {
      return;
    }

    setBusyId(library.id);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/bridge/connected-libraries/${encodeURIComponent(
          library.id,
        )}/hide`,
        {
          method: "POST",
        },
      );
      const payload = await readLibraryMutation(response);

      if (!response.ok || !payload.ok) {
        setError(payload.ok ? "The Bridge could not remove this connection." : payload.error);
        return;
      }

      replaceLibrary(payload.library);
      setNotice("Connection removed from the normal list. History remains.");
      router.refresh();
    } catch {
      setError("The Bridge could not remove this connection right now.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="grid min-w-0 gap-6" aria-live="polite">
      <NsnCard className="min-w-0" tone={bridgeHealth.ok ? "aqua" : "sand"}>
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="min-w-0">
            <NsnBadge tone={bridgeHealth.ok ? "approved" : "pending"}>
              {bridgeHealth.ok ? "Bridge ready" : "Bridge unavailable"}
            </NsnBadge>
            <h2 className="nsn-display mt-3 break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
              {bridgeHealth.ok
                ? activeLibraries.length === 0
                  ? "Choose the folders you would like the Librarian to understand."
                  : "Connected Libraries"
                : "The NSN Bridge is not running."}
            </h2>
            <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              {bridgeHealth.ok
                ? "The local computer remains the source of truth. The Librarian stores knowledge work and history, not copied files."
                : "Open the NSN Bridge on this computer to choose and watch local folders."}
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row lg:justify-end">
            {!bridgeHealth.ok ? (
              <a
                className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] [overflow-wrap:anywhere]"
                href="nsn-bridge://open"
              >
                Open Bridge
              </a>
            ) : (
              <NsnButton
                disabled={busyId === "picker"}
                onClick={() => void chooseFolder()}
                type="button"
                variant="primary"
              >
                {busyId === "picker"
                  ? "Choosing..."
                  : selectionBasket.length > 0
                    ? "Add Another Folder"
                    : "Choose Folders"}
              </NsnButton>
            )}
            <NsnButton
              disabled={busyId === "status"}
              onClick={() => void refreshBridgeStatus()}
              type="button"
              variant="secondary"
            >
              Retry Connection
            </NsnButton>
          </div>
        </div>
        <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
              Bridge Currently Reachable
            </p>
            <p className="mt-1 font-semibold text-[var(--nsn-navy)]">
              {bridgeHealth.ok ? "Yes" : "No"}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
              Folders Actively Connected
            </p>
            <p className="mt-1 font-semibold text-[var(--nsn-navy)]">
              {activeLibraries.length}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
              Watching
            </p>
            <p className="mt-1 font-semibold text-[var(--nsn-navy)]">
              {watchingLibraries.length}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
              Previous Connections
            </p>
            <p className="mt-1 font-semibold text-[var(--nsn-navy)]">
              {historicalLibraries.length}
            </p>
          </div>
        </div>
      </NsnCard>

      {selectionBasket.length > 0 ? (
        <NsnCard className="min-w-0" tone="aqua">
          <div className="grid min-w-0 gap-5">
            <div className="min-w-0">
              <NsnBadge tone="pending">Review selected folders</NsnBadge>
              <h2 className="nsn-display mt-3 break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                Review Selected Folders
              </h2>
              <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                {selectionBasket.length} folders are ready for review. Each one
                will become its own connected library with separate permissions,
                scan sessions, recommendations, monitoring state, plans,
                execution history, and undo history.
              </p>
            </div>

            {duplicateSelectionRoots.length > 0 ? (
              <p
                className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-warning)]"
                role="alert"
              >
                Remove duplicate folders from the selection before connecting.
              </p>
            ) : null}

            {selectionOverlaps.length > 0 ? (
              <div className="grid min-w-0 gap-3 rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3">
                <p className="break-words text-sm font-semibold text-[var(--nsn-warning)] [overflow-wrap:anywhere]">
                  These folders overlap. Connecting both may scan the same files
                  twice.
                </p>
                <div className="grid min-w-0 gap-3">
                  {selectionOverlaps.map((overlap) => {
                    const existingParent = currentLibraries.find(
                      (library) => library.bridgeRootId === overlap.parentRootId,
                    );

                    return (
                      <div
                        className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-3"
                        key={`${overlap.parentRootId}:${overlap.childRootId}`}
                      >
                        <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                          <span className="font-semibold">
                            {overlap.parentLabel}
                          </span>{" "}
                          contains{" "}
                          <span className="font-semibold">
                            {overlap.childLabel}
                          </span>
                          .
                        </p>
                        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
                          {overlap.source === "existing-library" ? (
                            <>
                              {existingParent ? (
                                <Link
                                  className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                                  href={`#connected-library-${existingParent.id}`}
                                >
                                  Open Existing Connection
                                </Link>
                              ) : null}
                              <NsnButton
                                onClick={() =>
                                  removeSelectedFolder(overlap.childRootId)
                                }
                                type="button"
                                variant="secondary"
                              >
                                Remove Child from Selection
                              </NsnButton>
                            </>
                          ) : (
                            <>
                              <NsnButton
                                onClick={() =>
                                  keepParentOnly(
                                    overlap.parentRootId,
                                    overlap.childRootId,
                                  )
                                }
                                type="button"
                                variant="secondary"
                              >
                                Keep Parent Only
                              </NsnButton>
                              <NsnButton
                                onClick={() =>
                                  keepChildOnly(
                                    overlap.parentRootId,
                                    overlap.childRootId,
                                  )
                                }
                                type="button"
                                variant="secondary"
                              >
                                Keep Child Only
                              </NsnButton>
                            </>
                          )}
                          <NsnButton
                            disabled={
                              confirmedOverlapRootIdSet.has(
                                overlap.parentRootId,
                              ) &&
                              confirmedOverlapRootIdSet.has(overlap.childRootId)
                            }
                            onClick={confirmAllOverlaps}
                            type="button"
                            variant="primary"
                          >
                            Connect Both
                          </NsnButton>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="grid min-w-0 gap-4 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-[var(--nsn-navy)]">
                  Apply the same permissions to all folders
                </h3>
                <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  Use these as common defaults, then adjust individual folders
                  below.
                </p>
              </div>
              <div className="grid min-w-0 gap-3 xl:grid-cols-3">
                {permissionSections.map((section) => (
                  <div
                    className="grid min-w-0 content-start gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3"
                    key={section.title}
                  >
                    <h4 className="text-sm font-semibold text-[var(--nsn-navy)]">
                      {section.title}
                    </h4>
                    {section.permissions.map((permission) => (
                      <label
                        className="grid min-w-0 gap-2 text-sm text-[var(--nsn-navy)]"
                        key={permission.key}
                      >
                        <span className="flex min-w-0 items-start gap-3">
                          <input
                            checked={sharedSelectionPermissions[permission.key]}
                            className="mt-1 h-4 w-4 shrink-0"
                            onChange={(event) =>
                              setSharedSelectionPermissions((current) => ({
                                ...current,
                                [permission.key]: event.target.checked,
                              }))
                            }
                            type="checkbox"
                          />
                          <span className="min-w-0">
                            <span className="block break-words font-semibold [overflow-wrap:anywhere]">
                              {permission.label}
                            </span>
                            <span className="mt-1 block break-words text-xs leading-5 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                              {permission.description}
                            </span>
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
              <NsnButton
                className="w-full sm:w-fit"
                onClick={applySharedSelectionPermissions}
                type="button"
                variant="secondary"
              >
                Apply Permissions to All Selected Folders
              </NsnButton>
            </div>

            <div className="grid min-w-0 gap-4">
              {selectionBasket.map((item) => (
                <div
                  className="grid min-w-0 gap-4 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-4"
                  key={item.selection.rootId}
                >
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <NsnBadge tone={selectionBadgeTone(item)}>
                        {selectionAvailabilityLabel(item)}
                      </NsnBadge>
                      <p className="mt-3 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                        {item.selection.safeLocation}
                      </p>
                    </div>
                    <NsnButton
                      onClick={() => removeSelectedFolder(item.selection.rootId)}
                      type="button"
                      variant="secondary"
                    >
                      Remove from Selection
                    </NsnButton>
                  </div>

                  <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
                    Suggested display name
                    <input
                      className="min-h-11 min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-sm text-[var(--nsn-navy)]"
                      onChange={(event) =>
                        updateSelectedFolder(item.selection.rootId, (current) => ({
                          ...current,
                          displayName: event.target.value,
                        }))
                      }
                      value={item.displayName}
                    />
                  </label>

                  {item.existingLibrary ? (
                    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
                      <Link
                        className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                        href={`#connected-library-${item.existingLibrary.id}`}
                      >
                        Open Existing Connection
                      </Link>
                      <NsnButton
                        onClick={() =>
                          setNotice(
                            "Connecting selected folders will update permissions for already connected folders.",
                          )
                        }
                        type="button"
                        variant="secondary"
                      >
                        Update Permissions
                      </NsnButton>
                    </div>
                  ) : null}

                  <fieldset className="grid min-w-0 gap-3">
                    <legend className="text-sm font-semibold text-[var(--nsn-navy)]">
                      Permission controls
                    </legend>
                    <div className="grid min-w-0 gap-3 xl:grid-cols-3">
                      {permissionSections.map((section) => (
                        <div
                          className="grid min-w-0 content-start gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-3"
                          key={section.title}
                        >
                          <h4 className="text-sm font-semibold text-[var(--nsn-navy)]">
                            {section.title}
                          </h4>
                          {section.permissions.map((permission) => (
                            <label
                              className="grid min-w-0 gap-2 text-sm text-[var(--nsn-navy)]"
                              key={permission.key}
                            >
                              <span className="flex min-w-0 items-start gap-3">
                                <input
                                  checked={item.permissions[permission.key]}
                                  className="mt-1 h-4 w-4 shrink-0"
                                  onChange={(event) =>
                                    updateSelectedFolder(
                                      item.selection.rootId,
                                      (current) => ({
                                        ...current,
                                        permissions: {
                                          ...current.permissions,
                                          [permission.key]: event.target.checked,
                                        },
                                      }),
                                    )
                                  }
                                  type="checkbox"
                                />
                                <span className="min-w-0">
                                  <span className="block break-words font-semibold [overflow-wrap:anywhere]">
                                    {permission.label}
                                  </span>
                                  <span className="mt-1 block break-words text-xs leading-5 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                                    {permission.description}
                                  </span>
                                </span>
                              </span>
                            </label>
                          ))}
                        </div>
                      ))}
                    </div>
                  </fieldset>
                </div>
              ))}
            </div>

            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
              <NsnButton
                disabled={busyId === "connect"}
                onClick={() => void chooseFolder()}
                type="button"
                variant="secondary"
              >
                Add Another Folder
              </NsnButton>
              <NsnButton
                disabled={busyId === "connect"}
                onClick={clearSelectionBasket}
                type="button"
                variant="secondary"
              >
                Clear Selection
              </NsnButton>
              <NsnButton
                disabled={
                  busyId === "connect" ||
                  duplicateSelectionRoots.length > 0 ||
                  hasBlockingSelectionOverlaps
                }
                onClick={() => void connectSelectedFolders()}
                type="button"
                variant="primary"
              >
                {busyId === "connect"
                  ? "Connecting Selected Folders..."
                  : "Connect Selected Folders"}
              </NsnButton>
            </div>
          </div>
        </NsnCard>
      ) : null}

      {notice ? (
        <p className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-teal-dark)]">
          {notice}
        </p>
      ) : null}

      {error ? (
        <p
          className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-warning)]"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <ConnectedLibraryBatchPanel
        currentLibraries={currentLibraries}
        onLibraryChanged={replaceLibrary}
        permissionGroups={permissionGroups}
      />

      <div className="grid min-w-0 gap-6">
        {[
          {
            description:
              "Folders currently available through the local Bridge.",
                libraries: currentLibraries,
            title: "Active Connections",
          },
          {
            description:
              "Disconnected or legacy folders whose history is still preserved.",
            libraries: historicalLibraries,
            title: "Previous Connections",
          },
        ].map((section) =>
          section.libraries.length > 0 ? (
            <section className="grid min-w-0 gap-4" key={section.title}>
              <div className="min-w-0">
                <h2 className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                  {section.title}
                </h2>
                <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  {section.description}
                </p>
              </div>
              <div className="grid min-w-0 gap-4">
        {section.libraries.map((library) => {
          const isBusy = busyId === library.id;
          const isPrevious = section.title === "Previous Connections";
          const canUse =
            library.bridgeReachable &&
            !library.requiresReconnect &&
            library.status === "CONNECTED";
          const canScan = canUse && library.readPermission;
          const canWatch = canUse && library.readPermission && library.watchPermission;
          const monitoringBusy = monitoringAction?.libraryId === library.id;

          return (
            <NsnCard
              className="min-w-0 scroll-mt-6"
              id={`connected-library-${library.id}`}
              key={library.id}
            >
              <div className="grid min-w-0 gap-5">
                <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <NsnBadge tone={statusTone(library)}>
                      {statusLabel(library)}
                    </NsnBadge>
                    <h3 className="nsn-display mt-3 break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                      {library.displayName}
                    </h3>
                    <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {library.safeLocalLocation}
                    </p>
                  </div>
                  <NsnBadge tone={library.watchPermission ? "approved" : "pending"}>
                    {monitoringLabel(library)}
                  </NsnBadge>
                </div>

                {library.requiresReconnect ? (
                  <p className="rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3 text-sm leading-6 text-[var(--nsn-slate)]">
                    Reconnect this folder through the NSN Bridge to resume
                    scanning or watching. History, Notebook entries, Memory,
                    recommendations, plans, execution, and undo records remain.
                  </p>
                ) : null}

                <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                      Scan Sessions
                    </p>
                    <p className="mt-1 font-semibold text-[var(--nsn-navy)]">
                      {library.scanSessionCount}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                      Recent Changes
                    </p>
                    <p className="mt-1 font-semibold text-[var(--nsn-navy)]">
                      {library.recentChangeCount}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                      Need Attention
                    </p>
                    <p className="mt-1 font-semibold text-[var(--nsn-navy)]">
                      {library.itemsNeedingAttention}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                      Platform
                    </p>
                    <p className="mt-1 font-semibold text-[var(--nsn-navy)]">
                      {library.platform.toLowerCase()}
                    </p>
                  </div>
                </div>

                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                    Permission Summary
                  </p>
                  <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                    {permissionSummary(library)}
                  </p>
                </div>

                <div className="grid min-w-0 gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                      Monitoring Status
                    </p>
                    <p className="mt-1 break-words text-sm font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                      {monitoringLabel(library)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                      Started
                    </p>
                    <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {formatDateTime(library.monitoringStartedAt)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                      Watcher Heartbeat
                    </p>
                    <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {formatDateTime(library.monitoringHeartbeatAt)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                      Last Detected Change
                    </p>
                    <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {formatDateTime(library.lastDetectedChangeAt)}
                    </p>
                  </div>
                  {monitoringErrorLabel(library.monitoringErrorCategory) ? (
                    <p className="break-words text-sm leading-6 text-[var(--nsn-warning)] [overflow-wrap:anywhere] sm:col-span-2 xl:col-span-4">
                      {monitoringErrorLabel(library.monitoringErrorCategory)}
                    </p>
                  ) : null}
                </div>

                <form
                  className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const formData = new FormData(event.currentTarget);
                    void patchLibrary(
                      library.id,
                      {
                        displayName: String(formData.get("displayName") ?? ""),
                      },
                      "Display name updated.",
                    );
                  }}
                >
                  <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
                    Display name
                    <input
                      className="min-h-11 min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-sm text-[var(--nsn-navy)]"
                      defaultValue={library.displayName}
                      disabled={library.requiresReconnect}
                      name="displayName"
                    />
                  </label>
                  <NsnButton
                    disabled={isBusy || library.requiresReconnect}
                    type="submit"
                    variant="secondary"
                  >
                    Rename Display Name
                  </NsnButton>
                </form>

                <fieldset className="grid min-w-0 gap-3">
                  <legend className="text-sm font-semibold text-[var(--nsn-navy)]">
                    Edit Permissions
                  </legend>
                  <div className="grid min-w-0 gap-3 xl:grid-cols-3">
                    {permissionSections.map((section) => (
                      <div
                        className="grid min-w-0 content-start gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3"
                        key={section.title}
                      >
                        <h4 className="text-sm font-semibold text-[var(--nsn-navy)]">
                          {section.title}
                        </h4>
                        {section.permissions.map((permission) => (
                          <label
                            className="grid min-w-0 gap-2 text-sm text-[var(--nsn-navy)]"
                            key={permission.key}
                          >
                            <span className="flex min-w-0 items-start gap-3">
                              <input
                                checked={library[permission.key]}
                                className="mt-1 h-4 w-4 shrink-0"
                                disabled={isBusy || library.requiresReconnect}
                                onChange={(event) =>
                                  patchLibrary(
                                    library.id,
                                    {
                                      [permission.key]: event.target.checked,
                                    },
                                    "Permissions updated.",
                                  )
                                }
                                type="checkbox"
                              />
                              <span className="min-w-0">
                                <span className="block break-words font-semibold [overflow-wrap:anywhere]">
                                  {permission.label}
                                </span>
                                <span className="mt-1 block break-words text-xs leading-5 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                                  {permission.description}
                                </span>
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    ))}
                  </div>
                </fieldset>

                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
                  {isPrevious ? (
                    <>
                      <NsnButton
                        disabled={busyId === "picker" || isBusy}
                        onClick={() => {
                          setNotice(
                            "Choose the same folder to reconnect this history.",
                          );
                          void chooseFolder();
                        }}
                        type="button"
                        variant="primary"
                      >
                        Reconnect Folder
                      </NsnButton>
                      <Link
                        className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                        href={getScanSessionsRoute()}
                      >
                        View History
                      </Link>
                      <NsnButton
                        disabled={isBusy}
                        onClick={() => void hideHistoricalConnection(library)}
                        type="button"
                        variant="secondary"
                      >
                        Keep History and Remove Connection
                      </NsnButton>
                    </>
                  ) : (
                    <>
                  {canScan ? (
                    <BridgeScanControl
                      connectedLibraryId={library.id}
                      isDevelopment={false}
                      scanLabel="Scan Now"
                    />
                  ) : (
                    <NsnButton disabled type="button" variant="secondary">
                      Scan Now
                    </NsnButton>
                  )}
                  {library.monitoringState === "WATCHING" ? (
                    <NsnButton
                      disabled={isBusy}
                      onClick={() =>
                        monitoringCommand(
                          library,
                          `/api/bridge/monitor/${encodeURIComponent(
                            library.id,
                          )}/pause`,
                          "Watching paused.",
                          "pause",
                        )
                      }
                      type="button"
                      variant="secondary"
                    >
                      {monitoringBusy && monitoringAction.action === "pause"
                        ? "Pausing..."
                        : "Pause Watching"}
                    </NsnButton>
                  ) : (
                    <NsnButton
                      disabled={isBusy || !canWatch}
                      onClick={() =>
                        monitoringCommand(
                          library,
                          `/api/bridge/monitor/${encodeURIComponent(
                            library.id,
                          )}/${
                            library.monitoringState === "PAUSED"
                              ? "resume"
                              : "start"
                          }`,
                          library.monitoringState === "PAUSED"
                            ? "Watching resumed."
                            : "Watching started.",
                          library.monitoringState === "PAUSED"
                            ? "resume"
                            : "start",
                        )
                      }
                      type="button"
                      variant="primary"
                    >
                      {monitoringBusy
                        ? monitoringAction.action === "resume"
                          ? "Resuming..."
                          : "Starting..."
                        : library.monitoringState === "PAUSED"
                          ? "Resume Watching"
                          : "Start Watching"}
                    </NsnButton>
                  )}
                  <Link
                    className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                    href={getScanSessionsRoute()}
                  >
                    View Scan Sessions
                  </Link>
                  <Link
                    className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                    href="/admin/library/review"
                  >
                    Review Recommendations
                  </Link>
                  <Link
                    className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                    href={getBridgeMonitoringRoute()}
                  >
                    Monitoring Activity
                  </Link>
                  {library.isEnabled && !library.requiresReconnect ? (
                    <NsnButton
                      disabled={isBusy}
                      onClick={() => openDisconnectDialog(library)}
                      type="button"
                      variant="secondary"
                    >
                      Disconnect Folder
                    </NsnButton>
                  ) : null}
                    </>
                  )}
                </div>
              </div>
            </NsnCard>
          );
        })}
              </div>
            </section>
          ) : null,
        )}
      </div>

      {disconnectCandidate ? (
        <div
          aria-labelledby="disconnect-folder-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid min-w-0 place-items-center overflow-y-auto bg-[rgba(16,24,40,0.42)] p-4"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeDisconnectDialog();
            }
          }}
          role="dialog"
        >
          <div className="grid max-h-[calc(100vh-2rem)] w-full max-w-lg min-w-0 gap-5 overflow-y-auto rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-5 shadow-xl">
            <div className="min-w-0">
              <h2
                className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
                id="disconnect-folder-title"
              >
                Disconnect this folder?
              </h2>
              <p className="mt-3 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                The Librarian will stop scanning and watching this folder. Your
                local files will not be changed or deleted. Existing Notebook,
                Memory, recommendations, plans, organization history, and
                Knowledge Graph provenance will remain available.
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:justify-end">
              <NsnButton
                onClick={closeDisconnectDialog}
                ref={disconnectCancelRef}
                type="button"
                variant="secondary"
              >
                Cancel
              </NsnButton>
              <NsnButton
                disabled={busyId === disconnectCandidate.id}
                onClick={() => void disconnectLibrary(disconnectCandidate)}
                type="button"
                variant="primary"
              >
                Disconnect Folder
              </NsnButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
