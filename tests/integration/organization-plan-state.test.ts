import assert from "node:assert/strict";
import test from "node:test";

import { organizationPlanUiState } from "../../src/lib/bridge/organization-plan-state";

test("a ready plan is awaiting final authorization", () => {
  assert.equal(
    organizationPlanUiState({ planStatus: "READY_FOR_EXECUTION" }),
    "AWAITING_EXECUTION",
  );
});

test("pending and running execution records are executing", () => {
  assert.equal(
    organizationPlanUiState({
      executionStatus: "PENDING",
      planStatus: "READY_FOR_EXECUTION",
    }),
    "EXECUTING",
  );
  assert.equal(
    organizationPlanUiState({
      executionStatus: "RUNNING",
      planStatus: "READY_FOR_EXECUTION",
    }),
    "EXECUTING",
  );
});

test("a completed execution is shown as completed after refresh", () => {
  assert.equal(
    organizationPlanUiState({
      executionStatus: "COMPLETED",
      planStatus: "EXECUTED",
    }),
    "COMPLETED",
  );
});

test("a running undo takes precedence over the completed execution", () => {
  assert.equal(
    organizationPlanUiState({
      executionStatus: "COMPLETED",
      planStatus: "EXECUTED",
      undoStatus: "RUNNING",
    }),
    "UNDOING",
  );
});

test("a completed undo remains visibly undone after refresh", () => {
  assert.equal(
    organizationPlanUiState({
      executionStatus: "COMPLETED",
      planStatus: "EXECUTED",
      undoStatus: "COMPLETED",
    }),
    "UNDONE",
  );
});

test("failed or partial records require attention", () => {
  assert.equal(
    organizationPlanUiState({
      executionStatus: "FAILED",
      planStatus: "READY_FOR_EXECUTION",
    }),
    "NEEDS_ATTENTION",
  );
  assert.equal(
    organizationPlanUiState({
      executionStatus: "PARTIALLY_COMPLETED",
      planStatus: "EXECUTED",
    }),
    "NEEDS_ATTENTION",
  );
});

test("cancelled plans remain cancelled without activating execution", () => {
  assert.equal(
    organizationPlanUiState({ planStatus: "CANCELLED" }),
    "CANCELLED",
  );
});
