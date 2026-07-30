-- CreateEnum
CREATE TYPE "MemoryType" AS ENUM ('THEME', 'TERM', 'PREFERENCE', 'RELATIONSHIP', 'NOTE');

-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "MemoryEntry" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "memoryType" "MemoryType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "evidence" JSONB NOT NULL,
    "status" "MemoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "memoryKey" TEXT NOT NULL,

    CONSTRAINT "MemoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemoryEntry_memoryKey_key" ON "MemoryEntry"("memoryKey");

-- CreateIndex
CREATE INDEX "MemoryEntry_memoryType_idx" ON "MemoryEntry"("memoryType");

-- CreateIndex
CREATE INDEX "MemoryEntry_status_idx" ON "MemoryEntry"("status");

-- CreateIndex
CREATE INDEX "MemoryEntry_lastSeen_idx" ON "MemoryEntry"("lastSeen");
