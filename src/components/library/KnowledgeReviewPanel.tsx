"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useRouter } from "next/navigation";

import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnButton } from "@/components/library/NsnButton";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import {
  getKnowledgeTopicRoute,
} from "@/lib/library/routes";
import {
  formatKnowledgeRelationshipType,
  isOrganizationHistoryRelationshipType,
  knowledgeObjectProposalLabel,
  knowledgeRelationshipProposalLabel,
  organizationHistoryLocationsFromEvidence,
} from "@/lib/knowledge/presentation";
import {
  knowledgeObjectTypes,
  type KnowledgeObjectSummary,
  type KnowledgeObjectType,
  type KnowledgeRelationshipSummary,
} from "@/types/library";

type KnowledgeReviewPanelProps = {
  mergeTargets: KnowledgeObjectSummary[];
  objects: KnowledgeObjectSummary[];
  relationships: KnowledgeRelationshipSummary[];
};

type DialogState =
  | { mode: "REVISE_OBJECT"; object: KnowledgeObjectSummary }
  | { mode: "MERGE_OBJECT"; object: KnowledgeObjectSummary }
  | { mode: "REVISE_RELATIONSHIP"; relationship: KnowledgeRelationshipSummary }
  | null;

type FilterValue =
  | "ALL"
  | "NEEDS_REVIEW"
  | "APPROVED"
  | "PROVISIONAL"
  | "REJECTED"
  | KnowledgeObjectType;

type ActionResponse = {
  ok: boolean;
  error?: string;
};

const filterOptions: Array<{ label: string; value: FilterValue }> = [
  { label: "All", value: "ALL" },
  { label: "Needs Review", value: "NEEDS_REVIEW" },
  { label: "Approved", value: "APPROVED" },
  { label: "Provisional", value: "PROVISIONAL" },
  { label: "Rejected", value: "REJECTED" },
  { label: "Topics", value: "TOPIC" },
  { label: "Concepts", value: "CONCEPT" },
  { label: "Frameworks", value: "FRAMEWORK" },
  { label: "People", value: "PERSON" },
  { label: "Projects", value: "PROJECT" },
  { label: "Workshops", value: "WORKSHOP" },
];

const objectTypeLabels: Record<KnowledgeObjectType, string> = {
  CONCEPT: "Concept",
  DECISION: "Decision",
  FRAMEWORK: "Framework",
  PERSON: "Person",
  PREFERENCE: "Preference",
  PROJECT: "Project",
  RESOURCE: "Resource",
  TOPIC: "Topic",
  WEBSITE_ARTICLE: "Website Article",
  WORKSHOP: "Workshop",
};

function statusTone(status: string): NsnBadgeTone {
  if (status === "APPROVED") {
    return "approved";
  }

  if (status === "REJECTED" || status === "ARCHIVED") {
    return "review";
  }

  return "pending";
}

function formatConfidence(value: number) {
  return `${Math.round(value * 100)}%`;
}

function searchTextForObject(object: KnowledgeObjectSummary) {
  return [
    object.name,
    object.description,
    object.objectType,
    object.status,
    object.provenanceSummary,
    ...object.evidence.appearedIn,
    ...object.evidence.relatedFiles,
    ...object.evidence.whyProposed,
  ]
    .join(" ")
    .toLowerCase();
}

function objectMatchesFilter(object: KnowledgeObjectSummary, filter: FilterValue) {
  if (filter === "ALL") {
    return true;
  }

  if (filter === "NEEDS_REVIEW") {
    return object.status === "PROVISIONAL";
  }

  if (
    filter === "APPROVED" ||
    filter === "PROVISIONAL" ||
    filter === "REJECTED"
  ) {
    return object.status === filter;
  }

  return object.objectType === filter;
}

