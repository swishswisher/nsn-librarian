-- Bound command lookup must stay indexed across large scan/read histories.
CREATE INDEX "BridgeCommand_read_file_owner_idx" ON "BridgeCommand"
("bridgeDeviceId", "connectedLibraryId", (payload->>'scanSessionId'), (payload->>'scannedFileId'), "commandId")
WHERE "commandType" = 'READ_FILE_TEMPORARILY';

-- Migration 37 omitted queued reads that had not acquired an observation lease.
-- Admit invalidation only when a bound legacy read proves the incomplete work;
-- any active captured command protects modern queued ownership, even a partial
-- capture which must remain fail closed rather than be guessed or overwritten.
UPDATE "ScannedFile" file SET "legacyObservationRecoveryPending" = true
FROM "ScanSession" scan JOIN "ConnectedFolder" root ON root.id = scan."connectedFolderId"
WHERE scan.id = file."sessionId" AND scan.status IN ('READING', 'EXAMINING')
  AND file."processingStage" = 'READING' AND file."readingStatus" = 'NOT_READ'
  AND file."observationClaimedAt" IS NULL
  AND file."observationRootRevision" IS NULL AND file."observationDeviceKeyFingerprint" IS NULL
  AND EXISTS (SELECT 1 FROM "BridgeCommand" legacy
    WHERE legacy."commandType" = 'READ_FILE_TEMPORARILY'
      AND legacy."bridgeDeviceId" = root."bridgeDeviceId" AND legacy."connectedLibraryId" = root.id
      AND legacy."bridgeRootId" = root."bridgeRootId"
      AND legacy.payload->>'scanSessionId' = scan.id AND legacy.payload->>'scannedFileId' = file.id
      AND legacy."authorizationContext"->>'rootConnectionRevision' IS NULL
      AND legacy."authorizationContext"->>'deviceKeyFingerprint' IS NULL)
  AND NOT EXISTS (SELECT 1 FROM "BridgeCommand" modern
    WHERE modern."commandType" = 'READ_FILE_TEMPORARILY' AND modern.status IN ('PENDING', 'ACKNOWLEDGED', 'RUNNING')
      AND modern."bridgeDeviceId" = root."bridgeDeviceId" AND modern."connectedLibraryId" = root.id
      AND modern.payload->>'scanSessionId' = scan.id AND modern.payload->>'scannedFileId' = file.id
      AND (modern."authorizationContext"->>'rootConnectionRevision' IS NOT NULL
        OR modern."authorizationContext"->>'deviceKeyFingerprint' IS NOT NULL));
