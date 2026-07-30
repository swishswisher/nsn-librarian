ALTER TYPE "ExecutionStatus" ADD VALUE 'BLOCKED';

ALTER TABLE "OrganizationPlan" ADD COLUMN "connectedLibraryId" TEXT;

UPDATE "OrganizationPlan" AS plan
SET "connectedLibraryId" = session."connectedFolderId"
FROM "ScanSession" AS session
WHERE plan."scanSessionId" = session."id";

ALTER TABLE "OrganizationPlan" ALTER COLUMN "connectedLibraryId" SET NOT NULL;

ALTER TABLE "ExecutionRun" ADD COLUMN "connectedLibraryId" TEXT;
ALTER TABLE "ExecutionRun" ADD COLUMN "bridgeRootId" TEXT;
ALTER TABLE "ExecutionRun" ADD COLUMN "permissionSnapshot" JSONB;
ALTER TABLE "ExecutionRun" ADD COLUMN "reconciliationStatus" TEXT NOT NULL DEFAULT 'NOT_REQUESTED';

UPDATE "ExecutionRun" AS run
SET "connectedLibraryId" = plan."connectedLibraryId"
FROM "OrganizationPlan" AS plan
WHERE run."organizationPlanId" = plan."id";

ALTER TABLE "ExecutionRun" ALTER COLUMN "connectedLibraryId" SET NOT NULL;

ALTER TABLE "ExecutionAction" ADD COLUMN "sourceChecksumBefore" TEXT;
ALTER TABLE "ExecutionAction" ADD COLUMN "destinationChecksumAfter" TEXT;

ALTER TABLE "MonitoringEvent" ADD COLUMN "executionRunId" TEXT;

CREATE INDEX "OrganizationPlan_connectedLibraryId_idx" ON "OrganizationPlan"("connectedLibraryId");
CREATE INDEX "ExecutionRun_connectedLibraryId_idx" ON "ExecutionRun"("connectedLibraryId");
CREATE INDEX "MonitoringEvent_executionRunId_idx" ON "MonitoringEvent"("executionRunId");

ALTER TABLE "OrganizationPlan"
ADD CONSTRAINT "OrganizationPlan_connectedLibraryId_fkey"
FOREIGN KEY ("connectedLibraryId") REFERENCES "ConnectedFolder"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExecutionRun"
ADD CONSTRAINT "ExecutionRun_connectedLibraryId_fkey"
FOREIGN KEY ("connectedLibraryId") REFERENCES "ConnectedFolder"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MonitoringEvent"
ADD CONSTRAINT "MonitoringEvent_executionRunId_fkey"
FOREIGN KEY ("executionRunId") REFERENCES "ExecutionRun"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
