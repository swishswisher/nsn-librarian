export const libraryBatchStatuses = [
  "DRAFT",
  "INGESTING",
  "READY",
  "FAILED",
  "ARCHIVED",
] as const;

export type LibraryBatchStatus = (typeof libraryBatchStatuses)[number];

export const librarySourceTypes = [
  "LOCAL_UPLOAD",
  "MAC_BRIDGE",
  "ZIP_IMPORT",
  "MANUAL",
  "EXTERNAL_DRIVE",
  "UNKNOWN",
] as const;

export type LibrarySourceType = (typeof librarySourceTypes)[number];

export const knowledgeItemKinds = [
  "DOCUMENT",
  "IMAGE",
  "AUDIO",
  "VIDEO",
  "EMAIL",
  "PRESENTATION",
  "SPREADSHEET",
  "ARCHIVE",
  "UNKNOWN",
] as const;

export type KnowledgeItemKind = (typeof knowledgeItemKinds)[number];

export const extractionStatuses = [
  "PENDING",
  "EXTRACTING",
  "COMPLETED",
  "FAILED",
  "UNSUPPORTED",
] as const;

export type ExtractionStatus = (typeof extractionStatuses)[number];

export const classificationStatuses = [
  "PENDING",
  "CLASSIFIED",
  "NEEDS_REVIEW",
  "FAILED",
  "SKIPPED",
] as const;

export type ClassificationStatus = (typeof classificationStatuses)[number];

export const reviewStatuses = [
  "PENDING",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "NEEDS_REVIEW",
] as const;

export type ReviewStatus = (typeof reviewStatuses)[number];

export const documentPrimaryTypes = [
  "ARTICLE_CANDIDATE",
  "NEWSLETTER_CANDIDATE",
  "WORKSHEET",
  "CLINICAL_TOOL",
  "CLINICAL_ASSESSMENT",
  "RESEARCH_SOURCE",
  "BOOK_REFERENCE",
  "THOUGHT_BANK",
  "CONCEPT_SEED",
  "WEBSITE_CONTENT",
  "MEDIA_ASSET",
  "NSN_INFRASTRUCTURE",
  "HANDOFF",
  "UNKNOWN",
  "NEEDS_REVIEW",
] as const;

export type DocumentPrimaryType = (typeof documentPrimaryTypes)[number];

export const topicTags = [
  "COUPLES",
  "ATTACHMENT",
  "TRAUMA",
  "SOMATIC",
  "GRIEF",
  "AUTISM_NEURODIVERSITY",
  "OCD_CERTAINTY",
  "ANXIETY_REGULATION",
  "AI_ETHICS",
  "FAMILY_SYSTEMS",
  "DBT",
  "MINDFULNESS",
  "NEUROFEEDBACK",
  "MEMORY_AGING_IDENTITY",
  "MORAL_INJURY_BETRAYAL",
  "ADDICTION",
  "HUMAN_DEVELOPMENT",
  "NERVOUS_SYSTEM",
] as const;

export type TopicTag = (typeof topicTags)[number];

export const audienceTags = [
  "PUBLIC",
  "CLIENT",
  "CLINICIAN",
  "WORKSHOP",
  "INTERNAL",
  "RESEARCH",
  "UNKNOWN",
] as const;

export type AudienceTag = (typeof audienceTags)[number];

export const originalVsSourceValues = [
  "DEANNE_ORIGINAL",
  "OUTSIDE_SOURCE",
  "MIXED",
  "UNKNOWN",
] as const;

export type OriginalVsSource = (typeof originalVsSourceValues)[number];

export const publishabilityValues = [
  "PUBLIC_READY",
  "INTERNAL_ONLY",
  "CLINICAL_RESTRICTED",
  "REFERENCE_ONLY",
  "DO_NOT_PUBLISH",
  "NEEDS_REVIEW",
] as const;

export type Publishability = (typeof publishabilityValues)[number];

export const migrationActionTypes = [
  "COPY",
  "MOVE",
  "LINK",
  "SKIP",
  "REVIEW",
] as const;

export type MigrationActionType = (typeof migrationActionTypes)[number];

export const migrationStatuses = [
  "PENDING",
  "READY",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "BLOCKED",
] as const;

export type MigrationStatus = (typeof migrationStatuses)[number];

