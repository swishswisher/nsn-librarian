"use client";

import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";

import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnButton } from "@/components/library/NsnButton";
import { NsnCard } from "@/components/library/NsnCard";
import type {
  BridgeExecutionPreview,
  BridgeExecutionPreviewResponse,
  BridgeExecutionResponse,
  BridgeExecutionRunSummary,
  BridgeOrganizationPlan,
  BridgeOrganizationPlanAction,
  BridgeOrganizationPlanDownload,
  BridgeOrganizationPlanMutationResponse,
  BridgeUndoPreview,
  BridgeUndoPreviewResponse,
  BridgeUndoResponse,
  BridgeUndoRunSummary,
  OrganizationPlanActionType,
  OrganizationPlanStatus,
  OrganizationPlanWarningType,
} from "@/lib/bridge/types";
import { getConnectedLibrariesRoute } from "@/lib/library/routes";

type OrganizationPlanReviewPanelProps = {
  latestExecution?: BridgeExecutionRunSummary | null;
  plan: BridgeOrganizationPlan;
};

type PlanDecision = "APPROVE" | "CANCEL";

function statusLabel(status: OrganizationPlanStatus) {
  if (status === "READY_FOR_EXECUTION") {
    return "Ready for organization";
  }

  return status.replaceAll("_", " ").toLowerCase();
}

function statusTone(status: OrganizationPlanStatus): NsnBadgeTone {
  if (status === "READY_FOR_EXECUTION") {
    return "approved";
  }

  if (status === "CANCELLED") {
    return "review";
  }

  if (status === "EXECUTED") {
    return "migration";
  }

  return "pending";
}

function actionTypeLabel(actionType: OrganizationPlanActionType) {
  if (actionType === "CREATE_FOLDER") {
    return "Create folder";
  }

  if (actionType === "RENAME_FOLDER") {
    return "Rename folder";
  }

  if (actionType === "MOVE_FILE") {
    return "Move file";
  }

  if (actionType === "RENAME_FILE") {
    return "Rename file";
  }

  if (actionType === "MOVE_AND_RENAME_FILE") {
    return "Move and rename file";
  }

  if (actionType === "WEBSITE_ACTION") {
    return "Website action";
  }

  return "Review only";
}

function fileNameFromRelativePath(relativePath: string) {
  return relativePath.split("/").filter(Boolean).pop() ?? relativePath;
}

function whatWillHappen(actionType: OrganizationPlanActionType) {
  if (actionType === "CREATE_FOLDER") {
    return "Create this folder inside the connected library.";
  }

  if (actionType === "MOVE_FILE") {
    return "Move this file to the planned location.";
  }

  if (actionType === "RENAME_FILE") {
    return "Rename this file in its current folder.";
  }

  if (actionType === "MOVE_AND_RENAME_FILE") {
    return "Move and rename this file as one approved organization step.";
  }

  return "Keep this as a review-only note.";
}

function requiredPermissionsFor(actionType: OrganizationPlanActionType) {
  if (actionType === "CREATE_FOLDER") {
    return ["Read files", "Create folders after approval"];
  }

  if (actionType === "MOVE_FILE") {
    return ["Read files", "Move files after approval"];
  }

  if (actionType === "RENAME_FILE") {
    return ["Read files", "Rename files after approval"];
  }

  if (actionType === "MOVE_AND_RENAME_FILE") {
    return [
      "Read files",
      "Move files after approval",
      "Rename files after approval",
    ];
  }

  return ["Review only"];
}

function executionActionTypeLabel(actionType: string) {
  if (
    actionType === "CREATE_FOLDER" ||
    actionType === "RENAME_FOLDER" ||
    actionType === "MOVE_FILE" ||
    actionType === "RENAME_FILE" ||
    actionType === "MOVE_AND_RENAME_FILE" ||
    actionType === "WEBSITE_ACTION" ||
    actionType === "REVIEW_ONLY"
  ) {
    return actionTypeLabel(actionType);
  }

  return "Planned action";
}

function executionStatusLabel(status: string) {
  if (status === "PARTIALLY_COMPLETED") {
    return "Some files were organized, but one action needs attention";
  }

  if (status === "COMPLETED") {
    return "Organization completed successfully";
  }

  if (status === "FAILED") {
    return "Organization stopped safely";
  }

  if (status === "BLOCKED") {
    return "Organization blocked before files changed";
  }

  return status.replaceAll("_", " ").toLowerCase();
}

function executionStatusTone(status: string): NsnBadgeTone {
  if (status === "COMPLETED") {
    return "approved";
  }

  if (
    status === "FAILED" ||
    status === "PARTIALLY_COMPLETED" ||
    status === "BLOCKED"
  ) {
    return "review";
  }

  if (status === "RUNNING") {
    return "migration";
  }

  return "pending";
}

function undoStatusLabel(status: string) {
  if (status === "PARTIALLY_COMPLETED") {
    return "Some changes were restored";
  }

  if (status === "COMPLETED") {
    return "Changes restored";
  }

  if (status === "RUNNING") {
    return "Restoring changes";
  }

  if (status === "BLOCKED") {
    return "Restore needs attention";
  }

  return status.replaceAll("_", " ").toLowerCase();
}

