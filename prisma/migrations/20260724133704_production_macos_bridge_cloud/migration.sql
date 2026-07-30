-- CreateEnum
CREATE TYPE "BridgeDeviceStatus" AS ENUM ('UNPAIRED', 'PAIRING', 'PAIRED', 'ONLINE', 'OFFLINE', 'UPDATE_REQUIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "BridgePairingCodeStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "BridgeCommandType" AS ENUM ('SELECT_FOLDERS', 'REGISTER_ROOT', 'SCAN_LIBRARY', 'START_WATCHING', 'PAUSE_WATCHING', 'RESUME_WATCHING', 'STOP_WATCHING', 'READ_FILE_TEMPORARILY', 'PREVIEW_EXECUTION', 'EXECUTE_PLAN', 'PREVIEW_UNDO', 'EXECUTE_UNDO', 'RECONCILE_LIBRARY', 'REVOKE_ROOT_ACCESS');

-- CreateEnum
CREATE TYPE "BridgeCommandStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BridgeAuditEventType" AS ENUM ('PAIRING_CODE_CREATED', 'DEVICE_PAIRED', 'DEVICE_REVOKED', 'HEARTBEAT_RECEIVED', 'COMMAND_CREATED', 'COMMAND_ACKNOWLEDGED', 'COMMAND_COMPLETED', 'COMMAND_REJECTED');

-- AlterTable
ALTER TABLE "ConnectedFolder" ADD COLUMN     "bridgeDeviceId" TEXT;

-- AlterTable
ALTER TABLE "ExecutionRun" ADD COLUMN     "bridgeDeviceId" TEXT;

-- CreateTable
CREATE TABLE "BridgeDevice" (
    "id" TEXT NOT NULL,
    "bridgeDeviceId" TEXT NOT NULL,
    "deviceDisplayName" TEXT NOT NULL,
    "platform" "ConnectedLibraryPlatform" NOT NULL DEFAULT 'UNKNOWN',
    "architecture" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "pairedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "status" "BridgeDeviceStatus" NOT NULL DEFAULT 'UNPAIRED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BridgeDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BridgePairingCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeSuffix" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL DEFAULT 'deanne',
    "status" "BridgePairingCodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "pairedDeviceId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BridgePairingCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BridgeCommand" (
    "id" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "bridgeDeviceId" TEXT NOT NULL,
    "connectedLibraryId" TEXT,
    "bridgeRootId" TEXT,
    "commandType" "BridgeCommandType" NOT NULL,
    "status" "BridgeCommandStatus" NOT NULL DEFAULT 'PENDING',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "authorizationContext" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "result" JSONB,
    "safeErrorCategory" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT 'SYSTEM',

    CONSTRAINT "BridgeCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BridgeAuditEntry" (
    "id" TEXT NOT NULL,
    "eventType" "BridgeAuditEventType" NOT NULL,
    "bridgeDeviceId" TEXT,
    "pairingCodeId" TEXT,
    "commandId" TEXT,
    "connectedLibraryId" TEXT,
    "actorUserId" TEXT,
    "safeSummary" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BridgeAuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BridgeDevice_bridgeDeviceId_key" ON "BridgeDevice"("bridgeDeviceId");

-- CreateIndex
CREATE INDEX "BridgeDevice_status_idx" ON "BridgeDevice"("status");

-- CreateIndex
CREATE INDEX "BridgeDevice_platform_idx" ON "BridgeDevice"("platform");

-- CreateIndex
CREATE INDEX "BridgeDevice_lastSeenAt_idx" ON "BridgeDevice"("lastSeenAt");

-- CreateIndex
CREATE INDEX "BridgeDevice_revokedAt_idx" ON "BridgeDevice"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BridgePairingCode_codeHash_key" ON "BridgePairingCode"("codeHash");

-- CreateIndex
CREATE INDEX "BridgePairingCode_requestedByUserId_idx" ON "BridgePairingCode"("requestedByUserId");

-- CreateIndex
CREATE INDEX "BridgePairingCode_status_idx" ON "BridgePairingCode"("status");

-- CreateIndex
CREATE INDEX "BridgePairingCode_expiresAt_idx" ON "BridgePairingCode"("expiresAt");

-- CreateIndex
CREATE INDEX "BridgePairingCode_pairedDeviceId_idx" ON "BridgePairingCode"("pairedDeviceId");

-- CreateIndex
CREATE UNIQUE INDEX "BridgeCommand_commandId_key" ON "BridgeCommand"("commandId");

-- CreateIndex
CREATE UNIQUE INDEX "BridgeCommand_idempotencyKey_key" ON "BridgeCommand"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BridgeCommand_bridgeDeviceId_idx" ON "BridgeCommand"("bridgeDeviceId");

-- CreateIndex
CREATE INDEX "BridgeCommand_connectedLibraryId_idx" ON "BridgeCommand"("connectedLibraryId");

-- CreateIndex
CREATE INDEX "BridgeCommand_bridgeRootId_idx" ON "BridgeCommand"("bridgeRootId");

-- CreateIndex
CREATE INDEX "BridgeCommand_commandType_idx" ON "BridgeCommand"("commandType");

-- CreateIndex
CREATE INDEX "BridgeCommand_status_idx" ON "BridgeCommand"("status");

-- CreateIndex
CREATE INDEX "BridgeCommand_issuedAt_idx" ON "BridgeCommand"("issuedAt");

-- CreateIndex
CREATE INDEX "BridgeCommand_expiresAt_idx" ON "BridgeCommand"("expiresAt");

-- CreateIndex
CREATE INDEX "BridgeAuditEntry_eventType_idx" ON "BridgeAuditEntry"("eventType");

-- CreateIndex
CREATE INDEX "BridgeAuditEntry_bridgeDeviceId_idx" ON "BridgeAuditEntry"("bridgeDeviceId");

-- CreateIndex
CREATE INDEX "BridgeAuditEntry_pairingCodeId_idx" ON "BridgeAuditEntry"("pairingCodeId");

-- CreateIndex
CREATE INDEX "BridgeAuditEntry_commandId_idx" ON "BridgeAuditEntry"("commandId");

-- CreateIndex
CREATE INDEX "BridgeAuditEntry_connectedLibraryId_idx" ON "BridgeAuditEntry"("connectedLibraryId");

-- CreateIndex
CREATE INDEX "BridgeAuditEntry_createdAt_idx" ON "BridgeAuditEntry"("createdAt");

-- CreateIndex
CREATE INDEX "ConnectedFolder_bridgeDeviceId_idx" ON "ConnectedFolder"("bridgeDeviceId");

-- CreateIndex
CREATE INDEX "ExecutionRun_bridgeDeviceId_idx" ON "ExecutionRun"("bridgeDeviceId");

-- AddForeignKey
ALTER TABLE "ConnectedFolder" ADD CONSTRAINT "ConnectedFolder_bridgeDeviceId_fkey" FOREIGN KEY ("bridgeDeviceId") REFERENCES "BridgeDevice"("bridgeDeviceId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgePairingCode" ADD CONSTRAINT "BridgePairingCode_pairedDeviceId_fkey" FOREIGN KEY ("pairedDeviceId") REFERENCES "BridgeDevice"("bridgeDeviceId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgeCommand" ADD CONSTRAINT "BridgeCommand_bridgeDeviceId_fkey" FOREIGN KEY ("bridgeDeviceId") REFERENCES "BridgeDevice"("bridgeDeviceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgeCommand" ADD CONSTRAINT "BridgeCommand_connectedLibraryId_fkey" FOREIGN KEY ("connectedLibraryId") REFERENCES "ConnectedFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgeAuditEntry" ADD CONSTRAINT "BridgeAuditEntry_bridgeDeviceId_fkey" FOREIGN KEY ("bridgeDeviceId") REFERENCES "BridgeDevice"("bridgeDeviceId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgeAuditEntry" ADD CONSTRAINT "BridgeAuditEntry_pairingCodeId_fkey" FOREIGN KEY ("pairingCodeId") REFERENCES "BridgePairingCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgeAuditEntry" ADD CONSTRAINT "BridgeAuditEntry_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "BridgeCommand"("commandId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgeAuditEntry" ADD CONSTRAINT "BridgeAuditEntry_connectedLibraryId_fkey" FOREIGN KEY ("connectedLibraryId") REFERENCES "ConnectedFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_bridgeDeviceId_fkey" FOREIGN KEY ("bridgeDeviceId") REFERENCES "BridgeDevice"("bridgeDeviceId") ON DELETE SET NULL ON UPDATE CASCADE;
