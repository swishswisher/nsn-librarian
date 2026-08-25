"use client";

import { useEffect, useMemo, useState } from "react";

import { ConnectedLibrariesManager } from "@/components/library/ConnectedLibrariesManager";
import type {
  ConnectedLibraryListResponse,
  ConnectedLibrarySummary,
} from "@/lib/bridge/types";
import type { LocalBridgeHealth } from "@/lib/bridge/local-bridge-client";

type ConnectedLibrariesLiveViewProps = {
  initialBridgeHealth: LocalBridgeHealth;
  initialLibraries: ConnectedLibrarySummary[];
};

const watchingRefreshDelayMs = 4_000;
const idleRefreshDelayMs = 10_000;

function monitoringSignature(libraries: ConnectedLibrarySummary[]) {
  return [...libraries]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((library) =>
      [
        library.id,
        library.bridgeReachable ? "reachable" : "unreachable",
        library.status,
        library.monitoringState,
        library.recentChangeCount,
        library.itemsNeedingAttention,
        library.lastDetectedChangeAt ?? "",
      ].join(":"),
    )
    .join("|");
}

function userIsEditing() {
  if (typeof document === "undefined") {
    return false;
  }

  const active = document.activeElement;

  return Boolean(
    document.querySelector('[aria-modal="true"]') ||
      active?.matches("input, textarea, select, [contenteditable='true']"),
  );
}

async function readLibraryList(response: Response) {
  try {
    return (await response.json()) as ConnectedLibraryListResponse;
  } catch {
    return null;
  }
}

export function ConnectedLibrariesLiveView({
  initialBridgeHealth,
  initialLibraries,
}: ConnectedLibrariesLiveViewProps) {
  const [libraries, setLibraries] = useState(initialLibraries);
  const hasWatchingLibrary = libraries.some(
    (library) => library.monitoringState === "WATCHING",
  );
  const refreshDelayMs = hasWatchingLibrary
    ? watchingRefreshDelayMs
    : idleRefreshDelayMs;
  const signature = useMemo(() => monitoringSignature(libraries), [libraries]);

  useEffect(() => {
    setLibraries(initialLibraries);
  }, [initialLibraries]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      if (
        cancelled ||
        document.visibilityState !== "visible" ||
        userIsEditing()
      ) {
        return;
      }

      try {
        const response = await fetch("/api/bridge/connected-libraries", {
          cache: "no-store",
        });
        const payload = await readLibraryList(response);

        if (!cancelled && response.ok && payload?.ok) {
          setLibraries(payload.libraries);
        }
      } catch {
        // Keep the last confirmed UI state. The normal Bridge status controls
        // remain responsible for surfacing connection errors.
      }
    };

    const interval = window.setInterval(() => {
      void refresh();
    }, refreshDelayMs);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshDelayMs]);

  return (
    <ConnectedLibrariesManager
      key={signature}
      initialBridgeHealth={initialBridgeHealth}
      initialLibraries={libraries}
    />
  );
}
