"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
  retryFailed = true,
  scanSessionId,
  variant = "accent",
}: RetryAutomaticProcessingButtonProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] =
    useState<BridgeScanProcessingProgress | null>(null);

  async function retryProcessing() {
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

      for (let attempt = 0; attempt < 500; attempt += 1) {
        const response = await fetch(
          `/api/bridge/scan-sessions/${encodeURIComponent(
            scanSessionId,
          )}/process`,
          {
            body: JSON.stringify({
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
        onClick={retryProcessing}
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
    </div>
  );
}
