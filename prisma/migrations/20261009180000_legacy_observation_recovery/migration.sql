-- Admit only upgrade-time incomplete owners lacking BOTH captured authority
-- fields. Do not manufacture authority, extraction, observations or approval.
-- Current grants and physical generation are checked by bounded Bridge recovery.
ALTER TABLE "ScannedFile" ADD COLUMN "legacyObservationRecoveryPending" BOOLEAN NOT NULL DEFAULT false;
UPDATE "ScannedFile" file SET "legacyObservationRecoveryPending" = true
FROM "ScanSession" scan
WHERE scan.id = file."sessionId" AND scan.status IN ('READING', 'EXAMINING')
  AND file."observationRootRevision" IS NULL AND file."observationDeviceKeyFingerprint" IS NULL
  AND (file."observationClaimedAt" IS NOT NULL OR file."processingStage" IN ('READ', 'EXAMINING', 'OBSERVING'))
  AND file."processingStage" IN ('READING', 'READ', 'EXAMINING', 'OBSERVING');
CREATE INDEX "ScannedFile_legacyObservationRecoveryPending_sessionId_id_idx"
ON "ScannedFile"("legacyObservationRecoveryPending", "sessionId", id);
-- The stronger legacy current-scan exclusion must use ordered per-root lookup,
-- including roots with deep scan history, rather than pairwise history scans.
CREATE INDEX "ScanSession_connectedFolderId_startedAt_id_idx"
ON "ScanSession"("connectedFolderId", "startedAt", id);
