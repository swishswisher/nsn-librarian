import type {
  ExecutionStatus,
  OrganizationPlanStatus,
  UndoStatus,
} from "./types";

export type OrganizationPlanUiState =
  | "REVIEWING"
  | "AWAITING_EXECUTION"
  | "EXECUTING"
  | "COMPLETED"
  | "UNDOING"
  | "UNDONE"
  | "NEEDS_ATTENTION"
  | "CANCELLED";

export function organizationPlanUiState(input: {
  executionStatus?: ExecutionStatus | null;
  planStatus: OrganizationPlanStatus;
  undoStatus?: UndoStatus | null;
}): OrganizationPlanUiState {
  if (input.undoStatus === "PENDING" || input.undoStatus === "RUNNING") {
    return "UNDOING";
  }

  if (input.undoStatus === "COMPLETED") {
    return "UNDONE";
  }

  if (
    input.undoStatus === "BLOCKED" ||
    input.undoStatus === "FAILED" ||
    input.undoStatus === "PARTIALLY_COMPLETED"
  ) {
    return "NEEDS_ATTENTION";
  }

  if (
    input.executionStatus === "PENDING" ||
    input.executionStatus === "RUNNING"
  ) {
    return "EXECUTING";
  }

  if (
    input.executionStatus === "BLOCKED" ||
    input.executionStatus === "FAILED" ||
    input.executionStatus === "PARTIALLY_COMPLETED"
  ) {
    return "NEEDS_ATTENTION";
  }

  if (
    input.planStatus === "EXECUTED" ||
    input.executionStatus === "COMPLETED"
  ) {
    return "COMPLETED";
  }

  if (input.planStatus === "CANCELLED") {
    return "CANCELLED";
  }

  if (input.planStatus === "READY_FOR_EXECUTION") {
    return "AWAITING_EXECUTION";
  }

  return "REVIEWING";
}
