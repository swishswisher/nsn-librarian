"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnButton } from "@/components/library/NsnButton";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import type {
  NotebookEntry,
  NotebookEntryDetail,
  NotebookEntryType,
  NotebookRevisionAction,
} from "@/types/library";

type LivingNotebookProps = {
  archiveEntries: NotebookEntry[];
  currentReflections: NotebookEntry[];
  needsAttention: NotebookEntry[];
  recentLearning: NotebookEntry[];
};

type NotebookTimelineProps = {
  learningUpdates: NotebookEntry[];
  mostImportantObservation: NotebookEntry | null;
  otherObservations: NotebookEntry[];
  questions: NotebookEntry[];
};

type NotebookEntryActionResult = {
  ok: boolean;
  error?: string;
};

const typeLabels: Record<NotebookEntryType, string> = {
  CONTEXT_NOTE: "Context Note",
  EMERGING_PATTERN: "Emerging Pattern",
  GROWING_THEME: "Growing Theme",
  HUMAN_REVISION: "Human Revision",
  LANGUAGE_PREFERENCE: "Language Preference",
  LEARNING_UPDATE: "Learning Update",
  MEMORY_LEARNING: "Memory Learning",
  OBSERVATION: "Observation",
  ORGANIZATION_DECISION: "Organization Decision",
  ORGANIZATION_RESULT: "Organization Result",
  POSSIBLE_DUPLICATE: "Possible Duplicate",
  POSSIBLE_RELATIONSHIP: "Possible Relationship",
  QUESTION: "Question",
  RECOMMENDATION_SUMMARY: "Recommendation Summary",
  REFLECTION: "Reflection",
  SCAN_SUMMARY: "Scan Summary",
  UNDO_RESULT: "Undo Result",
};

const typeTone: Record<NotebookEntryType, NsnBadgeTone> = {
  CONTEXT_NOTE: "source",
  EMERGING_PATTERN: "source",
  GROWING_THEME: "gold",
  HUMAN_REVISION: "approved",
  LANGUAGE_PREFERENCE: "approved",
  LEARNING_UPDATE: "approved",
  MEMORY_LEARNING: "approved",
  OBSERVATION: "migration",
  ORGANIZATION_DECISION: "gold",
  ORGANIZATION_RESULT: "migration",
  POSSIBLE_DUPLICATE: "review",
  POSSIBLE_RELATIONSHIP: "migration",
  QUESTION: "pending",
  RECOMMENDATION_SUMMARY: "source",
  REFLECTION: "unknown",
  SCAN_SUMMARY: "migration",
  UNDO_RESULT: "source",
};

const filterOptions = [
  { label: "Current", value: "CURRENT" },
  { label: "Needs Attention", value: "NEEDS_ATTENTION" },
  { label: "Learning", value: "LEARNING" },
  { label: "Questions", value: "QUESTIONS" },
  { label: "Organization", value: "ORGANIZATION" },
  { label: "Archive", value: "ARCHIVE" },
] as const;

const responseActions: Array<{
  label: string;
  value: NotebookRevisionAction;
}> = [
  { label: "Accept Reflection", value: "ACCEPT_REFLECTION" },
  { label: "Revise Reflection", value: "REVISE_REFLECTION" },
  { label: "Revise Wording", value: "REVISE_WORDING" },
  { label: "Add Context", value: "ADD_CONTEXT" },
  { label: "Answer Question", value: "ANSWER_QUESTION" },
  { label: "Reject Reflection", value: "REJECT_REFLECTION" },
  { label: "Approve for Memory", value: "APPROVE_FOR_MEMORY" },
  { label: "Keep as Notebook Only", value: "KEEP_NOTEBOOK_ONLY" },
];

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
  }).format(new Date(value));
}

