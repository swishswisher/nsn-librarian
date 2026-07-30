import type {
  KnowledgeEvidenceSummary,
  KnowledgeObjectStatus,
  KnowledgeObjectType,
  KnowledgeRelationshipType,
  KnowledgeTrustLevel,
} from "@/types/library";

export type KnowledgeSourceKind =
  | "MEMORY"
  | "NOTEBOOK"
  | "OBSERVATION"
  | "RECOMMENDATION"
  | "ORGANIZATION_PLAN"
  | "ORGANIZATION_HISTORY"
  | "AUDIO_RECORDING"
  | "VIDEO_RECORDING";

export type KnowledgeSourcePriority = "HIGH" | "MEDIUM" | "LOW";

export type KnowledgeObjectDraft = {
  approvedAt?: Date | null;
  approvedBy?: string | null;
  confidence: number;
  description: string;
  evidence: Partial<KnowledgeEvidenceSummary>;
  firstSeen?: Date;
  lastSeen?: Date;
  name: string;
  objectType: KnowledgeObjectType;
  provenanceSummary: string;
  sourceKey: string;
  status: KnowledgeObjectStatus;
  trustLevel: KnowledgeTrustLevel;
};

export type KnowledgeRelationshipDraft = {
  confidence: number;
  evidence: Partial<KnowledgeEvidenceSummary>;
  explanation: string;
  provenanceSummary: string;
  relationshipType: KnowledgeRelationshipType;
  sourceKey: string;
  status: KnowledgeObjectStatus;
  trustLevel: KnowledgeTrustLevel;
};

export type KnowledgeSource = {
  appearedIn: string;
  approvedAt?: Date | null;
  approvedBy?: string | null;
  confidence: number;
  evidence: Partial<KnowledgeEvidenceSummary>;
  occurredAt: Date;
  provenanceSummary: string;
  sourceId: string;
  sourceKey: string;
  sourceKind: KnowledgeSourceKind;
  sourcePriority?: KnowledgeSourcePriority;
  status: KnowledgeObjectStatus;
  text: string;
  trustLevel: KnowledgeTrustLevel;
};

export type StoredKnowledgeEvidence = KnowledgeEvidenceSummary;
