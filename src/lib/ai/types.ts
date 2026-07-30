import type {
  HumanDecisionType,
  KnowledgeItemKind,
  MemoryStatus,
  MemoryType,
  ObservationSessionStatus,
} from "@/types/library";

export type AIProviderName = "openai" | "anthropic";

export type AIJsonValue =
  | string
  | number
  | boolean
  | null
  | AIJsonValue[]
  | { [key: string]: AIJsonValue };

export type AIProviderOptions = {
  maxInputCharacters?: number;
  maxOutputTokens?: number;
};

export type AIObservationInput = {
  title: string | null;
  itemKind: KnowledgeItemKind | string;
  contentText: string | null;
  previewText: string | null;
  metadata: Record<string, AIJsonValue | undefined>;
};

export type AIObservation = {
  text: string;
  evidence: string[];
  whyItMatters: string;
  confidence: number;
  uncertainty: string;
};

export type AIPossibleTheme = {
  name: string;
  reason: string;
  evidence: string[];
  confidence: number;
  uncertainty: string;
};

export type AIPossibleRelationship = {
  targetHint: string;
  reason: string;
  evidence: string[];
  confidence: number;
  uncertainty: string;
};

export type AIReviewQuestion = {
  question: string;
  reason: string;
};

export type AIObservationResult = {
  provider: AIProviderName;
  model: string;
  observations: AIObservation[];
  possibleThemes: AIPossibleTheme[];
  possibleRelationships: AIPossibleRelationship[];
  questions: AIReviewQuestion[];
  confidence: number;
  uncertainty: string;
  warnings: string[];
};

export type AIReflectionMemoryEntry = {
  id: string;
  memoryType: MemoryType | string;
  title: string;
  description: string;
  confidence: number;
  evidence: string[];
  status: MemoryStatus | string;
  firstSeen: string;
  lastSeen: string;
  occurrenceCount: number;
};

export type AIReflectionObservationSession = {
  id: string;
  documentTitle: string;
  observerType: string;
  status: ObservationSessionStatus | string;
  observations: AIJsonValue;
  interpretations: AIJsonValue;
  explanation: AIJsonValue;
  confidence: number;
  createdAt: string;
};

export type AIReflectionHumanDecision = {
  id: string;
  observationSessionId: string;
  decisionType: HumanDecisionType | string;
  note: string | null;
  editedSuggestion: string | null;
  createdAt: string;
};

export type AIRelatedKnowledge = {
  sourceTitle: string;
  targetTitle: string;
  sharedTerms: string[];
  reason: string;
  status: string;
};

export type AIReflectionInput = {
  memoryEntries: AIReflectionMemoryEntry[];
  observationSessions: AIReflectionObservationSession[];
  humanDecisions: AIReflectionHumanDecision[];
  relatedKnowledge: AIRelatedKnowledge[];
};

export type AIEvidenceReference = {
  label: string;
  sourceIds: string[];
  summary: string;
};

export type AINotebookReflection = {
  title: string;
  reflection: string;
  whyItMatters: string;
  evidenceReferences: AIEvidenceReference[];
  relatedDocuments: string[];
  humanDecisions: string[];
  priority: number;
  usefulness: number;
  status: "CURRENT" | "ARCHIVE_CANDIDATE" | "QUESTION";
};

export type AIPriorityRanking = {
  title: string;
  reason: string;
  priority: number;
};

export type AIReflectionResult = {
  provider: AIProviderName;
  model: string;
  notebookReflections: AINotebookReflection[];
  questions: AIReviewQuestion[];
  evidenceReferences: AIEvidenceReference[];
  rankings: AIPriorityRanking[];
  warnings: string[];
};

export type AIProvider = {
  name: AIProviderName;
  observe(
    input: AIObservationInput,
    options?: AIProviderOptions,
  ): Promise<AIObservationResult>;
  reflect(
    input: AIReflectionInput,
    options?: AIProviderOptions,
  ): Promise<AIReflectionResult>;
};
