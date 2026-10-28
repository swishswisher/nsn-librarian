"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

type RefreshState = "pending" | "complete" | "failed";
const RefreshContext = createContext<RefreshState>("pending");

// Read saved Knowledge immediately. Refresh derived proposals in a separate
// authenticated request so navigation never waits for the backfill's writes.
export function KnowledgeRefreshProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RefreshState>("pending");
  const router = useRouter();
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    void fetch("/api/library/knowledge/refresh", {
      method: "POST",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]),
    }).then(async (response) => {
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error("Knowledge refresh failed");
      if (!disposed) {
        setState("complete");
        router.refresh();
      }
    }).catch(() => { if (!disposed) setState("failed"); });
    return () => { disposed = true; controller.abort(); };
  }, [router]);
  return <RefreshContext.Provider value={state}>{children}</RefreshContext.Provider>;
}

export function KnowledgeRefreshStatus() {
  const state = useContext(RefreshContext);
  if (state === "complete") return null;
  return <p className="text-sm text-[var(--nsn-slate)]" role="status">
    {state === "pending"
      ? "Updating knowledge from recent activity. You can browse saved results below."
      : "Recent knowledge could not be refreshed. Saved results are available; reload to try again."}
  </p>;
}