function undoStatusTone(status: string): NsnBadgeTone {
  if (status === "COMPLETED") {
    return "approved";
  }

  if (
    status === "FAILED" ||
    status === "PARTIALLY_COMPLETED" ||
    status === "BLOCKED"
  ) {
    return "review";
  }

  if (status === "RUNNING") {
    return "migration";
  }

  return "pending";
}

function undoActionTypeLabel(actionType: string) {
  if (actionType === "REMOVE_FOLDER") {
    return "Remove folder";
  }

  if (actionType === "RENAME_FILE") {
    return "Restore file name";
  }

  return "Move file back";
}

function safeErrorLabel(errorCategory: string) {
  if (errorCategory === "CHANGED_SOURCE") {
    return "The Bridge stopped because a source file changed after scanning.";
  }

  if (errorCategory === "VALIDATION_FAILED") {
    return "The Bridge stopped because a safety check failed.";
  }

  if (errorCategory === "DESTINATION_CONFLICT") {
    return "The Bridge stopped because a destination already exists.";
  }

  if (errorCategory === "MISSING_SOURCE") {
    return "The Bridge stopped because a source file is missing.";
  }

  if (errorCategory === "MISSING_PARENT") {
    return "The Bridge stopped because a destination folder is missing.";
  }

  if (errorCategory === "PATH_OUTSIDE_ROOT") {
    return "The Bridge stopped because a planned path left the connected folder.";
  }

  if (errorCategory === "SOURCE_NOT_FILE") {
    return "The Bridge stopped because a source item is not a regular file.";
  }

  if (errorCategory === "FILESYSTEM_OPERATION_FAILED") {
    return "The Bridge stopped because the local filesystem refused an operation.";
  }

  if (errorCategory === "PERMISSION_DENIED") {
    return "The Bridge stopped because a required folder permission is off.";
  }

  if (errorCategory === "BRIDGE_UNAVAILABLE") {
    return "The Bridge stopped because the local Bridge is not available.";
  }

  if (errorCategory === "EXECUTION_BLOCKED") {
    return "The Bridge blocked this organization before changing files.";
  }

  if (errorCategory === "FOLDER_NOT_EMPTY") {
    return "The Bridge stopped because a folder is not empty.";
  }

  if (errorCategory === "FOLDER_NOT_CREATED_BY_BRIDGE") {
    return "The Bridge stopped because that folder was not created by this organization.";
  }

  if (errorCategory === "UNDO_ALREADY_COMPLETED") {
    return "The Bridge has already restored these completed changes.";
  }

  if (errorCategory === "UNDO_RUNNING") {
    return "An undo is already active.";
  }

  if (errorCategory === "UNDO_NOT_AVAILABLE") {
    return "There are no completed Bridge changes ready to undo.";
  }

  if (errorCategory === "DUPLICATE_UNDO_DESTINATION") {
    return "More than one undo action would restore to the same location.";
  }

  return "The Bridge stopped before completing this action.";
}

function warningTypeLabel(warningType: OrganizationPlanWarningType) {
  if (warningType === "DUPLICATE_DESTINATION") {
    return "Duplicate destination";
  }

  if (warningType === "FILENAME_CONFLICT") {
    return "Filename conflict";
  }

  if (warningType === "FOLDER_CONFLICT") {
    return "Folder conflict";
  }

  if (warningType === "MISSING_PARENT") {
    return "Missing parent folder";
  }

  if (warningType === "OUTSIDE_ROOT_DESTINATION") {
    return "Outside connected folder";
  }

  if (warningType === "REVIEW_ONLY_ACTION") {
    return "Review only";
  }

  return "Invalid path";
}

