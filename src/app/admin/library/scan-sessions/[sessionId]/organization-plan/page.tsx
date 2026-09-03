import Link from "next/link";
import { notFound } from "next/navigation";

import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { OrganizationPlanGenerateButton } from "@/components/library/OrganizationPlanGenerateButton";
import { OrganizationPlanReviewPanel } from "@/components/library/OrganizationPlanReviewPanel";
import { RetryAutomaticProcessingButton } from "@/components/library/RetryAutomaticProcessingButton";
import { getOrganizationPlanPageData } from "@/lib/bridge/planner";
import type {
  BridgeScanSessionSummary,
  OrganizationSuggestionCounts,
} from "@/lib/bridge/types";
import { getNotebookEntryForOrganizationPlan } from "@/lib/library/notebook";
import {
  getNotebookEntryRoute,
  getRecommendationsRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";

export const dynamic = "force-dynamic";

type OrganizationPlanPageProps = {
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

function EmptyPlanningState({
  recommendationCounts,
  session,
}: {
  recommendationCounts: OrganizationSuggestionCounts;
  session: BridgeScanSessionSummary;
}) {
  const hasRecommendations = recommendationCounts.total > 0;
  const hasReviewedSuggestions = recommendationCounts.eligibleForPlanning > 0;

  if (!hasRecommendations) {
    return (
      <NsnCard className="min-w-0">
        <div className="grid min-w-0 gap-5 text-center">
          <div className="min-w-0">
            <h2 className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
              This scan session has no organization recommendations yet.
            </h2>
            <p className="mx-auto mt-3 max-w-2xl break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              The Librarian has not saved organization recommendations for{" "}
              {session.folderDisplayName} from this scan. You can ask it to
              prepare recommendations for this scan session without moving,
              renaming, creating, deleting, or copying files.
            </p>
          </div>
          <div className="mx-auto grid w-full max-w-md gap-3 sm:max-w-none sm:grid-cols-[auto_auto] sm:justify-center">
            <RetryAutomaticProcessingButton
              busyLabel="Preparing Recommendations..."
              label="Generate Recommendations for This Scan"
              retryFailed={false}
              scanSessionId={session.id}
              variant="primary"
            />
            <Link
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] [overflow-wrap:anywhere]"
              href={getScanSessionRoute(session.id)}
            >
              Back to Scan Session
            </Link>
          </div>
        </div>
      </NsnCard>
    );
  }

  return (
    <NsnCard className="min-w-0">
      <div className="grid min-w-0 gap-5 text-center">
        <div className="min-w-0">
          <h2 className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
            {hasReviewedSuggestions
              ? "No organization plan has been generated yet."
              : "No reviewed recommendations are ready for planning."}
          </h2>
          <p className="mx-auto mt-3 max-w-2xl break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            {hasReviewedSuggestions
              ? `Build a plan from the approved and edited recommendations for ${session.folderDisplayName}. The Librarian will not include pending, rejected, or unchanged recommendations.`
              : `Review recommendations for ${session.folderDisplayName} from this exact scan session. Only approved or edited organization recommendations can enter a plan.`}
          </p>
        </div>
        <div className="mx-auto grid w-full max-w-md gap-3 sm:max-w-none sm:grid-cols-[auto_auto] sm:justify-center">
          {hasReviewedSuggestions ? (
            <OrganizationPlanGenerateButton
              label="Build Organization Plan"
              scanSessionId={session.id}
            />
          ) : (
            <Link
              className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] sm:w-auto"
              href={getRecommendationsRoute(session.id)}
            >
              Review Recommendations
            </Link>
          )}
          <Link
            className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] [overflow-wrap:anywhere]"
            href={getScanSessionRoute(session.id)}
          >
            Back to Scan Session
          </Link>
        </div>
      </div>
    </NsnCard>
  );
}

export default async function OrganizationPlanPage({
  params,
}: OrganizationPlanPageProps) {
  const { sessionId } = await params;
  const data = await getOrganizationPlanPageData(sessionId);

  if (!data) {
    notFound();
  }

  const hasReviewedSuggestions =
    data.planningEligibility.eligibleForPlanning > 0;
  const hasUsablePlan = Boolean(data.plan && data.plan.totalActions > 0);
  const notebookReflection = data.plan
    ? await getNotebookEntryForOrganizationPlan(data.plan.id)
    : null;

  return (
    <LibraryShell active="review">
      <div className="grid min-w-0 gap-8">
        <NsnPageHeader
          description="Nothing will move yet. Select where each file should go, save your choices, and review the final changes before execution."
          eyebrow="Organization Plan"
          subtitle={`${data.session.folderDisplayName}. Started ${formatScanDate(
            data.session.startedAt,
          )}.`}
          title="Choose which changes to include"
        >
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            {hasReviewedSuggestions ? (
              <OrganizationPlanGenerateButton
                label={
                  data.plan ? "Regenerate Plan" : "Generate Organization Plan"
                }
                scanSessionId={data.session.id}
              />
            ) : null}
            <Link
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
              href={getScanSessionRoute(data.session.id)}
            >
              Back to Scan Session
            </Link>
            {notebookReflection ? (
              <Link
                className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] px-4 text-center text-sm font-semibold text-[var(--nsn-teal-dark)] transition hover:bg-[var(--nsn-soft-aqua)]"
                href={getNotebookEntryRoute(notebookReflection.id)}
              >
                Notebook Reflection
              </Link>
            ) : null}
          </div>
        </NsnPageHeader>

        {hasUsablePlan && data.plan ? (
          <OrganizationPlanReviewPanel
            latestExecution={data.latestExecution}
            plan={data.plan}
            rootLabel={data.session.folderDisplayName}
          />
        ) : (
          <EmptyPlanningState
            recommendationCounts={data.planningEligibility}
            session={data.session}
          />
        )}
      </div>
    </LibraryShell>
  );
}
