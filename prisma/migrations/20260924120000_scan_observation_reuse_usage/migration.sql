ALTER TABLE "ScannedFile"
  ADD COLUMN "observationFingerprint" TEXT,
  ADD COLUMN "observationVersion" TEXT,
  ADD COLUMN "observationOrigin" TEXT,
  ADD COLUMN "observationClaimedAt" TIMESTAMP(3),
  ADD COLUMN "aiRequestCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "aiHttpAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "aiInputTokens" INTEGER,
  ADD COLUMN "aiOutputTokens" INTEGER,
  ADD COLUMN "aiModel" TEXT;

CREATE INDEX "ScannedFile_observationFingerprint_idx" ON "ScannedFile"("observationFingerprint");
