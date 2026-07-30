-- CreateEnum
CREATE TYPE "ObservationSessionStatus" AS ENUM ('NEW', 'AWAITING_REVIEW', 'IN_REVIEW', 'APPROVED', 'MODIFIED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "HumanDecisionType" AS ENUM ('ACCEPT', 'MODIFY', 'REJECT', 'NOTE');

-- CreateTable
CREATE TABLE "ObservationSession" (
    "id" TEXT NOT NULL,
    "libraryDocumentId" TEXT NOT NULL,
    "observerType" TEXT NOT NULL,
    "status" "ObservationSessionStatus" NOT NULL DEFAULT 'AWAITING_REVIEW',
    "observations" JSONB NOT NULL,
    "interpretations" JSONB NOT NULL,
    "explanation" JSONB NOT NULL,
    "planSuggestions" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "warnings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObservationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanDecision" (
    "id" TEXT NOT NULL,
    "observationSessionId" TEXT NOT NULL,
    "decisionType" "HumanDecisionType" NOT NULL,
    "note" TEXT,
    "editedSuggestion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HumanDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ObservationSession_libraryDocumentId_idx" ON "ObservationSession"("libraryDocumentId");

-- CreateIndex
CREATE INDEX "ObservationSession_status_idx" ON "ObservationSession"("status");

-- CreateIndex
CREATE INDEX "ObservationSession_createdAt_idx" ON "ObservationSession"("createdAt");

-- CreateIndex
CREATE INDEX "HumanDecision_observationSessionId_idx" ON "HumanDecision"("observationSessionId");

-- CreateIndex
CREATE INDEX "HumanDecision_decisionType_idx" ON "HumanDecision"("decisionType");

-- CreateIndex
CREATE INDEX "HumanDecision_createdAt_idx" ON "HumanDecision"("createdAt");

-- AddForeignKey
ALTER TABLE "ObservationSession" ADD CONSTRAINT "ObservationSession_libraryDocumentId_fkey" FOREIGN KEY ("libraryDocumentId") REFERENCES "LibraryDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanDecision" ADD CONSTRAINT "HumanDecision_observationSessionId_fkey" FOREIGN KEY ("observationSessionId") REFERENCES "ObservationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
