CREATE TYPE "OrganizationPreferenceStatus" AS ENUM (
  'PROPOSED', 'DEFERRED', 'APPROVED', 'REJECTED', 'ARCHIVED', 'SUPERSEDED'
);

ALTER TABLE "ScanSession" ADD COLUMN "knowledgePersistenceStatus" TEXT NOT NULL DEFAULT 'NOT_ATTEMPTED';
CREATE INDEX "ExecutionAction_destinationRelativePath_idx" ON "ExecutionAction"("destinationRelativePath");

ALTER TABLE "KnowledgeConnection"
  ADD COLUMN "relationshipKey" TEXT,
  ADD COLUMN "relationshipKind" TEXT,
  ADD COLUMN "sourceFileKey" TEXT,
  ADD COLUMN "targetFileKey" TEXT,
  ADD COLUMN "sourceChecksum" TEXT,
  ADD COLUMN "targetChecksum" TEXT,
  ADD COLUMN "generationVersion" TEXT,
  ADD COLUMN "sourceEvidence" JSONB,
  ADD COLUMN "lastSeenAt" TIMESTAMP(3),
  ADD COLUMN "supersededAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "KnowledgeConnection_relationshipKey_key" ON "KnowledgeConnection"("relationshipKey");
CREATE INDEX "KnowledgeConnection_sourceFileKey_idx" ON "KnowledgeConnection"("sourceFileKey");
CREATE INDEX "KnowledgeConnection_targetFileKey_idx" ON "KnowledgeConnection"("targetFileKey");

CREATE TABLE "KnowledgeDocumentSignal" (
  "id" TEXT NOT NULL,
  "signalKey" TEXT NOT NULL,
  "connectedLibraryId" TEXT NOT NULL,
  "fileKey" TEXT NOT NULL,
  "relativePath" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "identityHash" TEXT NOT NULL,
  "supportHash" TEXT,
  "revisionNumber" TEXT,
  "revisionDate" TEXT,
  "sourceRanges" JSONB NOT NULL,
  "observationSessionId" TEXT NOT NULL,
  "generationVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededAt" TIMESTAMP(3),
  CONSTRAINT "KnowledgeDocumentSignal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnowledgeDocumentSignal_signalKey_key" ON "KnowledgeDocumentSignal"("signalKey");
CREATE INDEX "KnowledgeDocumentSignal_connectedLibraryId_kind_identityHash_status_idx" ON "KnowledgeDocumentSignal"("connectedLibraryId", "kind", "identityHash", "status");
CREATE INDEX "KnowledgeDocumentSignal_fileKey_status_idx" ON "KnowledgeDocumentSignal"("fileKey", "status");

CREATE TABLE "KnowledgeConnectionDecision" (
  "id" TEXT NOT NULL,
  "knowledgeConnectionId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "previousStatus" "KnowledgeConnectionStatus" NOT NULL,
  "nextStatus" "KnowledgeConnectionStatus" NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeConnectionDecision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KnowledgeConnectionDecision_knowledgeConnectionId_createdAt_idx" ON "KnowledgeConnectionDecision"("knowledgeConnectionId", "createdAt");
ALTER TABLE "KnowledgeConnectionDecision" ADD CONSTRAINT "KnowledgeConnectionDecision_knowledgeConnectionId_fkey"
  FOREIGN KEY ("knowledgeConnectionId") REFERENCES "KnowledgeConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OrganizationSuggestionDecisionEvent" (
  "id" TEXT NOT NULL,
  "suggestionId" TEXT NOT NULL,
  "scanSessionId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "previousStatus" TEXT NOT NULL,
  "nextStatus" TEXT NOT NULL,
  "context" TEXT,
  "destination" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationSuggestionDecisionEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrganizationSuggestionDecisionEvent_suggestionId_createdAt_idx" ON "OrganizationSuggestionDecisionEvent"("suggestionId", "createdAt");
CREATE INDEX "OrganizationSuggestionDecisionEvent_scanSessionId_createdAt_idx" ON "OrganizationSuggestionDecisionEvent"("scanSessionId", "createdAt");

CREATE TABLE "OrganizationPreference" (
  "id" TEXT NOT NULL,
  "connectedLibraryId" TEXT NOT NULL,
  "destinationRelativePath" TEXT NOT NULL,
  "scopeTerms" JSONB NOT NULL,
  "sourceDecisionIds" JSONB NOT NULL,
  "evidence" JSONB NOT NULL,
  "proposalKey" TEXT NOT NULL,
  "status" "OrganizationPreferenceStatus" NOT NULL DEFAULT 'PROPOSED',
  "version" INTEGER NOT NULL DEFAULT 1,
  "approvedAt" TIMESTAMP(3),
  "disputedAt" TIMESTAMP(3),
  "supersededById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrganizationPreference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrganizationPreference_proposalKey_key" ON "OrganizationPreference"("proposalKey");
CREATE INDEX "OrganizationPreference_connectedLibraryId_status_idx" ON "OrganizationPreference"("connectedLibraryId", "status");
CREATE INDEX "OrganizationPreference_createdAt_idx" ON "OrganizationPreference"("createdAt");

CREATE TABLE "OrganizationPreferenceRevision" (
  "id" TEXT NOT NULL,
  "preferenceId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "previousStatus" TEXT NOT NULL,
  "nextStatus" TEXT NOT NULL,
  "previousDestination" TEXT,
  "nextDestination" TEXT,
  "previousScopeTerms" JSONB,
  "nextScopeTerms" JSONB,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationPreferenceRevision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrganizationPreferenceRevision_preferenceId_createdAt_idx" ON "OrganizationPreferenceRevision"("preferenceId", "createdAt");
ALTER TABLE "OrganizationPreferenceRevision" ADD CONSTRAINT "OrganizationPreferenceRevision_preferenceId_fkey"
  FOREIGN KEY ("preferenceId") REFERENCES "OrganizationPreference"("id") ON DELETE CASCADE ON UPDATE CASCADE;
