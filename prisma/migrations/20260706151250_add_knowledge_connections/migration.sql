-- CreateEnum
CREATE TYPE "KnowledgeConnectionStatus" AS ENUM ('NEW', 'CONFIRMED', 'REJECTED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "KnowledgeConnection" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceObservationSessionId" TEXT NOT NULL,
    "targetObservationSessionId" TEXT NOT NULL,
    "similarityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sharedTerms" JSONB NOT NULL,
    "reasoning" TEXT NOT NULL,
    "status" "KnowledgeConnectionStatus" NOT NULL DEFAULT 'NEW',

    CONSTRAINT "KnowledgeConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeConnection_sourceObservationSessionId_idx" ON "KnowledgeConnection"("sourceObservationSessionId");

-- CreateIndex
CREATE INDEX "KnowledgeConnection_targetObservationSessionId_idx" ON "KnowledgeConnection"("targetObservationSessionId");

-- CreateIndex
CREATE INDEX "KnowledgeConnection_status_idx" ON "KnowledgeConnection"("status");

-- CreateIndex
CREATE INDEX "KnowledgeConnection_createdAt_idx" ON "KnowledgeConnection"("createdAt");

-- AddForeignKey
ALTER TABLE "KnowledgeConnection" ADD CONSTRAINT "KnowledgeConnection_sourceObservationSessionId_fkey" FOREIGN KEY ("sourceObservationSessionId") REFERENCES "ObservationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeConnection" ADD CONSTRAINT "KnowledgeConnection_targetObservationSessionId_fkey" FOREIGN KEY ("targetObservationSessionId") REFERENCES "ObservationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