function relationshipMatchesSearch(
  relationship: KnowledgeRelationshipSummary,
  query: string,
) {
  if (!query) {
    return true;
  }

  return [
    relationship.sourceName,
    relationship.targetName,
    relationship.relationshipType,
    relationship.explanation,
    relationship.provenanceSummary,
    ...relationship.evidence.appearedIn,
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

async function postJson(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const payload = (await response.json()) as ActionResponse;

  if (!payload.ok) {
    throw new Error(payload.error ?? "The knowledge review could not be saved.");
  }
}

export function KnowledgeReviewPanel({
  mergeTargets,
  objects,
  relationships,
}: KnowledgeReviewPanelProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterValue>("NEEDS_REVIEW");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLowerCase();

  const filteredObjects = useMemo(
    () =>
      objects.filter(
        (object) =>
          objectMatchesFilter(object, activeFilter) &&
          (!normalizedQuery ||
            searchTextForObject(object).includes(normalizedQuery)),
      ),
    [activeFilter, normalizedQuery, objects],
  );
  const visibleRelationships = useMemo(
    () =>
      relationships
        .filter((relationship) =>
          activeFilter === "NEEDS_REVIEW"
            ? relationship.status === "PROVISIONAL"
            : activeFilter === "APPROVED" ||
                activeFilter === "PROVISIONAL" ||
                activeFilter === "REJECTED"
              ? relationship.status === activeFilter
              : true,
        )
        .filter((relationship) =>
          relationshipMatchesSearch(relationship, normalizedQuery),
        )
        .slice(0, 40),
    [activeFilter, normalizedQuery, relationships],
  );

  async function submitObjectAction(
    objectId: string,
    action: "APPROVE" | "REJECT" | "KEEP_PROVISIONAL",
  ) {
    setSavingKey(`${objectId}:${action}`);
    setMessage(null);
    setError(null);

    try {
      await postJson(`/api/library/knowledge/objects/${encodeURIComponent(objectId)}/decision`, {
        action,
      });
      setMessage("Knowledge review saved.");
      router.refresh();
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "The knowledge review could not be saved.",
      );
    } finally {
      setSavingKey(null);
    }
  }

  async function submitRelationshipAction(
    relationshipId: string,
    action: "APPROVE" | "REJECT" | "KEEP_PROVISIONAL",
  ) {
    setSavingKey(`${relationshipId}:${action}`);
    setMessage(null);
    setError(null);

    try {
      await postJson(
        `/api/library/knowledge/relationships/${encodeURIComponent(
          relationshipId,
        )}/decision`,
        { action },
      );
      setMessage("Relationship review saved.");
      router.refresh();
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "The relationship review could not be saved.",
      );
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <section className="grid min-w-0 gap-6" aria-labelledby="knowledge-review">
      <div className="grid gap-4 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.35fr)] lg:items-end">
        <div className="min-w-0">
          <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]" id="knowledge-review">
            Knowledge Review
          </h2>
          <p className="mt-1 text-sm leading-6 text-[var(--nsn-slate)]">
            Review proposed topics, concepts, frameworks, and relationships before
            they become trusted knowledge.
          </p>
          <div
            aria-label="Knowledge filters"
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
          Search Knowledge
          <input
            className="nsn-input text-sm font-normal"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search topics, concepts, files"
            type="search"
            value={query}
          />
        </label>
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

      {filteredObjects.length > 0 ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {filteredObjects.map((object) => (
            <KnowledgeObjectCard
              key={object.id}
              mergeTargets={mergeTargets}
              object={object}
              onAction={submitObjectAction}
              onOpenDialog={setDialog}
              savingKey={savingKey}
            />
          ))}
        </div>
      ) : (
        <NsnEmptyState
          description="Try another filter or search term. Rejected items remain available for history."
          title="No knowledge items matched"
        />
      )}

      <section className="grid min-w-0 gap-4" aria-labelledby="relationship-review">
        <div className="min-w-0">
          <h2
            className="nsn-display text-2xl text-[var(--nsn-navy)]"
            id="relationship-review"
          >
            Relationship Review
          </h2>
          <p className="mt-1 text-sm leading-6 text-[var(--nsn-slate)]">
            Relationships stay provisional until Deanne reviews them.
          </p>
        </div>
        {visibleRelationships.length > 0 ? (
          <div className="grid min-w-0 gap-4">
            {visibleRelationships.map((relationship) => (
              <RelationshipCard
                key={relationship.id}
                onAction={submitRelationshipAction}
                onOpenDialog={setDialog}
                relationship={relationship}
                savingKey={savingKey}
              />
            ))}
          </div>
        ) : (
          <NsnEmptyState
            description="No relationships match this filter yet."
            title="No relationships in this view"
          />
        )}
      </section>

      <KnowledgeReviewDialog
        dialog={dialog}
        mergeTargets={mergeTargets}
        onClose={() => setDialog(null)}
        onError={setError}
        onMessage={setMessage}
      />
    </section>
  );
}

