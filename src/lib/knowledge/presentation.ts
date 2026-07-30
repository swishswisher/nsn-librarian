import type {
  KnowledgeEvidenceSummary,
  KnowledgeObjectType,
  KnowledgeRelationshipSummary,
  KnowledgeRelationshipType,
} from "@/types/library";

const objectProposalLabels: Record<KnowledgeObjectType, string> = {
  CONCEPT: "Proposed concept",
  DECISION: "Proposed decision",
  FRAMEWORK: "Proposed framework",
  PERSON: "Proposed person",
  PREFERENCE: "Proposed preference",
  PROJECT: "Proposed project",
  RESOURCE: "Proposed resource",
  TOPIC: "Proposed topic",
  WEBSITE_ARTICLE: "Proposed website article",
  WORKSHOP: "Proposed workshop",
};

const organizationHistoryTypes = new Set<KnowledgeRelationshipType>([
  "FILE_MOVED_TO",
  "FILE_RENAMED_TO",
  "FILE_GROUPED_WITH",
  "FILE_USED_IN_PLAN",
  "FILE_INCLUDED_IN_EXECUTION",
]);

const relationshipLabels: Record<KnowledgeRelationshipType, string> = {
  CONTRADICTS: "contradicts",
  CREATED_BY: "created by",
  DERIVED_FROM: "derived from",
  DUPLICATES: "duplicates",
  EVOLVED_FROM: "evolved from",
  FILE_GROUPED_WITH: "grouped with",
  FILE_INCLUDED_IN_EXECUTION: "included in execution",
  FILE_MOVED_TO: "moved to",
  FILE_RENAMED_TO: "renamed to",
  FILE_USED_IN_PLAN: "used in plan",
  GROUPED_WITH: "grouped with",
  MENTIONS: "mentions",
  PART_OF: "part of",
  PREFERRED_OVER: "preferred over",
  RELATED_TO: "related to",
  SUPPORTS: "supports",
  SUITABLE_FOR: "suitable for",
  USED_IN: "used in",
};

export function knowledgeObjectProposalLabel(objectType: KnowledgeObjectType) {
  return objectProposalLabels[objectType];
}

export function isOrganizationHistoryRelationshipType(
  relationshipType: KnowledgeRelationshipType,
) {
  return organizationHistoryTypes.has(relationshipType);
}

export function formatKnowledgeRelationshipType(
  relationshipType: KnowledgeRelationshipType,
) {
  return relationshipLabels[relationshipType] ?? relationshipType.toLowerCase();
}

export function knowledgeRelationshipProposalLabel(
  relationship: Pick<KnowledgeRelationshipSummary, "relationshipType">,
) {
  return isOrganizationHistoryRelationshipType(relationship.relationshipType)
    ? "Organization history"
    : "Proposed relationship";
}

export function organizationHistoryLocationsFromEvidence(
  evidence: KnowledgeEvidenceSummary,
) {
  const currentPrefix = "Current location:";
  const plannedPrefix = "Planned or completed location:";
  const current = evidence.timeline
    .find((item) => item.startsWith(currentPrefix))
    ?.slice(currentPrefix.length)
    .trim();
  const plannedOrCompleted = evidence.timeline
    .find((item) => item.startsWith(plannedPrefix))
    ?.slice(plannedPrefix.length)
    .trim();

  return {
    current: current || null,
    plannedOrCompleted: plannedOrCompleted || null,
  };
}
