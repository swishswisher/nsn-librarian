"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useRouter } from "next/navigation";

import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnButton } from "@/components/library/NsnButton";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import { NsnSearchField } from "@/components/library/NsnSearchField";
import { getRecommendationExamineRoute } from "@/lib/library/routes";
import type {
  BridgeOrganizationSuggestionMutationResponse,
  BridgeOrganizationSuggestionSummary,
  OrganizationSuggestionStatus,
  OrganizationSuggestionType,
} from "@/lib/bridge/types";
import type { KnowledgeReference } from "@/types/library";

type OrganizationSuggestionsReviewPanelProps = {
  libraryIdBySuggestionId?: Record<string, string>;
  libraryNameBySuggestionId?: Record<string, string>;
  libraryOptions?: Array<{ id: string; label: string }>;
  notebookHref?: string | null;
  scanSessionId?: string;
  suggestions: BridgeOrganizationSuggestionSummary[];
  showExamineLink?: boolean;
  topicsBySuggestionId?: Record<string, KnowledgeReference[]>;
};

type ReviewAction = "APPROVE" | "MODIFY" | "REJECT" | "LEAVE_UNCHANGED";

type PendingReviews = Partial<Record<string, ReviewAction>>;

type EditState = {
  suggestionId: string;
  destinationFolder: string;
  fileName: string;
  context: string;
} | null;

type FilterValue =
  | "ALL"
  | "PENDING"
  | "APPROVED"
  | "MODIFIED"
  | "REJECTED"
  | "LEFT_UNCHANGED"
  | "MOVE"
  | "RENAME"
  | "GROUP"
  | "DUPLICATE"
  | "IMAGE"
  | "AUDIO"
  | "VIDEO"
  | "WEBSITE_CANDIDATE"
  | `LIBRARY:${string}`;

type RecommendationGroup = {
  id: string;
  label: string;
  suggestions: BridgeOrganizationSuggestionSummary[];
};

const filterOptions: Array<{ label: string; value: FilterValue }> = [
  { label: "All Libraries", value: "ALL" },
  { label: "Pending", value: "PENDING" },
  { label: "Approved", value: "APPROVED" },
  { label: "Modified", value: "MODIFIED" },
  { label: "Rejected", value: "REJECTED" },
  { label: "Left Unchanged", value: "LEFT_UNCHANGED" },
  { label: "Move", value: "MOVE" },
  { label: "Rename", value: "RENAME" },
  { label: "Group", value: "GROUP" },
  { label: "Duplicate", value: "DUPLICATE" },
  { label: "Images", value: "IMAGE" },
  { label: "Audio", value: "AUDIO" },
  { label: "Video", value: "VIDEO" },
  { label: "Website Candidate", value: "WEBSITE_CANDIDATE" },
];

function suggestionTypeLabel(type: OrganizationSuggestionType) {
  if (type === "MOVE_FILE") {
    return "Move";
  }

  if (type === "RENAME_FILE") {
    return "Rename";
  }

  if (type === "CREATE_FOLDER") {
    return "New folder";
  }

  if (type === "GROUP_WITH_FILES") {
    return "Group";
  }

  if (type === "POSSIBLE_DUPLICATE") {
    return "Duplicate";
  }

  if (type === "WEBSITE_CANDIDATE") {
    return "Website";
  }

  return "Keep";
}

function statusLabel(status: OrganizationSuggestionStatus) {
  if (status === "LEFT_UNCHANGED") {
    return "Left unchanged";
  }

  return status.charAt(0) + status.slice(1).toLowerCase();
}

function statusTone(status: OrganizationSuggestionStatus): NsnBadgeTone {
  if (status === "APPROVED" || status === "MODIFIED") {
    return "approved";
  }

  if (status === "REJECTED") {
    return "review";
  }

  if (status === "LEFT_UNCHANGED") {
    return "source";
  }

  return "pending";
}

function formatConfidence(value: number) {
  const percent = Math.round(value * 100);
  const level = percent >= 80 ? "High" : percent >= 55 ? "Medium" : "Low";

  return `${level} - ${percent}%`;
}

function pathFileName(relativePath: string) {
  const parts = relativePath.split("/").filter(Boolean);

  return parts.at(-1) ?? relativePath;
}

