import Link from "next/link";
import type { ReactNode } from "react";

import { BridgeScanControl } from "@/components/library/BridgeScanControl";
import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnCard } from "@/components/library/NsnCard";
import { getBridgeCloudStatus } from "@/lib/bridge/cloud-coordinator";
import { getConnectedLibraries } from "@/lib/bridge/connected-libraries";
import { effectiveBridgeHealth } from "@/lib/bridge/effective-health";
import {
  bridgeHomeHealthDisplay,
  bridgeHomeShellStatus,
} from "@/lib/bridge/home-health";
import { getMonitoringDashboardData } from "@/lib/bridge/monitor";
import { getCurrentOrganizationPlanForHomepage } from "@/lib/bridge/planner";
import {
  getActiveBridgeScanSessionProgress,
  getBridgeScanSessions,
} from "@/lib/bridge/scan-sessions";
import { getLocalBridgeHealth } from "@/lib/bridge/local-bridge-client";
import { getKnowledgeHomepagePreview } from "@/lib/knowledge/queries";
import {
  getLibraryDocuments,
  getReviewQueueItems,
} from "@/lib/library/data";
import { getNotebookHomepagePreview } from "@/lib/library/notebook";
import {
  getKnowledgeRoute,
  getKnowledgeTopicRoute,
  getBridgeMonitoringRoute,
  getBridgeDownloadRoute,
  getConnectedLibrariesRoute,
  getConnectThisMacRoute,
  getNotebookEntryRoute,
  getNotebookRoute,
  getScanSessionRoute,
  getScanSessionsRoute,
} from "@/lib/library/routes";
import type {
  BridgeExecutionRunSummary,
  BridgeScanProcessingProgress,
  BridgeScanSessionSummary,
} from "@/lib/bridge/types";

export const dynamic = "force-dynamic";

type CurrentPlan = Awaited<ReturnType<typeof getCurrentOrganizationPlanForHomepage>>;
type NotebookHomepagePreview = Awaited<ReturnType<typeof getNotebookHomepagePreview>>;
type KnowledgeHomepagePreview = Awaited<ReturnType<typeof getKnowledgeHomepagePreview>>;
type MonitoringDashboard = Awaited<ReturnType<typeof getMonitoringDashboardData>>;

type AttentionTask = {
  actionLabel: string;
  description: string;
  href: string;
  id: string;
  tone: NsnBadgeTone;
  title: string;
};

type ActivityItem = {
  at: string;
  description: string;
  href: string;
  id: string;
  tone: NsnBadgeTone;
};

