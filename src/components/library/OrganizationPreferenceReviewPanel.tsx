"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { PreferenceAction } from "@/lib/library/organization-preferences";

type Preference = Awaited<ReturnType<typeof import("@/lib/library/organization-preferences").getOrganizationPreferencePageData>>[number];

export function OrganizationPreferenceReviewPanel({ preferences }: { preferences: Preference[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function decide(item: Preference, action: PreferenceAction, form?: FormData) {
    if (busyId) return;
    setBusyId(item.id);
    setError(null);
    try {
      const response = await fetch(`/api/library/organization-preferences/${encodeURIComponent(item.id)}/decision`, {
        body: JSON.stringify({
          action,
          destination: form?.get("destination")?.toString(),
          note: form?.get("note")?.toString() ?? notes[item.id],
          scopeTerms: form?.get("scopeTerms")?.toString().split(",").map((term) => term.trim()),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "The review could not be saved.");
      setEditingId(null);
      router.refresh();
    } catch (cause) {
      setError({ id: item.id, message: cause instanceof Error ? cause.message : "The review could not be saved." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="grid min-w-0 gap-4">
      <div>
        <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">Organization preferences</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--nsn-slate)]">
          Repeated organization decisions can suggest a rule. Only a preference you approve here may guide later recommendations in the same connected library.
        </p>
      </div>
      {preferences.length === 0 ? (
        <p className="text-sm text-[var(--nsn-slate)]">No reusable organization preferences have been proposed yet.</p>
      ) : (
        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          {preferences.map((item) => (
            <article className="grid min-w-0 gap-3 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4" key={item.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 break-words font-semibold text-[var(--nsn-navy)]">{item.libraryName}</h3>
                <span className="text-xs font-semibold text-[var(--nsn-slate)]">{item.disputed ? "Needs another review" : item.status.toLowerCase().replaceAll("_", " ")}</span>
              </div>
              <p className="break-words text-sm text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                For files whose content supports <strong>{item.scopeTerms.join(" and ")}</strong>, consider <strong>{item.destinationRelativePath}</strong>.
              </p>
              <p className="text-xs text-[var(--nsn-slate)]">This applies only to {item.libraryName}. It never moves files by itself.</p>
              <div className="text-xs text-[var(--nsn-slate)]">
                <p className="font-semibold">Reviewed decisions behind this proposal</p>
                <ul className="mt-1 grid gap-1 pl-4">
                  {item.sources.map((source, index) => (
                    <li className="list-disc break-words [overflow-wrap:anywhere]" key={`${index}-${source.relativePath}`}>
                      {source.relativePath}{source.destination ? ` to ${source.destination}` : ""} ({source.status.toLowerCase().replaceAll("_", " ")})
                      {source.context ? `: ${source.context}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
              {item.revisions.length > 0 ? (
                <details className="text-xs text-[var(--nsn-slate)]">
                  <summary className="cursor-pointer font-semibold">Review history</summary>
                  <ul className="mt-2 grid gap-1 pl-4">
                    {item.revisions.map((revision, index) => (
                      <li className="list-disc break-words" key={`${revision.createdAt}-${index}`}>
                        {new Date(revision.createdAt).toLocaleDateString("en-US")}: {revision.action.toLowerCase().replaceAll("_", " ")}
                        {revision.note ? `: ${revision.note}` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {item.conflictingDestinations.length > 0 ? <p className="break-words text-sm text-red-700">Another approved preference with this scope points to {item.conflictingDestinations.join(", ")}. Resolve the conflict before approving.</p> : null}
              {error?.id === item.id ? <p className="text-sm text-red-700" role="alert">{error.message}</p> : null}
              {editingId === item.id ? (
                <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void decide(item, "EDIT", new FormData(event.currentTarget)); }}>
                  <label className="grid gap-1 text-sm">Destination folder<input className="min-w-0 rounded border p-2" defaultValue={item.destinationRelativePath} name="destination" required /></label>
                  <label className="grid gap-1 text-sm">Scope terms, separated by commas<input className="min-w-0 rounded border p-2" defaultValue={item.scopeTerms.join(", ")} name="scopeTerms" required /></label>
                  <label className="grid gap-1 text-sm">Reason or correction<textarea className="min-w-0 rounded border p-2" name="note" rows={2} /></label>
                  <div className="flex flex-wrap gap-2"><button className="rounded border px-3 py-2 text-sm" disabled={busyId === item.id} type="submit">Save correction</button><button className="rounded border px-3 py-2 text-sm" onClick={() => setEditingId(null)} type="button">Cancel</button></div>
                </form>
              ) : null}
              {item.status !== "ARCHIVED" && item.status !== "REJECTED" ? (
                <div className="grid gap-2">
                  <label className="grid gap-1 text-sm">Reason or context (optional)<input className="min-w-0 rounded border p-2" maxLength={500} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} value={notes[item.id] ?? ""} /></label>
                  <div className="flex flex-wrap gap-2">
                  {item.status !== "APPROVED" ? <button className="rounded border px-3 py-2 text-sm" disabled={Boolean(busyId) || item.conflictingDestinations.length > 0 || item.disputed} onClick={() => void decide(item, "APPROVE")} type="button">Approve preference</button> : null}
                  <button className="rounded border px-3 py-2 text-sm" disabled={Boolean(busyId)} onClick={() => setEditingId(item.id)} type="button">Edit scope</button>
                  {item.status !== "APPROVED" ? <button className="rounded border px-3 py-2 text-sm" disabled={Boolean(busyId)} onClick={() => void decide(item, "DEFER")} type="button">Defer</button> : null}
                  {item.status !== "APPROVED" ? <button className="rounded border px-3 py-2 text-sm" disabled={Boolean(busyId)} onClick={() => void decide(item, "REJECT")} type="button">Reject</button> : null}
                  {item.status === "APPROVED" ? <button className="rounded border px-3 py-2 text-sm" disabled={Boolean(busyId)} onClick={() => void decide(item, "ARCHIVE")} type="button">Archive</button> : null}
                  </div>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