function statusLabel(entry: NotebookEntry) {
  if (entry.status === "ARCHIVED") {
    return "Archived";
  }

  if (entry.status === "ACCEPTED") {
    return "Accepted";
  }

  if (entry.status === "REJECTED") {
    return "Rejected";
  }

  if (entry.status === "NOTEBOOK_ONLY") {
    return "Notebook only";
  }

  return "Current";
}

function searchTextForEntry(entry: NotebookEntry) {
  return [
    entry.title,
    entry.summary ?? "",
    entry.body,
    entry.provenanceSummary ?? "",
    entry.entryType ?? entry.type,
    ...entry.history,
    ...(entry.relatedDocuments ?? []),
    ...(entry.humanDecisions ?? []),
    ...(entry.sourceLinks ?? []).flatMap((link) => [link.kind, link.label]),
  ]
    .join(" ")
    .toLowerCase();
}

function entryMatchesFilter(entry: NotebookEntry, filter: string) {
  const type = entry.entryType ?? entry.type;

  if (filter === "CURRENT") {
    return entry.status !== "ARCHIVED";
  }

  if (filter === "NEEDS_ATTENTION") {
    return Boolean(entry.requiresAttention) || type === "QUESTION";
  }

  if (filter === "LEARNING") {
    return (
      type === "MEMORY_LEARNING" ||
      type === "HUMAN_REVISION" ||
      type === "LANGUAGE_PREFERENCE" ||
      type === "LEARNING_UPDATE"
    );
  }

  if (filter === "QUESTIONS") {
    return type === "QUESTION";
  }

  if (filter === "ORGANIZATION") {
    return (
      type === "RECOMMENDATION_SUMMARY" ||
      type === "ORGANIZATION_DECISION" ||
      type === "ORGANIZATION_RESULT" ||
      type === "UNDO_RESULT"
    );
  }

  if (filter === "ARCHIVE") {
    return true;
  }

  return true;
}

async function postNotebookAction(url: string) {
  const response = await fetch(url, {
    method: "POST",
  });
  const payload = (await response.json()) as NotebookEntryActionResult;

  if (!payload.ok) {
    throw new Error(payload.error ?? "The Notebook could not be updated.");
  }
}