type LibraryEntryProps = {
  children?: ReactNode;
  description: string;
  href?: string;
  label: string;
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

function executionNeedsAttention(execution: BridgeExecutionRunSummary | null) {
  const latestUndo = execution?.latestUndoRun;

  return (
    execution?.status === "FAILED" ||
    latestUndo?.status === "FAILED" ||
    latestUndo?.status === "PARTIALLY_COMPLETED" ||
    latestUndo?.status === "BLOCKED"
  );
}

function undoIsAvailable(execution: BridgeExecutionRunSummary | null) {
  if (!execution) {
    return false;
  }

  const latestUndo = execution.latestUndoRun;

  if (latestUndo?.status === "COMPLETED" || latestUndo?.status === "RUNNING") {
    return false;
  }

  return (
    execution.status === "COMPLETED" ||
    execution.status === "PARTIALLY_COMPLETED"
  );
}

function monitoringFolderSummary(dashboard: MonitoringDashboard) {
  const folderCount = dashboard.folders.length;

  if (folderCount === 0) {
    return "No connected folders yet";
  }

  const watchingCount = dashboard.folders.filter(
    (folder) => folder.state === "WATCHING",
  ).length;
  const attentionCount = dashboard.folders.filter(
    (folder) => folder.state === "NEEDS_ATTENTION",
  ).length;
  const folderLabel = `${folderCount} connected folder${
    folderCount === 1 ? "" : "s"
  }`;

  if (attentionCount > 0) {
    return `${folderLabel} · ${attentionCount} need attention`;
  }

  if (watchingCount > 0) {
    return `${folderLabel} · ${watchingCount} watching`;
  }

  return `${folderLabel} · Not watching`;
}

function buildAttentionTasks({
  activeProgress,
  currentPlan,
  monitoringDashboard,
  reviewQueueCount,
  scanSessions,
}: {
  activeProgress: BridgeScanProcessingProgress | null;
  currentPlan: CurrentPlan;
  monitoringDashboard: MonitoringDashboard;
  reviewQueueCount: number;
  scanSessions: BridgeScanSessionSummary[];
}) {
  const tasks: AttentionTask[] = [];

  if (activeProgress?.isActive) {
    tasks.push({
      actionLabel: "View Scan Session",
      description: `${activeProgress.filesDiscovered} files found, ${activeProgress.filesWithSuggestions} recommendations prepared, ${activeProgress.failedFiles} needing attention.`,
      href: getScanSessionRoute(activeProgress.sessionId),
      id: "active-scan",
      tone: "migration",
      title: `The Librarian is examining ${activeProgress.folderDisplayName}.`,
    });
  }

  if (reviewQueueCount > 0) {
    tasks.push({
      actionLabel: "Review Recommendations",
      description:
        "The Librarian has observations ready for human review. Nothing enters Memory until Deanne decides.",
      href: "/admin/library/review",
      id: "review-queue",
      tone: "review",
      title: `${reviewQueueCount} recommendation${
        reviewQueueCount === 1 ? " is" : "s are"
      } ready`,
    });
  }

  if (monitoringDashboard.queue.needsAttention > 0) {
    tasks.push({
      actionLabel: "Open Monitoring",
      description:
        "A watched folder change needs a human look before it can be trusted.",
      href: getBridgeMonitoringRoute(),
      id: "monitoring-attention",
      tone: "review",
      title: "A watched folder change needs attention",
    });
  }

  if (currentPlan?.plan.status === "DRAFT") {
    tasks.push({
      actionLabel: "Approve Organization Plan",
      description:
        "The Librarian prepared a proposed reorganization from reviewed recommendations.",
      href: currentPlan.href,
      id: "plan-draft",
      tone: "pending",
      title: "An Organization Plan is waiting for approval",
    });
  } else if (
    currentPlan?.plan.status === "READY_FOR_EXECUTION" &&
    !currentPlan.latestExecution
  ) {
    tasks.push({
      actionLabel: "Preview Organization",
      description:
        "The plan is approved. The Bridge still needs a safety preview and Deanne's final confirmation before anything changes.",
      href: currentPlan.href,
      id: "plan-ready",
      tone: "approved",
      title: "An Organization Plan is ready to inspect",
    });
  }

  if (executionNeedsAttention(currentPlan?.latestExecution ?? null)) {
    tasks.push({
      actionLabel: "View Organization Plan",
      description:
        "The Bridge stopped safely. Review what changed, what failed, and what needs attention.",
      href: currentPlan?.href ?? "/admin/library/migration",
      id: "execution-attention",
      tone: "review",
      title: "An organization needs attention",
    });
  } else if (undoIsAvailable(currentPlan?.latestExecution ?? null)) {
    tasks.push({
      actionLabel: "Preview Undo",
      description:
        "The last completed organization can be restored from the Organization Plan page if Deanne chooses.",
      href: currentPlan?.href ?? "/admin/library/migration",
      id: "undo-available",
      tone: "source",
      title: "Undo is available",
    });
  }

  const latestTroubledScan = scanSessions.find(
    (session) =>
      session.failedFiles > 0 ||
      session.status === "FAILED" ||
      session.status === "COMPLETED_WITH_ERRORS",
  );

  if (latestTroubledScan) {
    tasks.push({
      actionLabel: "View Scan Session",
      description: `${latestTroubledScan.failedFiles} file${
        latestTroubledScan.failedFiles === 1 ? "" : "s"
      } need attention from this scan.`,
      href: getScanSessionRoute(latestTroubledScan.id),
      id: "files-need-attention",
      tone: "review",
      title: "Some files need recovery",
    });
  }

  return tasks;
}

function buildRecentActivity({
  activeProgress,
  currentPlan,
  scanSessions,
}: {
  activeProgress: BridgeScanProcessingProgress | null;
  currentPlan: CurrentPlan;
  scanSessions: BridgeScanSessionSummary[];
}) {
  const activity: ActivityItem[] = [];

  if (activeProgress) {
    activity.push({
      at: activeProgress.lastActivityAt,
      description: `The Librarian is examining ${activeProgress.folderDisplayName}: ${activeProgress.filesProcessed} files examined, ${activeProgress.filesWithSuggestions} recommendations prepared.`,
      href: getScanSessionRoute(activeProgress.sessionId),
      id: "activity-active-scan",
      tone: "migration",
    });
  }

  for (const session of scanSessions.slice(0, 3)) {
    activity.push({
      at: session.completedAt ?? session.startedAt,
      description:
        session.status === "COMPLETED" || session.status === "COMPLETED_WITH_ERRORS"
          ? `The Librarian examined ${session.totalFiles} file${
              session.totalFiles === 1 ? "" : "s"
            } in ${session.folderDisplayName}.`
          : `A scan session started for ${session.folderDisplayName}.`,
      href: getScanSessionRoute(session.id),
      id: `activity-scan-${session.id}`,
      tone:
        session.status === "FAILED" || session.status === "COMPLETED_WITH_ERRORS"
          ? "review"
          : "source",
    });
  }

  if (currentPlan) {
    activity.push({
      at: currentPlan.plan.updatedAt,
      description: `An Organization Plan was prepared for ${currentPlan.folderDisplayName}.`,
      href: currentPlan.href,
      id: `activity-plan-${currentPlan.plan.id}`,
      tone:
        currentPlan.plan.status === "READY_FOR_EXECUTION"
          ? "approved"
          : "pending",
    });
  }

  const latestExecution = currentPlan?.latestExecution;

  if (latestExecution?.completedAt) {
    activity.push({
      at: latestExecution.completedAt,
      description:
        latestExecution.status === "COMPLETED"
          ? `${latestExecution.completedActions} organization action${
              latestExecution.completedActions === 1 ? "" : "s"
            } completed successfully.`
          : `${latestExecution.completedActions} action${
              latestExecution.completedActions === 1 ? "" : "s"
            } completed, and ${latestExecution.failedActions} need attention.`,
      href: currentPlan?.href ?? "/admin/library/migration",
      id: `activity-execution-${latestExecution.id}`,
      tone: latestExecution.failedActions > 0 ? "review" : "approved",
    });
  }

  const latestUndo = latestExecution?.latestUndoRun;

  if (latestUndo?.completedAt) {
    activity.push({
      at: latestUndo.completedAt,
      description:
        latestUndo.status === "COMPLETED"
          ? "An organization was undone and completed changes were restored."
          : "An undo attempt stopped safely and needs attention.",
      href: currentPlan?.href ?? "/admin/library/migration",
      id: `activity-undo-${latestUndo.id}`,
      tone: latestUndo.status === "COMPLETED" ? "approved" : "review",
    });
  }

  return activity
    .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
    .slice(0, 6);
}

function AttentionCard({ task }: { task: AttentionTask }) {
  return (
    <NsnCard className="min-w-0">
      <article className="grid h-full min-w-0 gap-4">
        <div className="min-w-0">
          <NsnBadge tone={task.tone}>Needs your attention</NsnBadge>
          <h3 className="nsn-display mt-3 break-words text-2xl leading-8 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
            {task.title}
          </h3>
          <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            {task.description}
          </p>
        </div>
        <Link
          className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] sm:w-fit"
          href={task.href}
        >
          {task.actionLabel}
        </Link>
      </article>
    </NsnCard>
  );
}

