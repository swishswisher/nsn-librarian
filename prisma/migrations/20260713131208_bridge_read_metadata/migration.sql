-- CreateEnum
CREATE TYPE "BridgeFileReadingStatus" AS ENUM ('NOT_READ', 'READ', 'FAILED', 'UNSUPPORTED');

-- AlterTable
ALTER TABLE "ScannedFile" ADD COLUMN     "characterCount" INTEGER,
ADD COLUMN     "extractedAt" TIMESTAMP(3),
ADD COLUMN     "extractionErrorCategory" TEXT,
ADD COLUMN     "extractionStatus" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "libraryDocumentId" TEXT,
ADD COLUMN     "previewText" TEXT,
ADD COLUMN     "readingStatus" "BridgeFileReadingStatus" NOT NULL DEFAULT 'NOT_READ';

-- CreateIndex
CREATE INDEX "ScannedFile_readingStatus_idx" ON "ScannedFile"("readingStatus");

-- CreateIndex
CREATE INDEX "ScannedFile_extractionStatus_idx" ON "ScannedFile"("extractionStatus");

-- CreateIndex
CREATE INDEX "ScannedFile_libraryDocumentId_idx" ON "ScannedFile"("libraryDocumentId");

-- AddForeignKey
ALTER TABLE "ScannedFile" ADD CONSTRAINT "ScannedFile_libraryDocumentId_fkey" FOREIGN KEY ("libraryDocumentId") REFERENCES "LibraryDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
