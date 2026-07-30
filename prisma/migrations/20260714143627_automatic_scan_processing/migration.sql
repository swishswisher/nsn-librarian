-- CreateEnum
CREATE TYPE "ScannedFileProcessingStage" AS ENUM ('DISCOVERED', 'READING', 'READ', 'EXAMINING', 'EXAMINED', 'SUGGESTIONS_GENERATED', 'UNSUPPORTED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BridgeScanSessionStatus" ADD VALUE 'READING';
ALTER TYPE "BridgeScanSessionStatus" ADD VALUE 'EXAMINING';
ALTER TYPE "BridgeScanSessionStatus" ADD VALUE 'GENERATING_SUGGESTIONS';
ALTER TYPE "BridgeScanSessionStatus" ADD VALUE 'COMPLETED_WITH_ERRORS';

-- AlterTable
ALTER TABLE "ScannedFile" ADD COLUMN     "processedAt" TIMESTAMP(3),
ADD COLUMN     "processingErrorCategory" TEXT,
ADD COLUMN     "processingStage" "ScannedFileProcessingStage" NOT NULL DEFAULT 'DISCOVERED';

-- CreateIndex
CREATE INDEX "ScannedFile_processingStage_idx" ON "ScannedFile"("processingStage");
