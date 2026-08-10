CREATE TABLE IF NOT EXISTS "BridgeRequestNonce" (
  "id" TEXT NOT NULL,
  "bridgeDeviceId" TEXT NOT NULL,
  "nonceHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BridgeRequestNonce_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BridgeRequestNonce_nonceHash_key"
  ON "BridgeRequestNonce"("nonceHash");

CREATE INDEX IF NOT EXISTS "BridgeRequestNonce_bridgeDeviceId_idx"
  ON "BridgeRequestNonce"("bridgeDeviceId");

CREATE INDEX IF NOT EXISTS "BridgeRequestNonce_expiresAt_idx"
  ON "BridgeRequestNonce"("expiresAt");
