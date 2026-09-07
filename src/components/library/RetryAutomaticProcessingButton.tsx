"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { NsnButton } from "@/components/library/NsnButton";
import type {
  BridgeScanApiResponse,
  BridgeScanProcessingProgress,
  BridgeScanProgressApiResponse,
} from "@/lib/bridge/types";

type RetryAutomaticProcessingButtonProps = {
  busyLabel?: string;
  className?: string;
  label?: string;
  regenerate?: boolean;
  reviewedRecommendationCount?: number;
  retryFailed?: boolean;
  scanSessionId: string;
  variant?: "primary" | "secondary" | "accent";
};

const remoteProgressPollDelayMs = 2_000;
const remoteProgressPollAttempts = 450;

function summaryText(progress: BridgeScanProcessingProgress) {
  return `${progress.filesProcessed} examined, ${progress.filesWithSuggestions} files with recommendations, ${progress.failedFiles} needing attention, ${progress.remainingFiles} remaining.`;
}

function waitForRemoteProgress() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, remoteProgressPollDelayMs);
  });
}

async function readProgress(scanSessionId: string) {
  const response = await fetch(
    `/api/bridge/scan-sessions/${encodeURIComponent(scanSessionId)}/progress`,
    {
      method: "GET",
    },
  );
  const payload = (await response.json()) as BridgeScanProgressApiResponse;

  if (!response.ok || !payload.ok) {
    throw new Error(
      payload.ok
        ? "The Librarian could not refresh recommendation progress."
        : payload.error,
    );
  }

  return payload.progress;
}

export function RetryAutomaticProcessingButton({
  busyLabel = "Examining...",
  className = "",
  label = "Resume Examination",
  regenerate = false,
  reviewedRecommendationCount = 0,
  retryFailed = true,
  scanSessionId,
  variant = "accent",
}: RetryAutomaticProcessingButtonProps) {
  const router = useRouter();
  const confirmationButtonRef = useRef<HTMLButtonElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isConfirmationOpen, setIsConfirmationOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] =
    useState<BridgeScanProcessingProgress | null>(null);

  useEffect(() => {
    if (!isConfirmationOpen) {
      return;
    }

    const triggerButton = triggerButtonRef.current;

    confirmationButtonRef.current?.focus();

    return () => {
      triggerButton?.focus();
    };
  }, [isConfirmationOpen]);

  async function retryProcessing(includeRegeneration = false) {
    if (isProcessing) {
      return;
    }

    setError(null);
    setMessage(null);
    setProgress(null);
    setIsProcessing(true);

    try {
      const retryStartedAt = new Date().toISOString();
      let latestProgress: BridgeScanProcessingProgress | null = null;
      let prepareRegeneration = includeRegeneration;

      for (let attempt = 0; attempt < 500; attempt += 1) {
        const response = await fetch(
          `/api/bridge/scan-sessions/${encodeURIComponent(
            scanSessionId,
          )}/process`,
          {
            body: JSON.stringify({
              confirmation: prepareRegeneration ? "REGENERATE" : undefined,
              regenerate: prepareRegeneration,
              retryFailed,
              retryStartedAt,
            }),
            headers: {
              "Content-Type": "application/json",
            },
            method: "POST",
          },
        );
        const payload = (await response.json()) as BridgeScanApiResponse;

        if (!response.ok || !payload.ok) {
          setError(
            payload.ok
              ? "The Librarian could not resume this folder examination right now."
              : payload.error,
          );
          return;
        }

        prepareRegeneration = false;

        latestProgress = payload.progress;
        setProgress(payload.progress);

        if (payload.message) {
          setMessage(payload.message);
        }

        if (payload.queued) {
          for (
            let pollAttempt = 0;
            pollAttempt < remoteProgressPollAttempts;
            pollAttempt += 1
          ) {
            if (!latestProgress.isActive || latestProgress.isStale) {
              break;
            }

            await waitForRemoteProgress();
            latestProgress = await readProgress(scanSessionId);
            setProgress(latestProgress);
          }

          if (!latestProgress.isActive) {
            setMessage(
              latestProgress.failedFiles > 0
                ? "Recommendation generation finished. One or more files still need attention."
                : "Recommendation generation finished.",
            );
          } else if (latestProgress.isStale) {
            setError(
              "Recommendation generation appears to have stopped. Try again after checking that NSN Bridge is online.",
            );
          }

          break;
        }

        if (!payload.progress.isActive || payload.progress.isStale) {
          break;
        }
      }

      if (latestProgress?.isActive && !latestProgress.isStale) {
        setError(
          "The folder examination is taking longer than expected. Try again in a moment.",
        );
      }

      router.refresh();
    } catch {
      setError("The Librarian could not resume this folder examination.");
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <div className={["grid min-w-0 gap-3", className].join(" ")}>
      <NsnButton
        disabled={isProcessing}
        onClick={() => {
          if (regenerate) {
            setIsConfirmationOpen(true);
            return;
          }

          void retryProcessing();
        }}
        ref={triggerButtonRef}
        type="button"
        variant={variant}
      >
        {isProcessing ? busyLabel : label}
      </NsnButton>

      <div aria-live="polite" className="grid gap-2">
        {message ? (
          <p className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-teal-dark)]">
            {message}
          </p>
        ) : null}
        {progress ? (
          <p className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-teal-dark)]">
            {summaryText(progress)}
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
      </div>

      {isConfirmationOpen ? (
        <div
          aria-labelledby="regenerate-recommendations-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid min-w-0 place-items-center overflow-y-auto bg-[rgba(18,34,43,0.45)] p-4 sm:p-6"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !isProcessing) {
              setIsConfirmationOpen(false);
            }
          }}
          role="dialog"
        >
          <div className="grid max-h-[calc(100vh-2rem)] w-full max-w-xl min-w-0 gap-5 overflow-y-auto rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 shadow-xl sm:p-6">
            <div className="min-w-0">
              <h2
                className="nsn-display break-words text-2xl leading-8 text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
                id="regenerate-recommendations-title"
              >
                Regenerate recommendations?
              </h2>
              <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                The Librarian will re-analyze this existing scan with its
                current recommendation logic. It will not rescan the folder or
                move, rename, create, delete, copy, or upload files.
              </p>
            </div>

            {reviewedRecommendationCount > 0 ? (
              <div className="rounded-md border border-[var(--nsn-gold)] bg-[var(--nsn-warm-beige)] p-4 text-sm leading-6 text-[var(--nsn-navy)]">
                This scan has {reviewedRecommendationCount}{" "}
                {reviewedRecommendationCount === 1
                  ? "reviewed decision"
                  : "reviewed decisions"}
                . Those decisions and edits will remain in recommendation
                history. The new recommendations will begin as pending and
                require review again.
              </div>
            ) : (
              <div className="rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-4 text-sm leading-6 text-[var(--nsn-slate)]">
                The current pending recommendations will move into history and
                be replaced by a newly prepared set.
              </div>
            )}

            <p className="break-words text-sm font-semibold leading-6 text-[var(--nsn-teal-dark)] [overflow-wrap:anywhere]">
              The machine suggests. Deanne decides. Nothing moves without
              approval.
            </p>

            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <NsnButton
                disabled={isProcessing}
                onClick={() => {
                  setIsConfirmationOpen(false);
                  void retryProcessing(true);
                }}
                ref={confirmationButtonRef}
                type="button"
                variant="primary"
              >
                Regenerate Recommendations
              </NsnButton>
              <NsnButton
                disabled={isProcessing}
                onClick={() => setIsConfirmationOpen(false)}
                type="button"
                variant="secondary"
              >
                Cancel
              </NsnButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
