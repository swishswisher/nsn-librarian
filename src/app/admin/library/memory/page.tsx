import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getMemoryPageData } from "@/lib/library/memory";
import type { MemoryEntrySummary, MemoryType } from "@/types/library";

export const dynamic = "force-dynamic";

function formatConfidence(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
  }).format(new Date(value));
}

function memoryTypeLabel(memoryType: MemoryType) {
  if (memoryType === "THEME") {
    return "Theme";
  }

  if (memoryType === "TERM") {
    return "Term";
  }

  if (memoryType === "PREFERENCE") {
    return "Human preference";
  }

  if (memoryType === "RELATIONSHIP") {
    return "Relationship";
  }

  return "Note";
}

function memoryTypeTone(memoryType: MemoryType): NsnBadgeTone {
  if (memoryType === "THEME") {
    return "gold";
  }

  if (memoryType === "PREFERENCE") {
    return "approved";
  }

  if (memoryType === "RELATIONSHIP") {
    return "migration";
  }

  return "source";
}

function MemoryEntryCard({ entry }: { entry: MemoryEntrySummary }) {
  return (
    <article className="grid min-w-0 gap-3 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4">
      <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <h3 className="break-words text-base font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
            {entry.title}
          </h3>
          <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            {entry.description}
          </p>
        </div>
        <NsnBadge tone={memoryTypeTone(entry.memoryType)}>
          {memoryTypeLabel(entry.memoryType)}
        </NsnBadge>
      </div>

      <dl className="grid gap-3 text-xs leading-5 text-[var(--nsn-warm-gray)] sm:grid-cols-3">
        <div>
          <dt className="font-semibold uppercase tracking-[0.12em]">Seen</dt>
          <dd>{entry.occurrenceCount} times</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-[0.12em]">Confidence</dt>
          <dd>{formatConfidence(entry.confidence)}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-[0.12em]">Last seen</dt>
          <dd>{formatDate(entry.lastSeen)}</dd>
        </div>
      </dl>

      {entry.evidence.length > 0 ? (
        <ul className="grid gap-1 pl-4 text-xs leading-5 text-[var(--nsn-warm-gray)]">
          {entry.evidence.slice(0, 3).map((evidence) => (
            <li
              className="list-disc break-words [overflow-wrap:anywhere]"
              key={evidence}
            >
              {evidence}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function MemorySection({
  description,
  emptyDescription,
  entries,
  title,
}: {
  description: string;
  emptyDescription: string;
  entries: MemoryEntrySummary[];
  title: string;
}) {
  return (
    <section className="grid min-w-0 gap-4">
      <div className="min-w-0">
        <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--nsn-slate)]">
          {description}
        </p>
      </div>

      {entries.length > 0 ? (
        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          {entries.map((entry) => (
            <MemoryEntryCard entry={entry} key={entry.id} />
          ))}
        </div>
      ) : (
        <NsnEmptyState title="Nothing remembered here yet" description={emptyDescription} />
      )}
    </section>
  );
}

export default async function LibraryMemoryPage() {
  const memory = await getMemoryPageData();

  return (
    <LibraryShell active="memory">
      <div className="grid gap-8">
        <NsnPageHeader
          description="The Librarian remembers recurring patterns from approved reviews and human decisions. Rejected observations do not become Memory."
          eyebrow="Memory"
          title="Memory"
        />

        <NsnCard tone="aqua">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
            <div className="min-w-0">
              <p className="nsn-display text-2xl leading-8 text-[var(--nsn-navy)]">
                The Librarian remembers patterns, not assumptions.
              </p>
              <p className="mt-3 text-sm leading-7 text-[var(--nsn-slate)]">
                Human decisions shape memory. Memory evolves over time. Nothing is
                forgotten without human approval.
              </p>
            </div>
            <div className="rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 text-sm leading-7 text-[var(--nsn-slate)]">
              Memory is built from observation and review. It does not organize,
              move, or rewrite library items.
            </div>
          </div>
        </NsnCard>

        <MemorySection
          description="Themes are broad patterns that keep returning after approval."
          emptyDescription="Approve observations first. Themes appear only after the Librarian has repeated evidence."
          entries={memory.themes}
          title="Themes"
        />

        <MemorySection
          description="Preferred terms are recurring words from approved observations and review language."
          emptyDescription="The Librarian has not seen enough approved terminology yet."
          entries={memory.preferredTerms}
          title="Preferred terms"
        />

        <MemorySection
          description="Recurring concepts show relationships and notes that keep appearing in the library."
          emptyDescription="Related knowledge will appear here after approved observations create repeated connections."
          entries={memory.recurringConcepts}
          title="Recurring concepts"
        />

        <MemorySection
          description="Human preferences come from review decisions, including repeated approvals and repeated cautions."
          emptyDescription="Saved review notes will shape this section over time."
          entries={memory.humanPreferences}
          title="Human preferences"
        />

        <MemorySection
          description="Recently learned entries show what Memory has updated most recently."
          emptyDescription="Memory has not learned anything yet because no approved patterns have been saved."
          entries={memory.recentlyLearned}
          title="Recently learned"
        />
      </div>
    </LibraryShell>
  );
}
