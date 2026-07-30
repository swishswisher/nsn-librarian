import type { KnowledgeItemKind } from "@/types/library";

/**
 * Librarian's Mind constitutional boundary:
 * - The machine suggests. Deanne decides.
 * - Nothing moves without approval.
 * - The Librarian never learns from assumptions. It learns from observation.
 * - Knowledge is not defined by its format.
 * - The Human always has final authority.
 * - Claude is a tool, not the Librarian.
 */

export type MindInputSource =
  | "BRIDGE"
  | "READING_ROOM"
  | "UPLOAD"
  | "MANUAL"
  | "SYSTEM"
  | "UNKNOWN";

export type ObservationLabel =
  | "MISSING_OR_EMPTY_CONTENT"
  | "REPEATED_TERMS"
  | "POSSIBLE_PURPOSE"
  | "MAJOR_RECURRING_WORDS"
  | "ITEM_KIND_CONTEXT";

export type InterpretationLabel =
  | "INSUFFICIENT_EVIDENCE"
  | "POSSIBLE_TOPIC_SIGNAL"
  | "POSSIBLE_LIBRARY_PLACEMENT"
  | "HUMAN_REVIEW_NEEDED";

export type RelationshipType =
  | "RELATED_TOPIC"
  | "POSSIBLE_DUPLICATE"
  | "SOURCE_OR_DERIVATIVE"
  | "UNKNOWN";

export type PlanActionType =
  | "REVIEW_LATER"
  | "CONSIDER_CATEGORY"
  | "CONNECT_WITH_RELATED"
  | "LEAVE_UNCHANGED"
  | "NEEDS_HUMAN_REVIEW";

export type MindInput = {
  knowledgeItemId: string;
  title: string | null;
  itemKind: KnowledgeItemKind;
  contentText: string | null;
  previewText: string | null;
  metadata: Record<string, unknown>;
  source: MindInputSource;
};

export type Observation = {
  id: string;
  label: ObservationLabel;
  description: string;
  evidence: string[];
  confidence: number;
  uncertainty: string;
};

export type Interpretation = {
  id: string;
  label: InterpretationLabel;
  description: string;
  basedOnObservationIds: string[];
  confidence: number;
  uncertainty: string;
};

export type Connection = {
  id: string;
  relatedKnowledgeItemId: string;
  relationshipType: RelationshipType;
  description: string;
  confidence: number;
  evidence: string[];
};

export type Explanation = {
  summary: string;
  evidence: string[];
  uncertainty: string;
  confidence: number;
};

export type PlanSuggestion = {
  id: string;
  actionType: PlanActionType;
  label: string;
  description: string;
  reason: string;
  confidence: number;
  requiresHumanApproval: true;
};

export type MindResult = {
  observations: Observation[];
  interpretations: Interpretation[];
  connections: Connection[];
  explanation: Explanation;
  planSuggestions: PlanSuggestion[];
  overallConfidence: number;
  warnings: string[];
};

export type ObserverResult = {
  observations: Observation[];
  warnings: string[];
};
