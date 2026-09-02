ALTER TABLE "OrganizationSuggestion"
  ADD COLUMN IF NOT EXISTS "recommendationGenerationId" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS "recommendationGenerationVersion" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS "invalidatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "invalidatedReason" TEXT;

CREATE INDEX IF NOT EXISTS "OrganizationSuggestion_recommendationGenerationId_idx"
  ON "OrganizationSuggestion"("recommendationGenerationId");

CREATE INDEX IF NOT EXISTS "OrganizationSuggestion_recommendationGenerationVersion_idx"
  ON "OrganizationSuggestion"("recommendationGenerationVersion");

CREATE INDEX IF NOT EXISTS "OrganizationSuggestion_invalidatedAt_idx"
  ON "OrganizationSuggestion"("invalidatedAt");
