import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { ObservationDecisionPanel } from "@/components/library/ObservationDecisionPanel";
import { getObservationSessionReview } from "@/lib/library/observation-sessions";
import type {
  HumanDecisionType,
  ObservationSessionReview,
  ObservationSessionStatus,
} from "@/types/library";

export const dynamic = "force-dynamic";

type ReviewObservationPageProps = {
  params: Promise<{
    sessionId: string;
  }>;
};

function formatConfidence(value: number) {
  return `${Math.round(value * 100)}%`;
}

function similarityLabel(value: number) {
  if (value >= 0.7) {
    return "Strong similarity";
  }

  if (value >= 0.45) {
    return "Moderate similarity";
  }

  return "Possible similarity";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusLabel(status: ObservationSessionStatus) {
  if (status === "AWAITING_REVIEW") {
    return "Needs review";
  }

  if (status === "IN_REVIEW") {
    return "In review";
  }

  return status.replaceAll("_", " ").toLowerCase();
}

function statusTone(status: ObservationSessionStatus): NsnBadgeTone {
  if (status === "APPROVED" || status === "MODIFIED") {
    return "approved";
  }

  if (status === "REJECTED" || status === "AWAITING_REVIEW") {
    return "review";
  }

  return "unknown";
}

function observationModeLabel(observerType: string) {
  return observerType === "OPENAI"
    ? "Observed with AI assistance"
    : "Observed with basic observation mode";
}

function decisionLabel(decisionType: HumanDecisionType) {
  if (decisionType === "ACCEPT") {
    return "Accepted";
  }

  if (decisionType === "MODIFY") {
    return "Modified";
  }

  if (decisionType === "REJECT") {
    return "Rejected";
  }

  return "Left unchanged";
}

function ReviewSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="grid min-w-0 gap-3 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 sm:p-5">
      <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">{title}</h2>
      {children}
    </section>
  );
}

