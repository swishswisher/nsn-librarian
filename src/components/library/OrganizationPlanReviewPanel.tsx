"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";

import { FolderGroupedList } from "@/components/library/FolderGroupedList";
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
  BridgeOrganizationPlanMutationResponse,
  BridgeUndoPreview,
  BridgeUndoPreviewResponse,
  BridgeUndoResponse,
  BridgeUndoRunSummary,
  OrganizationPlanActionType,
  OrganizationPlanStatus,
  OrganizationPlanWarningType,
} from "@/lib/bridge/types";
import {
  actionCanBeChosen,
  chooseActionForSource,
  organizationPlanDownload,
  organizationPlanDecisionGroups,
  organizationPlanLiveSummary,
  selectedActionIdsFromActions,
} from "@/lib/bridge/organization-plan-review";
import { getConnectedLibrariesRoute } from "@/lib/library/routes";

type OrganizationPlanReviewPanelProps = {
  latestExecution?: BridgeExecutionRunSummary | null;
  plan: BridgeOrganizationPlan;
  rootLabel: string;
};

type PlanDecision = "APPROVE" | "CANCEL";

function statusLabel(status: OrganizationPlanStatus) {
  if (status === "DRAFT") {
    return "Choosing destinations";
  }

  if (status === "READY_FOR_EXECUTION") {
    return "Ready for final authorization";
  }

  if (status === "CANCELLED") {
    return "Plan cancelled";
  }

  if (status === "EXECUTED") {
    return "Changes completed";
  }
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

function actionIsSelectedForExecution(action: BridgeOrganizationPlanAction) {
  return actionCanBeChosen(action) && action.selectedForExecution === true;
}

function actionIsRequiredDependency(action: BridgeOrganizationPlanAction) {
  return (
    action.actionType === "CREATE_FOLDER" &&
    action.requiredForSelectedActions === true
  );
}

function actionIsReviewOnly(action: BridgeOrganizationPlanAction) {
  return (
    action.actionType === "WEBSITE_ACTION" ||
    action.actionType === "REVIEW_ONLY" ||
    (action.actionType === "CREATE_FOLDER" && !actionIsRequiredDependency(action))
  );
}

function folderFromRelativePath(relativePath: string) {
  const parts = relativePath.split("/").filter(Boolean);

  return parts.slice(0, -1).join("/");
}

function readableLibraryPath(rootLabel: string, relativePath: string) {
  const parts = relativePath.split("/").filter(Boolean);

  return [rootLabel, ...parts].join(" › ");
}

function confidenceLabel(value: number) {
  if (value >= 0.8) {
    return "High";
  }

  if (value >= 0.5) {
    return "Medium";
  }

  return "Low";
}

function counted(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function destinationOptionLabel(action: BridgeOrganizationPlanAction) {
  const destination = action.plannedRelativePath ?? "the proposed location";

  if (action.actionType === "RENAME_FILE") {
    return `Rename it to ${fileNameFromRelativePath(destination)}`;
  }

  if (action.actionType === "MOVE_AND_RENAME_FILE") {
    return `Move and rename it to ${destination}`;
  }

  return `Move it to ${folderFromRelativePath(destination) || destination}`;
}

function plainLanguageReason(action: BridgeOrganizationPlanAction) {
  const destination = action.plannedRelativePath ?? "";
  const fileName = fileNameFromRelativePath(action.sourceRelativePath);

  if (
    /\.(m4a|mp3|wav|aac|flac|ogg)$/i.test(fileName) &&
    /workshop/i.test(destination)
  ) {
    return "This is an audio recording about a workshop, so it may belong with other workshop recordings.";
  }

  const specificReason = [
    action.reason,
    ...action.evidence.originatingSuggestion.slice(2),
  ].find(
    (item) =>
      item.trim().length > 0 &&
      !/the librarian noticed|similar folder or name signals|practical folder pattern|audio-specific signals|video-specific signals|recommendation for review/i.test(
        item,
      ),
  );

  if (specificReason) {
    return specificReason;
  }

  const destinationFolder = folderFromRelativePath(destination);

  return `The reviewed file details relate to ${
    destinationFolder || destination
  }, so that location may make the file easier to find.`;
}

function inclusionLabel(
  action: BridgeOrganizationPlanAction,
  checked: boolean,
) {
  const change =
    action.actionType === "RENAME_FILE"
      ? "rename"
      : action.actionType === "MOVE_AND_RENAME_FILE"
        ? "move and rename"
        : "move";

  return checked
    ? `Include this ${change} in the plan`
    : `Choosing this option will include this ${change} in the plan`;
}

function sameStringSet(left: string[], right: string[]) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();

  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
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
  if (warningType === "DUPLICATE_SOURCE") {
    return "Conflicting destinations";
  }

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
  rootLabel,
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
  const [selectedActionIds, setSelectedActionIds] = useState<string[]>(
    () => selectedActionIdsFromActions(plan.actions),
  );
  const [error, setError] = useState<string | null>(null);
  const [executeConfirmation, setExecuteConfirmation] = useState("");
  const [undoConfirmation, setUndoConfirmation] = useState("");
  const [isExecuteDialogOpen, setIsExecuteDialogOpen] = useState(false);
  const [isUndoDialogOpen, setIsUndoDialogOpen] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSavingSelection, setIsSavingSelection] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [isUndoPreviewing, setIsUndoPreviewing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PlanDecision | null>(null);

  function replaceCurrentPlan(nextPlan: BridgeOrganizationPlan) {
    setCurrentPlan(nextPlan);
    setSelectedActionIds(selectedActionIdsFromActions(nextPlan.actions));
  }

  function chooseDestination(sourceRelativePath: string, actionId: string | null) {
    if (
      currentPlan.status !== "DRAFT" ||
      isSavingSelection
    ) {
      return;
    }

    setSelectedActionIds((current) =>
      chooseActionForSource(
        current,
        currentPlan.actions,
        sourceRelativePath,
        actionId,
      ),
    );
    setMessage(null);
    setExecutionPreview(null);
  }

  async function saveSelection() {
    if (isSavingSelection || currentPlan.status !== "DRAFT") {
      return;
    }

    if (selectedActionIds.length === 0) {
      await clearSelection();
      return;
    }

    setError(null);
    setMessage(null);
    setIsSavingSelection(true);

    try {
      const response = await fetch(
        `/api/bridge/organization-plans/${encodeURIComponent(
          currentPlan.id,
        )}/selection`,
        {
          body: JSON.stringify({ actionIds: selectedActionIds }),
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

      replaceCurrentPlan(payload.plan);
      setExecutionPreview(null);
      setMessage("Your choices were saved. No files were moved.");
      router.refresh();
    } catch {
      setError("The selected file actions could not be saved right now.");
    } finally {
      setIsSavingSelection(false);
    }
  }

  async function clearSelection() {
    if (isSavingSelection || currentPlan.status !== "DRAFT") {
      return;
    }

    if (currentPlan.summary.selectedFileActions === 0) {
      setSelectedActionIds([]);
      setMessage("The local selection was cleared. Nothing has been changed.");
      return;
    }

    setError(null);
    setMessage(null);
    setIsSavingSelection(true);

    try {
      const response = await fetch(
        `/api/bridge/organization-plans/${encodeURIComponent(
          currentPlan.id,
        )}/selection`,
        {
          body: JSON.stringify({ action: "CLEAR" }),
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

      replaceCurrentPlan(payload.plan);
      setExecutionPreview(null);
      setMessage("Your choices were saved. No files were moved.");
      router.refresh();
    } catch {
      setError("The selected file actions could not be cleared right now.");
    } finally {
      setIsSavingSelection(false);
    }
  }

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
      replaceCurrentPlan(payload.plan);
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
    if (currentPlan.summary.estimatedOperations === 0) {
      setError("Save at least one selected file action before downloading a plan.");
      return;
    }

    const payload = organizationPlanDownload(currentPlan);
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

      replaceCurrentPlan(payload.plan);
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
  const hasSavedSelection = currentPlan.summary.selectedFileActions > 0;
  const decisionGroups = useMemo(
    () => organizationPlanDecisionGroups(currentPlan.actions),
    [currentPlan.actions],
  );
  const reviewOnlyActions = currentPlan.actions.filter(actionIsReviewOnly);
  const filesystemActions = currentPlan.actions.filter(
    (action) => !actionIsReviewOnly(action),
  );
  const selectedFilesystemActions = filesystemActions.filter(
    (action) =>
      actionIsSelectedForExecution(action) || actionIsRequiredDependency(action),
  );
  const selectedActionCount = selectedActionIds.length;
  const savedActionIds = useMemo(
    () => selectedActionIdsFromActions(currentPlan.actions),
    [currentPlan.actions],
  );
  const hasUnsavedChoices = !sameStringSet(selectedActionIds, savedActionIds);
  const liveSummary = useMemo(
    () =>
      organizationPlanLiveSummary(currentPlan.actions, selectedActionIds),
    [currentPlan.actions, selectedActionIds],
  );
  const hasExecutionStarted =
    currentPlan.status === "EXECUTED" ||
    executionRun?.status === "COMPLETED" ||
    executionRun?.status === "PARTIALLY_COMPLETED" ||
    executionRun?.status === "RUNNING";
  const canPreviewExecution =
    currentPlan.summary.estimatedOperations > 0 &&
    currentPlan.status === "READY_FOR_EXECUTION" &&
    !hasExecutionStarted;
  const canExecutePlan =
    canPreviewExecution && executionPreview?.canExecute === true;
  const visibleUndoRun = undoRun ?? executionRun?.latestUndoRun ?? null;

  return (
    <div className="grid min-w-0 gap-8">
      <NsnCard tone="aqua">
        <div className="grid min-w-0 gap-5">
          <div className="min-w-0">
            <h2 className="nsn-display text-3xl text-[var(--nsn-navy)]">
              Choose which changes to include
            </h2>
            <p className="mt-3 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              Nothing will move yet. Select where each file should go, save your
              choices, and review the final changes before execution.
            </p>
          </div>
          <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Organization process">
            {[
              "Choose file destinations",
              "Save choices",
              "Review final plan",
              "Authorize execution",
            ].map((step, index) => (
              <li
                className="flex min-w-0 items-center gap-3 rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-card)] p-3 text-sm font-semibold text-[var(--nsn-navy)]"
                key={step}
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--nsn-teal)] text-xs text-white">
                  {index + 1}
                </span>
                <span className="break-words [overflow-wrap:anywhere]">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </NsnCard>

      <section
        aria-label="Live safety summary"
        aria-live="polite"
        className="sticky top-3 z-10"
      >
        <NsnCard className="min-w-0 shadow-sm">
          <div className="grid min-w-0 gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--nsn-navy)]">
                Safety summary
              </h2>
              <p className="mt-1 text-sm font-semibold text-[var(--nsn-teal-dark)]">
                Nothing has happened yet
              </p>
            </div>
            <ul className="grid min-w-0 gap-2 text-sm text-[var(--nsn-slate)] sm:grid-cols-2 xl:grid-cols-5">
              <li>{counted(liveSummary.filesMoved, "file")} will move</li>
              <li>
                {counted(liveSummary.foldersCreated, "folder")} will be created
              </li>
              <li>
                {counted(liveSummary.filesRenamed, "file")} will be renamed
              </li>
              <li>
                {counted(liveSummary.filesDeleted, "file")} will be deleted
              </li>
              <li>
                {counted(liveSummary.filesOverwritten, "file")} will be overwritten
              </li>
            </ul>
          </div>
        </NsnCard>
      </section>

      <NsnCard tone="aqua">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap gap-2">
              <NsnBadge tone={statusTone(currentPlan.status)}>
                {statusLabel(currentPlan.status)}
              </NsnBadge>
              <NsnBadge tone="source">
                {decisionGroups.length} files to decide
              </NsnBadge>
              <NsnBadge tone="approved">
                {currentPlan.summary.selectedFileActions} saved changes
              </NsnBadge>
              <NsnBadge tone="migration">
                {currentPlan.summary.estimatedOperations} steps after authorization
              </NsnBadge>
              <NsnBadge tone={currentPlan.warnings.length > 0 ? "review" : "approved"}>
                {currentPlan.warnings.length} warnings
              </NsnBadge>
            </div>
            <p className="mt-4 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              NSN can only organize files after you save, review, and authorize
              the final plan. It will not overwrite or delete files.
            </p>
          </div>
          <div className="grid min-w-0 gap-3 sm:grid-cols-3 lg:min-w-80 lg:grid-cols-1">
            {hasPlanActions ? (
              <>
                <NsnButton
                  disabled={
                    currentPlan.status !== "DRAFT" ||
                    !hasSavedSelection ||
                    hasUnsavedChoices ||
                    currentPlan.summary.blockingWarnings > 0 ||
                    pendingAction === "APPROVE"
                  }
                  onClick={() => submitDecision("APPROVE")}
                  type="button"
                  variant="primary"
                >
                  {pendingAction === "APPROVE"
                    ? "Preparing final plan..."
                    : "Review final plan"}
                </NsnButton>
                <NsnButton
                  disabled={!hasSavedSelection || hasUnsavedChoices}
                  onClick={downloadPlan}
                  type="button"
                  variant="accent"
                >
                  Download saved plan JSON
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
              {pendingAction === "CANCEL"
                ? "Cancelling..."
                : "Cancel this plan"}
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

      <Section title="Choose file destinations">
        <NsnCard className="min-w-0">
          <div className="grid min-w-0 gap-4">
            <div className="flex flex-wrap gap-2">
              <NsnBadge tone="source">
                {counted(decisionGroups.length, "file")} {decisionGroups.length === 1 ? "needs" : "need"} a choice
              </NsnBadge>
              <NsnBadge tone={selectedActionCount > 0 ? "approved" : "pending"}>
                {selectedActionCount} moves or renames included
              </NsnBadge>
              {hasUnsavedChoices ? (
                <NsnBadge tone="review">Choices not saved yet</NsnBadge>
              ) : (
                <NsnBadge tone={hasSavedSelection ? "approved" : "pending"}>
                  Choices match the saved plan
                </NsnBadge>
              )}
            </div>
            <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              Each file has one choice. Keeping the current location is the
              default. Choosing a destination includes that move in the plan; it
              does not move the file now.
            </p>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <NsnButton
                disabled={
                  currentPlan.status !== "DRAFT" ||
                  !hasUnsavedChoices ||
                  isSavingSelection
                }
                onClick={saveSelection}
                type="button"
                variant="primary"
              >
                {isSavingSelection
                  ? "Saving choices..."
                  : selectedActionCount === 0
                    ? "Save choice to keep every file where it is"
                    : `Save ${selectedActionCount} choice${
                        selectedActionCount === 1 ? "" : "s"
                      }`}
              </NsnButton>
              <NsnButton
                disabled={currentPlan.status !== "DRAFT" || isSavingSelection}
                onClick={clearSelection}
                type="button"
                variant="secondary"
              >
                Leave every file where it is
              </NsnButton>
            </div>
            {hasUnsavedChoices ? (
              <p className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-slate)]">
                Save these choices before reviewing or downloading the final
                plan. Nothing has moved.
              </p>
            ) : null}
          </div>
        </NsnCard>

        {decisionGroups.length === 0 ? (
          <NsnCard>
            <p className="text-sm leading-6 text-[var(--nsn-slate)]">
              There are no file destinations to choose in this plan.
            </p>
          </NsnCard>
        ) : (
          <div className="grid min-w-0 gap-5">
            {decisionGroups.map((group) => {
              const selectedAction = group.actions.find((action) =>
                selectedActionIds.includes(action.id),
              );
              const disabled = currentPlan.status !== "DRAFT" || isSavingSelection;
              const sourceFolder = folderFromRelativePath(
                group.sourceRelativePath,
              );
              const fileName = fileNameFromRelativePath(group.sourceRelativePath);

              return (
                <NsnCard className="min-w-0" key={group.sourceRelativePath}>
                  <fieldset className="grid min-w-0 gap-4" disabled={disabled}>
                    <legend className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                      {group.actions.length > 1
                        ? `Choose one location for ${fileName}`
                        : group.actions[0]?.actionType === "RENAME_FILE"
                          ? "Rename this file?"
                          : "Move this file?"}
                    </legend>
                    <div className="grid min-w-0 gap-2 text-sm leading-6">
                      <p className="break-words [overflow-wrap:anywhere]">
                        <span className="font-semibold text-[var(--nsn-navy)]">
                          File:
                        </span>{" "}
                        <span className="text-[var(--nsn-slate)]">{fileName}</span>
                      </p>
                      <p className="break-words [overflow-wrap:anywhere]">
                        <span className="font-semibold text-[var(--nsn-navy)]">
                          From:
                        </span>{" "}
                        <span className="text-[var(--nsn-slate)]">
                          {readableLibraryPath(rootLabel, sourceFolder)}
                        </span>
                      </p>
                    </div>

                    <label className="grid min-w-0 cursor-pointer gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-4 sm:grid-cols-[auto_minmax(0,1fr)]">
                      <input
                        checked={!selectedAction}
                        className="mt-1 h-5 w-5"
                        name={`destination-${group.sourceRelativePath}`}
                        onChange={() =>
                          chooseDestination(group.sourceRelativePath, null)
                        }
                        type="radio"
                      />
                      <span className="grid min-w-0 gap-1">
                        <span className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                          Keep it in {sourceFolder || rootLabel} — default
                        </span>
                        <span className="text-sm text-[var(--nsn-slate)]">
                          Leave this file where it is
                        </span>
                      </span>
                    </label>

                    {group.actions.map((action) => {
                      const checked = selectedAction?.id === action.id;
                      const destination = action.plannedRelativePath ?? "";
                      const destinationFolder = folderFromRelativePath(destination);

                      return (
                        <label
                          className="grid min-w-0 cursor-pointer gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 sm:grid-cols-[auto_minmax(0,1fr)]"
                          key={action.id}
                        >
                          <input
                            checked={checked}
                            className="mt-1 h-5 w-5"
                            name={`destination-${group.sourceRelativePath}`}
                            onChange={() =>
                              chooseDestination(
                                group.sourceRelativePath,
                                action.id,
                              )
                            }
                            type="radio"
                          />
                          <span className="grid min-w-0 gap-3">
                            <span className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                              {destinationOptionLabel(action)}
                            </span>
                            <span className="grid min-w-0 gap-2 text-sm leading-6">
                              <span className="break-words [overflow-wrap:anywhere]">
                                <span className="font-semibold text-[var(--nsn-navy)]">
                                  To:
                                </span>{" "}
                                <span className="text-[var(--nsn-slate)]">
                                  {readableLibraryPath(
                                    rootLabel,
                                    action.actionType === "RENAME_FILE"
                                      ? destination
                                      : destinationFolder,
                                  )}
                                </span>
                              </span>
                              <span className="break-words text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                                <span className="font-semibold text-[var(--nsn-navy)]">
                                  Why this may fit:
                                </span>{" "}
                                {plainLanguageReason(action)}
                              </span>
                              <span className="text-[var(--nsn-slate)]">
                                <span className="font-semibold text-[var(--nsn-navy)]">
                                  Confidence:
                                </span>{" "}
                                {confidenceLabel(action.confidence)}
                              </span>
                              <span className="font-semibold text-[var(--nsn-teal-dark)]">
                                {inclusionLabel(action, checked)}
                              </span>
                            </span>
                            {checked &&
                            (action.requiredFolderPaths?.length ?? 0) > 0 ? (
                              <span className="grid gap-2 rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-slate)]">
                                {action.requiredFolderPaths?.map((folderPath) => (
                                  <span
                                    className="break-words [overflow-wrap:anywhere]"
                                    key={folderPath}
                                  >
                                    NSN will also create the folder ‘{folderPath}’
                                    because this destination does not exist.
                                  </span>
                                ))}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                </NsnCard>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Saved final plan">
        {selectedFilesystemActions.length === 0 ? (
          <NsnCard>
            <p className="text-sm leading-6 text-[var(--nsn-slate)]">
              No file destinations have been saved yet. Nothing will move.
            </p>
          </NsnCard>
        ) : (
          <FolderGroupedList
            getId={(action) => action.id}
            getRelativePath={(action) =>
              action.sourceRelativePath ||
              action.plannedRelativePath ||
              action.plannedFolderPath ||
              ""
            }
            itemLabel="saved plan item"
            items={selectedFilesystemActions}
            renderItem={(action) => (
              <NsnCard className="min-w-0" key={action.id}>
                <div className="grid min-w-0 gap-5">
                  <div className="flex flex-wrap gap-2">
                    <NsnBadge tone="migration">
                      {action.order}. {actionTypeLabel(action.actionType)}
                    </NsnBadge>
                    <NsnBadge tone="source">
                      Confidence {confidenceLabel(action.confidence)}
                    </NsnBadge>
                    {actionIsRequiredDependency(action) ? (
                      <NsnBadge tone="approved">Created automatically</NsnBadge>
                    ) : null}
                  </div>

                  {actionIsRequiredDependency(action) ? (
                    <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      NSN will create the folder ‘{action.plannedFolderPath}’
                      because a saved file destination needs it.
                    </p>
                  ) : (
                    <div className="grid min-w-0 gap-3 text-sm leading-6">
                      <p className="break-words [overflow-wrap:anywhere]">
                        <span className="font-semibold text-[var(--nsn-navy)]">File:</span>{" "}
                        {fileNameFromRelativePath(action.sourceRelativePath)}
                      </p>
                      <p className="break-words [overflow-wrap:anywhere]">
                        <span className="font-semibold text-[var(--nsn-navy)]">From:</span>{" "}
                        {readableLibraryPath(
                          rootLabel,
                          folderFromRelativePath(action.sourceRelativePath),
                        )}
                      </p>
                      <p className="break-words [overflow-wrap:anywhere]">
                        <span className="font-semibold text-[var(--nsn-navy)]">To:</span>{" "}
                        {readableLibraryPath(
                          rootLabel,
                          action.plannedRelativePath ?? "",
                        )}
                      </p>
                    </div>
                  )}
                </div>
              </NsnCard>
            )}
          />
        )}
      </Section>

      <Section title="Other review information">
        <NsnCard className="min-w-0">
          <details className="group min-w-0">
            <summary className="cursor-pointer break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
              Items that need review but will not be moved (
              {reviewOnlyActions.length + currentPlan.warnings.length})
            </summary>
            <p className="mt-3 text-sm leading-6 text-[var(--nsn-slate)]">
              These notes cannot be selected and are not part of filesystem
              execution.
            </p>
            {reviewOnlyActions.length === 0 &&
            currentPlan.warnings.length === 0 ? (
              <p className="mt-4 text-sm leading-6 text-[var(--nsn-slate)]">
                There are no review-only notes or warnings in this plan.
              </p>
            ) : (
              <div className="mt-4 grid min-w-0 gap-3">
                {reviewOnlyActions.map((action) => (
                  <div
                    className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-4"
                    key={action.id}
                  >
                    <div className="flex flex-wrap gap-2">
                      <NsnBadge tone="source">
                        {actionTypeLabel(action.actionType)}
                      </NsnBadge>
                      <NsnBadge tone="pending">Will not move</NsnBadge>
                    </div>
                    <p className="mt-3 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {action.sourceRelativePath}
                    </p>
                    <p className="mt-2 break-words text-sm font-semibold leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                      {action.originatingSuggestion.title}
                    </p>
                    <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {action.reason}
                    </p>
                  </div>
                ))}
                {currentPlan.warnings.map((warning) => (
                  <div
                    className="min-w-0 rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-4"
                    key={warning.id}
                  >
                    <NsnBadge tone="review">
                      {warningTypeLabel(warning.warningType)}
                    </NsnBadge>
                    <h3 className="mt-3 break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                      {warning.title}
                    </h3>
                    <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {warning.description}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </details>
        </NsnCard>
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
