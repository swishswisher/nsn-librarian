import Link from "next/link";
import { notFound } from "next/navigation";

import { LibraryShell } from "@/components/library/LibraryShell";
import { NotebookEntryDetailView } from "@/components/library/NotebookTimeline";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getNotebookEntryDetail } from "@/lib/library/notebook";
import { getNotebookArchiveRoute, getNotebookRoute } from "@/lib/library/routes";

export const dynamic = "force-dynamic";

type NotebookEntryDetailPageProps = {
  params: Promise<{
    entryId: string;
  }>;
};

export default async function NotebookEntryDetailPage({
  params,
}: NotebookEntryDetailPageProps) {
  const { entryId } = await params;
  const entry = await getNotebookEntryDetail(entryId);

  if (!entry) {
    notFound();
  }

  return (
    <LibraryShell active="notebook">
      <div className="grid min-w-0 gap-8">
        <NsnPageHeader
          description="A focused view of the reflection, its provenance, related work, and Deanne's responses."
          eyebrow="Notebook Reflection"
          title="Reflection Detail"
        >
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <Link
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
              href={getNotebookRoute()}
            >
              Back to Notebook
            </Link>
            <Link
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
              href={getNotebookArchiveRoute()}
            >
              Open Archive
            </Link>
          </div>
        </NsnPageHeader>

        <NotebookEntryDetailView entry={entry} />
      </div>
    </LibraryShell>
  );
}
