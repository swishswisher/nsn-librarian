ALTER TABLE "ScanSession" ADD COLUMN "searchIndexStatus" TEXT NOT NULL DEFAULT 'NOT_ATTEMPTED';
ALTER TABLE "MemoryEntry" ADD COLUMN "searchProvenanceComplete" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MemoryEntry" ADD COLUMN "searchSourceCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MemoryEntry" ADD COLUMN "searchProvenanceCheckedAt" TIMESTAMP(3);

CREATE TABLE "MemorySearchSource" (
  "id" TEXT NOT NULL,
  "memoryEntryId" TEXT NOT NULL,
  "observationSessionId" TEXT NOT NULL,
  "connectedLibraryId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemorySearchSource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MemorySearchSource_memoryEntryId_observationSessionId_connectedLibraryId_key"
  ON "MemorySearchSource"("memoryEntryId", "observationSessionId", "connectedLibraryId");
CREATE INDEX "MemorySearchSource_connectedLibraryId_memoryEntryId_idx"
  ON "MemorySearchSource"("connectedLibraryId", "memoryEntryId");
ALTER TABLE "MemorySearchSource" ADD CONSTRAINT "MemorySearchSource_memoryEntryId_fkey"
  FOREIGN KEY ("memoryEntryId") REFERENCES "MemoryEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemorySearchSource" ADD CONSTRAINT "MemorySearchSource_observationSessionId_fkey"
  FOREIGN KEY ("observationSessionId") REFERENCES "ObservationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemorySearchSource" ADD CONSTRAINT "MemorySearchSource_connectedLibraryId_fkey"
  FOREIGN KEY ("connectedLibraryId") REFERENCES "ConnectedFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LibrarySearchBackfillFile" (
  "id" TEXT NOT NULL,
  "scanSessionId" TEXT NOT NULL,
  "scannedFileId" TEXT NOT NULL,
  "indexVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LibrarySearchBackfillFile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LibrarySearchBackfillFile_scanSessionId_scannedFileId_indexVersion_key"
  ON "LibrarySearchBackfillFile"("scanSessionId", "scannedFileId", "indexVersion");
CREATE INDEX "LibrarySearchBackfillFile_scanSessionId_indexVersion_status_idx"
  ON "LibrarySearchBackfillFile"("scanSessionId", "indexVersion", "status");
ALTER TABLE "LibrarySearchBackfillFile" ADD CONSTRAINT "LibrarySearchBackfillFile_scanSessionId_fkey"
  FOREIGN KEY ("scanSessionId") REFERENCES "ScanSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LibrarySearchBackfillFile" ADD CONSTRAINT "LibrarySearchBackfillFile_scannedFileId_fkey"
  FOREIGN KEY ("scannedFileId") REFERENCES "ScannedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LibrarySearchEntry" (
  "id" TEXT NOT NULL,
  "entryKey" TEXT NOT NULL,
  "fileKey" TEXT NOT NULL,
  "connectedLibraryId" TEXT NOT NULL,
  "scannedFileId" TEXT NOT NULL,
  "scanSessionId" TEXT NOT NULL,
  "relativePath" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "fileType" TEXT NOT NULL,
  "indexVersion" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "isCurrent" BOOLEAN NOT NULL DEFAULT true,
  "knowledgeState" TEXT NOT NULL,
  "sourceExcerpts" JSONB NOT NULL,
  "sourceTerms" TEXT[] NOT NULL,
  "reviewedTerms" TEXT[] NOT NULL,
  "concepts" TEXT[] NOT NULL,
  "entityHashes" TEXT[] NOT NULL,
  "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LibrarySearchEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LibrarySearchEntry_entryKey_key" ON "LibrarySearchEntry"("entryKey");
CREATE INDEX "LibrarySearchEntry_connectedLibraryId_isCurrent_scanSessionId_idx" ON "LibrarySearchEntry"("connectedLibraryId", "isCurrent", "scanSessionId");
CREATE INDEX "LibrarySearchEntry_fileKey_isCurrent_idx" ON "LibrarySearchEntry"("fileKey", "isCurrent");
CREATE INDEX "LibrarySearchEntry_connectedLibraryId_fileName_idx" ON "LibrarySearchEntry"("connectedLibraryId", "fileName");
CREATE INDEX "LibrarySearchEntry_sourceTerms_gin_idx" ON "LibrarySearchEntry" USING GIN ("sourceTerms");
CREATE INDEX "LibrarySearchEntry_reviewedTerms_gin_idx" ON "LibrarySearchEntry" USING GIN ("reviewedTerms");
CREATE INDEX "LibrarySearchEntry_concepts_gin_idx" ON "LibrarySearchEntry" USING GIN ("concepts");
CREATE INDEX "LibrarySearchEntry_entityHashes_gin_idx" ON "LibrarySearchEntry" USING GIN ("entityHashes");
ALTER TABLE "LibrarySearchEntry" ADD CONSTRAINT "LibrarySearchEntry_connectedLibraryId_fkey"
  FOREIGN KEY ("connectedLibraryId") REFERENCES "ConnectedFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LibrarySearchEntry" ADD CONSTRAINT "LibrarySearchEntry_scannedFileId_fkey"
  FOREIGN KEY ("scannedFileId") REFERENCES "ScannedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
