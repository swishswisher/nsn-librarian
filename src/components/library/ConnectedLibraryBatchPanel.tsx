"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { NsnBadge } from "@/components/library/NsnBadge";
import { NsnButton } from "@/components/library/NsnButton";
import { NsnCard } from "@/components/library/NsnCard";
import {
  getRecommendationsRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";
import type {
  BridgeBatchScanApiResponse,
  BridgeMonitoringApiResponse,
  BridgeScanApiResponse,
  BridgeScanProcessingProgress,
  BridgeScanSessionSummary,
  ConnectedLibraryMutationResponse,
  ConnectedLibraryPermissions,
  ConnectedLibrarySummary,
} from "@/lib/bridge/types";

type PermissionControl = {
  description: string;
  key: keyof ConnectedLibraryPermissions;
  label: string;
};

type ConnectedLibraryBatchPanelProps = {
  currentLibraries: ConnectedLibrarySummary[];
  onLibraryChanged: (library: ConnectedLibrarySummary) => void;
  permissionGroups: PermissionControl[];
};

type BatchScanRow = {
  connectedLibraryId: string;
  displayName: string;
  error: string | null;
  progress: BridgeScanProcessingProgress | null;
  session: BridgeScanSessionSummary | null;
};

const terminalStatuses = new Set<string>([
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELLED",
]);
const progressPollDelayMs = 1200;

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

function stageLabel(progress: BridgeScanProcessingProgress | null) {
  if (!progress) {
    return "Waiting";
  }

  if (progress.currentStage === "SCANNING") {
    return "Scanning files";
  }

  if (progress.currentStage === "READING") {
    return "Reading library items";
  }

  if (progress.currentStage === "EXAMINING") {
    return "Preparing observations";
  }

  if (progress.currentStage === "GENERATING_SUGGESTIONS") {
    return "Preparing recommendations";
  }

  if (progress.currentStage === "COMPLETED_WITH_ERRORS") {
    return "Completed with items needing attention";
  }

  if (progress.currentStage === "COMPLETED") {
    return "Completed";
  }

  if (progress.currentStage === "FAILED") {
    return "Needs attention";
  }

  return "Preparing scan";
}

function isTerminalProgress(progress: BridgeScanProcessingProgress | null) {
  return Boolean(progress && terminalStatuses.has(progress.currentStage));
}

async function readBatchScanResponse(response: Response) {
  try {
    return (await response.json()) as BridgeBatchScanApiResponse;
  } catch {
    return {
      ok: false,
      error: "The Librarian could not read the batch scan response.",
    } satisfies BridgeBatchScanApiResponse;
  }
}

async function readScanResponse(response: Response) {
  try {
    return (await response.json()) as BridgeScanApiResponse;
  } catch {
    return {
      ok: false,
      error: "The Librarian could not read scan progress.",
    } satisfies BridgeScanApiResponse;
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

async function readMonitoringResponse(response: Response) {
  try {
    return (await response.json()) as BridgeMonitoringApiResponse;
  } catch {
    return {
      ok: false,
      error: "The Bridge could not read the monitoring response.",
    } satisfies BridgeMonitoringApiResponse;
  }
}

export function ConnectedLibraryBatchPanel({
  currentLibraries,
  onLibraryChanged,
  permissionGroups,
}: ConnectedLibraryBatchPanelProps) {
  const processingSessionIdsRef = useRef(new Set<string>());
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([]);
  const [batchRows, setBatchRows] = useState<Record<string, BatchScanRow>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPermissionEditor, setShowPermissionEditor] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [sharedPermissions, setSharedPermissions] =
    useState<ConnectedLibraryPermissions>({
      createFolderPermission: false,
      moveFilePermission: false,
      organizationPlanPermission: true,
      readPermission: true,
      recommendationPermission: true,
      renameFilePermission: false,
      watchPermission: false,
    });

  const selectableIds = useMemo(
    () => currentLibraries.map((library) => library.id),
    [currentLibraries],
  );
  const selectedLibraries = useMemo(
    () =>
      currentLibraries.filter((library) =>
        selectedLibraryIds.includes(library.id),
      ),
    [currentLibraries, selectedLibraryIds],
  );
  const selectedCurrentIds = useMemo(
    () => selectedLibraryIds.filter((id) => selectableIds.includes(id)),
    [selectableIds, selectedLibraryIds],
  );
  const selectedCount = selectedLibraries.length;
  const allSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedLibraryIds.includes(id));
  const rows = Object.values(batchRows);
  const activeRowCount = rows.filter(
    (row) => row.progress?.isActive && !isTerminalProgress(row.progress),
  ).length;

  function toggleSelected(libraryId: string) {
    setSelectedLibraryIds((current) =>
      current.includes(libraryId)
        ? current.filter((id) => id !== libraryId)
        : [...current, libraryId],
    );
  }

  function selectedIdsOrAll() {
    return selectedCurrentIds.length > 0 ? selectedCurrentIds : selectableIds;
  }

  async function scanLibraries(libraryIds: string[]) {
    if (libraryIds.length === 0) {
      setError("Select at least one connected library before scanning.");
      return;
    }

    setBusyAction("scan");
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/bridge/scan/batch", {
        body: JSON.stringify({ connectedLibraryIds: libraryIds }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = await readBatchScanResponse(response);

      if (!response.ok || !payload.ok) {
        setError(
          payload.ok
            ? "The Librarian could not start the selected folder scans."
            : payload.error,
        );
        return;
      }

      setBatchRows((current) => {
        const next = { ...current };

        for (const result of payload.results) {
          next[result.connectedLibraryId] = {
            connectedLibraryId: result.connectedLibraryId,
            displayName: result.displayName,
            error: result.error ?? null,
            progress: result.progress,
            session: result.session,
          };
        }

        return next;
      });
      setNotice(
        `${payload.startedCount} folder scans started. ${payload.failedCount} folders need attention.`,
      );
    } catch {
      setError("The Librarian could not start the selected folder scans.");
    } finally {
      setBusyAction(null);
    }
  }

  const processBatchRow = useCallback(
    async (row: BatchScanRow, retryFailed = false) => {
      if (!row.session || processingSessionIdsRef.current.has(row.session.id)) {
        return;
      }

      processingSessionIdsRef.current.add(row.session.id);

      try {
        const response = await fetch(
          `/api/bridge/scan-sessions/${encodeURIComponent(row.session.id)}/process`,
          {
            body: retryFailed
              ? JSON.stringify({
                  retryFailed: true,
                  retryStartedAt: new Date().toISOString(),
                })
              : null,
            headers: {
              "Content-Type": "application/json",
            },
            method: "POST",
          },
        );
        const payload = await readScanResponse(response);

        if (!response.ok || !payload.ok) {
          throw new Error(
            payload.ok ? "Processing stopped unexpectedly." : payload.error,
          );
        }

        setBatchRows((current) => ({
          ...current,
          [row.connectedLibraryId]: {
            ...current[row.connectedLibraryId],
            connectedLibraryId: row.connectedLibraryId,
            displayName: row.displayName,
            error: null,
            progress: payload.progress,
            session: payload.session,
          },
        }));
      } catch {
        setBatchRows((current) => ({
          ...current,
          [row.connectedLibraryId]: {
            ...current[row.connectedLibraryId],
            connectedLibraryId: row.connectedLibraryId,
            displayName: row.displayName,
            error: "Processing stopped unexpectedly for this folder.",
            progress: row.progress,
            session: row.session,
          },
        }));
      } finally {
        if (row.session) {
          processingSessionIdsRef.current.delete(row.session.id);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const activeRows = Object.values(batchRows).filter(
      (row) =>
        row.session &&
        row.progress?.isActive &&
        !row.progress.isStale &&
        !isTerminalProgress(row.progress) &&
        !row.error,
    );

    if (activeRows.length === 0) {
      return;
    }

    const timeout = window.setTimeout(() => {
      for (const row of activeRows) {
        void processBatchRow(row);
      }
    }, progressPollDelayMs);

    return () => window.clearTimeout(timeout);
  }, [batchRows, processBatchRow]);

  async function monitorLibraries(action: "pause" | "start") {
    if (selectedCount === 0) {
      setError("Select at least one connected library first.");
      return;
    }

    setBusyAction(action);
    setError(null);
    setNotice(null);

    let successCount = 0;
    let failedCount = 0;

    for (const library of selectedLibraries) {
      try {
        const response = await fetch(
          `/api/bridge/monitor/${encodeURIComponent(library.id)}/${action}`,
          {
            body: JSON.stringify({ connectedLibraryId: library.id }),
            headers: {
              "Content-Type": "application/json",
            },
            method: "POST",
          },
        );
        const payload = await readMonitoringResponse(response);

        if (!response.ok || !payload.ok) {
          failedCount += 1;
          continue;
        }

        if (payload.library) {
          onLibraryChanged(payload.library);
        }

        successCount += 1;
      } catch {
        failedCount += 1;
      }
    }

    setBusyAction(null);
    setNotice(
      `${successCount} folders updated. ${failedCount} folders need attention.`,
    );
  }

  async function applySharedPermissions() {
    if (selectedCount === 0) {
      setError("Select at least one connected library first.");
      return;
    }

    setBusyAction("permissions");
    setError(null);
    setNotice(null);

    let successCount = 0;
    let failedCount = 0;

    for (const library of selectedLibraries) {
      try {
        const response = await fetch(
          `/api/bridge/connected-libraries/${encodeURIComponent(library.id)}`,
          {
            body: JSON.stringify(sharedPermissions),
            headers: {
              "Content-Type": "application/json",
            },
            method: "PATCH",
          },
        );
        const payload = await readLibraryMutation(response);

        if (!response.ok || !payload.ok) {
          failedCount += 1;
          continue;
        }

        onLibraryChanged(payload.library);
        successCount += 1;
      } catch {
        failedCount += 1;
      }
    }

    setBusyAction(null);
    setShowPermissionEditor(false);
    setNotice(
      `${successCount} folders updated. ${failedCount} folders need attention.`,
    );
  }

  async function disconnectSelected() {
    if (selectedCount === 0) {
      setError("Select at least one connected library first.");
      return;
    }

    setShowDisconnectConfirm(false);
    setBusyAction("disconnect");
    setError(null);
    setNotice(null);

    let successCount = 0;
    let failedCount = 0;

    for (const library of selectedLibraries) {
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
          failedCount += 1;
          continue;
        }

        onLibraryChanged(payload.library);
        successCount += 1;
      } catch {
        failedCount += 1;
      }
    }

    setBusyAction(null);
    setSelectedLibraryIds([]);
    setNotice(
      `${successCount} folders disconnected. ${failedCount} folders need attention. Local files were not changed.`,
    );
  }

  if (currentLibraries.length === 0) {
    return null;
  }

  return (
    <NsnCard className="min-w-0" tone="aqua">
      <div className="grid min-w-0 gap-5">
        <div className="min-w-0">
          <NsnBadge tone="approved">Batch controls</NsnBadge>
          <h2 className="nsn-display mt-3 break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
            Work with several connected folders.
          </h2>
          <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            Each selected folder keeps its own permissions, scan session,
            recommendations, monitoring state, plans, execution history, and
            undo history.
          </p>
        </div>

        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
          <NsnButton
            disabled={allSelected}
            onClick={() => setSelectedLibraryIds(selectableIds)}
            type="button"
            variant="secondary"
          >
            Select All
          </NsnButton>
          <NsnButton
            disabled={selectedCount === 0}
            onClick={() => setSelectedLibraryIds([])}
            type="button"
            variant="secondary"
          >
            Select None
          </NsnButton>
          <NsnButton
            disabled={selectedCount === 0 || busyAction === "scan"}
            onClick={() => void scanLibraries(selectedCurrentIds)}
            type="button"
            variant="primary"
          >
            {busyAction === "scan" ? "Starting Scans..." : "Scan Selected"}
          </NsnButton>
          <NsnButton
            disabled={busyAction === "scan"}
            onClick={() => void scanLibraries(selectedIdsOrAll())}
            type="button"
            variant="secondary"
          >
            Scan All Connected Libraries
          </NsnButton>
          <NsnButton
            disabled={selectedCount === 0 || busyAction === "start"}
            onClick={() => void monitorLibraries("start")}
            type="button"
            variant="secondary"
          >
            Start Watching Selected
          </NsnButton>
          <NsnButton
            disabled={selectedCount === 0 || busyAction === "pause"}
            onClick={() => void monitorLibraries("pause")}
            type="button"
            variant="secondary"
          >
            Pause Watching Selected
          </NsnButton>
          <NsnButton
            disabled={selectedCount === 0}
            onClick={() => setShowPermissionEditor((current) => !current)}
            type="button"
            variant="secondary"
          >
            Edit Shared Permissions
          </NsnButton>
          <NsnButton
            disabled={selectedCount === 0 || busyAction === "disconnect"}
            onClick={() => setShowDisconnectConfirm(true)}
            type="button"
            variant="secondary"
          >
            Disconnect Selected
          </NsnButton>
        </div>

        <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {currentLibraries.map((library) => (
            <label
              className="flex min-w-0 items-start gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3 text-sm text-[var(--nsn-navy)]"
              key={library.id}
            >
              <input
                checked={selectedLibraryIds.includes(library.id)}
                className="mt-1 h-4 w-4 shrink-0"
                onChange={() => toggleSelected(library.id)}
                type="checkbox"
              />
              <span className="min-w-0">
                <span className="block break-words font-semibold [overflow-wrap:anywhere]">
                  {library.displayName}
                </span>
                <span className="mt-1 block break-words text-xs leading-5 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  {library.safeLocalLocation}
                </span>
              </span>
            </label>
          ))}
        </div>

        {showPermissionEditor ? (
          <div className="grid min-w-0 gap-4 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-[var(--nsn-navy)]">
                Apply shared permissions to {selectedCount} selected folders.
              </h3>
              <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                Individual folder history remains separate. These settings only
                update the selected connected folders.
              </p>
            </div>
            <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {permissionGroups.map((permission) => (
                <label
                  className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3 text-sm text-[var(--nsn-navy)]"
                  key={permission.key}
                >
                  <span className="flex min-w-0 items-start gap-3">
                    <input
                      checked={sharedPermissions[permission.key]}
                      className="mt-1 h-4 w-4 shrink-0"
                      onChange={(event) =>
                        setSharedPermissions((current) => ({
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
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
              <NsnButton
                disabled={busyAction === "permissions"}
                onClick={() => setShowPermissionEditor(false)}
                type="button"
                variant="secondary"
              >
                Cancel
              </NsnButton>
              <NsnButton
                disabled={busyAction === "permissions"}
                onClick={() => void applySharedPermissions()}
                type="button"
                variant="primary"
              >
                {busyAction === "permissions"
                  ? "Updating..."
                  : "Apply to Selected Folders"}
              </NsnButton>
            </div>
          </div>
        ) : null}

        {rows.length > 0 ? (
          <div className="grid min-w-0 gap-3">
            <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="text-base font-semibold text-[var(--nsn-navy)]">
                Batch scan progress
              </h3>
              <p className="text-sm text-[var(--nsn-slate)]">
                {activeRowCount} folders still processing
              </p>
            </div>
            <div className="grid min-w-0 gap-3">
              {rows.map((row) => (
                <div
                  className="grid min-w-0 gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3"
                  key={row.connectedLibraryId}
                >
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                        {row.displayName}
                      </p>
                      <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                        {stageLabel(row.progress)}
                      </p>
                    </div>
                    <NsnBadge
                      tone={
                        row.error
                          ? "review"
                          : isTerminalProgress(row.progress)
                            ? "approved"
                            : "pending"
                      }
                    >
                      {row.error
                        ? "Needs attention"
                        : isTerminalProgress(row.progress)
                          ? "Finished"
                          : "Processing"}
                    </NsnBadge>
                  </div>
                  {row.progress ? (
                    <div className="grid grid-cols-2 gap-2 text-sm text-[var(--nsn-navy)] sm:grid-cols-3">
                      <span>{row.progress.filesDiscovered} found</span>
                      <span>{row.progress.filesProcessed} examined</span>
                      <span>
                        {row.progress.filesWithSuggestions} recommendations
                      </span>
                      <span>{row.progress.unsupportedFiles} unsupported</span>
                      <span>{row.progress.failedFiles} need attention</span>
                      <span>{row.progress.remainingFiles} remaining</span>
                    </div>
                  ) : null}
                  {row.error ? (
                    <p className="break-words text-sm leading-6 text-[var(--nsn-warning)] [overflow-wrap:anywhere]">
                      {row.error}
                    </p>
                  ) : null}
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
                    {row.session ? (
                      <>
                        <Link
                          className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                          href={getScanSessionRoute(row.session.id)}
                        >
                          View Scan Session
                        </Link>
                        <Link
                          className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                          href={getRecommendationsRoute(row.session.id)}
                        >
                          Review Recommendations
                        </Link>
                      </>
                    ) : null}
                    <NsnButton
                      disabled={!row.session}
                      onClick={() => void processBatchRow(row, true)}
                      type="button"
                      variant="secondary"
                    >
                      Retry
                    </NsnButton>
                    <Link
                      className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                      href={`#connected-library-${row.connectedLibraryId}`}
                    >
                      Reconnect
                    </Link>
                    <NsnButton
                      onClick={() => {
                        const library = currentLibraries.find(
                          (candidate) =>
                            candidate.id === row.connectedLibraryId,
                        );

                        if (library) {
                          setSelectedLibraryIds([library.id]);
                          setSharedPermissions(permissionsFromLibrary(library));
                          setShowPermissionEditor(true);
                        }
                      }}
                      type="button"
                      variant="secondary"
                    >
                      Edit Permissions
                    </NsnButton>
                    <NsnButton
                      onClick={() =>
                        setBatchRows((current) => {
                          const next = { ...current };
                          delete next[row.connectedLibraryId];
                          return next;
                        })
                      }
                      type="button"
                      variant="secondary"
                    >
                      Remove from Batch
                    </NsnButton>
                  </div>
                </div>
              ))}
            </div>
          </div>
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

        {showDisconnectConfirm ? (
          <div
            aria-labelledby="batch-disconnect-title"
            aria-modal="true"
            className="fixed inset-0 z-50 grid min-w-0 place-items-center overflow-y-auto bg-[rgba(16,24,40,0.42)] p-4"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setShowDisconnectConfirm(false);
              }
            }}
            role="dialog"
          >
            <div className="grid max-h-[calc(100vh-2rem)] w-full max-w-lg min-w-0 gap-5 overflow-y-auto rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-5 shadow-xl">
              <div className="min-w-0">
                <h2
                  className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
                  id="batch-disconnect-title"
                >
                  Disconnect selected folders?
                </h2>
                <p className="mt-3 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  The Librarian will stop scanning and watching these connected
                  folders. Local files will not be changed or deleted. History,
                  plans, execution records, undo records, and Notebook context
                  remain available.
                </p>
              </div>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:justify-end">
                <NsnButton
                  onClick={() => setShowDisconnectConfirm(false)}
                  type="button"
                  variant="secondary"
                >
                  Cancel
                </NsnButton>
                <NsnButton
                  disabled={busyAction === "disconnect"}
                  onClick={() => void disconnectSelected()}
                  type="button"
                  variant="primary"
                >
                  Disconnect Selected
                </NsnButton>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </NsnCard>
  );
}
