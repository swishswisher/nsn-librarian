-- Add milestone 11A execution-run fields while preserving the earlier
-- successfulActions/errorCategory columns for compatibility with existing data.
ALTER TABLE "ExecutionRun"
ADD COLUMN "completedActions" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "durationMs" INTEGER,
ADD COLUMN "safeErrorCategory" TEXT;

UPDATE "ExecutionRun"
SET
  "completedActions" = "successfulActions",
  "safeErrorCategory" = "errorCategory"
WHERE
  "completedActions" = 0
  AND (
    "successfulActions" > 0
    OR "errorCategory" IS NOT NULL
  );
