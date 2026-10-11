CREATE TABLE "LibraryAnswerUsage" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL,
  "model" TEXT,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "httpAttempts" INTEGER NOT NULL DEFAULT 0,
  "sourceCount" INTEGER NOT NULL,
  "processingVersion" TEXT NOT NULL,
  "errorCategory" TEXT,
  CONSTRAINT "LibraryAnswerUsage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LibraryAnswerUsage_createdAt_idx" ON "LibraryAnswerUsage"("createdAt");
CREATE INDEX "LibraryAnswerUsage_status_idx" ON "LibraryAnswerUsage"("status");
