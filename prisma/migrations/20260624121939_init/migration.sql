-- CreateEnum
CREATE TYPE "LibraryBatchStatus" AS ENUM ('DRAFT', 'INGESTING', 'READY', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LibrarySourceType" AS ENUM ('LOCAL_UPLOAD', 'MAC_BRIDGE', 'ZIP_IMPORT', 'MANUAL', 'EXTERNAL_DRIVE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('PENDING', 'EXTRACTING', 'COMPLETED', 'FAILED', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "ClassificationStatus" AS ENUM ('PENDING', 'CLASSIFIED', 'NEEDS_REVIEW', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "DocumentPrimaryType" AS ENUM ('ARTICLE_CANDIDATE', 'NEWSLETTER_CANDIDATE', 'WORKSHEET', 'CLINICAL_TOOL', 'CLINICAL_ASSESSMENT', 'RESEARCH_SOURCE', 'BOOK_REFERENCE', 'THOUGHT_BANK', 'CONCEPT_SEED', 'WEBSITE_CONTENT', 'MEDIA_ASSET', 'NSN_INFRASTRUCTURE', 'HANDOFF', 'UNKNOWN', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "OriginalVsSource" AS ENUM ('DEANNE_ORIGINAL', 'OUTSIDE_SOURCE', 'MIXED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Publishability" AS ENUM ('PUBLIC_READY', 'INTERNAL_ONLY', 'CLINICAL_RESTRICTED', 'REFERENCE_ONLY', 'DO_NOT_PUBLISH', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "MigrationActionType" AS ENUM ('COPY', 'MOVE', 'LINK', 'SKIP', 'REVIEW');

-- CreateEnum
CREATE TYPE "MigrationStatus" AS ENUM ('PENDING', 'READY', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'BLOCKED');

-- CreateTable
CREATE TABLE "LibraryBatch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" "LibrarySourceType" NOT NULL DEFAULT 'UNKNOWN',
    "notes" TEXT,
    "status" "LibraryBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryDocument" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "normalizedFileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "extension" TEXT,
    "fileSizeBytes" BIGINT,
    "checksum" TEXT,
    "rawText" TEXT,
    "previewText" TEXT,
    "wordCount" INTEGER,
    "extractionStatus" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "classificationStatus" "ClassificationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "storagePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentClassification" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "primaryType" "DocumentPrimaryType" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "secondaryTypes" JSONB NOT NULL,
    "topicTags" JSONB NOT NULL,
    "audienceTags" JSONB NOT NULL,
    "originalVsSource" "OriginalVsSource" NOT NULL DEFAULT 'UNKNOWN',
    "publishability" "Publishability" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "suggestedDestination" TEXT,
    "confidenceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reasoning" TEXT,
    "articleSeedScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "workshopScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bookSeedScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "clinicalUtilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "researchValueScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "duplicateRiskScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentClassification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentReview" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "approvedType" "DocumentPrimaryType",
    "approvedTags" JSONB NOT NULL,
    "approvedDestination" TEXT,
    "isDeanneOriginal" BOOLEAN NOT NULL DEFAULT false,
    "isReferenceOnly" BOOLEAN NOT NULL DEFAULT false,
    "isArticleSeed" BOOLEAN NOT NULL DEFAULT false,
    "isDoNotPublish" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "decisionStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryTaxonomyNode" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parentId" TEXT,
    "nodeType" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryTaxonomyNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateGroup" (
    "id" TEXT NOT NULL,
    "groupHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DuplicateGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationQueueItem" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "destinationPath" TEXT NOT NULL,
    "actionType" "MigrationActionType" NOT NULL DEFAULT 'REVIEW',
    "status" "MigrationStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationQueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LibraryBatch_status_idx" ON "LibraryBatch"("status");

-- CreateIndex
CREATE INDEX "LibraryBatch_sourceType_idx" ON "LibraryBatch"("sourceType");

-- CreateIndex
CREATE INDEX "LibraryDocument_batchId_idx" ON "LibraryDocument"("batchId");

-- CreateIndex
CREATE INDEX "LibraryDocument_checksum_idx" ON "LibraryDocument"("checksum");

-- CreateIndex
CREATE INDEX "LibraryDocument_classificationStatus_idx" ON "LibraryDocument"("classificationStatus");

-- CreateIndex
CREATE INDEX "LibraryDocument_reviewStatus_idx" ON "LibraryDocument"("reviewStatus");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentClassification_documentId_key" ON "DocumentClassification"("documentId");

-- CreateIndex
CREATE INDEX "DocumentClassification_primaryType_idx" ON "DocumentClassification"("primaryType");

-- CreateIndex
CREATE INDEX "DocumentClassification_publishability_idx" ON "DocumentClassification"("publishability");

-- CreateIndex
CREATE INDEX "DocumentReview_documentId_idx" ON "DocumentReview"("documentId");

-- CreateIndex
CREATE INDEX "DocumentReview_decisionStatus_idx" ON "DocumentReview"("decisionStatus");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryTaxonomyNode_slug_key" ON "LibraryTaxonomyNode"("slug");

-- CreateIndex
CREATE INDEX "LibraryTaxonomyNode_parentId_idx" ON "LibraryTaxonomyNode"("parentId");

-- CreateIndex
CREATE INDEX "LibraryTaxonomyNode_nodeType_idx" ON "LibraryTaxonomyNode"("nodeType");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateGroup_groupHash_key" ON "DuplicateGroup"("groupHash");

-- CreateIndex
CREATE INDEX "DuplicateGroup_status_idx" ON "DuplicateGroup"("status");

-- CreateIndex
CREATE INDEX "MigrationQueueItem_documentId_idx" ON "MigrationQueueItem"("documentId");

-- CreateIndex
CREATE INDEX "MigrationQueueItem_status_idx" ON "MigrationQueueItem"("status");

-- CreateIndex
CREATE INDEX "MigrationQueueItem_actionType_idx" ON "MigrationQueueItem"("actionType");

-- AddForeignKey
ALTER TABLE "LibraryDocument" ADD CONSTRAINT "LibraryDocument_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "LibraryBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentClassification" ADD CONSTRAINT "DocumentClassification_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "LibraryDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentReview" ADD CONSTRAINT "DocumentReview_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "LibraryDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryTaxonomyNode" ADD CONSTRAINT "LibraryTaxonomyNode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LibraryTaxonomyNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationQueueItem" ADD CONSTRAINT "MigrationQueueItem_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "LibraryDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
