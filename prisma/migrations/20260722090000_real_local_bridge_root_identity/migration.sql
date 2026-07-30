-- Connected Libraries now reconcile through a local Bridge root identifier.
-- Existing raw-path records remain as history and are marked legacy in app code.
ALTER TABLE "ConnectedFolder"
ADD COLUMN "bridgeRootId" TEXT,
ADD COLUMN "safeLocalLocation" TEXT,
ADD COLUMN "isLegacyConnection" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "legacyReason" TEXT,
ADD COLUMN "lastBridgeCheckAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "ConnectedFolder_bridgeRootId_key" ON "ConnectedFolder"("bridgeRootId");
CREATE INDEX "ConnectedFolder_bridgeRootId_idx" ON "ConnectedFolder"("bridgeRootId");
CREATE INDEX "ConnectedFolder_isLegacyConnection_idx" ON "ConnectedFolder"("isLegacyConnection");
CREATE INDEX "ConnectedFolder_lastBridgeCheckAt_idx" ON "ConnectedFolder"("lastBridgeCheckAt");
