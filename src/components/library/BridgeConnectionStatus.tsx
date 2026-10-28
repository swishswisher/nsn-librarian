"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { NsnBadgeTone } from "./NsnBadge";

type Status = { label: string; tone: NsnBadgeTone };
const initialStatus: Status = { label: "Checking connection…", tone: "source" };
const BridgeStatusContext = createContext<Status>(initialStatus);

// This provider lives in the shared layout, not in each page/loading shell.
// Its display state is never used to authorize a read or file operation.
export function BridgeConnectionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState(initialStatus);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let lastCheck = 0;
    const controller = new AbortController();
    async function check() {
      if (inFlight || disposed || document.visibilityState === "hidden") return;
      inFlight = true;
      lastCheck = Date.now();
      try {
        const response = await fetch("/api/bridge/status?view=indicator", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        const result = await response.json();
        if (!response.ok || !result.ok || typeof result.label !== "string" ||
            !["approved", "pending"].includes(result.tone)) throw new Error("Status unavailable");
        if (!disposed) setStatus({ label: result.label, tone: result.tone });
      } catch {
        // A failed status request is not proof that the Mac disconnected.
        if (!disposed) setStatus({ label: "Connection status unavailable", tone: "pending" });
      } finally {
        inFlight = false;
      }
    }
    function visible() { if (Date.now() - lastCheck >= 15_000) void check(); }
    void check();
    const timer = setInterval(() => void check(), 30_000);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  return <BridgeStatusContext.Provider value={status}>{children}</BridgeStatusContext.Provider>;
}

export function BridgeConnectionStatus({ label, tone }: { label?: string; tone?: NsnBadgeTone }) {
  const connection = useContext(BridgeStatusContext);
  // Preserve existing page-specific workflow labels, but never reset the shared
  // connection to a loading placeholder just because the route changed.
  const displayed = label && label !== initialStatus.label
    ? { label, tone: tone ?? "source" } : connection;
  return <div className="flex items-center gap-3 text-sm text-[var(--nsn-slate)]" role="status">
    <span aria-hidden="true" className={[
      "h-2.5 w-2.5 rounded-full",
      displayed.tone === "review" ? "bg-[var(--nsn-warning)]"
        : displayed.tone === "migration" ? "bg-[var(--nsn-gold)]"
        : displayed.tone === "approved" ? "bg-[var(--nsn-success)]"
        : "bg-[var(--nsn-warm-gray)]",
    ].join(" ")} />
    <span>Bridge: {displayed.label}</span>
  </div>;
}
