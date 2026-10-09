import type { Prisma } from "@prisma/client";

// An execution owns an immutable action snapshot once it is queued or started.
// Human planning writes and execution admission use the same parent revision.
export const blockingPlanExecutionWhere = {
  status: { in: ["PENDING", "RUNNING", "COMPLETED", "PARTIALLY_COMPLETED"] },
} satisfies Prisma.ExecutionRunWhereInput;

export async function claimPlanExecution(tx: Prisma.TransactionClient, plan: { id: string; updatedAt: Date }) {
  const changed = await tx.organizationPlan.updateMany({
    data: { updatedAt: new Date(Math.max(Date.now(), plan.updatedAt.getTime() + 1)) },
    where: { id: plan.id, status: "READY_FOR_EXECUTION", updatedAt: plan.updatedAt,
      executionRuns: { none: blockingPlanExecutionWhere } },
  });
  return changed.count === 1;
}
