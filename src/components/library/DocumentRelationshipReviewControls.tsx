"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Action = "CONFIRM" | "SEPARATE" | "RECONSIDER";

export function DocumentRelationshipReviewControls({
  id,
  kind,
  status,
}: {
  id: string;
  kind: string | null;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const revision = kind === "PROBABLE_REVISION";
  const project = kind === "BELONGS_TO_PROJECT";

  async function decide(action: Action) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/library/knowledge/document-relationships/${encodeURIComponent(id)}/decision`, {
        body: JSON.stringify({ action, note }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error ?? "This review could not be saved.");
      setNote("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This review could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-2 border-t border-[var(--nsn-border)] pt-3">
      <label className="grid gap-1 text-xs font-semibold text-[var(--nsn-slate)]">
        Context for this decision (optional)
        <textarea
          className="min-h-16 w-full rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-white)] p-2 text-sm font-normal text-[var(--nsn-navy)]"
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
          value={note}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        {status !== "CONFIRMED" ? (
          <button className="min-h-10 rounded-md border border-[var(--nsn-teal)] px-3 text-sm font-semibold text-[var(--nsn-teal)] disabled:opacity-50" disabled={busy} onClick={() => decide("CONFIRM")} type="button">
            {revision ? "Confirm revision link" : project ? "Confirm project link" : "Confirm same identity"}
          </button>
        ) : null}
        {status !== "REJECTED" ? (
          <button className="min-h-10 rounded-md border border-[var(--nsn-border)] px-3 text-sm text-[var(--nsn-navy)] disabled:opacity-50" disabled={busy} onClick={() => decide("SEPARATE")} type="button">
            {revision ? "Not revisions" : project ? "Not this project" : "Different identities"}
          </button>
        ) : null}
        {status !== "NEW" ? (
          <button className="min-h-10 rounded-md border border-[var(--nsn-border)] px-3 text-sm text-[var(--nsn-navy)]" disabled={busy} onClick={() => decide("RECONSIDER")} type="button">
            Reconsider
          </button>
        ) : null}
      </div>
      {error ? <p className="text-xs text-red-700" role="alert">{error}</p> : null}
    </div>
  );
}
