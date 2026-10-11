ALTER TABLE "ObservationSession" ADD COLUMN "memoryReconciliationStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED';
CREATE INDEX "ObservationSession_memoryReconciliationStatus_idx" ON "ObservationSession"("memoryReconciliationStatus");
ALTER TABLE "ConnectedFolder" ADD COLUMN "nativeConnectionRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ConnectedFolder" ADD COLUMN "nativeRootUpdatedAt" TIMESTAMP(3);
ALTER TABLE "ScanSession" ADD COLUMN "importInventoryHash" TEXT;
ALTER TABLE "ScanSession" ADD COLUMN "recommendationGeneration" TEXT;
ALTER TABLE "ScanSession" ADD COLUMN "recommendationLeaseUntil" TIMESTAMP(3);
CREATE INDEX "ScanSession_status_recommendationLeaseUntil_idx" ON "ScanSession"(status, "recommendationLeaseUntil");
CREATE INDEX "ScannedFile_sessionId_relativePath_id_idx" ON "ScannedFile"("sessionId", "relativePath", id);
CREATE INDEX "ScannedFile_pending_local_processing_idx" ON "ScannedFile"("sessionId", "relativePath", id)
WHERE "readStatus" = 'SUPPORTED' AND "sourceUnavailableAt" IS NULL
  AND "processingStage" NOT IN ('EXAMINED', 'SUGGESTIONS_GENERATED', 'RECOMMENDATIONS_READY', 'UNSUPPORTED', 'FAILED');
CREATE INDEX "MemoryEntry_evidence_idx" ON "MemoryEntry" USING GIN ("evidence");
CREATE INDEX "ObservationSession_libraryDocumentId_createdAt_id_idx" ON "ObservationSession"("libraryDocumentId", "createdAt", id);
CREATE INDEX "HumanDecision_observationSessionId_createdAt_id_idx" ON "HumanDecision"("observationSessionId", "createdAt", id);

-- Repair materialized authority from its retained latest non-NOTE event and
-- durably admit legacy reviews whose post-commit Memory build was interrupted.
UPDATE "ObservationSession" observation
SET status = CASE authority."decisionType" WHEN 'ACCEPT' THEN 'APPROVED'::"ObservationSessionStatus"
  WHEN 'MODIFY' THEN 'MODIFIED'::"ObservationSessionStatus" ELSE 'REJECTED'::"ObservationSessionStatus" END,
  "memoryReconciliationStatus" = 'PENDING@' || authority.id
FROM (SELECT DISTINCT ON ("observationSessionId") id, "observationSessionId", "decisionType"
  FROM "HumanDecision" WHERE "decisionType" IN ('ACCEPT', 'MODIFY', 'REJECT')
  ORDER BY "observationSessionId", "createdAt" DESC, id DESC) authority
WHERE observation.id = authority."observationSessionId";

-- A retained reviewed owner is not proof that its old derived wording already
-- reflects that review. Ordinary recovery re-establishes complete provenance.
UPDATE "MemoryEntry" SET "searchProvenanceComplete" = false
WHERE "searchProvenanceComplete" = true AND "searchSourceCount" > 0;
ALTER TABLE "ScanSession" ADD COLUMN "recommendationRegenerationGeneration" TEXT;
ALTER TABLE "ExecutionAction" ADD COLUMN "sourceScannedFileId" TEXT;
ALTER TABLE "ScannedFile" ADD COLUMN "observationRootRevision" INTEGER, ADD COLUMN "observationDeviceKeyFingerprint" TEXT;
ALTER TABLE "MonitoringBatch" ADD COLUMN "processingGeneration" TEXT, ADD COLUMN "processingLeaseUntil" TIMESTAMP(3), ADD COLUMN "rootConnectionRevision" INTEGER;
CREATE INDEX "MonitoringBatch_status_processingLeaseUntil_id_idx" ON "MonitoringBatch"("status", "processingLeaseUntil", "id");

-- Local physical effects have fsynced action journals; database run rows own
-- their authorized connection generation and fair ordinary-history recovery.
ALTER TABLE "ExecutionRun" ADD COLUMN "physicalRootRevision" INTEGER, ADD COLUMN "physicalRecoveryAttemptedAt" TIMESTAMP(3);
ALTER TABLE "UndoRun" ADD COLUMN "physicalRootRevision" INTEGER, ADD COLUMN "physicalRecoveryAttemptedAt" TIMESTAMP(3);

ALTER TABLE "ExecutionRun" ADD COLUMN "reconciliationGeneration" TEXT, ADD COLUMN "reconciliationScanSessionId" TEXT;
ALTER TABLE "ExecutionRun" ADD COLUMN "reconciliationRootRevision" INTEGER;

ALTER TABLE "ConnectedFolder" ADD COLUMN "physicalInventoryGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ScanSession" ADD COLUMN "inventoryGeneration" INTEGER NOT NULL DEFAULT 0;
