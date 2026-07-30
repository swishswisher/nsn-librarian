-- CreateEnum
CREATE TYPE "BridgeMonitoringState" AS ENUM ('NOT_CONNECTED', 'WATCHING', 'PAUSED', 'NEEDS_ATTENTION', 'STOPPED');

-- CreateEnum
CREATE TYPE "BridgeMonitoringEventType" AS ENUM ('FILE_ADDED', 'FILE_MODIFIED', 'FILE_RENAMED', 'FILE_MOVED', 'FILE_DELETED', 'FOLDER_ADDED', 'FOLDER_RENAMED', 'FOLDER_MOVED', 'FOLDER_DELETED');

-- CreateEnum
CREATE TYPE "BridgeMonitoringProcessingStatus" AS ENUM ('QUEUED', 'STABILIZING', 'PROCESSING', 'COMPLETED', 'NEEDS_ATTENTION', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "BridgeMonitoringBatchStatus" AS ENUM ('OPEN', 'PROCESSING', 'READY_FOR_REVIEW', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');

-- AlterTable
ALTER TABLE "ConnectedFolder" ADD COLUMN     "monitoringErrorCategory" TEXT,
ADD COLUMN     "monitoringGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "monitoringHeartbeatAt" TIMESTAMP(3),
ADD COLUMN     "monitoringLastCheckAt" TIMESTAMP(3),
ADD COLUMN     "monitoringLastSuccessfulCheckAt" TIMESTAMP(3),
ADD COLUMN     "monitoringPausedAt" TIMESTAMP(3),
ADD COLUMN     "monitoringReconciliationRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "monitoringStartedAt" TIMESTAMP(3),
ADD COLUMN     "monitoringState" "BridgeMonitoringState" NOT NULL DEFAULT 'STOPPED',
ADD COLUMN     "monitoringStoppedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ScannedFile" ADD COLUMN     "sourceUnavailableAt" TIMESTAMP(3),
ADD COLUMN     "sourceUnavailableReason" TEXT;

-- CreateTable
CREATE TABLE "MonitoringBatch" (
    "id" TEXT NOT NULL,
    "connectedFolderId" TEXT NOT NULL,
    "scanSessionId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" "BridgeMonitoringBatchStatus" NOT NULL DEFAULT 'OPEN',
    "totalEvents" INTEGER NOT NULL DEFAULT 0,
    "fileEvents" INTEGER NOT NULL DEFAULT 0,
    "folderEvents" INTEGER NOT NULL DEFAULT 0,
    "supportedFileEvents" INTEGER NOT NULL DEFAULT 0,
    "unsupportedFileEvents" INTEGER NOT NULL DEFAULT 0,
    "failedEvents" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB NOT NULL,
    "notificationTitle" TEXT,
    "notificationSummary" TEXT,
    "notebookEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitoringBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringEvent" (
    "id" TEXT NOT NULL,
    "connectedFolderId" TEXT NOT NULL,
    "scanSessionId" TEXT,
    "batchId" TEXT,
    "eventType" "BridgeMonitoringEventType" NOT NULL,
    "previousRelativePath" TEXT,
    "currentRelativePath" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stabilizedAt" TIMESTAMP(3),
    "checksumBefore" TEXT,
    "checksumAfter" TEXT,
    "sizeBefore" BIGINT,
    "sizeAfter" BIGINT,
    "modifiedAtBefore" TIMESTAMP(3),
    "modifiedAtAfter" TIMESTAMP(3),
    "renameMoveConfidence" DOUBLE PRECISION,
    "processingStatus" "BridgeMonitoringProcessingStatus" NOT NULL DEFAULT 'QUEUED',
    "safeErrorCategory" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "eventKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitoringEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonitoringBatch_connectedFolderId_idx" ON "MonitoringBatch"("connectedFolderId");

-- CreateIndex
CREATE INDEX "MonitoringBatch_scanSessionId_idx" ON "MonitoringBatch"("scanSessionId");

-- CreateIndex
CREATE INDEX "MonitoringBatch_status_idx" ON "MonitoringBatch"("status");

-- CreateIndex
CREATE INDEX "MonitoringBatch_startedAt_idx" ON "MonitoringBatch"("startedAt");

-- CreateIndex
CREATE INDEX "MonitoringBatch_completedAt_idx" ON "MonitoringBatch"("completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MonitoringEvent_eventKey_key" ON "MonitoringEvent"("eventKey");

-- CreateIndex
CREATE INDEX "MonitoringEvent_connectedFolderId_idx" ON "MonitoringEvent"("connectedFolderId");

-- CreateIndex
CREATE INDEX "MonitoringEvent_scanSessionId_idx" ON "MonitoringEvent"("scanSessionId");

-- CreateIndex
CREATE INDEX "MonitoringEvent_batchId_idx" ON "MonitoringEvent"("batchId");

-- CreateIndex
CREATE INDEX "MonitoringEvent_eventType_idx" ON "MonitoringEvent"("eventType");

-- CreateIndex
CREATE INDEX "MonitoringEvent_processingStatus_idx" ON "MonitoringEvent"("processingStatus");

-- CreateIndex
CREATE INDEX "MonitoringEvent_detectedAt_idx" ON "MonitoringEvent"("detectedAt");

-- CreateIndex
CREATE INDEX "ConnectedFolder_monitoringState_idx" ON "ConnectedFolder"("monitoringState");

-- CreateIndex
CREATE INDEX "ConnectedFolder_monitoringHeartbeatAt_idx" ON "ConnectedFolder"("monitoringHeartbeatAt");

-- CreateIndex
CREATE INDEX "ScannedFile_sourceUnavailableAt_idx" ON "ScannedFile"("sourceUnavailableAt");

-- AddForeignKey
ALTER TABLE "MonitoringBatch" ADD CONSTRAINT "MonitoringBatch_connectedFolderId_fkey" FOREIGN KEY ("connectedFolderId") REFERENCES "ConnectedFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringBatch" ADD CONSTRAINT "MonitoringBatch_scanSessionId_fkey" FOREIGN KEY ("scanSessionId") REFERENCES "ScanSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringEvent" ADD CONSTRAINT "MonitoringEvent_connectedFolderId_fkey" FOREIGN KEY ("connectedFolderId") REFERENCES "ConnectedFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringEvent" ADD CONSTRAINT "MonitoringEvent_scanSessionId_fkey" FOREIGN KEY ("scanSessionId") REFERENCES "ScanSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringEvent" ADD CONSTRAINT "MonitoringEvent_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "MonitoringBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