function pathFolder(relativePath: string) {
  const parts = relativePath.split("/").filter(Boolean);

  if (parts.length <= 1) {
    return "";
  }

  return parts.slice(0, -1).join("/");
}

function latestRevision(suggestion: BridgeOrganizationSuggestionSummary) {
  return suggestion.revisions[0] ?? null;
}

function recommendedPath(suggestion: BridgeOrganizationSuggestionSummary) {
  const revision = latestRevision(suggestion);

  if (revision?.revisedRelativePath) {
    return revision.revisedRelativePath;
  }

  if (suggestion.suggestionType === "KEEP_UNCHANGED") {
    return "Keep this file where it is.";
  }

  if (suggestion.suggestionType === "RENAME_FILE") {
    return suggestion.proposedFileName ?? "Review the file name.";
  }

  if (suggestion.suggestionType === "CREATE_FOLDER") {
    return suggestion.proposedRelativePath
      ? `Create ${suggestion.proposedRelativePath}`
      : "Create a review folder.";
  }

  return suggestion.proposedRelativePath ?? "Review before changing anything.";
}

function recommendationSummary(suggestion: BridgeOrganizationSuggestionSummary) {
  const text = suggestion.explanation.trim().replace(/\s+/g, " ");

  if (text.length <= 240) {
    return text;
  }

  const sentence = text.match(/^.{80,240}?[.!?](\s|$)/)?.[0]?.trim();

  return sentence ?? `${text.slice(0, 237).trim()}...`;
}

function initialEditState(
  suggestion: BridgeOrganizationSuggestionSummary,
): EditState {
  const revision = latestRevision(suggestion);
  const relativePath =
    revision?.revisedRelativePath ??
    suggestion.proposedRelativePath ??
    suggestion.currentRelativePath;

  return {
    context: revision?.context ?? "",
    destinationFolder: pathFolder(relativePath),
    fileName:
      revision?.revisedFileName ??
      suggestion.proposedFileName ??
      pathFileName(relativePath),
    suggestionId: suggestion.id,
  };
}

function filterMatches(
  suggestion: BridgeOrganizationSuggestionSummary,
  filter: FilterValue,
  libraryIdBySuggestionId: Record<string, string> = {},
) {
  if (filter === "ALL") {
    return true;
  }

  if (filter.startsWith("LIBRARY:")) {
    return libraryIdBySuggestionId[suggestion.id] === filter.slice("LIBRARY:".length);
  }

  if (
    filter === "PENDING" ||
    filter === "APPROVED" ||
    filter === "MODIFIED" ||
    filter === "REJECTED" ||
    filter === "LEFT_UNCHANGED"
  ) {
    return suggestion.status === filter;
  }

  if (filter === "MOVE") {
    return suggestion.suggestionType === "MOVE_FILE";
  }

  if (filter === "RENAME") {
    return suggestion.suggestionType === "RENAME_FILE";
  }

  if (filter === "GROUP") {
    return suggestion.suggestionType === "GROUP_WITH_FILES";
  }

  if (filter === "DUPLICATE") {
    return suggestion.suggestionType === "POSSIBLE_DUPLICATE";
  }

  if (filter === "AUDIO") {
    return suggestion.supportingInformation.some((item) =>
      item.toLowerCase().includes("file type: audio_"),
    );
  }

  if (filter === "IMAGE") {
    return suggestion.supportingInformation.some((item) =>
      item.toLowerCase().includes("file type: image_"),
    );
  }

  if (filter === "VIDEO") {
    return suggestion.supportingInformation.some((item) =>
      item.toLowerCase().includes("file type: video_"),
    );
  }

  return suggestion.suggestionType === "WEBSITE_CANDIDATE";
}

function groupForSuggestion(
  suggestion: BridgeOrganizationSuggestionSummary,
  libraryIdBySuggestionId: Record<string, string>,
  libraryNameBySuggestionId: Record<string, string>,
) {
  const folder = pathFolder(suggestion.currentRelativePath);
  const libraryId = libraryIdBySuggestionId[suggestion.id] ?? "current-session";
  const libraryName = libraryNameBySuggestionId[suggestion.id] ?? null;
  const folderLabel = folder || "Root Folder";

  return {
    id: `source-${encodeURIComponent(libraryId)}-${encodeURIComponent(
      folder || "/",
    )}`,
    label: libraryName ? `${libraryName} → ${folderLabel}` : folderLabel,
  };
}