function KnowledgeObjectCard({
  mergeTargets,
  object,
  onAction,
  onOpenDialog,
  savingKey,
}: {
  mergeTargets: KnowledgeObjectSummary[];
  object: KnowledgeObjectSummary;
  onAction: (
    objectId: string,
    action: "APPROVE" | "REJECT" | "KEEP_PROVISIONAL",
  ) => void;
  onOpenDialog: (dialog: DialogState) => void;
  savingKey: string | null;
}) {
  const canMerge = mergeTargets.some((target) => target.id !== object.id);

  return (
    <NsnCard className="min-w-0">
      <article className="grid h-full min-w-0 gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap gap-2">
            <NsnBadge tone="source">{objectTypeLabels[object.objectType]}</NsnBadge>
            <NsnBadge tone={statusTone(object.status)}>{object.status.toLowerCase()}</NsnBadge>
            <NsnBadge tone={object.trustLevel === "HUMAN_APPROVED" ? "approved" : "pending"}>
              {object.trustLevel === "HUMAN_APPROVED"
                ? "Trusted"
                : object.trustLevel === "EXCLUDED"
                  ? "Excluded"
                  : "Needs review"}
            </NsnBadge>
          </div>
          <Link
            className="group mt-3 block min-w-0"
            href={getKnowledgeTopicRoute(object.id)}
          >
            <h3 className="nsn-display break-words text-2xl leading-8 text-[var(--nsn-navy)] [overflow-wrap:anywhere] group-hover:text-[var(--nsn-teal-dark)]">
              <span className="block text-sm font-semibold uppercase tracking-[0.12em] text-[var(--nsn-teal-dark)]">
                {knowledgeObjectProposalLabel(object.objectType)}:
              </span>
              {object.name}
            </h3>
          </Link>
          <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            {object.description}
          </p>
        </div>

        <dl className="grid gap-3 text-xs leading-5 text-[var(--nsn-warm-gray)] sm:grid-cols-3">
          <div>
            <dt className="font-semibold uppercase tracking-[0.12em]">Seen</dt>
            <dd>{object.occurrenceCount} times</dd>
          </div>
          <div>
            <dt className="font-semibold uppercase tracking-[0.12em]">Confidence</dt>
            <dd>{formatConfidence(object.confidence)}</dd>
          </div>
          <div>
            <dt className="font-semibold uppercase tracking-[0.12em]">Connections</dt>
            <dd>{object.relationshipCount}</dd>
          </div>
        </dl>

        <div className="rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3 text-sm leading-6 text-[var(--nsn-slate)]">
          <p className="font-semibold text-[var(--nsn-navy)]">Why proposed</p>
          <p className="mt-1 break-words [overflow-wrap:anywhere]">
            {object.provenanceSummary}
          </p>
        </div>

        <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <NsnButton
            disabled={savingKey !== null}
            onClick={() => onAction(object.id, "APPROVE")}
            type="button"
            variant="primary"
          >
            {savingKey === `${object.id}:APPROVE` ? "Approving..." : "Approve"}
          </NsnButton>
          <NsnButton
            disabled={savingKey !== null}
            onClick={() => onOpenDialog({ mode: "REVISE_OBJECT", object })}
            type="button"
            variant="accent"
          >
            Revise
          </NsnButton>
          <NsnButton
            disabled={savingKey !== null}
            onClick={() => onAction(object.id, "REJECT")}
            type="button"
            variant="secondary"
          >
            Reject
          </NsnButton>
          <NsnButton
            disabled={savingKey !== null}
            onClick={() => onAction(object.id, "KEEP_PROVISIONAL")}
            type="button"
            variant="secondary"
          >
            Keep Provisional
          </NsnButton>
          <NsnButton
            disabled={!canMerge || savingKey !== null}
            onClick={() => onOpenDialog({ mode: "MERGE_OBJECT", object })}
            type="button"
            variant="secondary"
          >
            Merge with Existing
          </NsnButton>
        </div>
      </article>
    </NsnCard>
  );
}