export const observationSessionStatuses = [
  "NEW",
  "AWAITING_REVIEW",
  "IN_REVIEW",
  "APPROVED",
  "MODIFIED",
  "REJECTED",
  "ARCHIVED",
] as const;

export type ObservationSessionStatus =
  (typeof observationSessionStatuses)[number];

export const observationProviderTypes = ["DETERMINISTIC", "OPENAI"] as const;

export type ObservationProviderType = (typeof observationProviderTypes)[number];

export const humanDecisionTypes = [
  "ACCEPT",
  "MODIFY",
  "REJECT",
  "NOTE",
] as const;

export type HumanDecisionType = (typeof humanDecisionTypes)[number];

export const knowledgeConnectionStatuses = [
  "NEW",
  "CONFIRMED",
  "REJECTED",
  "ARCHIVED",
] as const;

export type KnowledgeConnectionStatus =
  (typeof knowledgeConnectionStatuses)[number];

export const memoryTypes = [
  "THEME",
  "TERM",
  "PREFERENCE",
  "RELATIONSHIP",
  "NOTE",
] as const;

export type MemoryType = (typeof memoryTypes)[number];

export const memoryStatuses = ["ACTIVE", "ARCHIVED"] as const;

export type MemoryStatus = (typeof memoryStatuses)[number];

export type ClassificationScoreSet = {
  articleSeedScore: number;
  workshopScore: number;
  bookSeedScore: number;
  clinicalUtilityScore: number;
  researchValueScore: number;
  duplicateRiskScore: number;
};

export type ClassificationResult = {
  primaryType: DocumentPrimaryType;
  secondaryTypes: DocumentPrimaryType[];
  topicTags: TopicTag[];
  audienceTags: AudienceTag[];
  originalVsSource: OriginalVsSource;
  publishability: Publishability;
  suggestedDestination: string;
  confidenceScore: number;
  reasoning: string;
  scores: ClassificationScoreSet;
};

export type LibraryDocumentSummary = {
  id: string;
  itemKind: KnowledgeItemKind;
  originalFileName: string;
  extension: string | null;
  mimeType: string | null;
  scanSessionName: string;
  extractionStatus: ExtractionStatus;
  canObserve: boolean;
  wordCount: number | null;
  previewText: string | null;
  primaryType: DocumentPrimaryType;
  topicTags: TopicTag[];
  classificationStatus: ClassificationStatus;
  reviewStatus: ReviewStatus;
  suggestedDestination: string;
  relatedItemCount: number;
};

export type DashboardMetric = {
  label: string;
  value: string;
  helper: string;
  tone: "sage" | "sand" | "review" | "aqua";
};

export type ReviewQueueItem = {
  id: string;
  documentName: string;
  observedAt: string;
  observerType: ObservationProviderType | string;
  confidence: number;
  summary: string;
  status: ObservationSessionStatus;
  relatedConnectionCount: number;
};

export type HumanDecisionHistoryItem = {
  id: string;
  decisionType: HumanDecisionType;
  note: string | null;
  editedSuggestion: string | null;
  createdAt: string;
};

export type ObservationSessionReview = {
  id: string;
  documentName: string;
  observedAt: string;
  observerType: ObservationProviderType | string;
  status: ObservationSessionStatus;
  confidence: number;
  observations: {
    id: string;
    description: string;
    evidence: string[];
    uncertainty: string;
    confidence: number;
  }[];
  interpretations: {
    id: string;
    description: string;
    uncertainty: string;
    confidence: number;
  }[];
  explanation: {
    summary: string;
    evidence: string[];
    uncertainty: string;
    confidence: number;
  };
  planSuggestions: {
    id: string;
    label: string;
    description: string;
    reason: string;
    confidence: number;
  }[];
  warnings: string[];
  relatedKnowledge: RelatedKnowledgeItem[];
  decisions: HumanDecisionHistoryItem[];
};

export type RelatedKnowledgeItem = {
  id: string;
  documentName: string;
  observedAt: string;
  similarityScore: number;
  confidence: number;
  sharedTerms: string[];
  reasoning: string;
  status: KnowledgeConnectionStatus;
};

export type MemoryEntrySummary = {
  id: string;
  memoryType: MemoryType;
  title: string;
  description: string;
  confidence: number;
  evidence: string[];
  status: MemoryStatus;
  firstSeen: string;
  lastSeen: string;
  occurrenceCount: number;
};

