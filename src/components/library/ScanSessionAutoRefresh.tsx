"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type {
  BridgeScanProgressApiResponse,
  BridgeScanSessionStatus,
} from "@/lib/bridge/types";

type ScanSessionAutoRefreshProps = {
  initialStatus: BridgeScanSessionStatus;
  scanSessionId: string;
};

const activeStatuses = new Set<BridgeScanSessionStatus>([
  "PENDING",
  "SCANNING",
  "READING",
  "EXAMINING",
  "GENERATING_SUGGESTIONS",
]);

function isActive(status: BridgeScanSessionStatus) {
  return activeStatuses.has(status);
}

export function ScanSessionAutoRefresh({
  initialStatus,
  scanSessionId,
}: ScanSessionAutoRefreshProps) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);

  useEffect(() => {
    if (!isActive(status)) {
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/bridge/scan-sessions/${encodeURIComponent(
            scanSessionId,
          )}/progress`,
          {
            method: "GET",
          },
        );
        const payload = (await response.json()) as BridgeScanProgressApiResponse;

        if (cancelled || !response.ok || !payload.ok) {
          return;
        }

        setStatus(payload.progress.currentStage);
        router.refresh();
      } catch {
        if (!cancelled) {
          router.refresh();
        }
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [router, scanSessionId, status]);

  if (!isActive(status)) {
    return null;
  }

  return (
    <p className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-teal-dark)]">
      The Librarian is still examining this folder. This page refreshes
      automatically while the scan session is active.
    </p>
  );
}
