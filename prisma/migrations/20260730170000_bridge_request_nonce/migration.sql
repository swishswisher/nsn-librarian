CREATE TABLE "BridgeRequestNonce" (
  "id" TEXT NOT NULL,
  "bridgeDeviceId" TEXT NOT NULL,
  "nonceHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BridgeRequestNonce_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BridgeRequestNonce_nonceHash_key"
  ON "BridgeRequestNonce"("nonceHash");

CREATE INDEX "BridgeRequestNonce_bridgeDeviceId_idx"
  ON "BridgeRequestNonce"("bridgeDeviceId");

CREATE INDEX "BridgeRequestNonce_expiresAt_idx"
  ON "BridgeRequestNonce"("expiresAt");
