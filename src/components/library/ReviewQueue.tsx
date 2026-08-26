"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { NsnBadge } from "@/components/library/NsnBadge";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import { NsnSearchField } from "@/components/library/NsnSearchField";
import type { ReviewQueueItem } from "@/types/library";

type ReviewQueueProps = {
  items: ReviewQueueItem[];
};

function formatConfidence(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatObservedAt(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusLabel(status: ReviewQueueItem["status"]) {
  if (status === "AWAITING_REVIEW") {
    return "Needs review";
  }

  return status.replaceAll("_", " ").toLowerCase();
}

function observationModeLabel(observerType: string) {
  return observerType === "OPENAI"
    ? "Observed with AI assistance"
    : "Observed with basic observation mode";
}

function relatedContextLabel(count: number) {
  if (count === 1) {
    return "This item appears related to 1 other piece in your library.";
  }

  return `This item appears related to ${count} other pieces in your library.`;
}

export function ReviewQueue({ items }: ReviewQueueProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    if (!query) {
      return items;
    }

    return items.filter((item) =>
      [item.documentName, item.summary, item.observerType, item.status]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [items, searchQuery]);

  if (items.length === 0) {
    return (
      <NsnEmptyState
        description="Observations will appear here after Deanne asks the Librarian to observe a readable item."
        title="No recommendations need attention"
      />
    );
  }

  return (
    <section aria-labelledby="review-queue-heading">
      <div className="mb-4">
        <h2
          className="nsn-display text-2xl text-[var(--nsn-navy)]"
          id="review-queue-heading"
        >
          Recommendations
        </h2>
        <p className="mt-1 text-sm text-[var(--nsn-slate)]">
          The machine suggests. Deanne decides. Nothing moves without approval.
        </p>
      </div>

      <div className="mb-4">
        <NsnSearchField
          label="Search observation recommendations"
          onChange={setSearchQuery}
          resultCount={filteredItems.length}
          value={searchQuery}
        />
      </div>

      <div className="grid gap-3">
        {filteredItems.map((item) => (
          <NsnCard key={item.id}>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
              <div className="min-w-0">
                <div className="flex flex-wrap gap-2">
                  <NsnBadge tone="review">{statusLabel(item.status)}</NsnBadge>
                  <NsnBadge tone="source">
                    Confidence {formatConfidence(item.confidence)}
                  </NsnBadge>
                </div>
                <h3 className="mt-3 break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                  {item.documentName}
                </h3>
                <p className="mt-1 text-sm leading-6 text-[var(--nsn-slate)]">
                  Observed {formatObservedAt(item.observedAt)}
                </p>
                <p className="mt-1 text-sm leading-6 text-[var(--nsn-slate)]">
                  {observationModeLabel(item.observerType)}
                </p>
                <p className="mt-3 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  {item.summary}
                </p>
                {item.relatedConnectionCount > 0 ? (
                  <p className="mt-2 break-words text-sm font-semibold leading-6 text-[var(--nsn-teal-dark)] [overflow-wrap:anywhere]">
                    {relatedContextLabel(item.relatedConnectionCount)}
                  </p>
                ) : null}
              </div>

              <Link
                className="inline-flex min-h-11 w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] sm:w-auto"
                href={`/admin/library/review/${item.id}`}
              >
                Review
              </Link>
            </div>
          </NsnCard>
        ))}
      </div>
      {filteredItems.length === 0 ? (
        <NsnEmptyState
          description="Try another file name or recommendation keyword."
          title="No recommendations match your search"
        />
      ) : null}
    </section>
  );
}
