import Link from "next/link";

import { BridgePairingPanel } from "@/components/library/BridgePairingPanel";
import { LibraryQuickNav } from "@/components/library/LibraryQuickNav";
import { NsnBadge } from "@/components/library/NsnBadge";
import { NsnCard } from "@/components/library/NsnCard";

export const dynamic = "force-dynamic";

export default function ConnectThisMacPage() {
  return (
    <main className="min-h-screen bg-[var(--nsn-cream)] px-4 py-8 text-[var(--nsn-navy)] sm:px-6 lg:px-8">
      <div className="mx-auto grid w-full max-w-4xl gap-6">
        <LibraryQuickNav />

        <header className="grid min-w-0 gap-4 rounded-xl border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] px-4 py-6 sm:px-6 lg:px-8">
          <NsnBadge tone="approved">Secure pairing</NsnBadge>
          <h1 className="nsn-display break-words text-4xl leading-tight [overflow-wrap:anywhere] sm:text-5xl">
            Connect This Mac
          </h1>
          <p className="max-w-3xl break-words text-base leading-8 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            Pairing lets the installed NSN Bridge identify this Mac to the
            Librarian. The Bridge still works only with folders Deanne chooses.
          </p>
        </header>

        <NsnCard className="min-w-0">
          <BridgePairingPanel />
        </NsnCard>

        <NsnCard className="grid min-w-0 gap-3" tone="aqua">
          <h2 className="nsn-display text-2xl">What pairing does</h2>
          <ul className="grid min-w-0 gap-2 text-sm leading-7 text-[var(--nsn-slate)]">
            <li>It registers this Mac as a paired Bridge device.</li>
            <li>It does not grant access to any folder by itself.</li>
            <li>Folder access starts only after Deanne chooses folders in the Bridge.</li>
            <li>Filesystem changes still require approved plans and final confirmation.</li>
          </ul>
        </NsnCard>

        <Link
          className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] sm:w-fit"
          href="/admin/library"
        >
          Return to Librarian
        </Link>
      </div>
    </main>
  );
}