export type MemoryPageData = {
  themes: MemoryEntrySummary[];
  preferredTerms: MemoryEntrySummary[];
  recurringConcepts: MemoryEntrySummary[];
  humanPreferences: MemoryEntrySummary[];
  recentlyLearned: MemoryEntrySummary[];
};

export const knowledgeObjectTypes = [
  "TOPIC",
  "CONCEPT",
  "FRAMEWORK",
  "PERSON",
  "PROJECT",
  "WORKSHOP",
  "RESOURCE",
  "WEBSITE_ARTICLE",
  "DECISION",
  "PREFERENCE",
] as const;

export type KnowledgeObjectType = (typeof knowledgeObjectTypes)[number];

export const knowledgeObjectStatuses = [
  "PROVISIONAL",
  "APPROVED",
  "REJECTED",
  "ARCHIVED",
] as const;

export type KnowledgeObjectStatus = (typeof knowledgeObjectStatuses)[number];

export const knowledgeTrustLevels = [
  "PROVISIONAL",
  "HUMAN_APPROVED",
  "EXCLUDED",
] as const;

export type KnowledgeTrustLevel = (typeof knowledgeTrustLevels)[number];

export const knowledgeRelationshipTypes = [
  "RELATED_TO",
  "PART_OF",
  "MENTIONS",
  "SUPPORTS",
  "CONTRADICTS",
  "DERIVED_FROM",
  "USED_IN",
  "CREATED_BY",
  "PREFERRED_OVER",
  "EVOLVED_FROM",
  "SUITABLE_FOR",
  "DUPLICATES",
  "GROUPED_WITH",
  "FILE_MOVED_TO",
  "FILE_RENAMED_TO",
  "FILE_GROUPED_WITH",
  "FILE_USED_IN_PLAN",
  "FILE_INCLUDED_IN_EXECUTION",
] as const;

export type KnowledgeRelationshipType =
  (typeof knowledgeRelationshipTypes)[number];

export type KnowledgeReference = {
  href: string;
  id: string;
  label: string;
  type: KnowledgeObjectType;
  status: KnowledgeObjectStatus;
};

export type KnowledgeEvidenceSummary = {
  appearedIn: string[];
  relatedFiles: string[];
  relatedNotebookEntryIds: string[];
  relatedRecommendations: string[];
  relatedPlans: string[];
  timeline: string[];
  whyProposed: string[];
};

export type KnowledgeObjectSummary = {
  id: string;
  objectType: KnowledgeObjectType;
  name: string;
  normalizedName: string;
  description: string;
  status: KnowledgeObjectStatus;
  confidence: number;
  trustLevel: KnowledgeTrustLevel;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  firstSeen: string;
  lastSeen: string;
  occurrenceCount: number;
  provenanceSummary: string;
  evidence: KnowledgeEvidenceSummary;
  canonicalObjectId: string | null;
  relationshipCount: number;
};

export type KnowledgeRelationshipSummary = {
  id: string;
  sourceObjectId: string;
  targetObjectId: string;
  sourceName: string;
  targetName: string;
  sourceType: KnowledgeObjectType;
  targetType: KnowledgeObjectType;
  relationshipType: KnowledgeRelationshipType;
  confidence: number;
  trustLevel: KnowledgeTrustLevel;
  status: KnowledgeObjectStatus;
  explanation: string;
  createdAt: string;
  approvedAt: string | null;
  provenanceSummary: string;
  evidence: KnowledgeEvidenceSummary;
};

export type KnowledgeObjectRevisionSummary = {
  id: string;
  actionType: string;
  previousName: string | null;
  revisedName: string | null;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
};

export type KnowledgeTopicPageData = {
  object: KnowledgeObjectSummary;
  incomingRelationships: KnowledgeRelationshipSummary[];
  outgoingRelationships: KnowledgeRelationshipSummary[];
  relatedObjects: KnowledgeObjectSummary[];
  revisions: KnowledgeObjectRevisionSummary[];
  mergedObjects: KnowledgeObjectSummary[];
  sourceLinks: NotebookSourceLink[];
};

export type KnowledgeGraphPageData = {
  objects: KnowledgeObjectSummary[];
  relationships: KnowledgeRelationshipSummary[];
};

export type KnowledgeReviewPageData = KnowledgeGraphPageData & {
  mergeTargets: KnowledgeObjectSummary[];
};

