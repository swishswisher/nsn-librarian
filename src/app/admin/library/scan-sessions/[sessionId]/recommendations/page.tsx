import Link from "next/link";
import { notFound } from "next/navigation";

import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { OrganizationPlanGenerateButton } from "@/components/library/OrganizationPlanGenerateButton";
import { OrganizationSuggestionsReviewPanel } from "@/components/library/OrganizationSuggestionsReviewPanel";
import { RetryAutomaticProcessingButton } from "@/components/library/RetryAutomaticProcessingButton";
import { getOrganizationSuggestionsForScanSession } from "@/lib/bridge/organization-suggestions";
import { organizationSuggestionCounts } from "@/lib/bridge/scan-sessions";
import { getKnowledgeContextForRecommendations } from "@/lib/knowledge/queries";
import { getNotebookEntryForScanSession } from "@/lib/library/notebook";
import {
  getNotebookEntryRoute,
  getOrganizationPlanRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";

export const dynamic = "force-dynamic";

type RecommendationsPageProps = {
  params: Promise<{
    sessionId: string;
  }>;
};

function formatScanDate(value: string | null) {
  if (!value) {
    return "Not completed yet";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function recommendationLogicLabel(version: string) {
  const match = version.match(/-v(\d+)$/i);

  return match ? `Current recommendation logic: version ${match[1]}` : "Current recommendation logic";
}

export default async function RecommendationsPage({
  params,
}: RecommendationsPageProps) {
  const { sessionId } = await params;
  const data = await getOrganizationSuggestionsForScanSession(sessionId);

  if (!data) {
    notFound();
  }

  const notebookReflection = await getNotebookEntryForScanSession(data.session.id);
  const topicsBySuggestionId = await getKnowledgeContextForRecommendations(
    data.suggestions.map((suggestion) => suggestion.id),
  );
  const recommendationCounts = organizationSuggestionCounts(data.suggestions);
  const hasRecommendations = recommendationCounts.total > 0;
  const hasActiveRecommendations =
    data.regeneration.activeRecommendationCount > 0;
  const canBuildPlan = recommendationCounts.eligibleForPlanning > 0;
  const suggestionsStateKey = data.suggestions
    .map((suggestion) =>
      [
        suggestion.id,
        suggestion.status,
        suggestion.reviewedAt ?? "",
        suggestion.recommendationGenerationId,
      ].join(":"),
    )
    .join("|");

  return (
    <LibraryShell active="review">
      <div className="grid gap-8">
        <nav
          aria-label="Recommendation breadcrumbs"
          className="flex min-w-0 flex-wrap gap-2 text-sm font-semibold text-[var(--nsn-slate)]"
        >
          <Link
            className="break-words text-[var(--nsn-teal-dark)] underline-offset-4 hover:underline [overflow-wrap:anywhere]"
            href={getScanSessionRoute(data.session.id)}
          >
            {data.session.folderDisplayName}
          </Link>
          <span aria-hidden="true">/</span>
          <span>Recommendations</span>
        </nav>

        <NsnPageHeader
          description="These are practical recommendations only. No file moves unless Deanne approves a plan, previews the organization, and gives final confirmation."
          eyebrow="Recommendations"
          subtitle={`${data.session.folderDisplayName}. Started ${formatScanDate(
            data.session.startedAt,
          )}.`}
          title="Review the Librarian's Recommendations"
        >
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            {notebookReflection ? (
              <Link
                className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-gold)] bg-[var(--nsn-warm-beige)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sand)]"
                href={getNotebookEntryRoute(notebookReflection.id)}
              >
                Notebook Context
              </Link>
            ) : null}
            <Link
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
              href={getScanSessionRoute(data.session.id)}
            >
              Back to Scan Session
            </Link>
          </div>
        </NsnPageHeader>

        <NsnCard tone="sand">
          <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                Selected root
              </p>
              <p className="mt-1 break-words text-sm font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                {data.session.folderDisplayName}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                Scan started
              </p>
              <p className="mt-1 break-words text-sm font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                {formatScanDate(data.session.startedAt)}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                Files scanned
              </p>
              <p className="mt-1 break-words text-sm font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                {data.session.totalFiles}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                Ready for plan
              </p>
              <p className="mt-1 break-words text-sm font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                {recommendationCounts.eligibleForPlanning}
              </p>
            </div>
          </div>
        </NsnCard>

        {hasRecommendations ? (
          <NsnCard className="min-w-0">
            <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                  {recommendationLogicLabel(
                    data.regeneration.currentGenerationVersion,
                  )}
                </p>
                <h2 className="nsn-display mt-2 break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                  Re-analyze this existing scan
                </h2>
                <p className="mt-2 max-w-3xl break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  Regeneration applies the Librarian&apos;s current
                  recommendation logic to this saved scan snapshot. It does not
                  scan the Mac folder again and cannot move, change, or delete
                  files.
                </p>
                {data.regeneration.earlierGenerationCount > 0 ? (
                  <p className="mt-3 break-words text-sm font-semibold leading-6 text-[var(--nsn-warning)] [overflow-wrap:anywhere]">
                    {data.regeneration.earlierGenerationCount} active
                    recommendations were prepared with earlier logic and should
                    be regenerated before review.
                  </p>
                ) : null}
              </div>
              <RetryAutomaticProcessingButton
                busyLabel="Regenerating Recommendations..."
                label="Regenerate Recommendations"
                regenerate
                retryFailed={false}
                reviewedRecommendationCount={
                  data.regeneration.reviewedRecommendationCount
                }
                scanSessionId={data.session.id}
                variant="primary"
              />
            </div>
          </NsnCard>
        ) : null}

        {data.regeneration.historicalRecommendationCount > 0 ? (
          <NsnCard className="min-w-0" tone="sand">
            <details className="group min-w-0">
              <summary className="cursor-pointer break-words text-sm font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                Earlier recommendation history: {data.regeneration.historicalRecommendationCount}{" "}
                retained
              </summary>
              <p className="mt-3 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                Earlier recommendations remain available for audit context,
                including {data.regeneration.historicalReviewedCount}{" "}
                reviewed decisions. They are not active and cannot enter a new
                Organization Plan.
              </p>
              <div className="mt-4 grid min-w-0 gap-3">
                {data.regeneration.history.map((generation) => (
                  <div
                    className="grid min-w-0 gap-1 border-t border-[var(--nsn-border)] pt-3 text-sm text-[var(--nsn-slate)] sm:grid-cols-[minmax(0,1fr)_auto]"
                    key={generation.generationId}
                  >
                    <p className="break-words [overflow-wrap:anywhere]">
                      Earlier pass from {formatScanDate(generation.createdAt)}:
                      {" "}{generation.total} recommendations
                    </p>
                    <p className="break-words [overflow-wrap:anywhere]">
                      {generation.approved} approved, {generation.modified}{" "}
                      edited, {generation.rejected} rejected,{" "}
                      {generation.leftUnchanged} left unchanged
                    </p>
                  </div>
                ))}
              </div>
            </details>
          </NsnCard>
        ) : null}

        <NsnCard tone="aqua">
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
            <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              The Librarian is proposing organization recommendations, not
              changing files. Approved, rejected, edited, and unchanged
              decisions are stored for review only. No folder is created and no
              local file is changed. This page is limited to this selected root
              and this selected scan session.
            </p>
            {canBuildPlan ? (
              <OrganizationPlanGenerateButton
                label="Build Organization Plan"
                scanSessionId={data.session.id}
              />
            ) : hasRecommendations ? (
              <div className="rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-3 text-sm leading-6 text-[var(--nsn-slate)]">
                Approve or edit at least one recommendation from this scan
                session before building an Organization Plan.
              </div>
            ) : (
              <div className="rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-3 text-sm leading-6 text-[var(--nsn-slate)]">
                No recommendations are saved yet. Use the action below to ask
                the Librarian to prepare recommendations for this scan.
              </div>
            )}
          </div>
        </NsnCard>

        {hasRecommendations ? (
          <OrganizationSuggestionsReviewPanel
            key={suggestionsStateKey}
            notebookHref={
              notebookReflection
                ? getNotebookEntryRoute(notebookReflection.id)
                : null
            }
            scanSessionId={data.session.id}
            suggestions={data.suggestions}
            topicsBySuggestionId={topicsBySuggestionId}
          />
        ) : (
          <NsnCard className="min-w-0">
            <div className="grid min-w-0 gap-4 text-center">
              <h2 className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                No organization recommendations for this scan yet.
              </h2>
              <p className="mx-auto max-w-2xl break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                If this scan contains supported files, ask the Librarian to
                prepare recommendations for this scan session. It will not
                change, move, rename, create, delete, copy, or upload files.
              </p>
              <div className="mx-auto grid w-full max-w-md gap-3 sm:max-w-none sm:grid-cols-[auto_auto] sm:justify-center">
                <RetryAutomaticProcessingButton
                  busyLabel="Preparing Recommendations..."
                  label={
                    hasActiveRecommendations
                      ? "Regenerate Recommendations"
                      : "Generate Recommendations for This Scan"
                  }
                  regenerate={hasActiveRecommendations}
                  retryFailed={false}
                  reviewedRecommendationCount={
                    data.regeneration.reviewedRecommendationCount
                  }
                  scanSessionId={data.session.id}
                  variant="primary"
                />
                <Link
                  className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] [overflow-wrap:anywhere]"
                  href={getOrganizationPlanRoute(data.session.id)}
                >
                  Back to Organization Plan
                </Link>
              </div>
            </div>
          </NsnCard>
        )}
      </div>
    </LibraryShell>
  );
}
