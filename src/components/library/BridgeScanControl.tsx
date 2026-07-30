"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { NsnButton } from "@/components/library/NsnButton";
import {
  getRecommendationsRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";
import type {
  BridgeScanApiResponse,
  BridgeScanProcessingProgress,
  BridgeScanProgressApiResponse,
  BridgeScanSessionStatus,
} from "@/lib/bridge/types";

type BridgeScanControlProps = {
  isDevelopment: boolean;
  className?: string;
  connectedLibraryId?: string | null;
  initialProgress?: BridgeScanProcessingProgress | null;
  scanLabel?: string;
};

const terminalStatuses = new Set<string>([
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELLED",
]);
const progressPollDelayMs = 1200;
const scanStartTimeoutMs = 20_000;
const scanResetDelayMs = 10_000;

function isTerminalStatus(status: BridgeScanSessionStatus | string) {
  return terminalStatuses.has(status);
}

function stageLabel(status: BridgeScanSessionStatus) {
  if (status === "SCANNING") {
    return "Scanning folder";
  }

  if (status === "READING") {
    return "Reading library items";
  }

  if (status === "EXAMINING") {
    return "Preparing observations";
  }

  if (status === "GENERATING_SUGGESTIONS") {
    return "Preparing recommendations";
  }

  if (status === "COMPLETED_WITH_ERRORS") {
    return "Completed with items needing attention";
  }

  if (status === "COMPLETED") {
    return "Completed";
  }

  if (status === "FAILED") {
    return "Needs attention";
  }

  return "Preparing scan";
}

function scanSummaryText(progress: BridgeScanProcessingProgress) {
  return `${progress.filesDiscovered} found, ${progress.filesProcessed} examined, ${progress.filesWithSuggestions} recommendations prepared, ${progress.unsupportedFiles} unsupported, ${progress.failedFiles} needing attention, ${progress.remainingFiles} remaining.`;
}

function hasReviewableSuggestions(progress: BridgeScanProcessingProgress | null) {
  return Boolean(progress && progress.pendingSuggestions > 0);
}

function safeRequestMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.name === "AbortError") {
    return "Scan could not be started.";
  }

  return fallback;
}

async function readScanResponse(response: Response) {
  try {
    return (await response.json()) as BridgeScanApiResponse;
  } catch {
    return {
      ok: false,
      error: "The Librarian could not read the scan response.",
    } satisfies BridgeScanApiResponse;
  }
}

async function readProgressResponse(response: Response) {
  try {
    return (await response.json()) as BridgeScanProgressApiResponse;
  } catch {
    return {
      ok: false,
      error: "The Librarian could not read scan progress.",
    } satisfies BridgeScanProgressApiResponse;
  }
}

