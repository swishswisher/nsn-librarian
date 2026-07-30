import Link from "next/link";

import { NsnBadge } from "@/components/library/NsnBadge";
import { NsnCard } from "@/components/library/NsnCard";
import { getConnectedLibrariesRoute } from "@/lib/library/routes";

export function ConnectFolderCard() {
  return (
    <NsnCard className="h-full" tone="sand">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2
            className="nsn-display text-2xl text-[var(--nsn-navy)]"
            id="connect-folder-heading"
          >
            Connect Folder
          </h2>
          <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            The MacBook remains the source of truth. The Librarian will receive
            a record of each folder scan through the NSN Bridge, not copied
            files.
          </p>
        </div>
        <NsnBadge tone="pending">Bridge not connected</NsnBadge>
      </div>

      <div className="mt-5 grid gap-4">
        <p
          className="rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3 text-sm leading-6 text-[var(--nsn-slate)]"
          role="status"
        >
          Bridge support is coming through Connected Libraries.
        </p>
        <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
          Connected Folders let the Bridge scan approved folders while the web
          app stores only observations, relationships, decisions, preferences,
          recommendations, notebook entries, scan sessions, and organization
          history.
        </p>
        <Link
          className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] sm:w-fit"
          href={getConnectedLibrariesRoute()}
        >
          Open Connected Libraries
        </Link>
      </div>
    </NsnCard>
  );
}
