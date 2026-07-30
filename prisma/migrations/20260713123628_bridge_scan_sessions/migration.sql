-- CreateEnum
CREATE TYPE "BridgeScanSessionStatus" AS ENUM ('PENDING', 'SCANNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ScannedFileReadStatus" AS ENUM ('PENDING', 'SUPPORTED', 'UNSUPPORTED', 'FAILED');

-- CreateTable
CREATE TABLE "ConnectedFolder" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastScanAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanSession" (
    "id" TEXT NOT NULL,
    "connectedFolderId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" "BridgeScanSessionStatus" NOT NULL DEFAULT 'PENDING',
    "filesScanned" INTEGER NOT NULL DEFAULT 0,
    "supportedFiles" INTEGER NOT NULL DEFAULT 0,
    "unsupportedFiles" INTEGER NOT NULL DEFAULT 0,
    "failedFiles" INTEGER NOT NULL DEFAULT 0,
    "observationsCreated" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ScanSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScannedFile" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "checksum" TEXT,
    "sizeBytes" BIGINT,
    "lastModified" TIMESTAMP(3),
    "readStatus" "ScannedFileReadStatus" NOT NULL DEFAULT 'PENDING',
    "scanError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScannedFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedFolder_localPath_key" ON "ConnectedFolder"("localPath");

-- CreateIndex
CREATE INDEX "ConnectedFolder_enabled_idx" ON "ConnectedFolder"("enabled");

-- CreateIndex
CREATE INDEX "ConnectedFolder_lastScanAt_idx" ON "ConnectedFolder"("lastScanAt");

-- CreateIndex
CREATE INDEX "ScanSession_connectedFolderId_idx" ON "ScanSession"("connectedFolderId");

-- CreateIndex
CREATE INDEX "ScanSession_status_idx" ON "ScanSession"("status");

-- CreateIndex
CREATE INDEX "ScanSession_startedAt_idx" ON "ScanSession"("startedAt");

-- CreateIndex
CREATE INDEX "ScannedFile_sessionId_idx" ON "ScannedFile"("sessionId");

-- CreateIndex
CREATE INDEX "ScannedFile_readStatus_idx" ON "ScannedFile"("readStatus");

-- CreateIndex
CREATE INDEX "ScannedFile_fileType_idx" ON "ScannedFile"("fileType");

-- CreateIndex
CREATE INDEX "ScannedFile_checksum_idx" ON "ScannedFile"("checksum");

-- AddForeignKey
ALTER TABLE "ScanSession" ADD CONSTRAINT "ScanSession_connectedFolderId_fkey" FOREIGN KEY ("connectedFolderId") REFERENCES "ConnectedFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScannedFile" ADD CONSTRAINT "ScannedFile_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ScanSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
