import Link from "next/link";

import { LibraryShell } from "@/components/library/LibraryShell";
import { NotebookEntryCard } from "@/components/library/NotebookTimeline";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getNotebookArchivePageData } from "@/lib/library/notebook";
import { getNotebookRoute } from "@/lib/library/routes";

export const dynamic = "force-dynamic";

export default async function NotebookArchivePage() {
  const archiveEntries = await getNotebookArchivePageData();

  return (
    <LibraryShell active="notebook">
      <div className="grid gap-8">
        <NsnPageHeader
          description="All Notebook entries remain available here, including entries archived out of Current Reflections. Ordinary UI actions never permanently delete Notebook history."
          eyebrow="Notebook Archive"
          title="Notebook Archive"
        >
          <Link
            className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
            href={getNotebookRoute()}
          >
            Back to Notebook
          </Link>
        </NsnPageHeader>

        {archiveEntries.length > 0 ? (
          <section className="grid min-w-0 gap-4" aria-label="Archived notebook reflections">
            {archiveEntries.map((entry) => (
              <NotebookEntryCard entry={entry} key={entry.id} />
            ))}
          </section>
        ) : (
          <NsnEmptyState
            description="Archive entries appear after scans, review decisions, organization work, or Memory learning create Notebook material to preserve."
            title="The archive is quiet"
          />
        )}
      </div>
    </LibraryShell>
  );
}