function ObservationList({
  review,
}: {
  review: ObservationSessionReview;
}) {
  if (review.observations.length === 0) {
    return (
      <p className="text-sm leading-6 text-[var(--nsn-slate)]">
        The Librarian did not have enough readable text to notice much yet.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      {review.observations.map((observation) => (
        <article
          className="min-w-0 border-l-2 border-[var(--nsn-teal)] pl-3"
          key={observation.id}
        >
          <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            {observation.description}
          </p>
          {observation.evidence.length > 0 ? (
            <ul className="mt-2 grid gap-1 pl-4 text-xs leading-5 text-[var(--nsn-warm-gray)]">
              {observation.evidence.slice(0, 5).map((evidence) => (
                <li
                  className="list-disc break-words [overflow-wrap:anywhere]"
                  key={evidence}
                >
                  {evidence}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 break-words text-xs leading-5 text-[var(--nsn-warm-gray)] [overflow-wrap:anywhere]">
            {observation.uncertainty}
          </p>
        </article>
      ))}
    </div>
  );
}

function InterpretationList({
  review,
}: {
  review: ObservationSessionReview;
}) {
  if (review.interpretations.length === 0) {
    return (
      <p className="text-sm leading-6 text-[var(--nsn-slate)]">
        There is no clear interpretation yet.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      {review.interpretations.map((interpretation) => (
        <article
          className="min-w-0 border-l-2 border-[var(--nsn-border)] pl-3"
          key={interpretation.id}
        >
          <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            {interpretation.description}
          </p>
          <p className="mt-2 break-words text-xs leading-5 text-[var(--nsn-warm-gray)] [overflow-wrap:anywhere]">
            {interpretation.uncertainty}
          </p>
        </article>
      ))}
    </div>
  );
}

function SuggestionList({
  review,
}: {
  review: ObservationSessionReview;
}) {
  if (review.planSuggestions.length === 0) {
    return (
      <p className="text-sm leading-6 text-[var(--nsn-slate)]">
        There is no suggested next step yet.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      {review.planSuggestions.map((suggestion) => (
        <article
          className="min-w-0 border-l-2 border-[var(--nsn-border)] pl-3"
          key={suggestion.id}
        >
          <p className="break-words text-sm font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
            {suggestion.label}
          </p>
          <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            {suggestion.description}
          </p>
          <p className="mt-2 break-words text-xs leading-5 text-[var(--nsn-warm-gray)] [overflow-wrap:anywhere]">
            {suggestion.reason}
          </p>
        </article>
      ))}
    </div>
  );
}

function DecisionHistory({
  review,
}: {
  review: ObservationSessionReview;
}) {
  if (review.decisions.length === 0) {
    return (
      <p className="text-sm leading-6 text-[var(--nsn-slate)]">
        No human decision has been saved for this observation yet.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      {review.decisions.map((decision) => (
        <article
          className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3"
          key={decision.id}
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <p className="font-semibold text-[var(--nsn-navy)]">
              {decisionLabel(decision.decisionType)}
            </p>
            <p className="text-xs leading-5 text-[var(--nsn-warm-gray)]">
              {formatDate(decision.createdAt)}
            </p>
          </div>
          {decision.editedSuggestion ? (
            <p className="mt-3 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              {decision.editedSuggestion}
            </p>
          ) : null}
          {decision.note ? (
            <p className="mt-3 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              {decision.note}
            </p>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function RelatedKnowledgeList({
  review,
}: {
  review: ObservationSessionReview;
}) {
  if (review.relatedKnowledge.length === 0) {
    return (
      <p className="text-sm leading-6 text-[var(--nsn-slate)]">
        The Librarian has not found related knowledge for this observation yet.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      {review.relatedKnowledge.map((connection) => (
        <article
          className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3"
          key={connection.id}
        >
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
            <div className="min-w-0">
              <p className="break-words text-sm font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                {connection.documentName}
              </p>
              <p className="mt-1 text-xs leading-5 text-[var(--nsn-warm-gray)]">
                Observed {formatDate(connection.observedAt)}
              </p>
            </div>
            <NsnBadge tone="migration">
              {similarityLabel(connection.similarityScore)}
            </NsnBadge>
          </div>

          <p className="mt-3 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            {connection.reasoning}
          </p>

          {connection.sharedTerms.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {connection.sharedTerms.map((term) => (
                <NsnBadge key={term} tone="source">
                  {term}
                </NsnBadge>
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

export default async function ReviewObservationPage({
  params,
}: ReviewObservationPageProps) {
  const { sessionId } = await params;
  const review = await getObservationSessionReview(sessionId);

  if (!review) {
    notFound();
  }

  return (
    <LibraryShell active="review">
      <div className="grid gap-8">
        <NsnPageHeader
          description="The Librarian is observing patterns, not making final decisions. The machine suggests. Deanne decides."
          eyebrow="Recommendations"
          subtitle={review.documentName}
          title="Review Observation"
        >
          <Link
            className="inline-flex min-h-11 w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] sm:w-auto"
            href="/admin/library/review"
          >
            Back to Recommendations
          </Link>
        </NsnPageHeader>

        <NsnCard tone="aqua">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
            <div className="min-w-0">
              <div className="flex flex-wrap gap-2">
                <NsnBadge tone={statusTone(review.status)}>
                  {statusLabel(review.status)}
                </NsnBadge>
                <NsnBadge tone="source">
                  Confidence {formatConfidence(review.confidence)}
                </NsnBadge>
                <NsnBadge tone="migration">
                  {observationModeLabel(review.observerType)}
                </NsnBadge>
              </div>
              <p className="mt-4 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                {review.explanation.summary}
              </p>
            </div>
            <p className="text-sm leading-6 text-[var(--nsn-slate)]">
              Observed {formatDate(review.observedAt)}
            </p>
          </div>
        </NsnCard>

        <div className="grid gap-5 xl:grid-cols-2">
          <ReviewSection title="What the Librarian noticed">
            <ObservationList review={review} />
          </ReviewSection>

          <ReviewSection title="What this may mean">
            <InterpretationList review={review} />
          </ReviewSection>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <ReviewSection title="Why human review is needed">
            <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              {review.explanation.uncertainty}
            </p>
            {review.explanation.evidence.length > 0 ? (
              <ul className="grid gap-1 pl-4 text-sm leading-6 text-[var(--nsn-slate)]">
                {review.explanation.evidence.slice(0, 5).map((evidence) => (
                  <li
                    className="list-disc break-words [overflow-wrap:anywhere]"
                    key={evidence}
                  >
                    {evidence}
                  </li>
                ))}
              </ul>
            ) : null}
          </ReviewSection>

          <ReviewSection title="Possible next steps">
            <SuggestionList review={review} />
          </ReviewSection>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <ReviewSection title="Related Knowledge">
            <RelatedKnowledgeList review={review} />
          </ReviewSection>

          <ReviewSection title="Warnings">
            {review.warnings.length > 0 ? (
              <ul className="grid gap-1 pl-4 text-sm leading-6 text-[var(--nsn-slate)]">
                {review.warnings.map((warning) => (
                  <li
                    className="list-disc break-words [overflow-wrap:anywhere]"
                    key={warning}
                  >
                    {warning}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm leading-6 text-[var(--nsn-slate)]">
                No warnings for this observation.
              </p>
            )}
          </ReviewSection>
        </div>

        <div className="grid gap-5">
          <ReviewSection title="Review history">
            <DecisionHistory review={review} />
          </ReviewSection>
        </div>

        <ObservationDecisionPanel
          currentStatus={review.status}
          sessionId={review.id}
        />
      </div>
    </LibraryShell>
  );
}