function LibraryEntry({ children, description, href, label }: LibraryEntryProps) {
  const content = (
    <div className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 transition hover:bg-[var(--nsn-sage-mist)]">
      <p className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
        {label}
      </p>
      <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
        {description}
      </p>
      {children}
    </div>
  );

  if (!href) {
    return content;
  }

  return (
    <Link className="block min-w-0" href={href}>
      {content}
    </Link>
  );
}

function ActivityTimeline({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return (
      <NsnCard className="min-w-0">
        <p className="text-sm leading-7 text-[var(--nsn-slate)]">
          Activity will appear here after the Librarian scans, examines,
          prepares recommendations, organizes files, or restores changes.
        </p>
      </NsnCard>
    );
  }

  return (
    <ol className="grid min-w-0 gap-3">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 transition hover:bg-[var(--nsn-sage-mist)] sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start"
            href={item.href}
          >
            <NsnBadge tone={item.tone}>{formatShortDate(item.at)}</NsnBadge>
            <div className="min-w-0">
              <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                {item.description}
              </p>
              <p className="mt-1 text-xs leading-5 text-[var(--nsn-warm-gray)]">
                {formatDateTime(item.at)}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ol>
  );
}

function NotebookPreview({ preview }: { preview: NotebookHomepagePreview }) {
  const hasEntries = Boolean(
    preview.latestReflection ||
      preview.unresolvedQuestion ||
      preview.recentLearning,
  );

  if (!hasEntries) {
    return (
      <NsnCard className="min-w-0" tone="aqua">
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            The Notebook will begin collecting meaningful reflections after the
            Librarian scans, examines, learns from decisions, prepares plans, or
            completes organization work.
          </p>
          <Link
            className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] sm:w-fit"
            href={getNotebookRoute()}
          >
            Open Notebook
          </Link>
        </div>
      </NsnCard>
    );
  }

  return (
    <NsnCard className="min-w-0">
      <div className="grid min-w-0 gap-5">
        {preview.latestReflection ? (
          <article className="grid min-w-0 gap-2">
            <NsnBadge tone="source">Latest reflection</NsnBadge>
            <Link
              className="group block min-w-0"
              href={getNotebookEntryRoute(preview.latestReflection.id)}
            >
              <h3 className="nsn-display break-words text-2xl leading-8 text-[var(--nsn-navy)] [overflow-wrap:anywhere] group-hover:text-[var(--nsn-teal-dark)]">
                {preview.latestReflection.title}
              </h3>
              <p className="mt-2 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                {preview.latestReflection.summary}
              </p>
            </Link>
          </article>
        ) : null}

        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          {preview.unresolvedQuestion ? (
            <Link
              className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-4 transition hover:bg-[var(--nsn-sage-mist)]"
              href={getNotebookEntryRoute(preview.unresolvedQuestion.id)}
            >
              <NsnBadge tone="review">Question</NsnBadge>
              <p className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                {preview.unresolvedQuestion.title}
              </p>
              <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                {preview.unresolvedQuestion.summary}
              </p>
            </Link>
          ) : null}

          {preview.recentLearning ? (
            <Link
              className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-4 transition hover:bg-[var(--nsn-sage-mist)]"
              href={getNotebookEntryRoute(preview.recentLearning.id)}
            >
              <NsnBadge tone="approved">Recent learning</NsnBadge>
              <p className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                {preview.recentLearning.title}
              </p>
              <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                {preview.recentLearning.summary}
              </p>
            </Link>
          ) : null}
        </div>

        <Link
          className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] sm:w-fit"
          href={getNotebookRoute()}
        >
          Open Notebook
        </Link>
      </div>
    </NsnCard>
  );
}

