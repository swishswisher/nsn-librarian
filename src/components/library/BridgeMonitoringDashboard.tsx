"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnButton } from "@/components/library/NsnButton";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import { NsnSearchField } from "@/components/library/NsnSearchField";
import {
  getConnectedLibrariesRoute,
  getNotebookEntryRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";
import type {
  BridgeMonitoringApiResponse,
  BridgeMonitoringDashboard,
  BridgeMonitoringEventSummary,
  BridgeMonitoringFolderSummary,
  BridgeMonitoringProcessingStatus,
  BridgeMonitoringState,
} from "@/lib/bridge/types";

type BridgeMonitoringDashboardProps = {
  initialDashboard: BridgeMonitoringDashboard;
};

const pollingDelayMs = 3000;

function stateTone(state: BridgeMonitoringState): NsnBadgeTone {
  if (state === "WATCHING") {
    return "approved";
  }

  if (state === "NEEDS_ATTENTION") {
    return "review";
  }

  if (state === "PAUSED") {
    return "pending";
  }

  return "source";
}

function queueStatusTone(status: BridgeMonitoringProcessingStatus): NsnBadgeTone {
  if (status === "COMPLETED") {
    return "approved";
  }

  if (status === "NEEDS_ATTENTION" || status === "FAILED") {
    return "review";
  }

  if (status === "PROCESSING") {
    return "migration";
  }

  return "pending";
}

function eventLabel(event: BridgeMonitoringEventSummary) {
  const labels: Record<BridgeMonitoringEventSummary["eventType"], string> = {
    FILE_ADDED: "File added",
    FILE_MODIFIED: "File changed",
    FILE_RENAMED: "File renamed",
    FILE_MOVED: "File moved",
    FILE_DELETED: "File unavailable",
    FOLDER_ADDED: "Folder added",
    FOLDER_RENAMED: "Folder renamed",
    FOLDER_MOVED: "Folder moved",
    FOLDER_DELETED: "Folder unavailable",
  };

  return labels[event.eventType];
}

function processingLabel(status: BridgeMonitoringProcessingStatus) {
  if (status === "QUEUED" || status === "STABILIZING") {
    return "Waiting to be examined";
  }

  if (status === "PROCESSING") {
    return "Being examined";
  }

  if (status === "COMPLETED") {
    return "Recorded";
  }

  if (status === "SKIPPED") {
    return "Recorded without reading";
  }

  return "Needs attention";
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

function pathLabel(event: BridgeMonitoringEventSummary) {
  if (
    event.previousRelativePath &&
    event.currentRelativePath &&
    event.previousRelativePath !== event.currentRelativePath
  ) {
    return `${event.previousRelativePath} -> ${event.currentRelativePath}`;
  }

  return (
    event.currentRelativePath ??
    event.previousRelativePath ??
    "Folder change recorded"
  );
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

function QueueTiles({ dashboard }: { dashboard: BridgeMonitoringDashboard }) {
  const tiles = [
    {
      label: "Waiting",
      value: dashboard.queue.queued,
    },
    {
      label: "Being Examined",
      value: dashboard.queue.processing,
    },
    {
      label: "Need Attention",
      value: dashboard.queue.needsAttention,
    },
    {
      label: "Recorded",
      value: dashboard.queue.completed,
    },
  ];

  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((tile) => (
        <NsnCard className="min-w-0 p-4" key={tile.label}>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
            {tile.label}
          </p>
          <p className="nsn-display mt-2 text-3xl text-[var(--nsn-navy)]">
            {tile.value}
          </p>
        </NsnCard>
      ))}
    </div>
  );
}

function RecentEventList({
  events,
}: {
  events: BridgeMonitoringEventSummary[];
}) {
  if (events.length === 0) {
    return (
      <NsnEmptyState
        description="Folder changes will appear here after monitoring is started."
        title="No watched changes yet"
      />
    );
  }

  return (
    <ol className="grid min-w-0 gap-3">
      {events.map((event) => (
        <li key={event.id}>
          <div className="grid min-w-0 gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <div className="min-w-0">
              <p className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                {eventLabel(event)}
              </p>
              <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                {pathLabel(event)}
              </p>
              {event.renameMoveConfidence ? (
                <p className="mt-1 text-sm leading-6 text-[var(--nsn-slate)]">
                  The Librarian inferred this move or rename from matching file
                  evidence.
                </p>
              ) : null}
              {event.safeErrorCategory ? (
                <p className="mt-1 text-sm leading-6 text-[var(--nsn-warning)]">
                  This change needs attention before it can be examined.
                </p>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-2 sm:items-end">
              <NsnBadge tone={queueStatusTone(event.processingStatus)}>
                {processingLabel(event.processingStatus)}
              </NsnBadge>
              <p className="text-xs leading-5 text-[var(--nsn-warm-gray)]">
                {formatDateTime(event.detectedAt)}
              </p>
              {event.scanSessionId ? (
                <Link
                  className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                  href={getScanSessionRoute(event.scanSessionId)}
                >
                  View Scan Session
                </Link>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function FolderCard({
  commandName,
  folder,
  onCommand,
  onStop,
}: {
  commandName: string | null;
  folder: BridgeMonitoringFolderSummary;
  onCommand: (endpoint: string, label: string, body?: unknown) => Promise<void>;
  onStop: (folder: BridgeMonitoringFolderSummary) => void;
}) {
  const isBusy = Boolean(commandName);

  return (
    <NsnCard className="min-w-0">
      <div className="grid min-w-0 gap-5">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
              {folder.displayName}
            </h2>
            <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              The local folder remains the source of truth. The Librarian keeps
              metadata, observations, recommendations, graph proposals, and
              Notebook reflections in step.
            </p>
          </div>
          <NsnBadge tone={stateTone(folder.state)}>{folder.humanState}</NsnBadge>
        </div>

        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
              Started
            </p>
            <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              {formatDateTime(folder.startedAt)}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
              Waiting
            </p>
            <p className="mt-1 font-semibold text-[var(--nsn-navy)]">
              {folder.queuedEvents}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
              Being Examined
            </p>
            <p className="mt-1 font-semibold text-[var(--nsn-navy)]">
              {folder.processingEvents}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
              Need Attention
            </p>
            <p className="mt-1 font-semibold text-[var(--nsn-navy)]">
              {folder.attentionEvents}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
              Last Heartbeat
            </p>
            <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              {formatDateTime(folder.heartbeatAt)}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
              Last Change
            </p>
            <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              {formatDateTime(folder.lastDetectedChangeAt)}
            </p>
          </div>
        </div>

        {folder.watchingAppearsStopped ? (
          <div className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-navy)]">
            <p className="font-semibold">Watching appears to have stopped.</p>
            <p className="mt-1">
              Resume watching or retry the Bridge connection before relying on
              new changes from this folder.
            </p>
          </div>
        ) : null}

        {folder.errorCategory ? (
          <div className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-warning)]">
            Monitoring needs attention before this folder can continue.
          </div>
        ) : null}

        {folder.needsReconciliation ? (
          <div className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-navy)]">
            Monitoring was restored after an interruption. A reconciliation
            check is available before the next batch is reviewed.
          </div>
        ) : null}

        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
          {folder.state === "WATCHING" ? (
            <NsnButton
              disabled={isBusy}
              onClick={() =>
                onCommand(
                  `/api/bridge/monitor/${encodeURIComponent(folder.id)}/pause`,
                  "Pausing monitoring...",
                )
              }
              type="button"
              variant="secondary"
            >
              Pause
            </NsnButton>
          ) : null}
          {folder.state === "PAUSED" ||
          folder.state === "STOPPED" ||
          folder.state === "NEEDS_ATTENTION" ? (
            <NsnButton
              disabled={isBusy}
              onClick={() =>
                onCommand(
                  `/api/bridge/monitor/${encodeURIComponent(folder.id)}/resume`,
                  "Resuming monitoring...",
                )
              }
              type="button"
              variant="primary"
            >
              Resume
            </NsnButton>
          ) : null}
          <NsnButton
            disabled={isBusy}
            onClick={() =>
              onCommand(
                `/api/bridge/monitor/${encodeURIComponent(folder.id)}/reconcile`,
                "Checking folder...",
              )
            }
            type="button"
            variant="accent"
          >
            Reconcile Folder
          </NsnButton>
          <NsnButton
            disabled={isBusy || folder.queuedEvents === 0}
            onClick={() =>
              onCommand("/api/bridge/monitor/process", "Processing changes...", {
                connectedLibraryId: folder.id,
              })
            }
            type="button"
            variant="primary"
          >
            Process Queue
          </NsnButton>
          <NsnButton
            disabled={isBusy || folder.attentionEvents === 0}
            onClick={() =>
              onCommand("/api/bridge/monitor/process", "Retrying changes...", {
                connectedLibraryId: folder.id,
                retryAttention: true,
              })
            }
            type="button"
            variant="secondary"
          >
            Retry Attention Items
          </NsnButton>
          {folder.state !== "STOPPED" ? (
            <NsnButton
              disabled={isBusy}
              onClick={() => onStop(folder)}
              type="button"
              variant="secondary"
            >
              Stop
            </NsnButton>
          ) : null}
        </div>

        {folder.recentEvents.length > 0 ? (
          <div className="grid min-w-0 gap-3">
            <h3 className="nsn-display text-xl text-[var(--nsn-navy)]">
              Recent Changes
            </h3>
            <RecentEventList events={folder.recentEvents} />
          </div>
        ) : null}
      </div>
    </NsnCard>
  );
}

export function BridgeMonitoringDashboard({
  initialDashboard,
}: BridgeMonitoringDashboardProps) {
  const router = useRouter();
  const hadStopDialogOpen = useRef(false);
  const stopCancelRef = useRef<HTMLButtonElement>(null);
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [commandName, setCommandName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [stopTarget, setStopTarget] =
    useState<BridgeMonitoringFolderSummary | null>(null);
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const matchingFolders = useMemo(
    () =>
      dashboard.folders.filter((folder) =>
        !normalizedSearch
          ? true
          : [
              folder.displayName,
              ...folder.recentEvents.flatMap((event) => [
                event.currentRelativePath,
                event.previousRelativePath,
              ]),
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(normalizedSearch),
      ),
    [dashboard.folders, normalizedSearch],
  );
  const matchingEvents = useMemo(
    () =>
      dashboard.recentEvents.filter((event) =>
        !normalizedSearch
          ? true
          : [event.currentRelativePath, event.previousRelativePath, event.eventType]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(normalizedSearch),
      ),
    [dashboard.recentEvents, normalizedSearch],
  );

  const runCommand = useCallback(
    async (endpoint: string, label: string, body?: unknown) => {
      if (commandName) {
        return;
      }

      setCommandName(label);
      setError(null);
      setNotice(null);

      try {
        const response = await fetch(endpoint, {
          body: body ? JSON.stringify(body) : null,
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        const payload = await readMonitoringResponse(response);

        if (!response.ok || !payload.ok) {
          setError(payload.ok ? "The Bridge could not update monitoring." : payload.error);
          return;
        }

        setDashboard(payload.dashboard);
        setNotice(payload.message ?? "Monitoring was updated.");
        router.refresh();
      } catch {
        setError("The Bridge could not update monitoring right now.");
      } finally {
        setCommandName(null);
      }
    },
    [commandName, router],
  );

  const refreshDashboard = useCallback(async () => {
    try {
      const response = await fetch("/api/bridge/monitor", {
        method: "GET",
      });
      const payload = await readMonitoringResponse(response);

      if (!response.ok || !payload.ok) {
        throw new Error(payload.ok ? "Monitoring could not be refreshed." : payload.error);
      }

      setDashboard(payload.dashboard);
    } catch {
      setError("Monitoring progress could not be refreshed.");
    }
  }, []);

  useEffect(() => {
    const hasWatchingFolder = dashboard.folders.some(
      (folder) => folder.state === "WATCHING",
    );

    if (!hasWatchingFolder) {
      return;
    }

    const timeout = window.setTimeout(async () => {
      await refreshDashboard();

      if (dashboard.queue.queued > 0 && !commandName) {
        await runCommand("/api/bridge/monitor/process", "Processing changes...");
      }
    }, pollingDelayMs);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [commandName, dashboard, refreshDashboard, runCommand]);

  useEffect(() => {
    if (stopTarget) {
      hadStopDialogOpen.current = true;
      stopCancelRef.current?.focus();
    }
  }, [stopTarget]);

  function closeStopDialog() {
    setStopTarget(null);
  }

  async function confirmStop() {
    if (!stopTarget) {
      return;
    }

    const folderId = stopTarget.id;
    closeStopDialog();
    await runCommand(
      `/api/bridge/monitor/${encodeURIComponent(folderId)}/stop`,
      "Stopping monitoring...",
    );
  }

  return (
    <div className="grid min-w-0 gap-6" aria-live="polite">
      <QueueTiles dashboard={dashboard} />

      <NsnSearchField
        label="Search monitoring"
        onChange={setSearchQuery}
        placeholder="Search folders, file names, or paths"
        resultCount={matchingEvents.length}
        value={searchQuery}
      />

      {commandName ? (
        <p className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-teal-dark)]">
          {commandName}
        </p>
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

      {dashboard.folders.length === 0 ? (
        <NsnCard tone="sand">
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
            <div className="min-w-0">
              <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">
                Bridge not connected
              </h2>
              <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                In local development, the Bridge can watch the configured test
                folder. Monitoring begins only after Deanne starts it.
              </p>
            </div>
            <Link
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] sm:w-fit"
              href={getConnectedLibrariesRoute()}
            >
              Open Connected Libraries
            </Link>
          </div>
        </NsnCard>
      ) : (
        <div className="grid min-w-0 gap-4">
          {matchingFolders.map((folder) => (
            <FolderCard
              commandName={commandName}
              folder={folder}
              key={folder.id}
              onCommand={runCommand}
              onStop={setStopTarget}
            />
          ))}
        </div>
      )}

      {dashboard.recentBatches.length > 0 ? (
        <section className="grid min-w-0 gap-4" aria-labelledby="change-digest-heading">
          <h2
            className="nsn-display text-2xl text-[var(--nsn-navy)]"
            id="change-digest-heading"
          >
            Change Digests
          </h2>
          <div className="grid min-w-0 gap-3">
            {dashboard.recentBatches.map((batch) => (
              <NsnCard className="min-w-0" key={batch.id}>
                <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                  <div className="min-w-0">
                    <NsnBadge
                      tone={
                        batch.status === "COMPLETED_WITH_ERRORS" ||
                        batch.status === "FAILED"
                          ? "review"
                          : "approved"
                      }
                    >
                      {batch.status === "COMPLETED_WITH_ERRORS"
                        ? "Needs attention"
                        : "Ready for review"}
                    </NsnBadge>
                    <h3 className="mt-3 break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                      {batch.notificationTitle ?? "Watched folder changes recorded"}
                    </h3>
                    <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {batch.notificationSummary ??
                        `${batch.totalEvents} change${
                          batch.totalEvents === 1 ? "" : "s"
                        } recorded.`}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[var(--nsn-warm-gray)]">
                      {formatDateTime(batch.completedAt ?? batch.startedAt)}
                    </p>
                  </div>
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap lg:flex-col">
                    {batch.scanSessionId ? (
                      <Link
                        className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                        href={getScanSessionRoute(batch.scanSessionId)}
                      >
                        Review Scan Session
                      </Link>
                    ) : null}
                    {batch.notebookEntryId ? (
                      <Link
                        className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                        href={getNotebookEntryRoute(batch.notebookEntryId)}
                      >
                        Read Notebook Reflection
                      </Link>
                    ) : null}
                  </div>
                </div>
              </NsnCard>
            ))}
          </div>
        </section>
      ) : null}

      {dashboard.recentEvents.length > 0 ? (
        <section className="grid min-w-0 gap-4" aria-labelledby="recent-events-heading">
          <h2
            className="nsn-display text-2xl text-[var(--nsn-navy)]"
            id="recent-events-heading"
          >
            Recent Changes Across Watched Folders
          </h2>
          <RecentEventList events={matchingEvents} />
        </section>
      ) : null}

      {stopTarget ? (
        <div
          aria-labelledby="stop-monitoring-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[rgb(31_42_68_/_0.45)] p-3"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeStopDialog();
            }
          }}
          role="dialog"
        >
          <div className="grid max-h-[calc(100dvh-1rem)] w-full max-w-lg gap-5 overflow-y-auto rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 shadow-xl sm:max-h-[calc(100dvh-2rem)] sm:p-6">
            <div className="min-w-0">
              <h2
                className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
                id="stop-monitoring-title"
              >
                Stop watching this folder?
              </h2>
              <p className="mt-3 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                Monitoring will stop noticing new changes until Deanne resumes
                it. Existing observations, recommendations, Memory, Notebook
                entries, and history remain preserved.
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:justify-end">
              <NsnButton onClick={confirmStop} type="button" variant="primary">
                Stop Monitoring
              </NsnButton>
              <NsnButton
                onClick={closeStopDialog}
                ref={stopCancelRef}
                type="button"
                variant="secondary"
              >
                Keep Watching
              </NsnButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
