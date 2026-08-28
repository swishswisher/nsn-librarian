import Link from "next/link";

import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getOrganizationPlanScanSessionSelectorData } from "@/lib/bridge/organization-plan-selector";
import type {
  ConnectedLibraryPlatform,
  ConnectedLibraryStatus,
  OrganizationSuggestionCounts,
} from "@/lib/bridge/types";
import {
  getOrganizationPlanRoute,
  getOrganizationPlansRoute,
  getRecommendationsRoute,
} from "@/lib/library/routes";

export const dynamic = "force-dynamic";

const linkBaseClass =
  "inline-flex min-h-11 max-w-full items-center justify-center rounded-md border px-4 text-center text-sm font-semibold transition [overflow-wrap:anywhere]";
const primaryLinkClass = `${linkBaseClass} border-[var(--nsn-teal)] bg-[var(--nsn-teal)] text-[var(--nsn-white)] hover:bg-[var(--nsn-teal-dark)]`;
const secondaryLinkClass = `${linkBaseClass} border-[var(--nsn-border)] bg-[var(--nsn-card)] text-[var(--nsn-navy)] hover:bg-[var(--nsn-sage-mist)]`;

function formatScanDate(value: string | null) {
  if (!value) {
    return "Not completed yet";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function platformLabel(platform: ConnectedLibraryPlatform) {
  return platform === "MACOS" ? "macOS" : titleCase(platform);
}

function rootStatusTone(status: ConnectedLibraryStatus): NsnBadgeTone {
  if (status === "CONNECTED") {
    return "approved";
  }

  if (status === "NEEDS_ATTENTION" || status === "DISCONNECTED") {
    return "review";
  }

  return "source";
}

function sessionStatusTone(status: string): NsnBadgeTone {
  if (status === "COMPLETED") {
    return "approved";
  }

  if (status === "COMPLETED_WITH_ERRORS") {
    return "review";
  }

  return "pending";
}

function eligibilityText(counts: OrganizationSuggestionCounts) {
  if (counts.eligibleForPlanning > 0) {
    return `${counts.eligibleForPlanning} reviewed recommendation${
      counts.eligibleForPlanning === 1 ? "" : "s"
    } ready for an Organization Plan.`;
  }

  if (counts.total === 0) {
    return "No organization recommendations have been saved for this scan yet.";
  }

  if (counts.pending > 0) {
    return "Review at least one pending recommendation before building a plan.";
  }

  return "No approved or edited recommendations are ready for planning.";
}

function RecommendationCountBadges({
  counts,
}: {
  counts: OrganizationSuggestionCounts;
}) {
  return (
    <div className="flex min-w-0 flex-wrap gap-2 text-sm">
      <NsnBadge tone="pending">Pending {counts.pending}</NsnBadge>
      <NsnBadge tone="approved">Approved {counts.approved}</NsnBadge>
      <NsnBadge tone="approved">Edited {counts.modified}</NsnBadge>
      <NsnBadge tone="review">Rejected {counts.rejected}</NsnBadge>
      <NsnBadge tone="source">Left unchanged {counts.leftUnchanged}</NsnBadge>
    </div>
  );
}

export default async function OrganizationPlanScanSessionSelectorPage() {
  const data = await getOrganizationPlanScanSessionSelectorData();

  return (
    <LibraryShell active="migration">
      <div className="grid min-w-0 gap-8">
        <NsnPageHeader
          description="Choose one completed scan session from one connected root. Plans are built from that scan session only, and nothing moves until a later approval and execution step."
          eyebrow="Organization Plans"
          subtitle={`${data.totalCompletedSessions} completed scan session${
            data.totalCompletedSessions === 1 ? "" : "s"
          } available`}
          title="Choose a Scan Session to Build a Plan"
        >
          <Link className={secondaryLinkClass} href={getOrganizationPlansRoute()}>
            Back to Organization Plans
          </Link>
        </NsnPageHeader>

        {data.roots.length === 0 ? (
          <NsnEmptyState
            description="Connect a folder and complete a scan before building an Organization Plan."
            title="No connected roots yet"
          />
        ) : null}

        <div className="grid min-w-0 gap-6">
          {data.roots.map((root) => (
            <section
              aria-labelledby={`organization-plan-root-${root.id}`}
              className="grid min-w-0 gap-4"
              key={root.id}
            >
              <NsnCard className="min-w-0">
                <div className="grid min-w-0 gap-4">
                  <div className="flex min-w-0 flex-wrap gap-2">
                    <NsnBadge tone={rootStatusTone(root.status)}>
                      {titleCase(root.status)}
                    </NsnBadge>
                    <NsnBadge tone="source">{platformLabel(root.platform)}</NsnBadge>
                    <NsnBadge tone="source">
                      {root.completedScanSessions.length} completed scan
                      {root.completedScanSessions.length === 1 ? "" : "s"}
                    </NsnBadge>
                  </div>
                  <div className="min-w-0">
                    <h2
                      className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
                      id={`organization-plan-root-${root.id}`}
                    >
                      {root.displayName}
                    </h2>
                    <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      This root is kept separate from every other connected
                      library when recommendations become an Organization Plan.
                    </p>
                  </div>
                </div>
              </NsnCard>

              {root.completedScanSessions.length === 0 ? (
                <NsnCard className="min-w-0" tone="sand">
                  <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                    This connected root does not have a completed scan session
                    ready for planning yet.
                  </p>
                </NsnCard>
              ) : (
                <div className="grid min-w-0 gap-4">
                  {root.completedScanSessions.map((session) => (
                    <NsnCard className="min-w-0" key={session.id}>
                      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                        <div className="grid min-w-0 gap-4">
                          <div className="flex min-w-0 flex-wrap gap-2">
                            <NsnBadge tone={sessionStatusTone(session.status)}>
                              {titleCase(session.status)}
                            </NsnBadge>
                            <NsnBadge
                              tone={
                                session.eligibleForPlanning
                                  ? "approved"
                                  : "pending"
                              }
                            >
                              {session.eligibleForPlanning
                                ? "Eligible for planning"
                                : "Review needed first"}
                            </NsnBadge>
                          </div>

                          <div className="min-w-0">
                            <h3 className="nsn-display break-words text-xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                              {root.displayName}
                            </h3>
                            <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                              Scan started {formatScanDate(session.startedAt)}.
                              Completed {formatScanDate(session.completedAt)}.
                            </p>
                          </div>

                          <div className="grid min-w-0 gap-3 text-sm leading-6 text-[var(--nsn-slate)]">
                            <p>
                              {session.fileCount} file
                              {session.fileCount === 1 ? "" : "s"} scanned.
                            </p>
                            <RecommendationCountBadges
                              counts={session.recommendationCounts}
                            />
                            <p className="break-words font-semibold text-[var(--nsn-teal-dark)] [overflow-wrap:anywhere]">
                              {eligibilityText(session.recommendationCounts)}
                            </p>
                          </div>
                        </div>

                        <div className="grid min-w-0 gap-2 lg:min-w-56">
                          <Link
                            className={primaryLinkClass}
                            href={getOrganizationPlanRoute(session.id)}
                          >
                            Open Organization Plan
                          </Link>
                          <Link
                            className={secondaryLinkClass}
                            href={getRecommendationsRoute(session.id)}
                          >
                            Review Recommendations
                          </Link>
                        </div>
                      </div>
                    </NsnCard>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </LibraryShell>
  );
}