function RelationshipCard({
  onAction,
  onOpenDialog,
  relationship,
  savingKey,
}: {
  onAction: (
    relationshipId: string,
    action: "APPROVE" | "REJECT" | "KEEP_PROVISIONAL",
  ) => void;
  onOpenDialog: (dialog: DialogState) => void;
  relationship: KnowledgeRelationshipSummary;
  savingKey: string | null;
}) {
  const isOrganizationHistory = isOrganizationHistoryRelationshipType(
    relationship.relationshipType,
  );
  const locations = organizationHistoryLocationsFromEvidence(relationship.evidence);
  const relationshipLabel = formatKnowledgeRelationshipType(
    relationship.relationshipType,
  );

  return (
    <NsnCard className="min-w-0">
      <article className="grid min-w-0 gap-4">
        <div className="flex flex-wrap gap-2">
          <NsnBadge tone={statusTone(relationship.status)}>
            {relationship.status.toLowerCase()}
          </NsnBadge>
          <NsnBadge tone="migration">
            {relationshipLabel}
          </NsnBadge>
          {isOrganizationHistory ? (
            <NsnBadge tone="source">Observed in organization history</NsnBadge>
          ) : null}
        </div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--nsn-teal-dark)]">
          {knowledgeRelationshipProposalLabel(relationship)}
        </p>
        <div className="grid min-w-0 gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center">
          <Link
            className="break-words font-semibold text-[var(--nsn-navy)] underline-offset-4 hover:underline [overflow-wrap:anywhere]"
            href={getKnowledgeTopicRoute(relationship.sourceObjectId)}
          >
            {relationship.sourceName}
          </Link>
          <span className="text-sm font-semibold text-[var(--nsn-teal-dark)]">
            {relationshipLabel}
          </span>
          <Link
            className="break-words font-semibold text-[var(--nsn-navy)] underline-offset-4 hover:underline [overflow-wrap:anywhere]"
            href={getKnowledgeTopicRoute(relationship.targetObjectId)}
          >
            {relationship.targetName}
          </Link>
        </div>
        <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
          {relationship.explanation}
        </p>
        {isOrganizationHistory ? (
          <dl className="grid min-w-0 gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3 text-sm leading-6 text-[var(--nsn-slate)] sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="font-semibold text-[var(--nsn-navy)]">
                Current location:
              </dt>
              <dd className="break-words [overflow-wrap:anywhere]">
                {locations.current ?? "Not recorded"}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="font-semibold text-[var(--nsn-navy)]">
                Planned or completed location:
              </dt>
              <dd className="break-words [overflow-wrap:anywhere]">
                {locations.plannedOrCompleted ?? "Not recorded"}
              </dd>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <dt className="font-semibold text-[var(--nsn-navy)]">
                Historical organization action
              </dt>
              <dd>
                This records where an item appeared in organization history. It
                is not a standalone topic.
              </dd>
            </div>
          </dl>
        ) : null}
        <p className="text-sm font-semibold text-[var(--nsn-teal-dark)]">
          Confidence: {formatConfidence(relationship.confidence)}
        </p>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <NsnButton
            disabled={savingKey !== null}
            onClick={() => onAction(relationship.id, "APPROVE")}
            type="button"
            variant="primary"
          >
            Approve
          </NsnButton>
          <NsnButton
            disabled={savingKey !== null}
            onClick={() =>
              onOpenDialog({ mode: "REVISE_RELATIONSHIP", relationship })
            }
            type="button"
            variant="accent"
          >
            Revise
          </NsnButton>
          <NsnButton
            disabled={savingKey !== null}
            onClick={() => onAction(relationship.id, "REJECT")}
            type="button"
            variant="secondary"
          >
            Reject
          </NsnButton>
          <NsnButton
            disabled={savingKey !== null}
            onClick={() => onAction(relationship.id, "KEEP_PROVISIONAL")}
            type="button"
            variant="secondary"
          >
            Keep Provisional
          </NsnButton>
        </div>
      </article>
    </NsnCard>
  );
}

