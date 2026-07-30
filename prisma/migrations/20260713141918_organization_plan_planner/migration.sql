-- CreateEnum
CREATE TYPE "OrganizationPlanStatus" AS ENUM ('DRAFT', 'READY_FOR_EXECUTION', 'EXECUTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "OrganizationPlan" (
    "id" TEXT NOT NULL,
    "scanSessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "status" "OrganizationPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "totalActions" INTEGER NOT NULL DEFAULT 0,
    "approvedActions" INTEGER NOT NULL DEFAULT 0,
    "modifiedActions" INTEGER NOT NULL DEFAULT 0,
    "rejectedActions" INTEGER NOT NULL DEFAULT 0,
    "unchangedActions" INTEGER NOT NULL DEFAULT 0,
    "actions" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "skippedItems" JSONB NOT NULL,
    "history" JSONB NOT NULL,

    CONSTRAINT "OrganizationPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationPlan_scanSessionId_idx" ON "OrganizationPlan"("scanSessionId");

-- CreateIndex
CREATE INDEX "OrganizationPlan_status_idx" ON "OrganizationPlan"("status");

-- CreateIndex
CREATE INDEX "OrganizationPlan_createdAt_idx" ON "OrganizationPlan"("createdAt");

-- CreateIndex
CREATE INDEX "OrganizationPlan_updatedAt_idx" ON "OrganizationPlan"("updatedAt");

-- AddForeignKey
ALTER TABLE "OrganizationPlan" ADD CONSTRAINT "OrganizationPlan_scanSessionId_fkey" FOREIGN KEY ("scanSessionId") REFERENCES "ScanSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