export type KnowledgeHomepagePreview = {
  growingTopic: KnowledgeObjectSummary | null;
  newlyApproved: KnowledgeObjectSummary | null;
  needsReview: KnowledgeObjectSummary | null;
  crossFileTopic: KnowledgeObjectSummary | null;
};

export const notebookEntryTypes = [
  "REFLECTION",
  "SCAN_SUMMARY",
  "OBSERVATION",
  "HUMAN_REVISION",
  "CONTEXT_NOTE",
  "RECOMMENDATION_SUMMARY",
  "ORGANIZATION_DECISION",
  "ORGANIZATION_RESULT",
  "UNDO_RESULT",
  "MEMORY_LEARNING",
  "QUESTION",
  "GROWING_THEME",
  "LANGUAGE_PREFERENCE",
  "EMERGING_PATTERN",
  "POSSIBLE_RELATIONSHIP",
  "POSSIBLE_DUPLICATE",
  "LEARNING_UPDATE",
] as const;

export type NotebookEntryType = (typeof notebookEntryTypes)[number];

export const notebookEntryStatuses = [
  "CURRENT",
  "ARCHIVED",
  "ACCEPTED",
  "REJECTED",
  "NOTEBOOK_ONLY",
] as const;

export type NotebookEntryStatus = (typeof notebookEntryStatuses)[number];

export const notebookRevisionActions = [
  "ACCEPT_REFLECTION",
  "REVISE_REFLECTION",
  "REVISE_WORDING",
  "ADD_CONTEXT",
  "ANSWER_QUESTION",
  "REJECT_REFLECTION",
  "APPROVE_FOR_MEMORY",
  "KEEP_NOTEBOOK_ONLY",
  "ARCHIVE",
  "RESTORE",
] as const;

export type NotebookRevisionAction = (typeof notebookRevisionActions)[number];

export type NotebookEvidence = {
  whyINoticedThis: string[];
  supportingMaterial: string[];
  earlierObservations: string[];
  reviewDecisions: string[];
  timeline: string[];
};

export type NotebookSourceLink = {
  href: string;
  label: string;
  kind: string;
};

export type NotebookRevision = {
  id: string;
  actionType: NotebookRevisionAction;
  revisedTitle: string | null;
  revisedSummary: string | null;
  revisedBody: string | null;
  note: string | null;
  createdAt: string;
};

export type NotebookEntry = {
  id: string;
  type: NotebookEntryType;
  entryType?: NotebookEntryType;
  title: string;
  summary?: string;
  body: string;
  whyItMatters: string;
  status?: NotebookEntryStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  priority: number;
  history: string[];
  evidence: NotebookEvidence;
  archiveStatus?: "CURRENT" | "ARCHIVED";
  relatedDocuments?: string[];
  humanDecisions?: string[];
  sourceType?: string;
  sourceId?: string;
  scanSessionId?: string | null;
  scannedFileId?: string | null;
  observationSessionId?: string | null;
  recommendationId?: string | null;
  organizationPlanId?: string | null;
  executionRunId?: string | null;
  undoRunId?: string | null;
  memoryItemId?: string | null;
  requiresAttention?: boolean;
  approvedForMemory?: boolean;
  provenanceSummary?: string;
  sourceLinks?: NotebookSourceLink[];
  relatedEntries?: NotebookSourceLink[];
  relatedKnowledge?: KnowledgeReference[];
};

export type NotebookDigest = {
  examinedItemsToday: number;
  growingThemesToday: number;
  possibleRelationshipsToday: number;
  learnedPreferencesToday: number;
  waitingQuestions: number;
};

export type NotebookPageData = {
  digest: NotebookDigest;
  allEntries?: NotebookEntry[];
  currentReflections?: NotebookEntry[];
  needsAttention?: NotebookEntry[];
  recentLearning?: NotebookEntry[];
  mostImportantObservation: NotebookEntry | null;
  otherObservations: NotebookEntry[];
  questions: NotebookEntry[];
  learningUpdates: NotebookEntry[];
  archiveEntries: NotebookEntry[];
};

export type NotebookEntryDetail = NotebookEntry & {
  revisions: NotebookRevision[];
};

export type MigrationQueueRow = {
  id: string;
  fileName: string;
  destinationPath: string;
  actionType: MigrationActionType;
  status: MigrationStatus;
};
