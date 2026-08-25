"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

const quickLinks = [
  { href: "/admin/library", label: "Home" },
  { href: "/admin/library/connected-libraries", label: "Connected Libraries" },
  { href: "/admin/library/monitoring", label: "Monitoring" },
  { href: "/admin/library/review", label: "Recommendations" },
  { href: "/admin/library/migration", label: "Organization Plans" },
] as const;

export function LibraryQuickNav() {
  const router = useRouter();

  return (
    <nav
      aria-label="Quick library navigation"
      className="flex min-w-0 flex-wrap items-center gap-2"
    >
      <button
        className="inline-flex min-h-9 items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-xs font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
        onClick={() => router.back()}
        type="button"
      >
        ← Back
      </button>
      {quickLinks.map((item) => (
        <Link
          className="inline-flex min-h-9 items-center justify-center rounded-md border border-transparent px-3 text-xs font-semibold text-[var(--nsn-slate)] transition hover:border-[var(--nsn-border)] hover:bg-[var(--nsn-sage-mist)] hover:text-[var(--nsn-navy)]"
          href={item.href}
          key={item.href}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
