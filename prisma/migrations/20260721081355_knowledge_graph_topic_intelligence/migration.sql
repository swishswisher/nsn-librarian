-- CreateEnum
CREATE TYPE "KnowledgeObjectType" AS ENUM ('TOPIC', 'CONCEPT', 'FRAMEWORK', 'PERSON', 'PROJECT', 'WORKSHOP', 'RESOURCE', 'WEBSITE_ARTICLE', 'DECISION', 'PREFERENCE');

-- CreateEnum
CREATE TYPE "KnowledgeObjectStatus" AS ENUM ('PROVISIONAL', 'APPROVED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "KnowledgeTrustLevel" AS ENUM ('PROVISIONAL', 'HUMAN_APPROVED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "KnowledgeRelationshipType" AS ENUM ('RELATED_TO', 'PART_OF', 'MENTIONS', 'SUPPORTS', 'CONTRADICTS', 'DERIVED_FROM', 'USED_IN', 'CREATED_BY', 'PREFERRED_OVER', 'EVOLVED_FROM', 'SUITABLE_FOR', 'DUPLICATES', 'GROUPED_WITH');

-- CreateEnum
CREATE TYPE "KnowledgeRelationshipStatus" AS ENUM ('PROVISIONAL', 'APPROVED', 'REJECTED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "KnowledgeObject" (
    "id" TEXT NOT NULL,
    "objectType" "KnowledgeObjectType" NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "KnowledgeObjectStatus" NOT NULL DEFAULT 'PROVISIONAL',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "trustLevel" "KnowledgeTrustLevel" NOT NULL DEFAULT 'PROVISIONAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "provenanceSummary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "sourceKeys" JSONB NOT NULL,
    "canonicalObjectId" TEXT,

    CONSTRAINT "KnowledgeObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeRelationship" (
    "id" TEXT NOT NULL,
    "sourceObjectId" TEXT NOT NULL,
    "targetObjectId" TEXT NOT NULL,
    "relationshipType" "KnowledgeRelationshipType" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "trustLevel" "KnowledgeTrustLevel" NOT NULL DEFAULT 'PROVISIONAL',
    "status" "KnowledgeRelationshipStatus" NOT NULL DEFAULT 'PROVISIONAL',
    "explanation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "provenanceSummary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "relationshipKey" TEXT NOT NULL,

    CONSTRAINT "KnowledgeRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeObjectRevision" (
    "id" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "previousName" TEXT,
    "revisedName" TEXT,
    "previousType" TEXT,
    "revisedType" TEXT,
    "previousStatus" TEXT,
    "revisedStatus" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "KnowledgeObjectRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeRelationshipRevision" (
    "id" TEXT NOT NULL,
    "relationshipId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "previousStatus" TEXT,
    "revisedStatus" TEXT,
    "previousType" TEXT,
    "revisedType" TEXT,
    "revisedExplanation" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "KnowledgeRelationshipRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeObjectMerge" (
    "id" TEXT NOT NULL,
    "canonicalObjectId" TEXT NOT NULL,
    "mergedObjectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "reason" TEXT,
    "provenanceSummary" TEXT NOT NULL,

    CONSTRAINT "KnowledgeObjectMerge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeObject_objectType_idx" ON "KnowledgeObject"("objectType");

-- CreateIndex
CREATE INDEX "KnowledgeObject_normalizedName_idx" ON "KnowledgeObject"("normalizedName");

-- CreateIndex
CREATE INDEX "KnowledgeObject_status_idx" ON "KnowledgeObject"("status");

-- CreateIndex
CREATE INDEX "KnowledgeObject_trustLevel_idx" ON "KnowledgeObject"("trustLevel");

-- CreateIndex
CREATE INDEX "KnowledgeObject_canonicalObjectId_idx" ON "KnowledgeObject"("canonicalObjectId");

-- CreateIndex
CREATE INDEX "KnowledgeObject_lastSeen_idx" ON "KnowledgeObject"("lastSeen");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeObject_objectType_normalizedName_key" ON "KnowledgeObject"("objectType", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeRelationship_relationshipKey_key" ON "KnowledgeRelationship"("relationshipKey");

-- CreateIndex
CREATE INDEX "KnowledgeRelationship_sourceObjectId_idx" ON "KnowledgeRelationship"("sourceObjectId");

-- CreateIndex
CREATE INDEX "KnowledgeRelationship_targetObjectId_idx" ON "KnowledgeRelationship"("targetObjectId");

-- CreateIndex
CREATE INDEX "KnowledgeRelationship_relationshipType_idx" ON "KnowledgeRelationship"("relationshipType");

-- CreateIndex
CREATE INDEX "KnowledgeRelationship_status_idx" ON "KnowledgeRelationship"("status");

-- CreateIndex
CREATE INDEX "KnowledgeRelationship_trustLevel_idx" ON "KnowledgeRelationship"("trustLevel");

-- CreateIndex
CREATE INDEX "KnowledgeRelationship_createdAt_idx" ON "KnowledgeRelationship"("createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeObjectRevision_objectId_idx" ON "KnowledgeObjectRevision"("objectId");

-- CreateIndex
CREATE INDEX "KnowledgeObjectRevision_actionType_idx" ON "KnowledgeObjectRevision"("actionType");

-- CreateIndex
CREATE INDEX "KnowledgeObjectRevision_createdAt_idx" ON "KnowledgeObjectRevision"("createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeRelationshipRevision_relationshipId_idx" ON "KnowledgeRelationshipRevision"("relationshipId");

-- CreateIndex
CREATE INDEX "KnowledgeRelationshipRevision_actionType_idx" ON "KnowledgeRelationshipRevision"("actionType");

-- CreateIndex
CREATE INDEX "KnowledgeRelationshipRevision_createdAt_idx" ON "KnowledgeRelationshipRevision"("createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeObjectMerge_canonicalObjectId_idx" ON "KnowledgeObjectMerge"("canonicalObjectId");

-- CreateIndex
CREATE INDEX "KnowledgeObjectMerge_mergedObjectId_idx" ON "KnowledgeObjectMerge"("mergedObjectId");

-- CreateIndex
CREATE INDEX "KnowledgeObjectMerge_createdAt_idx" ON "KnowledgeObjectMerge"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeObjectMerge_canonicalObjectId_mergedObjectId_key" ON "KnowledgeObjectMerge"("canonicalObjectId", "mergedObjectId");

-- AddForeignKey
ALTER TABLE "KnowledgeObject" ADD CONSTRAINT "KnowledgeObject_canonicalObjectId_fkey" FOREIGN KEY ("canonicalObjectId") REFERENCES "KnowledgeObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeRelationship" ADD CONSTRAINT "KnowledgeRelationship_sourceObjectId_fkey" FOREIGN KEY ("sourceObjectId") REFERENCES "KnowledgeObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeRelationship" ADD CONSTRAINT "KnowledgeRelationship_targetObjectId_fkey" FOREIGN KEY ("targetObjectId") REFERENCES "KnowledgeObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeObjectRevision" ADD CONSTRAINT "KnowledgeObjectRevision_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "KnowledgeObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeRelationshipRevision" ADD CONSTRAINT "KnowledgeRelationshipRevision_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "KnowledgeRelationship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeObjectMerge" ADD CONSTRAINT "KnowledgeObjectMerge_canonicalObjectId_fkey" FOREIGN KEY ("canonicalObjectId") REFERENCES "KnowledgeObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeObjectMerge" ADD CONSTRAINT "KnowledgeObjectMerge_mergedObjectId_fkey" FOREIGN KEY ("mergedObjectId") REFERENCES "KnowledgeObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
