import Link from "next/link";

import { LibraryShell } from "@/components/library/LibraryShell";
import { LivingNotebook } from "@/components/library/NotebookTimeline";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getNotebookPageData } from "@/lib/library/notebook";
import { getNotebookArchiveRoute } from "@/lib/library/routes";
import type { NotebookDigest } from "@/types/library";

export const dynamic = "force-dynamic";

function digestLine(label: string, value: number, noun: string) {
  return (
    <div className="rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4">
      <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--nsn-teal)]">
        {label}
      </dt>
      <dd className="mt-2 text-sm leading-6 text-[var(--nsn-slate)]">
        <span className="nsn-display mr-2 text-3xl text-[var(--nsn-navy)]">
          {value}
        </span>
        {noun}
      </dd>
    </div>
  );
}

function TodaysNotebook({ digest }: { digest: NotebookDigest }) {
  return (
    <NsnCard tone="sand">
      <section className="grid gap-5" aria-labelledby="todays-notebook">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--nsn-teal)]">
            Today&apos;s Notebook
          </p>
          <h2
            className="nsn-display mt-2 text-3xl text-[var(--nsn-navy)]"
            id="todays-notebook"
          >
            What the Librarian is holding today
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--nsn-slate)]">
            The Librarian reflects before speaking. The machine suggests. Deanne
            decides.
          </p>
        </div>

        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {digestLine("Examined", digest.examinedItemsToday, "new items")}
          {digestLine("Remembered", digest.growingThemesToday, "growing themes")}
          {digestLine("Found", digest.possibleRelationshipsToday, "possible relationships")}
          {digestLine("Learned", digest.learnedPreferencesToday, "writing preferences")}
          {digestLine("Waiting", digest.waitingQuestions, "questions for review")}
        </dl>
      </section>
    </NsnCard>
  );
}

export default async function LibraryNotebookPage() {
  const notebook = await getNotebookPageData();

  return (
    <LibraryShell active="notebook">
      <div className="grid gap-8">
        <NsnPageHeader
          description="The Librarian's reflective record of what was noticed, what changed, what was learned, and what still needs Deanne's attention."
          eyebrow="Notebook"
          title="The Living Notebook"
        >
          <Link
            className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
            href={getNotebookArchiveRoute()}
          >
            Open Archive
          </Link>
        </NsnPageHeader>

        <TodaysNotebook digest={notebook.digest} />

        <LivingNotebook
          archiveEntries={notebook.archiveEntries}
          currentReflections={notebook.currentReflections ?? []}
          needsAttention={notebook.needsAttention ?? []}
          recentLearning={notebook.recentLearning ?? []}
        />
      </div>
    </LibraryShell>
  );
}
