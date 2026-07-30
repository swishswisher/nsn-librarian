-- CreateEnum
CREATE TYPE "NotebookEntryType" AS ENUM ('REFLECTION', 'SCAN_SUMMARY', 'OBSERVATION', 'HUMAN_REVISION', 'CONTEXT_NOTE', 'RECOMMENDATION_SUMMARY', 'ORGANIZATION_DECISION', 'ORGANIZATION_RESULT', 'UNDO_RESULT', 'MEMORY_LEARNING', 'QUESTION', 'GROWING_THEME', 'LANGUAGE_PREFERENCE', 'EMERGING_PATTERN', 'POSSIBLE_RELATIONSHIP', 'POSSIBLE_DUPLICATE', 'LEARNING_UPDATE');

-- CreateEnum
CREATE TYPE "NotebookEntryStatus" AS ENUM ('CURRENT', 'ARCHIVED', 'ACCEPTED', 'REJECTED', 'NOTEBOOK_ONLY');

-- CreateEnum
CREATE TYPE "NotebookRevisionAction" AS ENUM ('ACCEPT_REFLECTION', 'REVISE_REFLECTION', 'REVISE_WORDING', 'ADD_CONTEXT', 'ANSWER_QUESTION', 'REJECT_REFLECTION', 'APPROVE_FOR_MEMORY', 'KEEP_NOTEBOOK_ONLY', 'ARCHIVE', 'RESTORE');

-- CreateTable
CREATE TABLE "NotebookEntry" (
    "id" TEXT NOT NULL,
    "entryType" "NotebookEntryType" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "NotebookEntryStatus" NOT NULL DEFAULT 'CURRENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "scanSessionId" TEXT,
    "scannedFileId" TEXT,
    "observationSessionId" TEXT,
    "recommendationId" TEXT,
    "organizationPlanId" TEXT,
    "executionRunId" TEXT,
    "undoRunId" TEXT,
    "memoryItemId" TEXT,
    "requiresAttention" BOOLEAN NOT NULL DEFAULT false,
    "approvedForMemory" BOOLEAN NOT NULL DEFAULT false,
    "provenanceSummary" TEXT NOT NULL,
    "history" JSONB NOT NULL,
    "relatedEntryKeys" JSONB NOT NULL,

    CONSTRAINT "NotebookEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotebookEntryRevision" (
    "id" TEXT NOT NULL,
    "notebookEntryId" TEXT NOT NULL,
    "actionType" "NotebookRevisionAction" NOT NULL,
    "revisedTitle" TEXT,
    "revisedSummary" TEXT,
    "revisedBody" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotebookEntryRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotebookEntry_sourceKey_key" ON "NotebookEntry"("sourceKey");

-- CreateIndex
CREATE INDEX "NotebookEntry_entryType_idx" ON "NotebookEntry"("entryType");

-- CreateIndex
CREATE INDEX "NotebookEntry_status_idx" ON "NotebookEntry"("status");

-- CreateIndex
CREATE INDEX "NotebookEntry_sourceType_idx" ON "NotebookEntry"("sourceType");

-- CreateIndex
CREATE INDEX "NotebookEntry_sourceId_idx" ON "NotebookEntry"("sourceId");

-- CreateIndex
CREATE INDEX "NotebookEntry_scanSessionId_idx" ON "NotebookEntry"("scanSessionId");

-- CreateIndex
CREATE INDEX "NotebookEntry_observationSessionId_idx" ON "NotebookEntry"("observationSessionId");

-- CreateIndex
CREATE INDEX "NotebookEntry_recommendationId_idx" ON "NotebookEntry"("recommendationId");

-- CreateIndex
CREATE INDEX "NotebookEntry_organizationPlanId_idx" ON "NotebookEntry"("organizationPlanId");

-- CreateIndex
CREATE INDEX "NotebookEntry_executionRunId_idx" ON "NotebookEntry"("executionRunId");

-- CreateIndex
CREATE INDEX "NotebookEntry_undoRunId_idx" ON "NotebookEntry"("undoRunId");

-- CreateIndex
CREATE INDEX "NotebookEntry_memoryItemId_idx" ON "NotebookEntry"("memoryItemId");

-- CreateIndex
CREATE INDEX "NotebookEntry_requiresAttention_idx" ON "NotebookEntry"("requiresAttention");

-- CreateIndex
CREATE INDEX "NotebookEntry_createdAt_idx" ON "NotebookEntry"("createdAt");

-- CreateIndex
CREATE INDEX "NotebookEntry_updatedAt_idx" ON "NotebookEntry"("updatedAt");

-- CreateIndex
CREATE INDEX "NotebookEntryRevision_notebookEntryId_idx" ON "NotebookEntryRevision"("notebookEntryId");

-- CreateIndex
CREATE INDEX "NotebookEntryRevision_actionType_idx" ON "NotebookEntryRevision"("actionType");

-- CreateIndex
CREATE INDEX "NotebookEntryRevision_createdAt_idx" ON "NotebookEntryRevision"("createdAt");

-- AddForeignKey
ALTER TABLE "NotebookEntryRevision" ADD CONSTRAINT "NotebookEntryRevision_notebookEntryId_fkey" FOREIGN KEY ("notebookEntryId") REFERENCES "NotebookEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
