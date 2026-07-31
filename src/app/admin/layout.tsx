import type { ReactNode } from "react";

import { requireHumanSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await requireHumanSession("/admin/library");

  return (
    <>
      <div className="fixed right-3 top-3 z-[100] flex items-center gap-3 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)]/95 px-3 py-2 shadow-lg backdrop-blur sm:right-5 sm:top-5">
        <div className="hidden min-w-0 sm:block">
          <p className="max-w-44 truncate text-xs font-semibold text-[var(--nsn-navy)]">
            {session.name}
          </p>
          <p className="max-w-44 truncate text-[10px] uppercase tracking-[0.12em] text-[var(--nsn-warm-gray)]">
            {session.role === "OWNER" ? "Owner" : "Approved librarian"}
          </p>
        </div>
        <form action="/api/auth/logout" method="post">
          <button
            className="rounded-md border border-[var(--nsn-border)] bg-white px-3 py-2 text-xs font-bold text-[var(--nsn-slate)] transition hover:border-[var(--nsn-teal)] hover:text-[var(--nsn-teal-dark)]"
            type="submit"
          >
            Sign out
          </button>
        </form>
      </div>
      {children}
    </>
  );
}
