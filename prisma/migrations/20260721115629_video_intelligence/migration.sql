-- CreateEnum
CREATE TYPE "VideoProcessingStatus" AS ENUM ('NOT_REQUESTED', 'PROCESSING', 'COMPLETED', 'UNAVAILABLE', 'FAILED');

-- CreateEnum
CREATE TYPE "VideoPrivacyState" AS ENUM ('PRIVATE', 'INTERNAL', 'REVIEW_REQUIRED', 'WEBSITE_CANDIDATE', 'APPROVED_FOR_PUBLIC_USE');

-- CreateTable
CREATE TABLE "VideoRecordingMetadata" (
    "id" TEXT NOT NULL,
    "scannedFileId" TEXT NOT NULL,
    "durationSeconds" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "frameRate" DOUBLE PRECISION,
    "codec" TEXT,
    "container" TEXT,
    "bitrateKbps" INTEGER,
    "hasAudioTrack" BOOLEAN,
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceModifiedAt" TIMESTAMP(3),
    "transcriptSnippet" TEXT,
    "summary" TEXT,
    "transcriptionConfidence" DOUBLE PRECISION,
    "transcriptionStatus" "VideoProcessingStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "transcriptionErrorCategory" TEXT,
    "frameAnalysisStatus" "VideoProcessingStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "frameAnalysisErrorCategory" TEXT,
    "privacyState" "VideoPrivacyState" NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "humanLabels" JSONB NOT NULL,
    "machineLabels" JSONB NOT NULL,
    "provisionalTopics" JSONB NOT NULL,
    "provisionalPeople" JSONB NOT NULL,
    "provisionalProjects" JSONB NOT NULL,
    "provisionalQuestions" JSONB NOT NULL,
    "selectedFrameDescriptions" JSONB NOT NULL,
    "chapterSuggestions" JSONB NOT NULL,
    "relatedSignals" JSONB NOT NULL,
    "duplicateKind" TEXT,
    "duplicateOfScannedFileId" TEXT,
    "duplicateConfidence" DOUBLE PRECISION,
    "videoFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoRecordingMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoRecordingMetadata_scannedFileId_key" ON "VideoRecordingMetadata"("scannedFileId");

-- CreateIndex
CREATE INDEX "VideoRecordingMetadata_privacyState_idx" ON "VideoRecordingMetadata"("privacyState");

-- CreateIndex
CREATE INDEX "VideoRecordingMetadata_transcriptionStatus_idx" ON "VideoRecordingMetadata"("transcriptionStatus");

-- CreateIndex
CREATE INDEX "VideoRecordingMetadata_frameAnalysisStatus_idx" ON "VideoRecordingMetadata"("frameAnalysisStatus");

-- CreateIndex
CREATE INDEX "VideoRecordingMetadata_duplicateKind_idx" ON "VideoRecordingMetadata"("duplicateKind");

-- CreateIndex
CREATE INDEX "VideoRecordingMetadata_videoFingerprint_idx" ON "VideoRecordingMetadata"("videoFingerprint");

-- CreateIndex
CREATE INDEX "VideoRecordingMetadata_sourceModifiedAt_idx" ON "VideoRecordingMetadata"("sourceModifiedAt");

-- AddForeignKey
ALTER TABLE "VideoRecordingMetadata" ADD CONSTRAINT "VideoRecordingMetadata_scannedFileId_fkey" FOREIGN KEY ("scannedFileId") REFERENCES "ScannedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