function KnowledgeReviewDialog({
  dialog,
  mergeTargets,
  onClose,
  onError,
  onMessage,
}: {
  dialog: DialogState;
  mergeTargets: KnowledgeObjectSummary[];
  onClose: () => void;
  onError: (message: string | null) => void;
  onMessage: (message: string | null) => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [objectType, setObjectType] = useState<KnowledgeObjectType>("TOPIC");
  const [canonicalObjectId, setCanonicalObjectId] = useState("");
  const [note, setNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!dialog) {
      return;
    }

    lastFocusedElementRef.current = document.activeElement as HTMLElement | null;

    queueMicrotask(() => {
      if (dialog.mode === "REVISE_OBJECT") {
        setName(dialog.object.name);
        setDescription(dialog.object.description);
        setObjectType(dialog.object.objectType);
      } else if (dialog.mode === "MERGE_OBJECT") {
        setCanonicalObjectId(
          mergeTargets.find((target) => target.id !== dialog.object.id)?.id ?? "",
        );
      } else {
        setDescription(dialog.relationship.explanation);
      }

      setNote("");
      window.requestAnimationFrame(() => firstFieldRef.current?.focus());
    });
  }, [dialog, mergeTargets]);

  useEffect(() => {
    if (!dialog) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        window.requestAnimationFrame(() => lastFocusedElementRef.current?.focus());
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const modal = dialogRef.current;

      if (!modal) {
        return;
      }

      const focusable = [
        ...modal.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);

      if (!first || !last) {
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [dialog, onClose]);

  if (!dialog) {
    return null;
  }

  async function submit() {
    if (!dialog || isSaving) {
      return;
    }

    setIsSaving(true);
    onMessage(null);
    onError(null);

    try {
      if (dialog.mode === "REVISE_OBJECT") {
        await postJson(
          `/api/library/knowledge/objects/${encodeURIComponent(
            dialog.object.id,
          )}/decision`,
          {
            action: "REVISE",
            description,
            name,
            note,
            objectType,
          },
        );
      } else if (dialog.mode === "MERGE_OBJECT") {
        await postJson(
          `/api/library/knowledge/objects/${encodeURIComponent(
            dialog.object.id,
          )}/merge`,
          {
            canonicalObjectId,
            reason: note,
          },
        );
      } else {
        await postJson(
          `/api/library/knowledge/relationships/${encodeURIComponent(
            dialog.relationship.id,
          )}/decision`,
          {
            action: "REVISE",
            explanation: description,
            note,
          },
        );
      }

      onMessage("Knowledge review saved.");
      onClose();
      window.requestAnimationFrame(() => lastFocusedElementRef.current?.focus());
      router.refresh();
    } catch (dialogError) {
      onError(
        dialogError instanceof Error
          ? dialogError.message
          : "The knowledge review could not be saved.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  const title =
    dialog.mode === "MERGE_OBJECT"
      ? "Merge Knowledge Items"
      : dialog.mode === "REVISE_RELATIONSHIP"
        ? "Revise Relationship"
        : "Revise Knowledge Item";
  const targetOptions = mergeTargets.filter(
    (target) => dialog.mode !== "MERGE_OBJECT" || target.id !== dialog.object.id,
  );

  return (
    <div
      aria-labelledby="knowledge-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[rgb(31_42_68_/_0.42)] p-4"
      role="dialog"
    >
      <div
        className="grid w-full max-w-2xl min-w-0 gap-5 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-5 shadow-xl"
        ref={dialogRef}
      >
        <div className="min-w-0">
          <h2
            className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
            id="knowledge-dialog-title"
          >
            {title}
          </h2>
          <p className="mt-1 text-sm leading-6 text-[var(--nsn-slate)]">
            The original proposal remains preserved in history.
          </p>
        </div>

        {dialog.mode === "MERGE_OBJECT" ? (
          <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
            Keep this knowledge item
            <select
              className="nsn-input min-h-11 text-sm font-normal"
              onChange={(event) => setCanonicalObjectId(event.target.value)}
              ref={firstFieldRef as RefObject<HTMLSelectElement>}
              value={canonicalObjectId}
            >
              {targetOptions.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            {dialog.mode === "REVISE_OBJECT" ? (
              <>
                <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
                  Name
                  <input
                    className="nsn-input text-sm font-normal"
                    onChange={(event) => setName(event.target.value)}
                    ref={firstFieldRef as RefObject<HTMLInputElement>}
                    value={name}
                  />
                </label>
                <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
                  Type
                  <select
                    className="nsn-input min-h-11 text-sm font-normal"
                    onChange={(event) =>
                      setObjectType(event.target.value as KnowledgeObjectType)
                    }
                    value={objectType}
                  >
                    {knowledgeObjectTypes.map((type) => (
                      <option key={type} value={type}>
                        {objectTypeLabels[type]}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
            <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
              {dialog.mode === "REVISE_RELATIONSHIP"
                ? "Relationship explanation"
                : "Description"}
              <textarea
                className="nsn-input min-h-28 resize-y text-sm font-normal"
                onChange={(event) => setDescription(event.target.value)}
                ref={
                  dialog.mode === "REVISE_RELATIONSHIP"
                    ? (firstFieldRef as RefObject<HTMLTextAreaElement>)
                    : undefined
                }
                value={description}
              />
            </label>
          </>
        )}

        <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
          Context or reason
          <textarea
            className="nsn-input min-h-24 resize-y text-sm font-normal"
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional"
            value={note}
          />
        </label>

        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:justify-end">
          <NsnButton
            disabled={isSaving}
            onClick={() => {
              onClose();
              window.requestAnimationFrame(() =>
                lastFocusedElementRef.current?.focus(),
              );
            }}
            type="button"
            variant="secondary"
          >
            Cancel
          </NsnButton>
          <NsnButton disabled={isSaving} onClick={submit} type="button" variant="primary">
            {isSaving ? "Saving..." : "Save Review"}
          </NsnButton>
        </div>
      </div>
    </div>
  );
}
