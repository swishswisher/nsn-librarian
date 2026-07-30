-- CreateEnum
CREATE TYPE "ConnectedLibraryPlatform" AS ENUM ('WINDOWS', 'MACOS', 'LINUX', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ConnectedLibraryStatus" AS ENUM ('CONNECTED', 'PAUSED', 'NEEDS_ATTENTION', 'DISCONNECTED');

-- AlterTable
ALTER TABLE "ConnectedFolder" ADD COLUMN     "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "createFolderPermission" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastMonitoringAt" TIMESTAMP(3),
ADD COLUMN     "moveFilePermission" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "organizationPlanPermission" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "platform" "ConnectedLibraryPlatform" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "readPermission" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "recommendationPermission" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "renameFilePermission" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" "ConnectedLibraryStatus" NOT NULL DEFAULT 'CONNECTED',
ADD COLUMN     "watchPermission" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ConnectedFolder_lastMonitoringAt_idx" ON "ConnectedFolder"("lastMonitoringAt");

-- CreateIndex
CREATE INDEX "ConnectedFolder_status_idx" ON "ConnectedFolder"("status");

-- CreateIndex
CREATE INDEX "ConnectedFolder_platform_idx" ON "ConnectedFolder"("platform");