export function BridgeScanControl({
  className = "",
  connectedLibraryId = null,
  initialProgress = null,
  isDevelopment,
  scanLabel = "Scan Folder",
}: BridgeScanControlProps) {
  const router = useRouter();
  const abortScanRef = useRef<AbortController | null>(null);
  const hadCompletionDialogOpen = useRef(false);
  const requestWasReset = useRef(false);
  const stayButtonRef = useRef<HTMLButtonElement>(null);
  const scanButtonRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCompletionDialogOpen, setIsCompletionDialogOpen] = useState(false);
  const [isCreatingScan, setIsCreatingScan] = useState(false);
  const [isProcessingRequest, setIsProcessingRequest] = useState(false);
  const [processingPaused, setProcessingPaused] = useState(false);
  const [progress, setProgress] =
    useState<BridgeScanProcessingProgress | null>(initialProgress);
  const [showScanReset, setShowScanReset] = useState(false);

  const completeIfTerminal = useCallback(
    (nextProgress: BridgeScanProcessingProgress) => {
      if (isTerminalStatus(nextProgress.currentStage)) {
        setProcessingPaused(false);
        setIsCompletionDialogOpen(true);
        router.refresh();
      }
    },
    [router],
  );

  const refreshProgress = useCallback(async (sessionId: string) => {
    const response = await fetch(
      `/api/bridge/scan-sessions/${encodeURIComponent(sessionId)}/progress`,
      {
        method: "GET",
      },
    );
    const body = await readProgressResponse(response);

    if (!response.ok || !body.ok) {
      throw new Error(body.ok ? "Scan progress could not be refreshed." : body.error);
    }

    return body.progress;
  }, []);

  const processSessionStep = useCallback(
    async (
      sessionId: string,
      retryFailed = false,
      retryStartedAt?: string,
    ) => {
      if (isProcessingRequest) {
        return;
      }

      setIsProcessingRequest(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/bridge/scan-sessions/${encodeURIComponent(sessionId)}/process`,
          {
            body: retryFailed
              ? JSON.stringify({ retryFailed: true, retryStartedAt })
              : null,
            headers: {
              "Content-Type": "application/json",
            },
            method: "POST",
          },
        );
        const body = await readScanResponse(response);

        if (!response.ok || !body.ok) {
          throw new Error(
            body.ok
              ? "The Librarian stopped examining this folder unexpectedly."
              : body.error,
          );
        }

        setProgress(body.progress);

        if (isTerminalStatus(body.progress.currentStage)) {
          completeIfTerminal(body.progress);
        } else if (body.progress.isStale) {
          setProcessingPaused(true);
          setError("The folder examination appears to have stopped.");
        } else {
          setProcessingPaused(false);
        }
      } catch {
        setProcessingPaused(true);
        setError("The Librarian stopped examining this folder unexpectedly.");
      } finally {
        setIsProcessingRequest(false);
      }
    },
    [completeIfTerminal, isProcessingRequest],
  );

  useEffect(() => {
    if (!isCreatingScan) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setShowScanReset(true);
    }, scanResetDelayMs);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [isCreatingScan]);

  useEffect(() => {
    if (
      !progress?.isActive ||
      isCreatingScan ||
      isProcessingRequest ||
      processingPaused
    ) {
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      try {
        const nextProgress = await refreshProgress(progress.sessionId);

        if (cancelled) {
          return;
        }

        setProgress(nextProgress);

        if (isTerminalStatus(nextProgress.currentStage)) {
          completeIfTerminal(nextProgress);
          return;
        }

        if (nextProgress.isStale) {
          setProcessingPaused(true);
          setError("The folder examination appears to have stopped.");
          return;
        }

        await processSessionStep(nextProgress.sessionId);
      } catch {
        if (!cancelled) {
          setProcessingPaused(true);
          setError("The Librarian stopped examining this folder unexpectedly.");
        }
      }
    }, progressPollDelayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [
    completeIfTerminal,
    isCreatingScan,
    isProcessingRequest,
    processSessionStep,
    processingPaused,
    progress,
    refreshProgress,
  ]);

  useEffect(() => {
    if (isCompletionDialogOpen) {
      hadCompletionDialogOpen.current = true;
      stayButtonRef.current?.focus();
    } else if (hadCompletionDialogOpen.current) {
      hadCompletionDialogOpen.current = false;
      scanButtonRef.current?.focus();
    }
  }, [isCompletionDialogOpen]);

  if (!connectedLibraryId && !isDevelopment) {
    return (
      <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
        Connect a folder before starting a scan.
      </p>
    );
  }

  async function scanFolder() {
    if (isCreatingScan) {
      return;
    }

    const abortController = new AbortController();
    const timeout = window.setTimeout(() => {
      abortController.abort();
    }, scanStartTimeoutMs);

    abortScanRef.current = abortController;
    requestWasReset.current = false;
    setError(null);
    setProgress(null);
    setProcessingPaused(false);
    setIsCompletionDialogOpen(false);
    setIsCreatingScan(true);

    try {
      const response = await fetch("/api/bridge/scan", {
        body: connectedLibraryId
          ? JSON.stringify({ connectedLibraryId })
          : null,
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: abortController.signal,
      });
      const body = await readScanResponse(response);

      if (!response.ok || !body.ok) {
        setError(
          body.ok ? "Scan could not be started." : body.error,
        );
        return;
      }

      setProgress(body.progress);

      if (isTerminalStatus(body.progress.currentStage)) {
        completeIfTerminal(body.progress);
      } else if (body.progress.isStale) {
        setProcessingPaused(true);
        setError("The folder examination appears to have stopped.");
      }

      router.refresh();
    } catch (caughtError) {
      setError(
        requestWasReset.current
          ? "The waiting scan request was reset. The persisted scan session was not changed."
          : safeRequestMessage(
              caughtError,
              "Scan could not be started.",
            ),
      );
    } finally {
      window.clearTimeout(timeout);
      abortScanRef.current = null;
      requestWasReset.current = false;
      setIsCreatingScan(false);
      setShowScanReset(false);
    }
  }

  function resetScanRequestState() {
    requestWasReset.current = true;
    abortScanRef.current?.abort();
    setIsCreatingScan(false);
    setShowScanReset(false);
  }

  async function resumeProcessing() {
    if (!progress) {
      return;
    }

    setProcessingPaused(false);
    setError(null);
    await processSessionStep(progress.sessionId, true, new Date().toISOString());
  }

  async function markSessionFailed() {
    if (!progress) {
      return;
    }

    setError(null);
    setIsProcessingRequest(true);

    try {
      const response = await fetch(
        `/api/bridge/scan-sessions/${encodeURIComponent(progress.sessionId)}/fail`,
        {
          method: "POST",
        },
      );
      const body = await readScanResponse(response);

      if (!response.ok || !body.ok) {
        setError(
          body.ok
            ? "The Librarian stopped examining this folder unexpectedly."
            : body.error,
        );
        return;
      }

      setProgress(body.progress);
      setProcessingPaused(false);
      router.refresh();
    } catch {
      setError("The Librarian stopped examining this folder unexpectedly.");
    } finally {
      setIsProcessingRequest(false);
    }
  }

  function returnHome() {
    setError(null);
    setProgress(null);
    setProcessingPaused(false);
    setIsCompletionDialogOpen(false);
  }

  const showRecovery =
    Boolean(progress?.isActive) && (processingPaused || Boolean(progress?.isStale));

  return (
    <div className={["grid min-w-0 gap-3", className].join(" ")}>
      <NsnButton
        aria-busy={isCreatingScan}
        className="w-full sm:w-fit"
        disabled={isCreatingScan}
        onClick={scanFolder}
        ref={scanButtonRef}
        type="button"
        variant="primary"
      >
        {isCreatingScan ? "Starting scan..." : scanLabel}
      </NsnButton>

      <div aria-live="polite" className="grid min-w-0 gap-3">
        {isCreatingScan ? (
          <div className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-teal-dark)]">
            <p className="break-words font-semibold [overflow-wrap:anywhere]">
              Starting a folder scan.
            </p>
            <p className="break-words [overflow-wrap:anywhere]">
              The first response should return quickly. Reading, observation,
              and recommendations continue through visible progress steps.
            </p>
            {showScanReset ? (
              <NsnButton
                className="w-full sm:w-fit"
                onClick={resetScanRequestState}
                type="button"
                variant="secondary"
              >
                Reset Waiting State
              </NsnButton>
            ) : null}
          </div>
        ) : null}

        {progress ? (
          <div className="grid min-w-0 gap-3 rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-teal-dark)]">
            <div className="min-w-0">
              <p className="break-words font-semibold [overflow-wrap:anywhere]">
                {stageLabel(progress.currentStage)} for{" "}
                {progress.folderDisplayName}.
              </p>
              <p className="break-words [overflow-wrap:anywhere]">
                {scanSummaryText(progress)}
              </p>
              {progress.isActive && !showRecovery ? (
                <p className="mt-1 break-words [overflow-wrap:anywhere]">
                  {isProcessingRequest
                    ? "Examining the next file..."
                    : "Watching the Librarian's progress..."}
                </p>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2 text-[var(--nsn-navy)] sm:grid-cols-3">
              <span>{progress.filesDiscovered} found</span>
              <span>{progress.filesProcessed} examined</span>
              <span>{progress.filesWithSuggestions} recommendations</span>
              <span>{progress.unsupportedFiles} unsupported</span>
              <span>{progress.failedFiles} need attention</span>
              <span>{progress.remainingFiles} remaining</span>
            </div>
            {showRecovery ? (
              <div className="grid min-w-0 gap-3 rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-[var(--nsn-navy)]">
                <p className="break-words font-semibold [overflow-wrap:anywhere]">
                  The folder examination appears to have stopped.
                </p>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <NsnButton
                    disabled={isProcessingRequest}
                    onClick={resumeProcessing}
                    type="button"
                    variant="primary"
                  >
                    {isProcessingRequest ? "Resuming..." : "Resume Examination"}
                  </NsnButton>
                  <NsnButton
                    disabled={isProcessingRequest}
                    onClick={markSessionFailed}
                    type="button"
                    variant="secondary"
                  >
                    Mark Needs Attention
                  </NsnButton>
                  <NsnButton
                    onClick={returnHome}
                    type="button"
                    variant="secondary"
                  >
                    Return Home
                  </NsnButton>
                </div>
              </div>
            ) : null}
            {!progress.isActive ? (
              <Link
                className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-3 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] sm:w-fit"
                href={getScanSessionRoute(progress.sessionId)}
              >
                View Scan Session
              </Link>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p
            className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-warning)]"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </div>

      {isCompletionDialogOpen && progress ? (
        <div
          aria-labelledby="folder-examination-complete-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[rgb(31_42_68_/_0.45)] p-3"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setIsCompletionDialogOpen(false);
            }
          }}
          role="dialog"
        >
          <div className="grid max-h-[calc(100dvh-1rem)] w-full max-w-xl gap-5 overflow-y-auto rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 shadow-xl sm:max-h-[calc(100dvh-2rem)] sm:p-6">
            <div className="min-w-0">
              <h2
                className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
                id="folder-examination-complete-title"
              >
                The Librarian has finished examining this folder.
              </h2>
              <p className="mt-3 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                {scanSummaryText(progress)}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {hasReviewableSuggestions(progress) ? (
                <Link
                  className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)]"
                  href={getRecommendationsRoute(progress.sessionId)}
                >
                  Review Recommendations
                </Link>
              ) : (
                <Link
                  className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)]"
                  href={getScanSessionRoute(progress.sessionId)}
                >
                  View Scan Session
                </Link>
              )}

              {hasReviewableSuggestions(progress) ? (
                <Link
                  className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                  href={getScanSessionRoute(progress.sessionId)}
                >
                  View Scan Session
                </Link>
              ) : null}

              <button
                className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                onClick={() => setIsCompletionDialogOpen(false)}
                ref={stayButtonRef}
                type="button"
              >
                Stay on Home
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
