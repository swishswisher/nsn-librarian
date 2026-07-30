import Link from "next/link";
import { notFound } from "next/navigation";

import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { RetryAutomaticProcessingButton } from "@/components/library/RetryAutomaticProcessingButton";
import { ScanSessionAutoRefresh } from "@/components/library/ScanSessionAutoRefresh";
import { ScannedFilesPanel } from "@/components/library/ScannedFilesPanel";
import { scannedFileCategoryCounts } from "@/lib/bridge/scanned-file-filters";
import { getBridgeScanSessionDetail } from "@/lib/bridge/scan-sessions";
import { getNotebookEntryForScanSession } from "@/lib/library/notebook";
import {
  getNotebookEntryRoute,
  getOrganizationPlanRoute,
  getRecommendationsRoute,
  getScanSessionsRoute,
} from "@/lib/library/routes";
import type { BridgeScanSessionStatus } from "@/lib/bridge/types";

export const dynamic = "force-dynamic";

type ScanSessionDetailPageProps = {
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

function statusLabel(status: BridgeScanSessionStatus) {
  if (status === "COMPLETED") {
    return "Completed";
  }

  if (status === "SCANNING") {
    return "Scanning";
  }

  if (status === "READING") {
    return "Reading";
  }

  if (status === "EXAMINING") {
    return "Examining";
  }

  if (status === "GENERATING_SUGGESTIONS") {
    return "Preparing recommendations";
  }

  if (status === "COMPLETED_WITH_ERRORS") {
    return "Completed with items needing attention";
  }

  if (status === "FAILED") {
    return "Needs attention";
  }

  return "Pending";
}

function statusTone(status: BridgeScanSessionStatus): NsnBadgeTone {
  if (status === "COMPLETED") {
    return "approved";
  }

  if (status === "FAILED" || status === "COMPLETED_WITH_ERRORS") {
    return "review";
  }

  return "pending";
}

function SummaryTile({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <NsnCard className="min-w-0">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
        {label}
      </p>
      <p className="nsn-display mt-2 break-words text-3xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
        {value}
      </p>
    </NsnCard>
  );
}

export default async function ScanSessionDetailPage({
  params,
}: ScanSessionDetailPageProps) {
  const { sessionId } = await params;
  const session = await getBridgeScanSessionDetail(sessionId);

  if (!session) {
    notFound();
  }

  const notebookReflection = await getNotebookEntryForScanSession(session.id);

  const filesRead = session.scannedFiles.filter(
    (file) => file.readingStatus === "READ",
  ).length;
  const filesWithSuggestions = session.scannedFiles.filter(
    (file) => file.organizationSuggestionCounts.total > 0,
  ).length;
  const categoryCounts = scannedFileCategoryCounts(session.scannedFiles);
  const needsAttention = session.scannedFiles.filter(
    (file) =>
      file.processingStage === "FAILED" ||
      file.readStatus === "FAILED" ||
      file.readingStatus === "FAILED" ||
      file.extractionStatus === "FAILED" ||
      Boolean(file.sourceUnavailableAt),
  ).length;
  const filesProcessed = session.scannedFiles.filter(
    (file) =>
      file.processingStage === "SUGGESTIONS_GENERATED" ||
      file.processingStage === "FAILED" ||
      file.processingStage === "UNSUPPORTED" ||
      file.readStatus === "UNSUPPORTED" ||
      file.readStatus === "FAILED" ||
      Boolean(file.sourceUnavailableAt),
  ).length;
  const remainingFiles = Math.max(0, session.totalFiles - filesProcessed);
  const canRetryProcessing = remainingFiles > 0 || needsAttention > 0;

  return (
    <LibraryShell active="documents">
      <div className="grid gap-8">
        <NsnPageHeader
          description="This scan session records what the Librarian found, read, observed, and recommended. Full extracted text is used only temporarily while examining files."
          eyebrow="Scan Session"
          subtitle={`Started ${formatScanDate(session.startedAt)}. Completed ${formatScanDate(
            session.completedAt,
          )}.`}
          title={session.folderDisplayName}
        >
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <Link
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)]"
              href={getRecommendationsRoute(session.id)}
            >
              Review Recommendations
            </Link>
            <Link
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-gold)] bg-[var(--nsn-warm-beige)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sand)]"
              href={getOrganizationPlanRoute(session.id)}
            >
              View Organization Plan
            </Link>
            {notebookReflection ? (
              <Link
                className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                href={getNotebookEntryRoute(notebookReflection.id)}
              >
                View Notebook Reflection
              </Link>
            ) : null}
            <Link
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
              href={getScanSessionsRoute()}
            >
              Back to Scan Sessions
            </Link>
          </div>
        </NsnPageHeader>

        <section
          aria-label="Scan session summary"
          className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-9"
        >
          <NsnCard className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
              Status
            </p>
            <div className="mt-3">
              <NsnBadge tone={statusTone(session.status)}>
                {statusLabel(session.status)}
              </NsnBadge>
            </div>
          </NsnCard>
          <SummaryTile label="Files Found" value={session.totalFiles} />
          <SummaryTile label="Files Examined" value={filesProcessed} />
          <SummaryTile
            label="Recommendations Ready"
            value={filesWithSuggestions}
          />
          <SummaryTile label="Documents" value={categoryCounts.documents} />
          <SummaryTile label="Images" value={categoryCounts.images} />
          <SummaryTile label="Audio Recordings" value={categoryCounts.audio} />
          <SummaryTile label="Video Recordings" value={categoryCounts.video} />
          <SummaryTile label="Unsupported" value={session.unsupportedFiles} />
          <SummaryTile label="Needs Attention" value={needsAttention} />
          <SummaryTile label="Remaining" value={remainingFiles} />
        </section>

        <ScanSessionAutoRefresh
          initialStatus={session.status}
          scanSessionId={session.id}
        />

        {canRetryProcessing ? (
          <NsnCard tone="sand">
            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
              <div className="min-w-0">
                <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">
                  Continue Folder Examination
                </h2>
                <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  Use this for older or interrupted scan sessions. The
                  Librarian will examine only files still waiting or needing
                  attention, and it will not duplicate existing observations or
                  recommendations.
                </p>
              </div>
              <RetryAutomaticProcessingButton scanSessionId={session.id} />
            </div>
          </NsnCard>
        ) : null}

        <section
          aria-label="Organization recommendation summary"
          className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-8"
        >
          <SummaryTile
            label="Files Examined"
            value={session.organizationSummary.filesExamined}
          />
          <SummaryTile label="Files Read" value={filesRead} />
          <SummaryTile
            label="Pending Recommendations"
            value={session.organizationSummary.pending}
          />
          <SummaryTile
            label="Approved"
            value={session.organizationSummary.approved}
          />
          <SummaryTile
            label="Modified"
            value={session.organizationSummary.modified}
          />
          <SummaryTile
            label="Ready for Plan"
            value={session.organizationSummary.eligibleForPlanning}
          />
          <SummaryTile
            label="Rejected"
            value={session.organizationSummary.rejected}
          />
          <SummaryTile
            label="Left Unchanged"
            value={session.organizationSummary.leftUnchanged}
          />
        </section>

        <ScannedFilesPanel files={session.scannedFiles} scanSessionId={session.id} />
      </div>
    </LibraryShell>
  );
}
