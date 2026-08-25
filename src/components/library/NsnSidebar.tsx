import Link from "next/link";

export type LibrarySection =
  | "overview"
  | "batches"
  | "connected-libraries"
  | "documents"
  | "monitoring"
  | "review"
  | "notebook"
  | "knowledge"
  | "memory"
  | "taxonomy"
  | "migration"
  | "history";

type NsnSidebarProps = {
  active: LibrarySection;
};

const navItems: Array<{ label: string; href: string; section: LibrarySection }> = [
  { label: "Home", href: "/admin/library", section: "overview" },
  {
    label: "Connected Libraries",
    href: "/admin/library/connected-libraries",
    section: "connected-libraries",
  },
  { label: "Library", href: "/admin/library/documents", section: "documents" },
  {
    label: "Monitoring",
    href: "/admin/library/monitoring",
    section: "monitoring",
  },
  { label: "Recommendations", href: "/admin/library/review", section: "review" },
  {
    label: "Organization Plans",
    href: "/admin/library/migration",
    section: "migration",
  },
  { label: "Notebook", href: "/admin/library/notebook", section: "notebook" },
  { label: "Knowledge", href: "/admin/library/knowledge", section: "knowledge" },
  { label: "Memory", href: "/admin/library/memory", section: "memory" },
  { label: "Activity", href: "/admin/library/history", section: "history" },
];

export function NsnSidebar({ active }: NsnSidebarProps) {
  return (
    <aside className="border-r border-[var(--nsn-border)] bg-[var(--nsn-card)] px-5 py-6 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto">
      <div className="flex min-h-full flex-col gap-8">
        <div>
          <div className="flex h-11 w-11 items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-soft-aqua)] text-sm font-semibold text-[var(--nsn-teal-dark)]">
            NSN
          </div>
          <h2 className="nsn-display mt-4 text-2xl text-[var(--nsn-navy)]">
            NSN Librarian
          </h2>
          <p className="mt-2 text-sm leading-6 text-[var(--nsn-slate)]">
            Domestic Appeal LLC
            <br />
            Neural Synergistic Network
          </p>
        </div>

        <nav aria-label="Library sections">
          <ul className="grid gap-1.5">
            {navItems.map((item) => {
              const isActive = item.section === active;

              return (
                <li key={item.href}>
                  <Link
                    aria-current={isActive ? "page" : undefined}
                    className={[
                      "flex min-h-11 items-center rounded-md border px-3 text-sm font-semibold transition",
                      isActive
                        ? "border-[var(--nsn-soft-aqua)] bg-[var(--nsn-soft-aqua)] text-[var(--nsn-teal-dark)]"
                        : "border-transparent text-[var(--nsn-slate)] hover:border-[var(--nsn-border)] hover:bg-[var(--nsn-sage-mist)] hover:text-[var(--nsn-navy)]",
                    ].join(" ")}
                    href={item.href}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="mt-auto grid gap-4">
          <div className="rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-4">
            <p className="nsn-display text-lg leading-7 text-[var(--nsn-navy)]">
              The machine suggests.
              <br />
              Deanne decides.
              <br />
              Nothing moves without approval.
            </p>
          </div>
          <div className="border-t border-[var(--nsn-border)] pt-4 text-xs uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
            <p>NSN System</p>
            <p className="mt-1 text-[var(--nsn-teal)]">v1.0.0</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
