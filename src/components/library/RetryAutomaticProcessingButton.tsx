"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { NsnButton } from "@/components/library/NsnButton";
import type {
  BridgeScanApiResponse,
  BridgeScanProcessingProgress,
} from "@/lib/bridge/types";

type RetryAutomaticProcessingButtonProps = {
  scanSessionId: string;
};

function summaryText(progress: BridgeScanProcessingProgress) {
  return `${progress.filesProcessed} examined, ${progress.filesWithSuggestions} files with recommendations, ${progress.failedFiles} needing attention, ${progress.remainingFiles} remaining.`;
}

export function RetryAutomaticProcessingButton({
  scanSessionId,
}: RetryAutomaticProcessingButtonProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] =
    useState<BridgeScanProcessingProgress | null>(null);

  async function retryProcessing() {
    if (isProcessing) {
      return;
    }

    setError(null);
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
              retryFailed: true,
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
    <div className="grid min-w-0 gap-3">
      <NsnButton
        disabled={isProcessing}
        onClick={retryProcessing}
        type="button"
        variant="accent"
      >
        {isProcessing ? "Examining..." : "Resume Examination"}
      </NsnButton>

      <div aria-live="polite" className="grid gap-2">
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