function buildGroups(
  suggestions: BridgeOrganizationSuggestionSummary[],
  libraryIdBySuggestionId: Record<string, string>,
  libraryNameBySuggestionId: Record<string, string>,
) {
  const groups = new Map<string, RecommendationGroup>();

  for (const suggestion of suggestions) {
    const group = groupForSuggestion(
      suggestion,
      libraryIdBySuggestionId,
      libraryNameBySuggestionId,
    );
    const existing = groups.get(group.id);

    if (existing) {
      existing.suggestions.push(suggestion);
    } else {
      groups.set(group.id, {
        id: group.id,
        label: group.label,
        suggestions: [suggestion],
      });
    }
  }

  return [...groups.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

function basedOnSummary(suggestion: BridgeOrganizationSuggestionSummary) {
  const sourceText = [
    suggestion.explanation,
    suggestion.whySuggested.join(" "),
    suggestion.supportingInformation.join(" "),
  ]
    .join(" ")
    .toLowerCase();
  const items: string[] = [];

  if (
    suggestion.suggestionType === "GROUP_WITH_FILES" ||
    suggestion.suggestionType === "POSSIBLE_DUPLICATE" ||
    sourceText.includes("similar")
  ) {
    items.push("related files and recordings");
  }

  if (
    sourceText.includes("approved memory") ||
    sourceText.includes("preference") ||
    sourceText.includes("preferred")
  ) {
    items.push("approved terminology preferences");
  }

  if (
    sourceText.includes("theme") ||
    sourceText.includes("concept") ||
    sourceText.includes("term")
  ) {
    items.push("similar themes");
  }

  if (
    suggestion.suggestionType === "MOVE_FILE" ||
    suggestion.suggestionType === "CREATE_FOLDER" ||
    sourceText.includes("folder")
  ) {
    items.push("existing folder patterns");
  }

  if (items.length === 0) {
    items.push("the file name and reviewed content");
  }

  return [...new Set(items)].slice(0, 4);
}

function statusCounts(rows: BridgeOrganizationSuggestionSummary[]) {
  return rows.reduce(
    (counts, suggestion) => ({
      ...counts,
      [suggestion.status]: (counts[suggestion.status] ?? 0) + 1,
    }),
    {} as Record<OrganizationSuggestionStatus, number>,
  );
}

function canReviewSuggestion(suggestion: BridgeOrganizationSuggestionSummary) {
  return suggestion.status === "PENDING";
}

function decisionSavedMessage(action: ReviewAction) {
  if (action === "APPROVE") {
    return "The recommendation was approved for planning. No filesystem action occurred.";
  }

  if (action === "MODIFY") {
    return "The edited recommendation was saved for planning. No filesystem action occurred.";
  }

  if (action === "REJECT") {
    return "The recommendation was rejected. It will not be included in an Organization Plan.";
  }

  return "The recommendation was marked to leave unchanged. It will not be included in an Organization Plan.";
}

function toggleRecordValue(
  setter: Dispatch<SetStateAction<Record<string, boolean>>>,
  key: string,
) {
  setter((current) => ({
    ...current,
    [key]: !current[key],
  }));
}

export function OrganizationSuggestionsReviewPanel({
  libraryIdBySuggestionId = {},
  libraryNameBySuggestionId = {},
  libraryOptions = [],
  notebookHref = null,
  showExamineLink = true,
  suggestions,
  topicsBySuggestionId = {},
}: OrganizationSuggestionsReviewPanelProps) {
  const router = useRouter();
  const editDialogRef = useRef<HTMLDivElement>(null);
  const firstEditFieldRef = useRef<HTMLInputElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const [rows, setRows] = useState(suggestions);
  const [activeFilter, setActiveFilter] = useState<FilterValue>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [editState, setEditState] = useState<EditState>(null);
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>(
    {},
  );
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );
  const [expandedReasons, setExpandedReasons] = useState<Record<string, boolean>>(
    {},
  );
  const [pendingReviews, setPendingReviews] = useState<PendingReviews>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const counts = useMemo(() => statusCounts(rows), [rows]);
  const eligibleForPlanning =
    (counts.APPROVED ?? 0) + (counts.MODIFIED ?? 0);
  const allFilterOptions = useMemo(
    () => [
      ...filterOptions,
      ...libraryOptions.map((library) => ({
        label: library.label,
        value: `LIBRARY:${library.id}` as FilterValue,
      })),
    ],
    [libraryOptions],
  );
  const filteredRows = useMemo(
    () =>
      rows.filter((suggestion) => {
        if (!filterMatches(suggestion, activeFilter, libraryIdBySuggestionId)) {
          return false;
        }

        const query = searchQuery.trim().toLowerCase();

        if (!query) {
          return true;
        }

        return [
          suggestion.title,
          suggestion.currentRelativePath,
          suggestion.proposedRelativePath,
          suggestion.proposedFileName,
          suggestion.explanation,
          suggestion.whySuggested.join(" "),
          suggestion.supportingInformation.join(" "),
          libraryNameBySuggestionId[suggestion.id],
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query);
      }),
    [
      activeFilter,
      libraryIdBySuggestionId,
      libraryNameBySuggestionId,
      rows,
      searchQuery,
    ],
  );
  const groups = useMemo(
    () =>
      buildGroups(
        filteredRows,
        libraryIdBySuggestionId,
        libraryNameBySuggestionId,
      ),
    [filteredRows, libraryIdBySuggestionId, libraryNameBySuggestionId],
  );
  const groupsExpandedByDefault = groups.length <= 4;
  const editingSuggestion = useMemo(
    () =>
      editState
        ? (rows.find((suggestion) => suggestion.id === editState.suggestionId) ??
          null)
        : null,
    [editState, rows],
  );
  const editIsSaving = Boolean(
    editingSuggestion &&
      pendingReviews[editingSuggestion.id] === "MODIFY",
  );

  function groupIsExpanded(groupId: string) {
    return expandedGroups[groupId] ?? groupsExpandedByDefault;
  }

  const closeEditSuggestion = useCallback(() => {
    setEditState(null);

    window.requestAnimationFrame(() => {
      lastFocusedElementRef.current?.focus();
      lastFocusedElementRef.current = null;
    });
  }, []);

  useEffect(() => {
    if (!editState) {
      return;
    }

    firstEditFieldRef.current?.focus();
  }, [editState]);

  useEffect(() => {
    if (!editState) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      const dialog = editDialogRef.current;

      if (!dialog) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        closeEditSuggestion();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter(
        (element) =>
          !element.hasAttribute("disabled") &&
          element.getAttribute("aria-hidden") !== "true",
      );

      if (focusable.length === 0) {
        return;
      }

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
  }, [closeEditSuggestion, editState]);

  function updateSuggestion(nextSuggestion: BridgeOrganizationSuggestionSummary) {
    setRows((currentRows) =>
      currentRows.map((suggestion) =>
        suggestion.id === nextSuggestion.id ? nextSuggestion : suggestion,
      ),
    );
  }

  function expandAllGroups() {
    setExpandedGroups((current) => ({
      ...current,
      ...Object.fromEntries(groups.map((group) => [group.id, true])),
    }));
  }

  function collapseAllGroups() {
    setExpandedGroups((current) => ({
      ...current,
      ...Object.fromEntries(groups.map((group) => [group.id, false])),
    }));
  }

  function openEditSuggestion(
    suggestion: BridgeOrganizationSuggestionSummary,
    trigger: HTMLElement | null,
  ) {
    if (!canReviewSuggestion(suggestion)) {
      setError("This recommendation has already been reviewed.");
      return;
    }

    lastFocusedElementRef.current = trigger;
    setMessage(null);
    setError(null);
    setEditState(initialEditState(suggestion));
  }

  async function submitReview(
    suggestion: BridgeOrganizationSuggestionSummary,
    action: ReviewAction,
  ) {
    if (pendingReviews[suggestion.id]) {
      return;
    }

    if (!canReviewSuggestion(suggestion)) {
      setError("This recommendation has already been reviewed.");
      return;
    }

    setPendingReviews((current) => ({
      ...current,
      [suggestion.id]: action,
    }));
    setMessage(null);
    setError(null);

    const body =
      action === "MODIFY" && editState?.suggestionId === suggestion.id
        ? {
            action,
            context: editState.context,
            destinationFolder: editState.destinationFolder,
            fileName: editState.fileName,
            scanSessionId: suggestion.scanSessionId,
          }
        : { action, scanSessionId: suggestion.scanSessionId };

    try {
      const response = await fetch(
        `/api/bridge/organization-suggestions/${encodeURIComponent(
          suggestion.id,
        )}/decision`,
        {
          body: JSON.stringify(body),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      const payload =
        (await response.json()) as BridgeOrganizationSuggestionMutationResponse;

      if (!payload.ok) {
        setError(payload.error);
        return;
      }

      updateSuggestion(payload.suggestion);
      setMessage(decisionSavedMessage(action));
      closeEditSuggestion();
      router.refresh();
    } catch {
      setError("The recommendation could not be saved right now.");
    } finally {
      setPendingReviews((current) => {
        const remaining = { ...current };

        delete remaining[suggestion.id];

        return remaining;
      });
    }
  }

  if (rows.length === 0) {
    return (
      <NsnEmptyState
        description="Recommendations appear after the Librarian has read and examined a file. Approved recommendations wait for an Organization Plan and Deanne's final approval."
        title="No recommendations yet"
      />
    );
  }

  return (
    <section
      className="grid min-w-0 gap-5"
      aria-labelledby="recommendations-review-heading"
    >
      <div className="grid gap-3">
        <h2
          className="nsn-display text-2xl text-[var(--nsn-navy)]"
          id="recommendations-review-heading"
        >
          Recommendations
        </h2>
        <div className="flex flex-wrap gap-2 text-sm">
          <NsnBadge tone="pending">Pending {counts.PENDING ?? 0}</NsnBadge>
          <NsnBadge tone="approved">Approved {counts.APPROVED ?? 0}</NsnBadge>
          <NsnBadge tone="approved">Modified {counts.MODIFIED ?? 0}</NsnBadge>
          <NsnBadge tone="approved">
            Ready for plan {eligibleForPlanning}
          </NsnBadge>
          <NsnBadge tone="review">Rejected {counts.REJECTED ?? 0}</NsnBadge>
          <NsnBadge tone="source">
            Left unchanged {counts.LEFT_UNCHANGED ?? 0}
          </NsnBadge>
        </div>

        <div
          aria-label="Filter recommendations"
          className="flex min-w-0 flex-wrap gap-2"
          role="group"
        >
          {allFilterOptions.map((filter) => (
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

        <NsnSearchField
          label="Search organization recommendations"
          onChange={setSearchQuery}
          resultCount={filteredRows.length}
          value={searchQuery}
        />

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <NsnButton onClick={expandAllGroups} type="button" variant="secondary">
            Expand all
          </NsnButton>
          <NsnButton onClick={collapseAllGroups} type="button" variant="secondary">
            Collapse all
          </NsnButton>
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
      </div>

      {filteredRows.length === 0 ? (
        <NsnEmptyState
          description="No recommendations match this filter or search. Change either one to see the rest of the review queue."
          title="Nothing in this view"
        />
      ) : null}

      {groups.length > 0 ? (
        <div className="grid min-w-0 gap-4">
          {groups.map((group) => {
            const isGroupOpen = groupIsExpanded(group.id);

            return (
              <section
                aria-labelledby={`recommendation-group-${group.id}`}
                className="grid min-w-0 gap-3"
                key={group.id}
              >
                <button
                  aria-expanded={isGroupOpen}
                  className="grid min-w-0 gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 text-left transition hover:bg-[var(--nsn-sage-mist)] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  onClick={() =>
                    setExpandedGroups((current) => ({
                      ...current,
                      [group.id]: !isGroupOpen,
                    }))
                  }
                  type="button"
                >
                  <span className="min-w-0">
                    <span
                      className="nsn-display block break-words text-xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
                      id={`recommendation-group-${group.id}`}
                    >
                      {group.label}
                    </span>
                    <span className="mt-1 block text-sm leading-6 text-[var(--nsn-slate)]">
                      {group.suggestions.length} recommendation
                      {group.suggestions.length === 1 ? "" : "s"}
                      {" in this source folder"}
                    </span>
                  </span>
                  <span className="text-sm font-semibold text-[var(--nsn-teal-dark)]">
                    {isGroupOpen ? "Collapse" : "Expand"}
                  </span>
                </button>

                {isGroupOpen ? (
                  <div className="grid min-w-0 gap-4">
                    {group.suggestions.map((suggestion) => {
                      const revision = latestRevision(suggestion);
                      const reasonExpanded = Boolean(expandedReasons[suggestion.id]);
                      const detailExpanded = Boolean(expandedDetails[suggestion.id]);
                      const basedOn = basedOnSummary(suggestion);
                      const canReview = canReviewSuggestion(suggestion);
                      const pendingAction = pendingReviews[suggestion.id] ?? null;
                      const isCardSaving = Boolean(pendingAction);
                      const canExamine = Boolean(
                        suggestion.scanSessionId && suggestion.id,
                      );
                      const relatedTopics = topicsBySuggestionId[suggestion.id] ?? [];

                      return (
                        <NsnCard className="min-w-0" key={suggestion.id}>
                          <div className="grid min-w-0 gap-5">
                            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                              <div className="min-w-0">
                                <div className="flex flex-wrap gap-2">
                                  <NsnBadge tone="migration">
                                    {suggestionTypeLabel(suggestion.suggestionType)}
                                  </NsnBadge>
                                  <NsnBadge tone={statusTone(suggestion.status)}>
                                    {statusLabel(suggestion.status)}
                                  </NsnBadge>
                                  {libraryNameBySuggestionId[suggestion.id] ? (
                                    <NsnBadge tone="source">
                                      {libraryNameBySuggestionId[suggestion.id]}
                                    </NsnBadge>
                                  ) : null}
                                </div>

                                <div className="mt-4 grid min-w-0 gap-3 text-sm leading-6">
                                  <div className="min-w-0">
                                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                                      File
                                    </p>
                                    <h3 className="nsn-display mt-1 break-words text-2xl leading-8 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                                      {pathFileName(suggestion.currentRelativePath)}
                                    </h3>
                                  </div>

                                  <div className="min-w-0">
                                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                                      Current
                                    </p>
                                    <p className="break-words text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                                      {suggestion.currentRelativePath}
                                    </p>
                                  </div>

                                  <div className="min-w-0">
                                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                                      Recommended
                                    </p>
                                    <p className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                                      {recommendedPath(suggestion)}
                                    </p>
                                  </div>

                                  <div className="min-w-0">
                                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                                      Recommendation
                                    </p>
                                    <p className="break-words text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                                      {recommendationSummary(suggestion)}
                                    </p>
                                  </div>

                                  <p className="font-semibold text-[var(--nsn-teal-dark)]">
                                    Confidence: {formatConfidence(suggestion.confidence)}
                                  </p>

                                  {relatedTopics.length > 0 ? (
                                    <div className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3">
                                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-teal-dark)]">
                                        Related topics
                                      </p>
                                      <div className="flex min-w-0 flex-wrap gap-2">
                                        {relatedTopics.map((topic) => (
                                          <Link
                                            className="inline-flex min-h-9 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-center text-xs font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-soft-aqua)] [overflow-wrap:anywhere]"
                                            href={topic.href}
                                            key={topic.id}
                                          >
                                            {topic.label}
                                          </Link>
                                        ))}
                                      </div>
                                    </div>
                                  ) : null}
                                </div>
                              </div>

                              <div className="grid min-w-0 gap-2 lg:min-w-48">
                                <NsnButton
                                  disabled={!canReview || isCardSaving}
                                  onClick={() =>
                                    submitReview(suggestion, "APPROVE")
                                  }
                                  type="button"
                                  variant="primary"
                                >
                                  {pendingAction === "APPROVE"
                                    ? "Approving..."
                                    : "Approve"}
                                </NsnButton>
                                <NsnButton
                                  disabled={!canReview || isCardSaving}
                                  onClick={(event) =>
                                    openEditSuggestion(
                                      suggestion,
                                      event.currentTarget,
                                    )
                                  }
                                  type="button"
                                  variant="accent"
                                >
                                  Edit Suggestion
                                </NsnButton>
                                <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
                                  <NsnButton
                                    disabled={!canReview || isCardSaving}
                                    onClick={() => submitReview(suggestion, "REJECT")}
                                    type="button"
                                    variant="secondary"
                                  >
                                    {pendingAction === "REJECT"
                                      ? "Rejecting..."
                                      : "Reject"}
                                  </NsnButton>
                                  <NsnButton
                                    disabled={!canReview || isCardSaving}
                                    onClick={() =>
                                      submitReview(suggestion, "LEAVE_UNCHANGED")
                                    }
                                    type="button"
                                    variant="secondary"
                                  >
                                    {pendingAction === "LEAVE_UNCHANGED"
                                      ? "Saving..."
                                      : "Leave Unchanged"}
                                  </NsnButton>
                                  {showExamineLink && canExamine ? (
                                    <Link
                                      className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] [overflow-wrap:anywhere]"
                                      href={getRecommendationExamineRoute(
                                        suggestion.scanSessionId,
                                        suggestion.id,
                                      )}
                                    >
                                      Examine
                                    </Link>
                                  ) : null}
                                  {notebookHref ? (
                                    <Link
                                      className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] px-4 text-center text-sm font-semibold text-[var(--nsn-teal-dark)] transition hover:bg-[var(--nsn-soft-aqua)] [overflow-wrap:anywhere]"
                                      href={notebookHref}
                                    >
                                      Notebook Context
                                    </Link>
                                  ) : null}
                                </div>
                                {!canReview ? (
                                  <p className="text-xs leading-5 text-[var(--nsn-slate)]">
                                    This recommendation has been reviewed.
                                  </p>
                                ) : null}
                              </div>
                            </div>

                            <div className="grid min-w-0 gap-4 rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-[var(--nsn-navy)]">
                                  Why this may fit:
                                </p>
                                <ul className="mt-2 grid gap-1 pl-4 text-sm leading-6 text-[var(--nsn-slate)]">
                                  {basedOn.map((item) => (
                                    <li
                                      className="list-disc break-words [overflow-wrap:anywhere]"
                                      key={item}
                                    >
                                      {item}
                                    </li>
                                  ))}
                                </ul>
                              </div>

                              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                                <button
                                  aria-expanded={reasonExpanded}
                                  className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-teal-dark)] transition hover:bg-[var(--nsn-soft-aqua)]"
                                  onClick={() =>
                                    toggleRecordValue(
                                      setExpandedReasons,
                                      suggestion.id,
                                    )
                                  }
                                  type="button"
                                >
                                  Why did the Librarian suggest this?
                                </button>
                                <button
                                  aria-expanded={detailExpanded}
                                  className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-slate)] transition hover:bg-[var(--nsn-cream)]"
                                  onClick={() =>
                                    toggleRecordValue(
                                      setExpandedDetails,
                                      suggestion.id,
                                    )
                                  }
                                  type="button"
                                >
                                  Show detailed reasoning
                                </button>
                              </div>

                              {reasonExpanded ? (
                                <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-3">
                                  <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                                    {suggestion.explanation}
                                  </p>
                                  {suggestion.whySuggested.length > 0 ? (
                                    <ul className="mt-2 grid gap-1 pl-4 text-sm leading-6 text-[var(--nsn-slate)]">
                                      {suggestion.whySuggested.map((reason) => (
                                        <li
                                          className="list-disc break-words [overflow-wrap:anywhere]"
                                          key={reason}
                                        >
                                          {reason}
                                        </li>
                                      ))}
                                    </ul>
                                  ) : null}
                                </div>
                              ) : null}

                              {detailExpanded ? (
                                <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-3">
                                  <p className="text-sm font-semibold text-[var(--nsn-navy)]">
                                    Detailed reasoning
                                  </p>
                                  {suggestion.supportingInformation.length > 0 ? (
                                    <ul className="mt-2 grid gap-1 pl-4 text-sm leading-6 text-[var(--nsn-slate)]">
                                      {suggestion.supportingInformation.map(
                                        (item) => (
                                          <li
                                            className="list-disc break-words [overflow-wrap:anywhere]"
                                            key={item}
                                          >
                                            {item}
                                          </li>
                                        ),
                                      )}
                                    </ul>
                                  ) : (
                                    <p className="mt-2 text-sm leading-6 text-[var(--nsn-slate)]">
                                      No detailed support was saved for this
                                      recommendation.
                                    </p>
                                  )}
                                </div>
                              ) : null}
                            </div>

                            {revision ? (
                              <div className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-card)] p-3">
                                <p className="text-sm font-semibold text-[var(--nsn-navy)]">
                                  Deanne revised this recommendation
                                </p>
                                <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                                  {revision.revisedRelativePath}
                                </p>
                                {revision.context ? (
                                  <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                                    {revision.context}
                                  </p>
                                ) : null}
                              </div>
                            ) : null}

                          </div>
                        </NsnCard>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}

      {editState && editingSuggestion ? (
        <div className="fixed inset-0 z-50 grid min-w-0 place-items-center overflow-y-auto bg-[rgba(18,34,43,0.45)] p-4 sm:p-6">
          <div
            aria-describedby="edit-recommendation-description"
            aria-labelledby="edit-recommendation-title"
            aria-modal="true"
            className="grid max-h-[calc(100vh-2rem)] w-full max-w-3xl min-w-0 gap-5 overflow-y-auto rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 shadow-xl sm:p-6"
            ref={editDialogRef}
            role="dialog"
          >
            <div className="grid min-w-0 gap-2">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                Edit Suggestion
              </p>
              <h3
                className="nsn-display break-words text-2xl leading-8 text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
                id="edit-recommendation-title"
              >
                Revise this recommendation
              </h3>
              <p
                className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]"
                id="edit-recommendation-description"
              >
                The original recommendation stays preserved. Your edited
                destination, filename, and context are stored separately for
                planning review.
              </p>
            </div>

            <div className="grid min-w-0 gap-3 rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                  Current file
                </p>
                <p className="break-words text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  {editingSuggestion.currentRelativePath}
                </p>
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                  Original recommendation
                </p>
                <p className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                  {recommendedPath(editingSuggestion)}
                </p>
              </div>
              <p className="break-words text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                {editingSuggestion.explanation}
              </p>
            </div>

            <div className="grid min-w-0 gap-3 md:grid-cols-2">
              <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--nsn-navy)]">
                Proposed destination folder
                <input
                  className="min-h-11 min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-sm font-normal text-[var(--nsn-navy)]"
                  onChange={(event) =>
                    setEditState((current) =>
                      current
                        ? {
                            ...current,
                            destinationFolder: event.target.value,
                          }
                        : current,
                    )
                  }
                  placeholder="Example: Becoming"
                  ref={firstEditFieldRef}
                  value={editState.destinationFolder}
                />
              </label>
              <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--nsn-navy)]">
                Proposed filename
                <input
                  className="min-h-11 min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-sm font-normal text-[var(--nsn-navy)]"
                  onChange={(event) =>
                    setEditState((current) =>
                      current
                        ? {
                            ...current,
                            fileName: event.target.value,
                          }
                        : current,
                    )
                  }
                  placeholder="Example: becoming-notes.txt"
                  value={editState.fileName}
                />
              </label>
            </div>

            <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--nsn-navy)]">
              Context or reason
              <textarea
                className="min-h-28 min-w-0 resize-y rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 py-2 text-sm font-normal leading-6 text-[var(--nsn-navy)]"
                onChange={(event) =>
                  setEditState((current) =>
                    current
                      ? {
                          ...current,
                          context: event.target.value,
                        }
                      : current,
                  )
                }
                placeholder="Why this edited recommendation is better."
                value={editState.context}
              />
            </label>

            <div className="flex min-w-0 flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <NsnButton
                disabled={editIsSaving}
                onClick={closeEditSuggestion}
                type="button"
                variant="secondary"
              >
                Cancel
              </NsnButton>
              <NsnButton
                disabled={editIsSaving}
                onClick={() => submitReview(editingSuggestion, "MODIFY")}
                type="button"
                variant="primary"
              >
                {editIsSaving ? "Saving edit..." : "Save Edited Recommendation"}
              </NsnButton>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
