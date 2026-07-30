-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "ExecutionRun" (
    "id" TEXT NOT NULL,
    "organizationPlanId" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "totalActions" INTEGER NOT NULL DEFAULT 0,
    "successfulActions" INTEGER NOT NULL DEFAULT 0,
    "failedActions" INTEGER NOT NULL DEFAULT 0,
    "errorCategory" TEXT,

    CONSTRAINT "ExecutionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionAction" (
    "id" TEXT NOT NULL,
    "executionRunId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "sourceRelativePath" TEXT NOT NULL,
    "destinationRelativePath" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "safeErrorCategory" TEXT,
    "sequence" INTEGER NOT NULL,

    CONSTRAINT "ExecutionAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecutionRun_organizationPlanId_idx" ON "ExecutionRun"("organizationPlanId");

-- CreateIndex
CREATE INDEX "ExecutionRun_status_idx" ON "ExecutionRun"("status");

-- CreateIndex
CREATE INDEX "ExecutionRun_startedAt_idx" ON "ExecutionRun"("startedAt");

-- CreateIndex
CREATE INDEX "ExecutionRun_completedAt_idx" ON "ExecutionRun"("completedAt");

-- CreateIndex
CREATE INDEX "ExecutionAction_executionRunId_idx" ON "ExecutionAction"("executionRunId");

-- CreateIndex
CREATE INDEX "ExecutionAction_status_idx" ON "ExecutionAction"("status");

-- CreateIndex
CREATE INDEX "ExecutionAction_sequence_idx" ON "ExecutionAction"("sequence");

-- AddForeignKey
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_organizationPlanId_fkey" FOREIGN KEY ("organizationPlanId") REFERENCES "OrganizationPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionAction" ADD CONSTRAINT "ExecutionAction_executionRunId_fkey" FOREIGN KEY ("executionRunId") REFERENCES "ExecutionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
