type NsnSearchFieldProps = {
  label?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  resultCount?: number;
  value: string;
};

export function NsnSearchField({
  label = "Search",
  onChange,
  placeholder = "Search by file name or path",
  resultCount,
  value,
}: NsnSearchFieldProps) {
  const id = `nsn-search-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <div className="grid min-w-0 gap-2 sm:max-w-xl">
      <label className="text-sm font-semibold text-[var(--nsn-navy)]" htmlFor={id}>
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <input
          className="min-h-11 min-w-0 flex-1 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-base text-[var(--nsn-navy)] outline-none transition placeholder:text-[var(--nsn-warm-gray)] focus:border-[var(--nsn-teal)] focus:ring-2 focus:ring-[var(--nsn-soft-aqua)]"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          type="search"
          value={value}
        />
        {value ? (
          <button
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] px-3 text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
            onClick={() => onChange("")}
            type="button"
          >
            Clear
          </button>
        ) : null}
      </div>
      {typeof resultCount === "number" ? (
        <p aria-live="polite" className="text-sm text-[var(--nsn-slate)]">
          {resultCount} matching result{resultCount === 1 ? "" : "s"}
        </p>
      ) : null}
    </div>
  );
}
