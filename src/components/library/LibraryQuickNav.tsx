"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const primaryLinks = [
  { href: "/admin/library", label: "Home" },
  { href: "/admin/library/connected-libraries", label: "Connected" },
  { href: "/admin/library/documents", label: "Library" },
  { href: "/admin/library/monitoring", label: "Monitoring" },
  { href: "/admin/library/review", label: "Recommendations" },
  { href: "/admin/library/migration", label: "Plans" },
  { href: "/admin/library/notebook", label: "Notebook" },
  { href: "/admin/library/history", label: "Activity" },
] as const;

const setupLinks = [
  { href: "/connect-this-mac", label: "Connect Mac" },
  { href: "/download/bridge", label: "Bridge Download" },
] as const;

function isActivePath(pathname: string, href: string) {
  if (href === "/admin/library") {
    return pathname === href;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export function LibraryQuickNav() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--nsn-border)] bg-[var(--nsn-card)]/95 p-2 shadow-[0_8px_28px_rgba(23,49,59,0.06)] backdrop-blur sm:flex-row sm:items-center">
      <div className="flex shrink-0 items-center gap-2">
        <button
          aria-label="Go to the previous page"
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-cream)] px-3 text-sm font-semibold text-[var(--nsn-navy)] transition hover:border-[var(--nsn-soft-aqua)] hover:bg-[var(--nsn-sage-mist)]"
          onClick={() => router.back()}
          type="button"
        >
          <span aria-hidden="true">←</span>
          <span>Back</span>
        </button>
        <Link
          className="inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-semibold text-[var(--nsn-teal-dark)] transition hover:bg-[var(--nsn-sage-mist)]"
          href="/admin/library"
        >
          NSN Librarian
        </Link>
      </div>

      <div aria-hidden="true" className="hidden h-7 w-px shrink-0 bg-[var(--nsn-border)] sm:block" />

      <nav
        aria-label="Librarian navigation"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-1 sm:pb-0"
      >
        {primaryLinks.map((item) => {
          const active = isActivePath(pathname, item.href);

          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={[
                "inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg px-3 text-sm font-semibold transition",
                active
                  ? "bg-[var(--nsn-soft-aqua)] text-[var(--nsn-teal-dark)] shadow-sm"
                  : "text-[var(--nsn-slate)] hover:bg-[var(--nsn-sage-mist)] hover:text-[var(--nsn-navy)]",
              ].join(" ")}
              href={item.href}
              key={item.href}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div aria-hidden="true" className="hidden h-7 w-px shrink-0 bg-[var(--nsn-border)] xl:block" />

      <nav
        aria-label="Mac setup navigation"
        className="flex shrink-0 items-center gap-1 overflow-x-auto"
      >
        {setupLinks.map((item) => {
          const active = isActivePath(pathname, item.href);

          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={[
                "inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg border px-3 text-sm font-semibold transition",
                active
                  ? "border-[var(--nsn-teal)] bg-[var(--nsn-teal)] text-white"
                  : "border-[var(--nsn-border)] bg-[var(--nsn-cream)] text-[var(--nsn-navy)] hover:border-[var(--nsn-soft-aqua)] hover:bg-[var(--nsn-sage-mist)]",
              ].join(" ")}
              href={item.href}
              key={item.href}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
