ALTER TYPE "ConnectedLibraryStatus" ADD VALUE IF NOT EXISTS 'MERGED';
ALTER TYPE "ConnectedLibraryStatus" ADD VALUE IF NOT EXISTS 'HIDDEN_FROM_ACTIVE_LIST';

ALTER TABLE "ConnectedFolder"
  ADD COLUMN "folderFingerprint" TEXT,
  ADD COLUMN "canonicalConnectedLibraryId" TEXT,
  ADD COLUMN "disconnectedAt" TIMESTAMP(3),
  ADD COLUMN "hiddenFromActiveListAt" TIMESTAMP(3),
  ADD COLUMN "mergedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "ConnectedFolder_folderFingerprint_key" ON "ConnectedFolder"("folderFingerprint");
CREATE INDEX "ConnectedFolder_canonicalConnectedLibraryId_idx" ON "ConnectedFolder"("canonicalConnectedLibraryId");
CREATE INDEX "ConnectedFolder_disconnectedAt_idx" ON "ConnectedFolder"("disconnectedAt");
CREATE INDEX "ConnectedFolder_hiddenFromActiveListAt_idx" ON "ConnectedFolder"("hiddenFromActiveListAt");
