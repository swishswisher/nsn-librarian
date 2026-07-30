-- Milestone 11B: persisted undo and recovery records.
CREATE TYPE "UndoStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'FAILED',
  'BLOCKED'
);

ALTER TABLE "ExecutionAction"
ADD COLUMN "createdFilesystemItem" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "UndoRun" (
  "id" TEXT NOT NULL,
  "executionRunId" TEXT NOT NULL,
  "status" "UndoStatus" NOT NULL DEFAULT 'PENDING',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "totalActions" INTEGER NOT NULL DEFAULT 0,
  "completedActions" INTEGER NOT NULL DEFAULT 0,
  "failedActions" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER,
  "safeErrorCategory" TEXT,

  CONSTRAINT "UndoRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UndoAction" (
  "id" TEXT NOT NULL,
  "undoRunId" TEXT NOT NULL,
  "originalExecutionActionId" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "sourceRelativePath" TEXT NOT NULL,
  "destinationRelativePath" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "status" "UndoStatus" NOT NULL DEFAULT 'PENDING',
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "safeErrorCategory" TEXT,

  CONSTRAINT "UndoAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UndoRun_executionRunId_idx" ON "UndoRun"("executionRunId");
CREATE INDEX "UndoRun_status_idx" ON "UndoRun"("status");
CREATE INDEX "UndoRun_startedAt_idx" ON "UndoRun"("startedAt");
CREATE INDEX "UndoRun_completedAt_idx" ON "UndoRun"("completedAt");

CREATE INDEX "UndoAction_undoRunId_idx" ON "UndoAction"("undoRunId");
CREATE INDEX "UndoAction_originalExecutionActionId_idx" ON "UndoAction"("originalExecutionActionId");
CREATE INDEX "UndoAction_status_idx" ON "UndoAction"("status");
CREATE INDEX "UndoAction_sequence_idx" ON "UndoAction"("sequence");

ALTER TABLE "UndoRun"
ADD CONSTRAINT "UndoRun_executionRunId_fkey"
FOREIGN KEY ("executionRunId") REFERENCES "ExecutionRun"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UndoAction"
ADD CONSTRAINT "UndoAction_undoRunId_fkey"
FOREIGN KEY ("undoRunId") REFERENCES "UndoRun"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UndoAction"
ADD CONSTRAINT "UndoAction_originalExecutionActionId_fkey"
FOREIGN KEY ("originalExecutionActionId") REFERENCES "ExecutionAction"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
