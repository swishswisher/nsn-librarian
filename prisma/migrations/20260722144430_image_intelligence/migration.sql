-- CreateEnum
CREATE TYPE "ImageProcessingStatus" AS ENUM ('NOT_REQUESTED', 'PROCESSING', 'COMPLETED', 'UNAVAILABLE', 'FAILED');

-- CreateEnum
CREATE TYPE "ImagePrivacyState" AS ENUM ('PRIVATE', 'INTERNAL', 'REVIEW_REQUIRED', 'WEBSITE_CANDIDATE', 'APPROVED_FOR_PUBLIC_USE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ScannedFileProcessingStage" ADD VALUE 'READING_IMAGE_METADATA';
ALTER TYPE "ScannedFileProcessingStage" ADD VALUE 'METADATA_READY';
ALTER TYPE "ScannedFileProcessingStage" ADD VALUE 'PREPARING_PREVIEW';
ALTER TYPE "ScannedFileProcessingStage" ADD VALUE 'ANALYZING_IMAGE';
ALTER TYPE "ScannedFileProcessingStage" ADD VALUE 'OCR_PROCESSING';
ALTER TYPE "ScannedFileProcessingStage" ADD VALUE 'OBSERVING';
ALTER TYPE "ScannedFileProcessingStage" ADD VALUE 'RECOMMENDATIONS_READY';

-- CreateTable
CREATE TABLE "ImageAssetMetadata" (
    "id" TEXT NOT NULL,
    "scannedFileId" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "format" TEXT,
    "orientation" TEXT,
    "colorProfile" TEXT,
    "embeddedDate" TIMESTAMP(3),
    "cameraDevice" TEXT,
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceModifiedAt" TIMESTAMP(3),
    "previewStatus" "ImageProcessingStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "previewErrorCategory" TEXT,
    "visualAnalysisStatus" "ImageProcessingStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "visualAnalysisErrorCategory" TEXT,
    "ocrStatus" "ImageProcessingStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "ocrErrorCategory" TEXT,
    "privacyState" "ImagePrivacyState" NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "humanLabels" JSONB NOT NULL,
    "machineLabels" JSONB NOT NULL,
    "provisionalTopics" JSONB NOT NULL,
    "provisionalQuestions" JSONB NOT NULL,
    "relatedSignals" JSONB NOT NULL,
    "summary" TEXT,
    "textSnippet" TEXT,
    "duplicateKind" TEXT,
    "duplicateOfScannedFileId" TEXT,
    "duplicateConfidence" DOUBLE PRECISION,
    "imageFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageAssetMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImageAssetMetadata_scannedFileId_key" ON "ImageAssetMetadata"("scannedFileId");

-- CreateIndex
CREATE INDEX "ImageAssetMetadata_privacyState_idx" ON "ImageAssetMetadata"("privacyState");

-- CreateIndex
CREATE INDEX "ImageAssetMetadata_previewStatus_idx" ON "ImageAssetMetadata"("previewStatus");

-- CreateIndex
CREATE INDEX "ImageAssetMetadata_visualAnalysisStatus_idx" ON "ImageAssetMetadata"("visualAnalysisStatus");

-- CreateIndex
CREATE INDEX "ImageAssetMetadata_ocrStatus_idx" ON "ImageAssetMetadata"("ocrStatus");

-- CreateIndex
CREATE INDEX "ImageAssetMetadata_duplicateKind_idx" ON "ImageAssetMetadata"("duplicateKind");

-- CreateIndex
CREATE INDEX "ImageAssetMetadata_imageFingerprint_idx" ON "ImageAssetMetadata"("imageFingerprint");

-- CreateIndex
CREATE INDEX "ImageAssetMetadata_sourceModifiedAt_idx" ON "ImageAssetMetadata"("sourceModifiedAt");

-- AddForeignKey
ALTER TABLE "ImageAssetMetadata" ADD CONSTRAINT "ImageAssetMetadata_scannedFileId_fkey" FOREIGN KEY ("scannedFileId") REFERENCES "ScannedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
