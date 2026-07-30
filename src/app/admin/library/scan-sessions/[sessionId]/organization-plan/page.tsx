import Link from "next/link";
import { notFound } from "next/navigation";

import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { OrganizationPlanGenerateButton } from "@/components/library/OrganizationPlanGenerateButton";
import { OrganizationPlanReviewPanel } from "@/components/library/OrganizationPlanReviewPanel";
import { getOrganizationPlanPageData } from "@/lib/bridge/planner";
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
  hasReviewedSuggestions,
  sessionId,
}: {
  hasReviewedSuggestions: boolean;
  sessionId: string;
}) {
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
              ? "Generate a plan after reviewing recommendations. The Librarian will include approved and modified recommendations only."
              : "Approve or modify recommendations before asking the Librarian to build a plan."}
          </p>
        </div>
        <div className="flex justify-center">
          <Link
            className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] sm:w-auto"
            href={getRecommendationsRoute(sessionId)}
          >
            Review Recommendations
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
  const hasUsablePlan = Boolean(
    hasReviewedSuggestions && data.plan && data.plan.totalActions > 0,
  );
  const notebookReflection = data.plan
    ? await getNotebookEntryForOrganizationPlan(data.plan.id)
    : null;

  return (
    <LibraryShell active="review">
      <div className="grid min-w-0 gap-8">
        <NsnPageHeader
          description="This plan gathers only reviewed recommendations into one inspection view. Organizing files requires plan approval, a safety preview, and Deanne's final confirmation."
          eyebrow="Organization Plan"
          subtitle={`${data.session.folderDisplayName}. Started ${formatScanDate(
            data.session.startedAt,
          )}.`}
          title="Review Organization Plan"
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

        <NsnCard tone="aqua">
          <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            The Organization Plan is a readable checklist for Deanne. It keeps
            every planned action, warning, skipped item, and decision history
            visible before the Bridge is allowed to create folders, move files,
            or rename files.
          </p>
        </NsnCard>

        {hasUsablePlan && data.plan ? (
          <OrganizationPlanReviewPanel
            latestExecution={data.latestExecution}
            plan={data.plan}
          />
        ) : (
          <EmptyPlanningState
            hasReviewedSuggestions={hasReviewedSuggestions}
            sessionId={data.session.id}
          />
        )}
      </div>
    </LibraryShell>
  );
}