function NotebookActionButtons({ entry }: { entry: NotebookEntry }) {
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isArchived = entry.status === "ARCHIVED";

  async function submit(action: "archive" | "restore") {
    if (isSaving) {
      return;
    }

    setIsSaving(true);
    setMessage(null);
    setError(null);

    try {
      await postNotebookAction(
        `/api/library/notebook/${encodeURIComponent(entry.id)}/${action}`,
      );
      setMessage(action === "archive" ? "Entry archived." : "Entry restored.");
      router.refresh();
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "The Notebook could not be updated.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-2">
      {isArchived ? (
        <NsnButton
          disabled={isSaving}
          onClick={() => submit("restore")}
          type="button"
          variant="primary"
        >
          {isSaving ? "Restoring..." : "Restore to Current"}
        </NsnButton>
      ) : (
        <NsnButton
          disabled={isSaving}
          onClick={() => submit("archive")}
          type="button"
          variant="secondary"
        >
          {isSaving ? "Archiving..." : "Archive Entry"}
        </NsnButton>
      )}
      <div aria-live="polite" className="grid gap-1">
        {message ? (
          <p className="text-xs leading-5 text-[var(--nsn-teal-dark)]">
            {message}
          </p>
        ) : null}
        {error ? (
          <p className="text-xs leading-5 text-[var(--nsn-warning)]" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SourceLinks({ entry }: { entry: NotebookEntry }) {
  const links = entry.sourceLinks ?? [];

  if (links.length === 0) {
    return null;
  }

  return (
    <div className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--nsn-teal)]">
        Related material
      </p>
      <div className="flex min-w-0 flex-wrap gap-2">
        {links.map((link) => (
          <Link
            className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] [overflow-wrap:anywhere]"
            href={link.href}
            key={`${link.kind}-${link.href}`}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function NotebookEntryCard({
  entry,
  featured = false,
}: {
  entry: NotebookEntry;
  featured?: boolean;
}) {
  const type = entry.entryType ?? entry.type;

  return (
    <article
      className={[
        "grid min-w-0 gap-4 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 shadow-[0_14px_34px_rgb(31_42_68_/_0.05)] sm:p-5",
        featured ? "border-[var(--nsn-gold)] bg-[linear-gradient(135deg,var(--nsn-card),var(--nsn-sand))]" : "",
      ].join(" ")}
    >
      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap gap-2">
            <NsnBadge tone={typeTone[type]}>{typeLabels[type]}</NsnBadge>
            <NsnBadge tone={entry.requiresAttention ? "review" : "source"}>
              {entry.requiresAttention ? "Needs attention" : statusLabel(entry)}
            </NsnBadge>
            {entry.approvedForMemory ? (
              <NsnBadge tone="approved">Approved for Memory review</NsnBadge>
            ) : null}
          </div>
          <h3 className="nsn-display mt-3 break-words text-2xl leading-8 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
            {entry.title}
          </h3>
          <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            {entry.summary ?? entry.body}
          </p>
        </div>
        <p className="text-sm leading-6 text-[var(--nsn-warm-gray)]">
          {formatDate(entry.updatedAt)}
        </p>
      </div>

      <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
        {entry.body}
      </p>

      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <SourceLinks entry={entry} />
        <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:min-w-52 lg:grid-cols-1">
          <Link
            className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)]"
            href={`/admin/library/notebook/${encodeURIComponent(entry.id)}`}
          >
            Open Reflection
          </Link>
          <NotebookActionButtons entry={entry} />
        </div>
      </div>
    </article>
  );
}

function NotebookSection({
  description,
  entries,
  featured = false,
  title,
}: {
  description: string;
  entries: NotebookEntry[];
  featured?: boolean;
  title: string;
}) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <section className="grid min-w-0 gap-4">
      <div className="min-w-0">
        <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">{title}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--nsn-slate)]">
          {description}
        </p>
      </div>
      <div className="grid min-w-0 gap-4">
        {entries.map((entry) => (
          <NotebookEntryCard entry={entry} featured={featured} key={entry.id} />
        ))}
      </div>
    </section>
  );
}

export function LivingNotebook({
  archiveEntries,
  currentReflections,
  needsAttention,
  recentLearning,
}: LivingNotebookProps) {
  const [activeFilter, setActiveFilter] = useState("CURRENT");
  const [query, setQuery] = useState("");
  const allEntries = archiveEntries;
  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return allEntries.filter((entry) => {
      const matchesFilter = entryMatchesFilter(entry, activeFilter);
      const matchesSearch =
        normalizedQuery.length === 0 ||
        searchTextForEntry(entry).includes(normalizedQuery);

      return matchesFilter && matchesSearch;
    });
  }, [activeFilter, allEntries, query]);
  const isFiltering = activeFilter !== "CURRENT" || query.trim().length > 0;

  if (allEntries.length === 0) {
    return (
      <NsnEmptyState
        description="Reflections will appear after scans, reviews, organization decisions, or Memory learning create meaningful Notebook material."
        title="The Notebook is quiet"
      />
    );
  }

  return (
    <section className="grid min-w-0 gap-6" aria-labelledby="living-notebook">
      <div className="grid gap-4 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.38fr)] lg:items-end">
        <div className="min-w-0">
          <h2
            className="nsn-display text-2xl text-[var(--nsn-navy)]"
            id="living-notebook"
          >
            Notebook Filters
          </h2>
          <p className="mt-1 text-sm leading-6 text-[var(--nsn-slate)]">
            Search reflections, decisions, related files, and approved terminology.
            The Notebook does not search full original document text.
          </p>
          <div
            aria-label="Notebook filters"
            className="mt-4 flex min-w-0 flex-wrap gap-2"
            role="group"
          >
            {filterOptions.map((filter) => (
              <button
                aria-pressed={activeFilter === filter.value}
                className={[
                  "inline-flex min-h-10 max-w-full items-center justify-center rounded-md border px-3 text-center text-sm font-semibold transition",
                  activeFilter === filter.value
                    ? "border-[var(--nsn-teal)] bg-[var(--nsn-teal)] text-[var(--nsn-white)]"
                    : "border-[var(--nsn-border)] bg-[var(--nsn-card)] text-[var(--nsn-navy)] hover:bg-[var(--nsn-sage-mist)]",
                ].join(" ")}
                key={filter.value}
                onClick={() => setActiveFilter(filter.value)}
                type="button"
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
        <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
          Search Notebook
          <input
            className="nsn-input w-full text-sm font-normal"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search reflections, decisions, files"
            type="search"
            value={query}
          />
        </label>
      </div>

      {isFiltering ? (
        filteredEntries.length > 0 ? (
          <NotebookSection
            description="Matching Notebook entries. Archive includes current and older entries so history remains visible."
            entries={filteredEntries}
            title="Filtered Notebook Entries"
          />
        ) : (
          <NsnEmptyState
            description="Try another word from a reflection, decision, related file, or approved term."
            title="No Notebook entries matched"
          />
        )
      ) : (
        <>
          <NotebookSection
            description="Recent reflections that still matter for current review."
            entries={currentReflections}
            featured
            title="Current Reflections"
          />
          <NotebookSection
            description="Questions, unresolved context, or work that needs Deanne's attention before it can move forward."
            entries={needsAttention}
            title="Needs Your Attention"
          />
          <NotebookSection
            description="Durable learning from approved decisions and wording changes."
            entries={recentLearning}
            title="Recent Learning"
          />
          <NotebookSection
            description="All Notebook entries remain available here. Archiving removes an entry from Current Reflections only."
            entries={archiveEntries.slice(0, 8)}
            title="Archive"
          />
        </>
      )}
    </section>
  );
}

export function NotebookTimeline({
  learningUpdates,
  mostImportantObservation,
  otherObservations,
  questions,
}: NotebookTimelineProps) {
  return (
    <LivingNotebook
      archiveEntries={[
        mostImportantObservation,
        ...otherObservations,
        ...questions,
        ...learningUpdates,
      ].filter((entry): entry is NotebookEntry => entry !== null)}
      currentReflections={[
        mostImportantObservation,
        ...otherObservations,
      ].filter((entry): entry is NotebookEntry => entry !== null)}
      needsAttention={questions}
      recentLearning={learningUpdates}
    />
  );
}

export function NotebookEntryDetailView({
  entry,
}: {
  entry: NotebookEntryDetail;
}) {
  const type = entry.entryType ?? entry.type;

  return (
    <div className="grid min-w-0 gap-6">
      <NsnCard tone="aqua">
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap gap-2">
              <NsnBadge tone={typeTone[type]}>{typeLabels[type]}</NsnBadge>
              <NsnBadge tone={entry.requiresAttention ? "review" : "source"}>
                {entry.requiresAttention ? "Needs attention" : statusLabel(entry)}
              </NsnBadge>
            </div>
            <h1 className="nsn-display mt-3 break-words text-4xl leading-tight text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
              {entry.title}
            </h1>
            <p className="mt-3 break-words text-base leading-8 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              {entry.summary}
            </p>
          </div>
          <p className="text-sm leading-6 text-[var(--nsn-warm-gray)]">
            Updated {formatDate(entry.updatedAt)}
          </p>
        </div>
      </NsnCard>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <section className="grid min-w-0 gap-4 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 sm:p-5">
          <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">
            Reflection
          </h2>
          <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            {entry.body}
          </p>
          <div className="rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-4">
            <h3 className="text-sm font-semibold text-[var(--nsn-navy)]">
              Why the Librarian created it
            </h3>
            <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              {entry.provenanceSummary}
            </p>
          </div>
        </section>

        <section className="grid min-w-0 gap-4 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 sm:p-5">
          <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">
            Provenance
          </h2>
          <SourceLinks entry={entry} />
          {entry.relatedKnowledge && entry.relatedKnowledge.length > 0 ? (
            <div className="grid min-w-0 gap-2">
              <h3 className="text-sm font-semibold text-[var(--nsn-navy)]">
                Related Knowledge
              </h3>
              <div className="flex min-w-0 flex-wrap gap-2">
                {entry.relatedKnowledge.map((knowledge) => (
                  <Link
                    className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] px-3 text-center text-sm font-semibold text-[var(--nsn-teal-dark)] transition hover:bg-[var(--nsn-soft-aqua)] [overflow-wrap:anywhere]"
                    href={knowledge.href}
                    key={knowledge.id}
                  >
                    {knowledge.label}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
          {entry.relatedEntries && entry.relatedEntries.length > 0 ? (
            <div className="grid min-w-0 gap-2">
              <h3 className="text-sm font-semibold text-[var(--nsn-navy)]">
                Related Notebook entries
              </h3>
              <div className="grid gap-2">
                {entry.relatedEntries.map((related) => (
                  <Link
                    className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] [overflow-wrap:anywhere]"
                    href={related.href}
                    key={related.href}
                  >
                    {related.label}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </div>

      <section className="grid min-w-0 gap-4 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 sm:p-5">
        <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">
          Evidence and History
        </h2>
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <EvidenceList title="Why I noticed this" items={entry.evidence.whyINoticedThis} />
          <EvidenceList title="Supporting material" items={entry.evidence.supportingMaterial} />
          <EvidenceList title="Earlier observations" items={entry.evidence.earlierObservations} />
          <EvidenceList title="Review decisions" items={entry.evidence.reviewDecisions} />
          <EvidenceList title="Timeline" items={entry.evidence.timeline} />
          <EvidenceList title="History" items={entry.history} />
        </div>
      </section>

      <NotebookResponsePanel entry={entry} />
    </div>
  );
}

function EvidenceList({ items, title }: { items: string[]; title: string }) {
  if (items.length === 0) {
    return (
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-[var(--nsn-navy)]">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-[var(--nsn-slate)]">
          Nothing recorded here yet.
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-[var(--nsn-navy)]">{title}</h3>
      <ul className="mt-2 grid gap-1 pl-4 text-sm leading-6 text-[var(--nsn-slate)]">
        {items.map((item) => (
          <li className="list-disc break-words [overflow-wrap:anywhere]" key={item}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NotebookResponsePanel({ entry }: { entry: NotebookEntryDetail }) {
  const router = useRouter();
  const [actionType, setActionType] =
    useState<NotebookRevisionAction>("ACCEPT_REFLECTION");
  const [note, setNote] = useState("");
  const [revisedTitle, setRevisedTitle] = useState("");
  const [revisedSummary, setRevisedSummary] = useState("");
  const [revisedBody, setRevisedBody] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submitResponse() {
    if (isSaving) {
      return;
    }

    setIsSaving(true);
    setMessage(null);
    setError(null);

    try {
      const response = await fetch(
        `/api/library/notebook/${encodeURIComponent(entry.id)}/response`,
        {
          body: JSON.stringify({
            actionType,
            note,
            revisedBody,
            revisedSummary,
            revisedTitle,
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      const payload = (await response.json()) as NotebookEntryActionResult;

      if (!payload.ok) {
        throw new Error(payload.error ?? "The Notebook response could not be saved.");
      }

      setMessage("Response saved. The original reflection remains preserved.");
      setNote("");
      setRevisedTitle("");
      setRevisedSummary("");
      setRevisedBody("");
      router.refresh();
    } catch (responseError) {
      setError(
        responseError instanceof Error
          ? responseError.message
          : "The Notebook response could not be saved.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="grid min-w-0 gap-4 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 sm:p-5">
      <div className="min-w-0">
        <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">
          Deanne&apos;s Response
        </h2>
        <p className="mt-1 text-sm leading-7 text-[var(--nsn-slate)]">
          Responses are stored separately so the original machine-created
          reflection remains visible. Approving for Memory records human intent;
          it does not insert raw Notebook text into trusted Memory.
        </p>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
          Response action
          <select
            className="nsn-input min-h-11 text-sm font-normal"
            onChange={(event) =>
              setActionType(event.target.value as NotebookRevisionAction)
            }
            value={actionType}
          >
            {responseActions.map((action) => (
              <option key={action.value} value={action.value}>
                {action.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
          Revised title
          <input
            className="nsn-input text-sm font-normal"
            onChange={(event) => setRevisedTitle(event.target.value)}
            placeholder="Optional"
            value={revisedTitle}
          />
        </label>
        <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
          Revised summary
          <textarea
            className="nsn-input min-h-24 resize-y text-sm font-normal"
            onChange={(event) => setRevisedSummary(event.target.value)}
            placeholder="Optional"
            value={revisedSummary}
          />
        </label>
        <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
          Revised reflection
          <textarea
            className="nsn-input min-h-24 resize-y text-sm font-normal"
            onChange={(event) => setRevisedBody(event.target.value)}
            placeholder="Optional"
            value={revisedBody}
          />
        </label>
      </div>
      <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
        Context or answer
        <textarea
          className="nsn-input min-h-28 resize-y text-sm font-normal"
          onChange={(event) => setNote(event.target.value)}
          placeholder="Add context, answer a question, or explain a revision."
          value={note}
        />
      </label>

      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
        <NsnButton
          disabled={isSaving}
          onClick={submitResponse}
          type="button"
          variant="primary"
        >
          {isSaving ? "Saving..." : "Save Response"}
        </NsnButton>
        <NotebookActionButtons entry={entry} />
      </div>

      <div aria-live="polite" className="grid gap-2">
        {message ? (
          <p className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-teal-dark)]">
            {message}
          </p>
        ) : null}
        {error ? (
          <p
            className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-warning)]"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </div>

      <div className="grid min-w-0 gap-3">
        <h3 className="text-sm font-semibold text-[var(--nsn-navy)]">
          Response History
        </h3>
        {entry.revisions.length > 0 ? (
          <div className="grid gap-3">
            {entry.revisions.map((revision) => (
              <NsnCard className="min-w-0" key={revision.id}>
                <NsnBadge tone="source">
                  {revision.actionType.replaceAll("_", " ").toLowerCase()}
                </NsnBadge>
                <p className="mt-2 text-xs leading-5 text-[var(--nsn-warm-gray)]">
                  {formatDate(revision.createdAt)}
                </p>
                {revision.note ? (
                  <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                    {revision.note}
                  </p>
                ) : null}
                {revision.revisedTitle ||
                revision.revisedSummary ||
                revision.revisedBody ? (
                  <div className="mt-3 grid gap-2 text-sm leading-6 text-[var(--nsn-slate)]">
                    {revision.revisedTitle ? (
                      <p className="break-words [overflow-wrap:anywhere]">
                        Revised title: {revision.revisedTitle}
                      </p>
                    ) : null}
                    {revision.revisedSummary ? (
                      <p className="break-words [overflow-wrap:anywhere]">
                        Revised summary: {revision.revisedSummary}
                      </p>
                    ) : null}
                    {revision.revisedBody ? (
                      <p className="break-words [overflow-wrap:anywhere]">
                        Revised reflection: {revision.revisedBody}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </NsnCard>
            ))}
          </div>
        ) : (
          <p className="text-sm leading-6 text-[var(--nsn-slate)]">
            No human response has been saved yet.
          </p>
        )}
      </div>
    </section>
  );
}