function formatConfidence(value: number) {
  return `${Math.round(value * 100)}%`;
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

function Section({
  children,
  id,
  title,
}: {
  children: ReactNode;
  id?: string;
  title: string;
}) {
  return (
    <section className="grid min-w-0 gap-4" aria-label={title} id={id}>
      <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">{title}</h2>
      {children}
    </section>
  );
}

function ActionDestination({ action }: { action: BridgeOrganizationPlanAction }) {
  if (action.actionType === "CREATE_FOLDER") {
    return (
      <>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
          Planned folder
        </p>
        <p className="break-words text-sm font-semibold leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
          {action.plannedFolderPath ?? "No folder path recorded"}
        </p>
      </>
    );
  }

  return (
    <div className="grid gap-2">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
          Current location
        </p>
        <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
          {action.sourceRelativePath}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
          Planned location
        </p>
        <p className="break-words text-sm font-semibold leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
          {action.plannedRelativePath ?? "No planned location recorded"}
        </p>
      </div>
    </div>
  );
}

function EvidenceList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return (
      <p className="text-sm leading-6 text-[var(--nsn-slate)]">
        No supporting detail was recorded for this category.
      </p>
    );
  }

  return (
    <ul className="grid gap-1 pl-4 text-sm leading-6 text-[var(--nsn-slate)]">
      {items.map((item) => (
        <li className="list-disc break-words [overflow-wrap:anywhere]" key={item}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "Not completed";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDuration(startedAt: string, completedAt: string | null) {
  if (!completedAt) {
    return "In progress";
  }

  const milliseconds = Math.max(
    0,
    new Date(completedAt).getTime() - new Date(startedAt).getTime(),
  );
  const seconds = Math.max(1, Math.round(milliseconds / 1000));

  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function formatStoredDuration(
  startedAt: string,
  completedAt: string | null,
  durationMs: number | null,
) {
  if (durationMs === null) {
    return formatDuration(startedAt, completedAt);
  }

  const seconds = Math.max(1, Math.round(durationMs / 1000));

  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function IssueList({
  emptyLabel,
  issues,
  title,
}: {
  emptyLabel: string;
  issues: BridgeExecutionPreview["blockingIssues"];
  title: string;
}) {
  return (
    <div className="grid min-w-0 gap-2">
      <h4 className="text-sm font-semibold text-[var(--nsn-navy)]">{title}</h4>
      {issues.length === 0 ? (
        <p className="text-sm leading-6 text-[var(--nsn-slate)]">{emptyLabel}</p>
      ) : (
        <ul className="grid gap-2">
          {issues.map((issue) => (
            <li
              className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-slate)]"
              key={issue.id}
            >
              <span className="block break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                {issue.title}
              </span>
              <span className="block break-words [overflow-wrap:anywhere]">
                {issue.description}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExecutionPreviewPanel({
  preview,
}: {
  preview: BridgeExecutionPreview;
}) {
  const permissionBlocked = preview.blockingIssues.some(
    (issue) => issue.category === "PERMISSION_DENIED",
  );

  return (
    <Section title="Organization Preview">
      <NsnCard className="min-w-0">
        <div className="grid min-w-0 gap-5">
          <div className="flex flex-wrap gap-2">
            <NsnBadge tone={preview.canExecute ? "approved" : "review"}>
              {preview.canExecute ? "Ready to organize" : "Needs review"}
            </NsnBadge>
            <NsnBadge tone="source">
              {preview.estimatedOperations} estimated operations
            </NsnBadge>
          </div>

          {permissionBlocked ? (
            <div className="grid gap-3 rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3">
              <p className="break-words text-sm font-semibold leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                This plan is ready, but the Librarian does not currently have
                permission to make these changes.
              </p>
              <Link
                className="inline-flex min-h-11 max-w-max items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-sm font-semibold text-[var(--nsn-navy)] hover:bg-[var(--nsn-sage-mist)]"
                href={getConnectedLibrariesRoute()}
              >
                Review Folder Permissions
              </Link>
            </div>
          ) : null}

          <div className="grid min-w-0 gap-3">
            <p className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm font-semibold leading-6 text-[var(--nsn-teal-dark)]">
              Nothing has been changed yet.
            </p>
            {preview.actions.map((action) => (
              <div
                className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3"
                key={action.id}
              >
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                  {action.sequence}. {actionTypeLabel(action.actionType)}
                </p>
                {action.sourceRelativePath ? (
                  <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                    Current: {action.sourceRelativePath}
                  </p>
                ) : null}
                <p className="break-words text-sm font-semibold leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                  Planned: {action.destinationRelativePath}
                </p>
              </div>
            ))}
          </div>

          <div className="grid min-w-0 gap-4 lg:grid-cols-3">
            <IssueList
              emptyLabel="No conflicts found."
              issues={preview.conflicts}
              title="Conflicts"
            />
            <IssueList
              emptyLabel="No missing files found."
              issues={preview.missingFiles}
              title="Missing Files"
            />
            <IssueList
              emptyLabel="No changed files found."
              issues={preview.changedFiles}
              title="Changed Files"
            />
          </div>

          {preview.blockingIssues.length > 0 ? (
            <IssueList
              emptyLabel=""
              issues={preview.blockingIssues}
              title="Blocking Safety Checks"
            />
          ) : null}
        </div>
      </NsnCard>
    </Section>
  );
}

function UndoPreviewPanel({ preview }: { preview: BridgeUndoPreview }) {
  return (
    <Section title="Undo Preview">
      <NsnCard className="min-w-0">
        <div className="grid min-w-0 gap-5">
          <div className="flex flex-wrap gap-2">
            <NsnBadge tone={preview.canUndo ? "approved" : "review"}>
              {preview.canUndo ? "Ready to restore" : "Needs review"}
            </NsnBadge>
            <NsnBadge tone="source">
              {preview.estimatedOperations} estimated operations
            </NsnBadge>
          </div>

          <p className="text-sm leading-7 text-[var(--nsn-slate)]">
            This is a preview only. The Bridge has not changed the filesystem.
          </p>

          <div className="grid min-w-0 gap-3">
            {preview.actions.map((action) => (
              <div
                className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3"
                key={action.id}
              >
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                  {action.sequence}. {undoActionTypeLabel(action.actionType)}
                </p>
                <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  Current: {action.sourceRelativePath}
                </p>
                <p className="break-words text-sm font-semibold leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                  Restores to: {action.destinationRelativePath}
                </p>
              </div>
            ))}
          </div>

          <div className="grid min-w-0 gap-4 lg:grid-cols-4">
            <IssueList
              emptyLabel="No conflicts found."
              issues={preview.conflicts}
              title="Conflicts"
            />
            <IssueList
              emptyLabel="No missing items found."
              issues={preview.missingFiles}
              title="Missing"
            />
            <IssueList
              emptyLabel="No changed files found."
              issues={preview.changedFiles}
              title="Changed Files"
            />
            <IssueList
              emptyLabel="No blocked actions found."
              issues={preview.blockedActions}
              title="Blocked"
            />
          </div>

          {preview.blockingIssues.length > 0 ? (
            <IssueList
              emptyLabel=""
              issues={preview.blockingIssues}
              title="Blocking Safety Checks"
            />
          ) : null}
        </div>
      </NsnCard>
    </Section>
  );
}

function UndoRunPanel({ run }: { run: BridgeUndoRunSummary }) {
  const skippedActions = run.actions.filter(
    (action) => action.status === "PENDING",
  ).length;

  return (
    <div className="grid min-w-0 gap-4 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-sage-mist)] p-4">
      <div className="flex flex-wrap gap-2">
        <NsnBadge tone={undoStatusTone(run.status)}>
          {undoStatusLabel(run.status)}
        </NsnBadge>
        <NsnBadge tone="approved">{run.completedActions} restored</NsnBadge>
        <NsnBadge tone={run.failedActions > 0 ? "review" : "source"}>
          {run.failedActions} blocked
        </NsnBadge>
        <NsnBadge tone={skippedActions > 0 ? "pending" : "source"}>
          {skippedActions} skipped
        </NsnBadge>
      </div>
      <div className="grid gap-2 text-sm leading-6 text-[var(--nsn-slate)]">
        <p>Started: {formatDateTime(run.startedAt)}</p>
        <p>Completed: {formatDateTime(run.completedAt)}</p>
        <p>
          Undo time:{" "}
          {formatStoredDuration(run.startedAt, run.completedAt, run.durationMs)}
        </p>
        {run.safeErrorCategory ? (
          <p>{safeErrorLabel(run.safeErrorCategory)}</p>
        ) : null}
      </div>
      <div className="grid gap-3">
        {run.actions.map((action) => (
          <div
            className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3"
            key={action.id}
          >
            <div className="flex flex-wrap gap-2">
              <NsnBadge tone={undoStatusTone(action.status)}>
                {undoStatusLabel(action.status)}
              </NsnBadge>
              <NsnBadge tone="source">
                {action.sequence}. {undoActionTypeLabel(action.actionType)}
              </NsnBadge>
            </div>
            <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              From: {action.sourceRelativePath}
            </p>
            <p className="break-words text-sm font-semibold leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
              Restored to: {action.destinationRelativePath}
            </p>
            {action.safeErrorCategory ? (
              <p className="break-words text-sm leading-6 text-[var(--nsn-warning)] [overflow-wrap:anywhere]">
                {safeErrorLabel(action.safeErrorCategory)}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function ExecutionRunPanel({
  isUndoPreviewing,
  latestUndoRun,
  onOpenUndoDialog,
  onPreviewUndo,
  run,
  undoPreview,
}: {
  isUndoPreviewing: boolean;
  latestUndoRun: BridgeUndoRunSummary | null;
  onOpenUndoDialog: () => void;
  onPreviewUndo: () => void;
  run: BridgeExecutionRunSummary;
  undoPreview: BridgeUndoPreview | null;
}) {
  const skippedActions = run.actions.filter(
    (action) => action.status === "PENDING",
  ).length;
  const completedActionCount = run.actions.filter(
    (action) => action.status === "COMPLETED",
  ).length;
  const undoCompleted = latestUndoRun?.status === "COMPLETED";
  const undoRunning = latestUndoRun?.status === "RUNNING";
  const canRequestUndo =
    (run.status === "COMPLETED" || run.status === "PARTIALLY_COMPLETED") &&
    completedActionCount > 0 &&
    !undoCompleted &&
    !undoRunning;

  return (
    <Section id="execution-history" title="Organization History">
      <NsnCard className="min-w-0">
        <div className="grid min-w-0 gap-5">
          <div className="flex flex-wrap gap-2">
            <NsnBadge tone={executionStatusTone(run.status)}>
              {executionStatusLabel(run.status)}
            </NsnBadge>
            <NsnBadge tone="approved">
              {run.completedActions} organized
            </NsnBadge>
            <NsnBadge tone={run.failedActions > 0 ? "review" : "source"}>
              {run.failedActions} need attention
            </NsnBadge>
            <NsnBadge tone={skippedActions > 0 ? "pending" : "source"}>
              {skippedActions} skipped
            </NsnBadge>
            {latestUndoRun ? (
              <NsnBadge tone={undoStatusTone(latestUndoRun.status)}>
                {undoStatusLabel(latestUndoRun.status)}
              </NsnBadge>
            ) : null}
          </div>
          <div className="grid gap-2 text-sm leading-6 text-[var(--nsn-slate)]">
            <p>Started: {formatDateTime(run.startedAt)}</p>
            <p>Completed: {formatDateTime(run.completedAt)}</p>
            <p>
              Organization time:{" "}
              {formatStoredDuration(
                run.startedAt,
                run.completedAt,
                run.durationMs,
              )}
            </p>
            {run.safeErrorCategory ? (
              <p>{safeErrorLabel(run.safeErrorCategory)}</p>
            ) : null}
          </div>
          <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            <NsnButton
              onClick={() =>
                document
                  .getElementById("execution-history")
                  ?.scrollIntoView({ block: "start" })
              }
              type="button"
              variant="secondary"
            >
              View Details
            </NsnButton>
            <NsnButton
              disabled={!canRequestUndo || isUndoPreviewing}
              onClick={onPreviewUndo}
              type="button"
              variant="accent"
            >
              {isUndoPreviewing ? "Previewing..." : "Preview Undo"}
            </NsnButton>
            <NsnButton
              disabled={!canRequestUndo || undoPreview?.canUndo !== true}
              onClick={onOpenUndoDialog}
              type="button"
              variant="primary"
            >
              Undo Changes
            </NsnButton>
          </div>
          {undoCompleted ? (
            <p className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-teal-dark)]">
              UNDONE. The Bridge restored the completed file and folder changes
              from this organization.
            </p>
          ) : null}
          <div className="grid gap-3">
            {run.actions.map((action) => (
              <div
                className="grid min-w-0 gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3"
                key={action.id}
              >
                <div className="flex flex-wrap gap-2">
                  <NsnBadge tone={executionStatusTone(action.status)}>
                    {executionStatusLabel(action.status)}
                  </NsnBadge>
                  <NsnBadge tone="source">
                    {action.sequence}. {executionActionTypeLabel(action.actionType)}
                  </NsnBadge>
                </div>
                {action.sourceRelativePath ? (
                  <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                    Current: {action.sourceRelativePath}
                  </p>
                ) : null}
                <p className="break-words text-sm font-semibold leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                  Planned: {action.destinationRelativePath}
                </p>
                {action.safeErrorCategory ? (
                  <p className="break-words text-sm leading-6 text-[var(--nsn-warning)] [overflow-wrap:anywhere]">
                    {safeErrorLabel(action.safeErrorCategory)}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          {latestUndoRun ? <UndoRunPanel run={latestUndoRun} /> : null}
        </div>
      </NsnCard>
    </Section>
  );
}

export function OrganizationPlanReviewPanel({
  latestExecution = null,
  plan,
}: OrganizationPlanReviewPanelProps) {
  const router = useRouter();
  const [currentPlan, setCurrentPlan] = useState(plan);
  const [executionPreview, setExecutionPreview] =
    useState<BridgeExecutionPreview | null>(null);
  const [executionRun, setExecutionRun] =
    useState<BridgeExecutionRunSummary | null>(latestExecution);
  const [undoPreview, setUndoPreview] = useState<BridgeUndoPreview | null>(null);
  const [undoRun, setUndoRun] = useState<BridgeUndoRunSummary | null>(
    latestExecution?.latestUndoRun ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [executeConfirmation, setExecuteConfirmation] = useState("");
  const [undoConfirmation, setUndoConfirmation] = useState("");
  const [isExecuteDialogOpen, setIsExecuteDialogOpen] = useState(false);
  const [isUndoDialogOpen, setIsUndoDialogOpen] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [isUndoPreviewing, setIsUndoPreviewing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PlanDecision | null>(null);

  async function submitDecision(action: PlanDecision) {
    if (pendingAction) {
      return;
    }

    setError(null);
    setMessage(null);
    setPendingAction(action);

    try {
      const response = await fetch(
        `/api/bridge/organization-plans/${encodeURIComponent(
          currentPlan.id,
        )}/decision`,
        {
          body: JSON.stringify({ action }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      const payload =
        (await response.json()) as BridgeOrganizationPlanMutationResponse;

      if (!payload.ok) {
        setError(payload.error);
        return;
      }

      setExecutionPreview(null);
      setUndoPreview(null);
      setCurrentPlan(payload.plan);
      setMessage(
        action === "APPROVE"
          ? "The plan is marked ready for organization. No filesystem action occurred."
          : "The plan was cancelled. No filesystem action occurred.",
      );
      router.refresh();
    } catch {
      setError("The organization plan could not be updated right now.");
    } finally {
      setPendingAction(null);
    }
  }

  function downloadPlan() {
    if (currentPlan.totalActions === 0 || currentPlan.actions.length === 0) {
      setError("No reviewed recommendations are ready for planning.");
      return;
    }

    const payload: BridgeOrganizationPlanDownload = {
      exportedAt: new Date().toISOString(),
      plan: currentPlan,
      safety: {
        executionAllowed: false,
        note: "This JSON is an organization plan only. It does not authorize moving, renaming, creating, deleting, copying, or publishing files.",
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `organization-plan-${currentPlan.id}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function previewExecution() {
    if (isPreviewing) {
      return;
    }

    setError(null);
    setMessage(null);
    setIsPreviewing(true);

    try {
      const response = await fetch(
        `/api/bridge/organization-plans/${encodeURIComponent(
          currentPlan.id,
        )}/execution-preview`,
        {
          method: "POST",
        },
      );
      const payload =
        (await response.json()) as BridgeExecutionPreviewResponse;

      if (!payload.ok) {
        setError(payload.error);
        if (payload.preview) {
          setExecutionPreview(payload.preview);
        }
        return;
      }

      setExecutionPreview(payload.preview);
      setMessage(
        payload.preview.canExecute
          ? "The Bridge preview is clear. Review the actions before organizing files."
          : "The Bridge found safety issues. Review the preview before continuing.",
      );
    } catch {
      setError("The Bridge could not preview this organization safely.");
    } finally {
      setIsPreviewing(false);
    }
  }

  async function executePlan() {
    if (isExecuting || executeConfirmation !== "EXECUTE") {
      return;
    }

    setError(null);
    setMessage(null);
    setIsExecuting(true);

    try {
      const response = await fetch(
        `/api/bridge/organization-plans/${encodeURIComponent(
          currentPlan.id,
        )}/execute`,
        {
          body: JSON.stringify({ confirmation: executeConfirmation }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      const payload = (await response.json()) as BridgeExecutionResponse;

      if (!payload.ok) {
        setError(payload.error);
        if (payload.preview) {
          setExecutionPreview(payload.preview);
        }
        return;
      }

      setCurrentPlan(payload.plan);
      setExecutionPreview(payload.preview);
      setExecutionRun(payload.run);
      setUndoPreview(null);
      setUndoRun(null);
      setExecuteConfirmation("");
      setIsExecuteDialogOpen(false);
      setMessage(
        payload.run.status === "COMPLETED"
          ? "The Bridge organized the approved files. No files were overwritten or deleted."
          : "The Bridge stopped safely before completing every action. Review the organization history.",
      );
      router.refresh();
    } catch {
      setError("The Bridge could not organize these files safely.");
    } finally {
      setIsExecuting(false);
    }
  }

  async function previewUndo() {
    if (!executionRun || isUndoPreviewing) {
      return;
    }

    setError(null);
    setMessage(null);
    setIsUndoPreviewing(true);

    try {
      const response = await fetch(
        `/api/bridge/execution-runs/${encodeURIComponent(
          executionRun.id,
        )}/undo-preview`,
        {
          method: "POST",
        },
      );
      const payload = (await response.json()) as BridgeUndoPreviewResponse;

      if (!payload.ok) {
        setError(payload.error);
        if (payload.preview) {
          setUndoPreview(payload.preview);
        }
        if (payload.run) {
          setUndoRun(payload.run);
        }
        return;
      }

      setUndoPreview(payload.preview);
      setMessage(
        payload.preview.canUndo
          ? "The Bridge preview is clear. Review the restore actions before undoing."
          : "The Bridge found safety issues. Review the undo preview before continuing.",
      );
    } catch {
      setError("The Bridge could not preview this undo safely.");
    } finally {
      setIsUndoPreviewing(false);
    }
  }

  async function executeUndo() {
    if (!executionRun || isUndoing || undoConfirmation !== "UNDO") {
      return;
    }

    setError(null);
    setMessage(null);
    setIsUndoing(true);

    try {
      const response = await fetch(
        `/api/bridge/execution-runs/${encodeURIComponent(executionRun.id)}/undo`,
        {
          body: JSON.stringify({ confirmation: undoConfirmation }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      const payload = (await response.json()) as BridgeUndoResponse;

      if (!payload.ok) {
        setError(payload.error);
        if (payload.preview) {
          setUndoPreview(payload.preview);
        }
        if (payload.run) {
          setUndoRun(payload.run);
        }
        return;
      }

      setExecutionRun(payload.executionRun);
      setUndoPreview(null);
      setUndoRun(payload.run);
      setUndoConfirmation("");
      setIsUndoDialogOpen(false);
      setMessage(
        payload.run.status === "COMPLETED"
          ? "The Bridge restored the completed file and folder changes from this organization."
          : "The Bridge stopped safely before restoring every change. Review the undo history.",
      );
      router.refresh();
    } catch {
      setError("The Bridge could not undo this organization safely.");
    } finally {
      setIsUndoing(false);
    }
  }

  const canApproveOrCancel =
    currentPlan.status === "DRAFT" || currentPlan.status === "READY_FOR_EXECUTION";
  const hasPlanActions =
    currentPlan.totalActions > 0 && currentPlan.actions.length > 0;
  const hasExecutionStarted =
    currentPlan.status === "EXECUTED" ||
    executionRun?.status === "COMPLETED" ||
    executionRun?.status === "PARTIALLY_COMPLETED" ||
    executionRun?.status === "RUNNING";
  const canPreviewExecution =
    hasPlanActions &&
    currentPlan.status === "READY_FOR_EXECUTION" &&
    !hasExecutionStarted;
  const canExecutePlan =
    canPreviewExecution && executionPreview?.canExecute === true;
  const visibleUndoRun = undoRun ?? executionRun?.latestUndoRun ?? null;

  return (
    <div className="grid min-w-0 gap-8">
      <NsnCard tone="aqua">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap gap-2">
              <NsnBadge tone={statusTone(currentPlan.status)}>
                {statusLabel(currentPlan.status)}
              </NsnBadge>
              <NsnBadge tone="source">
                {currentPlan.totalActions} planned actions
              </NsnBadge>
              <NsnBadge tone={currentPlan.warnings.length > 0 ? "review" : "approved"}>
                {currentPlan.warnings.length} warnings
              </NsnBadge>
            </div>
            <p className="mt-4 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              This plan can only organize files after approval, preview, and final
              confirmation. The Bridge will not overwrite or delete files.
            </p>
          </div>
          <div className="grid min-w-0 gap-3 sm:grid-cols-3 lg:min-w-80 lg:grid-cols-1">
            {hasPlanActions ? (
              <>
                <NsnButton
                  disabled={currentPlan.status !== "DRAFT" || pendingAction === "APPROVE"}
                  onClick={() => submitDecision("APPROVE")}
                  type="button"
                  variant="primary"
                >
                  {pendingAction === "APPROVE" ? "Approving..." : "Approve Plan"}
                </NsnButton>
                <NsnButton onClick={downloadPlan} type="button" variant="accent">
                  Download Plan
                </NsnButton>
                {canPreviewExecution ? (
                  <NsnButton
                    disabled={isPreviewing}
                    onClick={previewExecution}
                    type="button"
                    variant="secondary"
                  >
                    {isPreviewing ? "Previewing..." : "Preview Organization"}
                  </NsnButton>
                ) : null}
                {currentPlan.status === "READY_FOR_EXECUTION" ? (
                  <NsnButton
                    disabled={!canExecutePlan}
                    onClick={() => setIsExecuteDialogOpen(true)}
                    type="button"
                    variant="primary"
                  >
                    Organize Files
                  </NsnButton>
                ) : null}
              </>
            ) : null}
            <NsnButton
              disabled={!canApproveOrCancel || hasExecutionStarted || pendingAction === "CANCEL"}
              onClick={() => submitDecision("CANCEL")}
              type="button"
              variant="secondary"
            >
              {pendingAction === "CANCEL" ? "Cancelling..." : "Cancel Plan"}
            </NsnButton>
          </div>
        </div>
        <div aria-live="polite" className="mt-4 grid gap-2">
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
      </NsnCard>

      {executionPreview ? (
        <ExecutionPreviewPanel preview={executionPreview} />
      ) : null}

      {undoPreview ? <UndoPreviewPanel preview={undoPreview} /> : null}

      {executionRun ? (
        <ExecutionRunPanel
          isUndoPreviewing={isUndoPreviewing}
          latestUndoRun={visibleUndoRun}
          onOpenUndoDialog={() => setIsUndoDialogOpen(true)}
          onPreviewUndo={previewUndo}
          run={executionRun}
          undoPreview={undoPreview}
        />
      ) : null}

      <Section title="Summary">
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryTile label="Files Affected" value={currentPlan.summary.filesAffected} />
          <SummaryTile
            label="Folders Affected"
            value={currentPlan.summary.foldersAffected}
          />
          <SummaryTile label="Moves" value={currentPlan.summary.moves} />
          <SummaryTile label="Renames" value={currentPlan.summary.renames} />
          <SummaryTile label="New Folders" value={currentPlan.summary.newFolders} />
          <SummaryTile
            label="Estimated Operations"
            value={currentPlan.summary.estimatedOperations}
          />
          <SummaryTile label="Warnings" value={currentPlan.summary.warnings} />
        </div>
      </Section>

      <Section title="Planned Changes">
        {currentPlan.actions.length === 0 ? (
          <NsnCard>
            <p className="text-sm leading-6 text-[var(--nsn-slate)]">
              No approved or modified recommendations are ready for planning yet.
            </p>
          </NsnCard>
        ) : (
          <div className="grid gap-4">
            {currentPlan.actions.map((action) => (
              <NsnCard className="min-w-0" key={action.id}>
                <div className="grid min-w-0 gap-5">
                  <div className="flex flex-wrap gap-2">
                    <NsnBadge tone="migration">
                      {action.order}. {actionTypeLabel(action.actionType)}
                    </NsnBadge>
                    <NsnBadge tone="source">
                      Confidence {formatConfidence(action.confidence)}
                    </NsnBadge>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                    <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                      <p className="mb-3 break-words text-sm font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                        File:{" "}
                        {fileNameFromRelativePath(
                          action.plannedRelativePath ??
                            action.plannedFolderPath ??
                            action.sourceRelativePath,
                        )}
                      </p>
                      <ActionDestination action={action} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-[var(--nsn-navy)]">
                        What will happen
                      </h3>
                      <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                        {whatWillHappen(action.actionType)}
                      </p>
                      <h3 className="mt-4 text-sm font-semibold text-[var(--nsn-navy)]">
                        Why is this in the plan?
                      </h3>
                      <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                        {action.reason}
                      </p>
                      <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                        Originating suggestion:{" "}
                        {action.originatingSuggestion.title}
                      </p>
                      <h3 className="mt-4 text-sm font-semibold text-[var(--nsn-navy)]">
                        Required permissions
                      </h3>
                      <ul className="mt-2 grid gap-1 pl-4 text-sm leading-6 text-[var(--nsn-slate)]">
                        {requiredPermissionsFor(action.actionType).map((item) => (
                          <li className="list-disc" key={item}>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="grid gap-4 xl:grid-cols-2">
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-[var(--nsn-navy)]">
                        Approved observation
                      </h4>
                      <EvidenceList items={action.evidence.approvedObservation} />
                    </div>
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-[var(--nsn-navy)]">
                        Approved Memory
                      </h4>
                      <EvidenceList items={action.evidence.approvedMemory} />
                    </div>
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-[var(--nsn-navy)]">
                        Human modification
                      </h4>
                      <EvidenceList items={action.evidence.humanModification} />
                    </div>
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-[var(--nsn-navy)]">
                        Originating suggestion
                      </h4>
                      <EvidenceList items={action.evidence.originatingSuggestion} />
                    </div>
                  </div>
                </div>
              </NsnCard>
            ))}
          </div>
        )}
      </Section>

      <Section title="Warnings">
        {currentPlan.warnings.length === 0 ? (
          <NsnCard>
            <p className="text-sm leading-6 text-[var(--nsn-slate)]">
              No conflicts were detected in this planning snapshot.
            </p>
          </NsnCard>
        ) : (
          <div className="grid gap-3">
            {currentPlan.warnings.map((warning) => (
              <NsnCard className="min-w-0" key={warning.id}>
                <NsnBadge tone="review">
                  {warningTypeLabel(warning.warningType)}
                </NsnBadge>
                <h3 className="mt-3 break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                  {warning.title}
                </h3>
                <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  {warning.description}
                </p>
              </NsnCard>
            ))}
          </div>
        )}
      </Section>

      <Section title="Skipped Items">
        {currentPlan.skippedItems.length === 0 ? (
          <NsnCard>
            <p className="text-sm leading-6 text-[var(--nsn-slate)]">
              Nothing was skipped.
            </p>
          </NsnCard>
        ) : (
          <div className="grid gap-3">
            {currentPlan.skippedItems.map((item) => (
              <NsnCard className="min-w-0" key={item.id}>
                <NsnBadge tone="source">{item.status}</NsnBadge>
                <p className="mt-3 break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                  {item.title}
                </p>
                <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  {item.currentRelativePath}
                </p>
                <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                  {item.reason}
                </p>
              </NsnCard>
            ))}
          </div>
        )}
      </Section>

      <Section title="History">
        <div className="grid gap-3">
          {currentPlan.history.map((item) => (
            <NsnCard className="min-w-0" key={item.id}>
              <p className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                {item.label}
              </p>
              <p className="mt-1 text-xs leading-5 text-[var(--nsn-warm-gray)]">
                {new Intl.DateTimeFormat("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(item.at))}
              </p>
              <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                {item.detail}
              </p>
            </NsnCard>
          ))}
        </div>
      </Section>

      {isExecuteDialogOpen ? (
        <div
          aria-labelledby="execute-plan-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[rgb(31_42_68_/_0.45)] p-3"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !isExecuting) {
              setExecuteConfirmation("");
              setIsExecuteDialogOpen(false);
            }
          }}
          role="dialog"
        >
          <div className="grid max-h-[calc(100vh-2rem)] w-full max-w-xl gap-5 overflow-y-auto rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 shadow-xl sm:p-6">
            <div className="min-w-0">
              <h2
                className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
                id="execute-plan-title"
              >
                Organize these files?
              </h2>
              <p className="mt-3 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                The Librarian will create folders, move files, and rename files
                exactly as shown in this approved Organization Plan.
              </p>
            </div>
            <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
              Type EXECUTE to confirm
              <input
                autoFocus
                className="min-h-11 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] px-3 text-sm font-semibold text-[var(--nsn-navy)] outline-none focus:border-[var(--nsn-teal)]"
                onChange={(event) => setExecuteConfirmation(event.target.value)}
                value={executeConfirmation}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <NsnButton
                disabled={isExecuting || executeConfirmation !== "EXECUTE"}
                onClick={executePlan}
                type="button"
                variant="primary"
              >
                {isExecuting ? "Organizing..." : "Organize Files"}
              </NsnButton>
              <NsnButton
                disabled={isExecuting}
                onClick={() => {
                  setExecuteConfirmation("");
                  setIsExecuteDialogOpen(false);
                }}
                type="button"
                variant="secondary"
              >
                Cancel
              </NsnButton>
            </div>
          </div>
        </div>
      ) : null}

      {isUndoDialogOpen ? (
        <div
          aria-labelledby="undo-organization-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[rgb(31_42_68_/_0.45)] p-3"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !isUndoing) {
              setUndoConfirmation("");
              setIsUndoDialogOpen(false);
            }
          }}
          role="dialog"
        >
          <div className="grid max-h-[calc(100vh-2rem)] w-full max-w-xl gap-5 overflow-y-auto rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 shadow-xl sm:p-6">
            <div className="min-w-0">
              <h2
                className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
                id="undo-organization-title"
              >
                Undo Organization?
              </h2>
              <p className="mt-3 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                The Bridge will restore the completed file and folder changes
                shown in this preview.
              </p>
            </div>
            <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
              Type UNDO to confirm
              <input
                autoFocus
                className="min-h-11 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] px-3 text-sm font-semibold text-[var(--nsn-navy)] outline-none focus:border-[var(--nsn-teal)]"
                onChange={(event) => setUndoConfirmation(event.target.value)}
                value={undoConfirmation}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <NsnButton
                disabled={isUndoing || undoConfirmation !== "UNDO"}
                onClick={executeUndo}
                type="button"
                variant="primary"
              >
                {isUndoing ? "Restoring..." : "Undo Changes"}
              </NsnButton>
              <NsnButton
                disabled={isUndoing}
                onClick={() => {
                  setUndoConfirmation("");
                  setIsUndoDialogOpen(false);
                }}
                type="button"
                variant="secondary"
              >
                Cancel
              </NsnButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
