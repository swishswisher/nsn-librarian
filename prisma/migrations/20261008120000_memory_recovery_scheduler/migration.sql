ALTER TABLE "ObservationSession" ADD COLUMN "memoryRecoveryFailureCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ObservationSession" ADD COLUMN "memoryRecoveryFailureGeneration" TEXT;
ALTER TABLE "ObservationSession" ADD COLUMN "memoryRecoveryNextAttemptAt" TIMESTAMP(3);
CREATE INDEX "ObservationSession_memoryRecoveryNextAttemptAt_updatedAt_id_idx"
ON "ObservationSession"("memoryRecoveryNextAttemptAt", "updatedAt", id);

CREATE TABLE "MemoryRecoveryState" (
  id TEXT NOT NULL,
  "runGeneration" TEXT NOT NULL,
  "lastStartedAt" TIMESTAMP(3) NOT NULL,
  "lastFinishedAt" TIMESTAMP(3),
  "lastSuccessfulRunAt" TIMESTAMP(3),
  "lastRunStatus" TEXT NOT NULL,
  CONSTRAINT "MemoryRecoveryState_pkey" PRIMARY KEY (id)
);
