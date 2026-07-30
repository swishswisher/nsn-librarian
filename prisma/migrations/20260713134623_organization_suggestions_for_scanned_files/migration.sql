-- CreateEnum
CREATE TYPE "OrganizationSuggestionType" AS ENUM ('MOVE_FILE', 'RENAME_FILE', 'CREATE_FOLDER', 'GROUP_WITH_FILES', 'POSSIBLE_DUPLICATE', 'WEBSITE_CANDIDATE', 'KEEP_UNCHANGED');

-- CreateEnum
CREATE TYPE "OrganizationSuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'MODIFIED', 'REJECTED', 'LEFT_UNCHANGED');

-- CreateTable
CREATE TABLE "OrganizationSuggestion" (
    "id" TEXT NOT NULL,
    "scannedFileId" TEXT NOT NULL,
    "scanSessionId" TEXT NOT NULL,
    "suggestionType" "OrganizationSuggestionType" NOT NULL,
    "currentRelativePath" TEXT NOT NULL,
    "proposedRelativePath" TEXT,
    "proposedFileName" TEXT,
    "title" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "OrganizationSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "whySuggested" JSONB NOT NULL,
    "supportingInformation" JSONB NOT NULL,
    "suggestionKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "OrganizationSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationSuggestionRevision" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "revisedRelativePath" TEXT,
    "revisedFileName" TEXT,
    "context" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationSuggestionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSuggestion_suggestionKey_key" ON "OrganizationSuggestion"("suggestionKey");

-- CreateIndex
CREATE INDEX "OrganizationSuggestion_scannedFileId_idx" ON "OrganizationSuggestion"("scannedFileId");

-- CreateIndex
CREATE INDEX "OrganizationSuggestion_scanSessionId_idx" ON "OrganizationSuggestion"("scanSessionId");

-- CreateIndex
CREATE INDEX "OrganizationSuggestion_suggestionType_idx" ON "OrganizationSuggestion"("suggestionType");

-- CreateIndex
CREATE INDEX "OrganizationSuggestion_status_idx" ON "OrganizationSuggestion"("status");

-- CreateIndex
CREATE INDEX "OrganizationSuggestion_createdAt_idx" ON "OrganizationSuggestion"("createdAt");

-- CreateIndex
CREATE INDEX "OrganizationSuggestionRevision_suggestionId_idx" ON "OrganizationSuggestionRevision"("suggestionId");

-- CreateIndex
CREATE INDEX "OrganizationSuggestionRevision_createdAt_idx" ON "OrganizationSuggestionRevision"("createdAt");

-- AddForeignKey
ALTER TABLE "OrganizationSuggestion" ADD CONSTRAINT "OrganizationSuggestion_scannedFileId_fkey" FOREIGN KEY ("scannedFileId") REFERENCES "ScannedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationSuggestion" ADD CONSTRAINT "OrganizationSuggestion_scanSessionId_fkey" FOREIGN KEY ("scanSessionId") REFERENCES "ScanSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationSuggestionRevision" ADD CONSTRAINT "OrganizationSuggestionRevision_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "OrganizationSuggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