function KnowledgePreview({ preview }: { preview: KnowledgeHomepagePreview }) {
  const items = [
    preview.growingTopic
      ? {
          badge: "Growing topic",
          description: `${preview.growingTopic.occurrenceCount} appearances recorded across reviewed material.`,
          item: preview.growingTopic,
        }
      : null,
    preview.newlyApproved
      ? {
          badge: "Newly approved",
          description: "This can now be treated as trusted Knowledge Graph material.",
          item: preview.newlyApproved,
        }
      : null,
    preview.needsReview
      ? {
          badge: "Needs review",
          description: "The Librarian is proposing this topic, but Deanne has not approved it.",
          item: preview.needsReview,
        }
      : null,
    preview.crossFileTopic
      ? {
          badge: "Across files",
          description: "This topic appears in more than one source context.",
          item: preview.crossFileTopic,
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  if (items.length === 0) {
    return (
      <NsnCard className="min-w-0" tone="aqua">
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            Topics will appear after the Librarian has enough reviewed material
            to propose meaningful knowledge.
          </p>
          <Link
            className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] sm:w-fit"
            href={getKnowledgeRoute()}
          >
            Open Knowledge
          </Link>
        </div>
      </NsnCard>
    );
  }

  return (
    <NsnCard className="min-w-0">
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        {items.slice(0, 4).map(({ badge, description, item }) => (
          <Link
            className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-4 transition hover:bg-[var(--nsn-sage-mist)]"
            href={getKnowledgeTopicRoute(item.id)}
            key={`${badge}-${item.id}`}
          >
            <NsnBadge tone={item.status === "APPROVED" ? "approved" : "pending"}>
              {badge}
            </NsnBadge>
            <p className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
              {item.name}
            </p>
            <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              {description}
            </p>
          </Link>
        ))}
      </div>
      <Link
        className="mt-4 inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] sm:w-fit"
        href={getKnowledgeRoute()}
      >
        Open Knowledge
      </Link>
    </NsnCard>
  );
}

function SectionTitle({
  children,
  subtitle,
}: {
  children: ReactNode;
  subtitle?: string;
}) {
  return (
    <div className="min-w-0">
      <h2 className="nsn-display break-words text-3xl leading-10 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
        {children}
      </h2>
      {subtitle ? (
        <p className="mt-2 max-w-3xl break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

export default async function LibraryAdminPage() {
  const [
    scanSessions,
    libraryItems,
    reviewQueueItems,
    currentPlan,
    activeScanProgress,
    notebookPreview,
    knowledgePreview,
    monitoringDashboard,
    connectedLibraries,
    localBridgeHealth,
    cloudBridgeStatus,
  ] = await Promise.all([
    getBridgeScanSessions(10),
    getLibraryDocuments(),
    getReviewQueueItems(),
    getCurrentOrganizationPlanForHomepage(),
    getActiveBridgeScanSessionProgress(),
    getNotebookHomepagePreview(),
    getKnowledgeHomepagePreview(),
    getMonitoringDashboardData(),
    getConnectedLibraries(),
    getLocalBridgeHealth(),
    getBridgeCloudStatus().catch(() => ({
      connectedLibraries: [],
      devices: [],
    })),
  ]);
  const bridgeHealth = effectiveBridgeHealth(
    localBridgeHealth,
    cloudBridgeStatus.devices,
  );
  const bridgeDisplay = bridgeHomeHealthDisplay({
    bridgeHealth,
    devices: cloudBridgeStatus.devices,
    formatLastSeen: formatDateTime,
  });
  const activeConnectedLibraries = connectedLibraries.filter(
    (library) =>
      !library.requiresReconnect &&
      library.bridgeReachable &&
      library.status === "CONNECTED",
  );
  const primaryLibrary =
    activeConnectedLibraries.find(
      (library) => library.status === "CONNECTED" && library.readPermission,
    ) ?? activeConnectedLibraries[0] ?? null;
  const progress = activeScanProgress?.progress ?? null;
  const attentionTasks = buildAttentionTasks({
    activeProgress: progress,
    currentPlan,
    monitoringDashboard,
    reviewQueueCount: reviewQueueItems.length,
    scanSessions,
  });
  const recentActivity = buildRecentActivity({
    activeProgress: progress,
    currentPlan,
    scanSessions,
  });
  const bridgeShellStatus = bridgeHomeShellStatus({
    activeProgress: progress,
    bridgeDisplay,
    currentPlan,
  });
  const bridgeLabel = bridgeShellStatus.label;
  const bridgeTone = bridgeShellStatus.tone;
  const bridgeStatusHref =
    activeConnectedLibraries.length > 0
      ? getBridgeMonitoringRoute()
      : bridgeHealth.ok
        ? getConnectedLibrariesRoute()
        : bridgeHealth.paired
          ? getConnectedLibrariesRoute()
          : getBridgeDownloadRoute();
  const bridgeStatusActionLabel =
    activeConnectedLibraries.length > 0
      ? "Open Monitoring"
      : bridgeHealth.ok
        ? "Connect Folder"
        : bridgeHealth.paired
          ? "Open Connected Libraries"
          : "Download Bridge";

  return (
    <LibraryShell active="overview" bridgeLabel={bridgeLabel} bridgeTone={bridgeTone}>
      <div className="grid min-w-0 gap-10">
        <header className="grid min-w-0 gap-5 rounded-xl border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start lg:px-8">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--nsn-teal-dark)]">
              NSN Librarian
            </p>
            <h1 className="nsn-display mt-3 break-words text-4xl leading-tight text-[var(--nsn-navy)] [overflow-wrap:anywhere] sm:text-5xl">
              Welcome back, Deanne.
            </h1>
            <p className="mt-4 max-w-3xl break-words text-base leading-8 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              Your library is in order. Here is what needs your attention.
            </p>
            <p className="mt-3 max-w-3xl break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              The machine suggests. Deanne decides. Nothing moves without
              approval.
            </p>
          </div>
          <NsnBadge tone={bridgeTone}>{bridgeLabel}</NsnBadge>
        </header>

        <section className="grid min-w-0 gap-4" aria-labelledby="attention-heading">
          <SectionTitle subtitle="Only current work that needs a human decision appears here.">
            <span id="attention-heading">Needs Your Attention</span>
          </SectionTitle>
          {attentionTasks.length > 0 ? (
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              {attentionTasks.map((task) => (
                <AttentionCard key={task.id} task={task} />
              ))}
            </div>
          ) : (
            <NsnCard className="min-w-0" tone="aqua">
              <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                Nothing is waiting for review right now. You can scan a folder,
                browse recent sessions, or open the Notebook.
              </p>
            </NsnCard>
          )}
        </section>

        <section className="grid min-w-0 gap-4" aria-labelledby="activity-heading">
          <SectionTitle subtitle="A calm record of what the Librarian has recently examined, prepared, organized, or restored.">
            <span id="activity-heading">Recent Library Activity</span>
          </SectionTitle>
          <ActivityTimeline items={recentActivity} />
        </section>

        <section className="grid min-w-0 gap-4" aria-labelledby="notebook-heading">
          <SectionTitle subtitle="The Librarian's reflective record of what changed, what matters, and what still needs Deanne's eye.">
            <span id="notebook-heading">Notebook</span>
          </SectionTitle>
          <NotebookPreview preview={notebookPreview} />
        </section>

        <section className="grid min-w-0 gap-4" aria-labelledby="knowledge-heading">
          <SectionTitle subtitle="A concise view of topics, concepts, and frameworks the Librarian is beginning to connect across the library.">
            <span id="knowledge-heading">Topics the Librarian is noticing</span>
          </SectionTitle>
          <KnowledgePreview preview={knowledgePreview} />
        </section>

        <section className="grid min-w-0 gap-4" aria-labelledby="library-heading">
          <SectionTitle subtitle="Start with the next useful action, not a technical dashboard.">
            <span id="library-heading">Your Library</span>
          </SectionTitle>
          <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {activeConnectedLibraries.length === 0 ? (
              <LibraryEntry
                description="Connect a local folder so the Bridge can scan files without uploading or copying them."
                href={getConnectedLibrariesRoute()}
                label="Connect Folder"
              />
            ) : (
              <LibraryEntry
                description={
                  primaryLibrary
                    ? `Ask the Librarian to scan ${primaryLibrary.displayName} and prepare provisional recommendations.`
                    : "Turn on read permission for a connected library before scanning."
                }
                label="Scan Folder"
              >
                {primaryLibrary ? (
                  <BridgeScanControl
                    connectedLibraryId={primaryLibrary.id}
                    initialProgress={progress}
                    isDevelopment={false}
                    scanLabel="Scan Folder"
                  />
                ) : (
                  <Link
                    className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                    href={getConnectedLibrariesRoute()}
                  >
                    Edit Permissions
                  </Link>
                )}
              </LibraryEntry>
            )}
            <LibraryEntry
              description={`${activeConnectedLibraries.length} connected folder${
                activeConnectedLibraries.length === 1 ? "" : "s"
              } available to scan, monitor, or adjust.`}
              href={getConnectedLibrariesRoute()}
              label="Connected Libraries"
            />
            <LibraryEntry
              description="Watch connected folders for additions, edits, moves, renames, and unavailable files."
              href={getBridgeMonitoringRoute()}
              label="Bridge Monitoring"
            />
            <LibraryEntry
              description="Install the Mac companion app that keeps local folders under Deanne's control."
              href={getBridgeDownloadRoute()}
              label="Download Bridge"
            />
            <LibraryEntry
              description="Generate a short-lived code to pair this Mac with the Librarian."
              href={getConnectThisMacRoute()}
              label="Connect This Mac"
            />
            <LibraryEntry
              description={`${scanSessions.length} recent scan session${
                scanSessions.length === 1 ? "" : "s"
              } available to inspect.`}
              href={getScanSessionsRoute()}
              label="Browse Scan Sessions"
            />
            <LibraryEntry
              description={`${reviewQueueItems.length} item${
                reviewQueueItems.length === 1 ? "" : "s"
              } waiting for Deanne's decision.`}
              href="/admin/library/review"
              label="Review Recommendations"
            />
            <LibraryEntry
              description="Read the Librarian's reflections and learning updates."
              href="/admin/library/notebook"
              label="Open Notebook"
            />
            <LibraryEntry
              description="Review proposed topics, concepts, frameworks, and relationships."
              href={getKnowledgeRoute()}
              label="Review Knowledge"
            />
            <LibraryEntry
              description={`${libraryItems.length} library item${
                libraryItems.length === 1 ? "" : "s"
              } known to the Librarian.`}
              href="/admin/library/memory"
              label="View Memory"
            />
          </div>
        </section>

        <section className="grid min-w-0 gap-4" aria-labelledby="bridge-heading">
          <SectionTitle subtitle="The Bridge is the path between local files and approved organization work.">
            <span id="bridge-heading">Bridge Status</span>
          </SectionTitle>
          <NsnCard className="min-w-0">
            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
              <div className="min-w-0">
                <NsnBadge tone={bridgeDisplay.badgeTone}>
                  {bridgeDisplay.badgeLabel}
                </NsnBadge>
                <p className="mt-4 max-w-3xl break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  Deanne&apos;s local computer remains the source of truth. The
                  web app keeps observations, decisions, Memory, Notebook
                  reflections, scan sessions, recommendations, plans,
                  organization history, and undo records.
                </p>
                <dl className="mt-4 grid min-w-0 gap-3 text-sm leading-6 text-[var(--nsn-slate)] sm:grid-cols-2 lg:grid-cols-4">
                  <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                    <dt className="font-semibold text-[var(--nsn-navy)]">
                      This Mac
                    </dt>
                    <dd className="break-words [overflow-wrap:anywhere]">
                      {bridgeDisplay.thisMacLabel}
                    </dd>
                  </div>
                  <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                    <dt className="font-semibold text-[var(--nsn-navy)]">
                      Device
                    </dt>
                    <dd className="break-words [overflow-wrap:anywhere]">
                      {bridgeDisplay.deviceLabel}
                    </dd>
                  </div>
                  <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                    <dt className="font-semibold text-[var(--nsn-navy)]">
                      Version
                    </dt>
                    <dd className="break-words [overflow-wrap:anywhere]">
                      {bridgeDisplay.versionLabel}
                    </dd>
                  </div>
                  <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                    <dt className="font-semibold text-[var(--nsn-navy)]">
                      Folders
                    </dt>
                    <dd className="break-words [overflow-wrap:anywhere]">
                      {monitoringFolderSummary(monitoringDashboard)}
                    </dd>
                  </div>
                </dl>
              </div>
              <Link
                className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] sm:w-fit"
                href={bridgeStatusHref}
              >
                {bridgeStatusActionLabel}
              </Link>
            </div>
          </NsnCard>
        </section>
      </div>
    </LibraryShell>
  );
}
