"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Candidate = {
  connectedLibraryId: string;
  id: string;
  kind: string;
  libraryName: string;
  relativePath: string;
};

export function IdentityCorrectionPanel({ candidates }: { candidates: Candidate[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<"SAME_CLIENT" | "BELONGS_TO_PROJECT">("SAME_CLIENT");
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const source = candidates.find((candidate) => candidate.id === sourceId);
  const sourceOptions = candidates.filter((candidate) => kind === "SAME_CLIENT"
    ? ["CLIENT", "UNRESOLVED_CLIENT"].includes(candidate.kind)
    : candidate.kind === "FILE_ANCHOR");
  const targetOptions = candidates.filter((candidate) =>
    candidate.connectedLibraryId === source?.connectedLibraryId && candidate.id !== sourceId &&
    (kind === "SAME_CLIENT" ? ["CLIENT", "UNRESOLVED_CLIENT"].includes(candidate.kind) : candidate.kind === "PROJECT"),
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !sourceId || !targetId || !note.trim()) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/library/knowledge/document-relationships/correction", {
        body: JSON.stringify({ kind, note, sourceSignalId: sourceId, targetSignalId: targetId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error ?? "This correction could not be saved.");
      setSaved(true);
      setNote("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This correction could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid min-w-0 gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 text-sm" onSubmit={submit}>
      <h3 className="font-semibold text-[var(--nsn-navy)]">Correct a relationship</h3>
      <label className="grid gap-1">
        Correction
        <select className="min-w-0 rounded-md border border-[var(--nsn-border)] p-2" onChange={(event) => { setKind(event.target.value as typeof kind); setSourceId(""); setTargetId(""); }} value={kind}>
          <option value="SAME_CLIENT">These files refer to the same client</option>
          <option value="BELONGS_TO_PROJECT">This file belongs to a project</option>
        </select>
      </label>
      <label className="grid gap-1">
        File to correct
        <select className="min-w-0 rounded-md border border-[var(--nsn-border)] p-2" onChange={(event) => { setSourceId(event.target.value); setTargetId(""); }} required value={sourceId}>
          <option value="">Choose a file</option>
          {sourceOptions.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.libraryName} / {candidate.relativePath} ({candidate.kind.toLowerCase().replaceAll("_", " ")})</option>)}
        </select>
      </label>
      <label className="grid gap-1">
        {kind === "SAME_CLIENT" ? "Other client file" : "Project file"}
        <select className="min-w-0 rounded-md border border-[var(--nsn-border)] p-2" disabled={!sourceId} onChange={(event) => setTargetId(event.target.value)} required value={targetId}>
          <option value="">Choose a file in the same library</option>
          {targetOptions.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.relativePath} ({candidate.kind.toLowerCase().replaceAll("_", " ")})</option>)}
        </select>
      </label>
      <label className="grid gap-1">
        Reason for this correction
        <textarea className="min-h-20 min-w-0 rounded-md border border-[var(--nsn-border)] p-2" maxLength={500} onChange={(event) => setNote(event.target.value)} required value={note} />
      </label>
      <div>
        <button className="min-h-10 rounded-md border border-[var(--nsn-teal)] px-3 font-semibold text-[var(--nsn-teal)] disabled:opacity-50" disabled={busy || !sourceId || !targetId || !note.trim()} type="submit">Save correction</button>
      </div>
      {saved ? <p className="text-[var(--nsn-teal)]" role="status">Correction saved.</p> : null}
      {error ? <p className="text-red-700" role="alert">{error}</p> : null}
    </form>
  );
}
