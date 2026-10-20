export function LibraryLoading({ label = "Loading this section…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="grid gap-4 rounded-xl border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-6">
      <p className="text-sm font-semibold text-[var(--nsn-slate)]">{label}</p>
      <div aria-hidden="true" className="grid gap-3 motion-safe:animate-pulse">
        <div className="h-6 w-2/5 rounded bg-[var(--nsn-sage-mist)]" />
        <div className="h-4 w-4/5 rounded bg-[var(--nsn-sage-mist)]" />
        <div className="h-4 w-3/5 rounded bg-[var(--nsn-sage-mist)]" />
      </div>
    </div>
  );
}
