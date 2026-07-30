-- CreateEnum
CREATE TYPE "AudioTranscriptionStatus" AS ENUM ('NOT_REQUESTED', 'TRANSCRIBING', 'COMPLETED', 'UNAVAILABLE', 'FAILED');

-- CreateEnum
CREATE TYPE "AudioPrivacyState" AS ENUM ('PRIVATE', 'INTERNAL', 'REVIEW_REQUIRED', 'WEBSITE_CANDIDATE', 'APPROVED_FOR_PUBLIC_USE');

-- AlterTable
ALTER TABLE "ScannedFile" ADD COLUMN     "sourceCreatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AudioRecordingMetadata" (
    "id" TEXT NOT NULL,
    "scannedFileId" TEXT NOT NULL,
    "durationSeconds" DOUBLE PRECISION,
    "sampleRateHz" INTEGER,
    "bitrateKbps" INTEGER,
    "channels" INTEGER,
    "codec" TEXT,
    "container" TEXT,
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceModifiedAt" TIMESTAMP(3),
    "transcriptSnippet" TEXT,
    "summary" TEXT,
    "transcriptionConfidence" DOUBLE PRECISION,
    "transcriptionStatus" "AudioTranscriptionStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "transcriptionErrorCategory" TEXT,
    "privacyState" "AudioPrivacyState" NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "humanLabels" JSONB NOT NULL,
    "machineLabels" JSONB NOT NULL,
    "provisionalTopics" JSONB NOT NULL,
    "provisionalPeople" JSONB NOT NULL,
    "provisionalProjects" JSONB NOT NULL,
    "provisionalActionItems" JSONB NOT NULL,
    "provisionalQuestions" JSONB NOT NULL,
    "duplicateKind" TEXT,
    "duplicateOfScannedFileId" TEXT,
    "duplicateConfidence" DOUBLE PRECISION,
    "audioFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioRecordingMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AudioRecordingMetadata_scannedFileId_key" ON "AudioRecordingMetadata"("scannedFileId");

-- CreateIndex
CREATE INDEX "AudioRecordingMetadata_privacyState_idx" ON "AudioRecordingMetadata"("privacyState");

-- CreateIndex
CREATE INDEX "AudioRecordingMetadata_transcriptionStatus_idx" ON "AudioRecordingMetadata"("transcriptionStatus");

-- CreateIndex
CREATE INDEX "AudioRecordingMetadata_duplicateKind_idx" ON "AudioRecordingMetadata"("duplicateKind");

-- CreateIndex
CREATE INDEX "AudioRecordingMetadata_audioFingerprint_idx" ON "AudioRecordingMetadata"("audioFingerprint");

-- CreateIndex
CREATE INDEX "AudioRecordingMetadata_sourceModifiedAt_idx" ON "AudioRecordingMetadata"("sourceModifiedAt");

-- AddForeignKey
ALTER TABLE "AudioRecordingMetadata" ADD CONSTRAINT "AudioRecordingMetadata_scannedFileId_fkey" FOREIGN KEY ("scannedFileId") REFERENCES "ScannedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
