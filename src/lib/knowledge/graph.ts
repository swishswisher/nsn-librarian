import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import {
  getKnowledgeGraphRoute,
  getKnowledgeTopicRoute,
  getNotebookEntryRoute,
} from "@/lib/library/routes";
import type {
  KnowledgeEvidenceSummary,
  KnowledgeGraphPageData,
  KnowledgeHomepagePreview,
  KnowledgeObjectStatus,
  KnowledgeObjectSummary,
  KnowledgeObjectType,
  KnowledgeObjectRevisionSummary,
  KnowledgeReference,
  KnowledgeRelationshipSummary,
  KnowledgeRelationshipType,
  KnowledgeReviewPageData,
  KnowledgeTopicPageData,
  KnowledgeTrustLevel,
  NotebookSourceLink,
} from "@/types/library";

import {
  compactText,
  evidenceFromJson,
  extractKnowledgeCandidates,
  isWorkflowKnowledgeName,
  mergeKnowledgeEvidence,
  normalizeKnowledgeName,
  relationshipKeyFor,
  safeConfidence,
  toJsonInput,
} from "./provenance";
import type {
  KnowledgeObjectDraft,
  KnowledgeRelationshipDraft,
  KnowledgeSource,
  KnowledgeSourcePriority,
} from "./types";

const trustedMemoryStatus = "ACTIVE";
const reviewedObservationStatuses = new Set(["APPROVED", "MODIFIED"]);
const reviewedRecommendationStatuses = ["APPROVED", "MODIFIED"] as const;
const usableNotebookStatuses = [
  "CURRENT",
  "ACCEPTED",
  "NOTEBOOK_ONLY",
] as const;
const relationshipCandidateLimit = 4;
const backfillLimit = 32;

let backfillPromise: Promise<void> | null = null;

type StoredKnowledgeObject = {
  approvedAt: Date | null;
  approvedBy: string | null;
  canonicalObjectId: string | null;
  confidence: number;
  createdAt: Date;
  description: string;
  evidence: Prisma.JsonValue;
  firstSeen: Date;
  id: string;
  lastSeen: Date;
  name: string;
  normalizedName: string;
  objectType: string;
  occurrenceCount: number;
  provenanceSummary: string;
  sourceRelations?: { id: string }[];
  targetRelations?: { id: string }[];
  status: string;
  trustLevel: string;
  updatedAt: Date;
};

type StoredKnowledgeRelationship = {
  approvedAt: Date | null;
  confidence: number;
  createdAt: Date;
  evidence: Prisma.JsonValue;
  explanation: string;
  id: string;
  provenanceSummary: string;
  relationshipType: string;
  sourceObjectId: string;
  sourceObject: {
    name: string;
    objectType: string;
  };
  status: string;
  targetObjectId: string;
  targetObject: {
    name: string;
    objectType: string;
  };
  trustLevel: string;
};

type SourceObjectResult = {
  object: {
    id: string;
    name: string;
    objectType: string;
  };
  sourceKey: string;
};

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function objectStatusFrom(value: string): KnowledgeObjectStatus {
  if (
    value === "PROVISIONAL" ||
    value === "APPROVED" ||
    value === "REJECTED" ||
    value === "ARCHIVED"
  ) {
    return value;
  }

  return "PROVISIONAL";
}

function trustLevelFrom(value: string): KnowledgeTrustLevel {
  if (
    value === "PROVISIONAL" ||
    value === "HUMAN_APPROVED" ||
    value === "EXCLUDED"
  ) {
    return value;
  }

  return "PROVISIONAL";
}

function toKnowledgeObjectSummary(
  object: StoredKnowledgeObject,
): KnowledgeObjectSummary {
  return {
    approvedAt: object.approvedAt?.toISOString() ?? null,
    approvedBy: object.approvedBy,
    canonicalObjectId: object.canonicalObjectId,
    confidence: object.confidence,
    createdAt: object.createdAt.toISOString(),
    description: object.description,
    evidence: evidenceFromJson(object.evidence),
    firstSeen: object.firstSeen.toISOString(),
    id: object.id,
    lastSeen: object.lastSeen.toISOString(),
    name: object.name,
    normalizedName: object.normalizedName,
    objectType: object.objectType as KnowledgeObjectType,
    occurrenceCount: object.occurrenceCount,
    provenanceSummary: object.provenanceSummary,
    relationshipCount:
      (object.sourceRelations?.length ?? 0) + (object.targetRelations?.length ?? 0),
    status: objectStatusFrom(object.status),
    trustLevel: trustLevelFrom(object.trustLevel),
    updatedAt: object.updatedAt.toISOString(),
  };
}

function toKnowledgeRelationshipSummary(
  relationship: StoredKnowledgeRelationship,
): KnowledgeRelationshipSummary {
  return {
    approvedAt: relationship.approvedAt?.toISOString() ?? null,
    confidence: relationship.confidence,
    createdAt: relationship.createdAt.toISOString(),
    evidence: evidenceFromJson(relationship.evidence),
    explanation: relationship.explanation,
    id: relationship.id,
    provenanceSummary: relationship.provenanceSummary,
    relationshipType:
      relationship.relationshipType as KnowledgeRelationshipType,
    sourceName: relationship.sourceObject.name,
    sourceObjectId: relationship.sourceObjectId,
    sourceType: relationship.sourceObject.objectType as KnowledgeObjectType,
    status: objectStatusFrom(relationship.status),
    targetName: relationship.targetObject.name,
    targetObjectId: relationship.targetObjectId,
    targetType: relationship.targetObject.objectType as KnowledgeObjectType,
    trustLevel: trustLevelFrom(relationship.trustLevel),
  };
}

function toKnowledgeRevisionSummary(revision: {
  actionType: string;
  createdAt: Date;
  createdBy: string | null;
  id: string;
  note: string | null;
  previousName: string | null;
  revisedName: string | null;
}): KnowledgeObjectRevisionSummary {
  return {
    actionType: revision.actionType,
    createdAt: revision.createdAt.toISOString(),
    createdBy: revision.createdBy,
    id: revision.id,
    note: revision.note,
    previousName: revision.previousName,
    revisedName: revision.revisedName,
  };
}

function jsonToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(jsonToText).join(" ");
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).map(jsonToText).join(" ");
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFromRecord(
  value: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const candidate = value[key];

    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function sourcePriority(source: KnowledgeSource): KnowledgeSourcePriority {
  if (source.sourcePriority) {
    return source.sourcePriority;
  }

  if (source.sourceKind === "MEMORY") {
    return "HIGH";
  }

  if (
    source.sourceKind === "OBSERVATION" ||
    source.sourceKind === "RECOMMENDATION" ||
    source.sourceKind === "NOTEBOOK" ||
    source.sourceKind === "AUDIO_RECORDING" ||
    source.sourceKind === "VIDEO_RECORDING"
  ) {
    return "MEDIUM";
  }

  return "LOW";
}

function isTopicLikeObjectType(objectType: KnowledgeObjectType) {
  return (
    objectType === "TOPIC" ||
    objectType === "CONCEPT" ||
    objectType === "FRAMEWORK"
  );
}

function sourceKeysFromJson(value: Prisma.JsonValue) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function objectHasReviewedMeaningfulSource(object: {
  sourceKeys: Prisma.JsonValue;
  status: string;
  trustLevel: string;
}) {
  if (object.status === "APPROVED" || object.trustLevel === "HUMAN_APPROVED") {
    return true;
  }

  return sourceKeysFromJson(object.sourceKeys).some((sourceKey) =>
    /^(memory|notebook|observation|recommendation|audio-recording|video-recording):/.test(
      sourceKey,
    ),
  );
}

async function shouldCreateObjectForSource(
  source: KnowledgeSource,
  draft: KnowledgeObjectDraft,
) {
  if (isWorkflowKnowledgeName(draft.name)) {
    return false;
  }

  if (sourcePriority(source) !== "LOW" || !isTopicLikeObjectType(draft.objectType)) {
    return true;
  }

  const prisma = getPrismaClient();
  const existing = await prisma.knowledgeObject.findUnique({
    select: {
      sourceKeys: true,
      status: true,
      trustLevel: true,
    },
    where: {
      objectType_normalizedName: {
        normalizedName: normalizeKnowledgeName(draft.name),
        objectType: draft.objectType,
      },
    },
  });

  return existing ? objectHasReviewedMeaningfulSource(existing) : false;
}

function sourceEvidence(source: KnowledgeSource): KnowledgeEvidenceSummary {
  return mergeKnowledgeEvidence(source.evidence, {
    appearedIn: [source.appearedIn],
    timeline: [`Seen: ${source.occurredAt.toLocaleDateString("en-US")}`],
    whyProposed: [source.provenanceSummary],
  });
}

function objectDescription(name: string, source: KnowledgeSource) {
  return compactText(
    `${name} appears in ${source.appearedIn}. ${source.text}`,
    260,
  );
}

function makeObjectDrafts(source: KnowledgeSource): KnowledgeObjectDraft[] {
  return extractKnowledgeCandidates(source.text).map((candidate) => ({
    approvedAt: source.approvedAt,
    approvedBy: source.approvedBy,
    confidence: source.confidence,
    description: objectDescription(candidate.name, source),
    evidence: sourceEvidence(source),
    firstSeen: source.occurredAt,
    lastSeen: source.occurredAt,
    name: candidate.name,
    objectType: candidate.objectType,
    provenanceSummary: source.provenanceSummary,
    sourceKey: source.sourceKey,
    status: source.status,
    trustLevel: source.trustLevel,
  }));
}

async function upsertKnowledgeObject(draft: KnowledgeObjectDraft) {
  const prisma = getPrismaClient();
  const normalizedName = normalizeKnowledgeName(draft.name);
  const existing = await prisma.knowledgeObject.findUnique({
    where: {
      objectType_normalizedName: {
        normalizedName,
        objectType: draft.objectType,
      },
    },
  });

  if (!existing) {
    try {
      return await prisma.knowledgeObject.create({
        data: {
          approvedAt: draft.approvedAt ?? null,
          approvedBy: draft.approvedBy ?? null,
          confidence: safeConfidence(draft.confidence),
          description: draft.description,
          evidence: toJsonInput(mergeKnowledgeEvidence(null, draft.evidence)),
          firstSeen: draft.firstSeen ?? new Date(),
          lastSeen: draft.lastSeen ?? new Date(),
          name: draft.name,
          normalizedName,
          objectType: draft.objectType,
          provenanceSummary: draft.provenanceSummary,
          sourceKeys: toJsonInput([draft.sourceKey]),
          status: draft.status,
          trustLevel: draft.trustLevel,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      return upsertKnowledgeObject(draft);
    }
  }

  const existingSourceKeys = Array.isArray(existing.sourceKeys)
    ? existing.sourceKeys.filter((item): item is string => typeof item === "string")
    : [];
  const alreadySawSource = existingSourceKeys.includes(draft.sourceKey);
  const sourceKeys = [...new Set([...existingSourceKeys, draft.sourceKey])];
  const existingEvidence = evidenceFromJson(existing.evidence);
  const shouldElevate =
    draft.status === "APPROVED" && existing.status !== "APPROVED";
  const status = shouldElevate ? "APPROVED" : existing.status;
  const trustLevel = shouldElevate ? "HUMAN_APPROVED" : existing.trustLevel;
  const confidence = safeConfidence(Math.max(existing.confidence, draft.confidence));

  return prisma.knowledgeObject.update({
    data: {
      approvedAt: shouldElevate ? (draft.approvedAt ?? new Date()) : existing.approvedAt,
      approvedBy: shouldElevate ? (draft.approvedBy ?? "Deanne") : existing.approvedBy,
      confidence,
      description:
        existing.description.length >= draft.description.length
          ? existing.description
          : draft.description,
      evidence: toJsonInput(mergeKnowledgeEvidence(existingEvidence, draft.evidence)),
      lastSeen:
        draft.lastSeen && draft.lastSeen > existing.lastSeen
          ? draft.lastSeen
          : existing.lastSeen,
      occurrenceCount: alreadySawSource
        ? existing.occurrenceCount
        : existing.occurrenceCount + 1,
      provenanceSummary: existing.provenanceSummary.includes(draft.provenanceSummary)
        ? existing.provenanceSummary
        : `${existing.provenanceSummary} ${draft.provenanceSummary}`,
      sourceKeys: toJsonInput(sourceKeys.filter(Boolean)),
      status,
      trustLevel,
    },
    where: { id: existing.id },
  });
}

async function upsertKnowledgeRelationship(
  sourceObjectId: string,
  targetObjectId: string,
  draft: KnowledgeRelationshipDraft,
) {
  if (sourceObjectId === targetObjectId) {
    return null;
  }

  const prisma = getPrismaClient();
  const relationshipKey = relationshipKeyFor(
    sourceObjectId,
    targetObjectId,
    draft.relationshipType,
  );
  const existing = await prisma.knowledgeRelationship.findUnique({
    where: { relationshipKey },
  });

  if (!existing) {
    try {
      return await prisma.knowledgeRelationship.create({
        data: {
          confidence: safeConfidence(draft.confidence),
          evidence: toJsonInput(mergeKnowledgeEvidence(null, draft.evidence)),
          explanation: draft.explanation,
          provenanceSummary: draft.provenanceSummary,
          relationshipKey,
          relationshipType: draft.relationshipType,
          sourceObjectId,
          status: draft.status,
          targetObjectId,
          trustLevel: draft.trustLevel,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      return upsertKnowledgeRelationship(sourceObjectId, targetObjectId, draft);
    }
  }

  const existingEvidence = evidenceFromJson(existing.evidence);
  const shouldElevate =
    draft.status === "APPROVED" && existing.status !== "APPROVED";

  return prisma.knowledgeRelationship.update({
    data: {
      approvedAt: shouldElevate ? new Date() : existing.approvedAt,
      confidence: safeConfidence(Math.max(existing.confidence, draft.confidence)),
      evidence: toJsonInput(mergeKnowledgeEvidence(existingEvidence, draft.evidence)),
      explanation:
        existing.explanation.length >= draft.explanation.length
          ? existing.explanation
          : draft.explanation,
      provenanceSummary: existing.provenanceSummary.includes(draft.provenanceSummary)
        ? existing.provenanceSummary
        : `${existing.provenanceSummary} ${draft.provenanceSummary}`,
      status: shouldElevate ? "APPROVED" : existing.status,
      trustLevel: shouldElevate ? "HUMAN_APPROVED" : existing.trustLevel,
    },
    where: { id: existing.id },
  });
}

async function createObjectsForSource(source: KnowledgeSource) {
  const objects: SourceObjectResult[] = [];

  for (const draft of makeObjectDrafts(source)) {
    if (!(await shouldCreateObjectForSource(source, draft))) {
      continue;
    }

    const object = await upsertKnowledgeObject(draft);

    objects.push({
      object: {
        id: object.id,
        name: object.name,
        objectType: object.objectType,
      },
      sourceKey: source.sourceKey,
    });
  }

  return objects;
}

async function createRelationshipsForSource(
  source: KnowledgeSource,
  objects: SourceObjectResult[],
) {
  const candidates = objects.slice(0, relationshipCandidateLimit);

  for (let index = 0; index < candidates.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < candidates.length; nextIndex += 1) {
      const sourceObject = candidates[index];
      const targetObject = candidates[nextIndex];

      if (!sourceObject || !targetObject) {
        continue;
      }

      await upsertKnowledgeRelationship(sourceObject.object.id, targetObject.object.id, {
        confidence: safeConfidence(source.confidence - 0.08),
        evidence: sourceEvidence(source),
        explanation:
          "The Librarian noticed these ideas appearing in the same reviewed context. This suggests a possible relationship, not a final conclusion.",
        provenanceSummary: source.provenanceSummary,
        relationshipType: "RELATED_TO",
        sourceKey: source.sourceKey,
        status: source.status,
        trustLevel: source.trustLevel,
      });
    }
  }
}

function normalizeEvidencePath(value: string | null | undefined) {
  return value?.replaceAll("\\", "/").replace(/^\/+/, "").trim() ?? "";
}

function folderFromRelativePath(relativePath: string) {
  const normalized = normalizeEvidencePath(relativePath);
  const lastSlash = normalized.lastIndexOf("/");

  return lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
}

function fileNameFromRelativePath(relativePath: string) {
  const normalized = normalizeEvidencePath(relativePath);
  const lastSlash = normalized.lastIndexOf("/");

  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

function joinRelativePath(folder: string, fileName: string) {
  const normalizedFolder = normalizeEvidencePath(folder);
  const normalizedFileName = normalizeEvidencePath(fileName);

  return normalizedFolder
    ? `${normalizedFolder}/${normalizedFileName}`
    : normalizedFileName;
}

function isSystemFixturePath(value: string | null | undefined) {
  const normalized = normalizeKnowledgeName(value ?? "");

  return (
    /\bcodex\b/.test(normalized) ||
    /\bmanual milestone\b/.test(normalized) ||
    /\bsmoke test\b/.test(normalized) ||
    (/\btest\b/.test(normalized) &&
      /\b(execution|fixture|move source|organized|temporary)\b/.test(normalized))
  );
}

function destinationForRecommendation(recommendation: {
  currentRelativePath: string;
  proposedFileName: string | null;
  proposedRelativePath: string | null;
  revisions: {
    revisedFileName: string | null;
    revisedRelativePath: string | null;
  }[];
}) {
  const latestRevision = recommendation.revisions[0] ?? null;
  const currentRelativePath = normalizeEvidencePath(recommendation.currentRelativePath);
  const revisedRelativePath = normalizeEvidencePath(
    latestRevision?.revisedRelativePath,
  );
  const revisedFileName = normalizeEvidencePath(latestRevision?.revisedFileName);
  const proposedRelativePath = normalizeEvidencePath(
    recommendation.proposedRelativePath,
  );
  const proposedFileName = normalizeEvidencePath(recommendation.proposedFileName);

  if (revisedRelativePath) {
    return revisedFileName
      ? joinRelativePath(folderFromRelativePath(revisedRelativePath), revisedFileName)
      : revisedRelativePath;
  }

  if (revisedFileName) {
    return joinRelativePath(
      folderFromRelativePath(proposedRelativePath || currentRelativePath),
      revisedFileName,
    );
  }

  if (proposedRelativePath) {
    return proposedFileName
      ? joinRelativePath(folderFromRelativePath(proposedRelativePath), proposedFileName)
      : proposedRelativePath;
  }

  if (proposedFileName) {
    return joinRelativePath(folderFromRelativePath(currentRelativePath), proposedFileName);
  }

  return "";
}

function organizationRelationshipTypeForSuggestion(
  suggestionType: string,
): KnowledgeRelationshipType | null {
  if (suggestionType === "MOVE_FILE") {
    return "FILE_MOVED_TO";
  }

  if (suggestionType === "RENAME_FILE") {
    return "FILE_RENAMED_TO";
  }

  if (
    suggestionType === "GROUP_WITH_FILES" ||
    suggestionType === "POSSIBLE_DUPLICATE"
  ) {
    return "FILE_GROUPED_WITH";
  }

  if (suggestionType === "CREATE_FOLDER" || suggestionType === "WEBSITE_CANDIDATE") {
    return "FILE_USED_IN_PLAN";
  }

  return null;
}

function organizationRelationshipTypeForPlanAction(
  actionType: string,
  suggestionType: string | null,
): KnowledgeRelationshipType | null {
  if (suggestionType) {
    const fromSuggestion = organizationRelationshipTypeForSuggestion(suggestionType);

    if (fromSuggestion) {
      return fromSuggestion;
    }
  }

  if (actionType === "MOVE_FILE") {
    return "FILE_MOVED_TO";
  }

  if (actionType === "RENAME_FILE") {
    return "FILE_RENAMED_TO";
  }

  if (actionType === "CREATE_FOLDER" || actionType === "WEBSITE_ACTION") {
    return "FILE_USED_IN_PLAN";
  }

  return null;
}

function organizationActionLabel(relationshipType: KnowledgeRelationshipType) {
  if (relationshipType === "FILE_MOVED_TO") {
    return "moved toward";
  }

  if (relationshipType === "FILE_RENAMED_TO") {
    return "renamed toward";
  }

  if (relationshipType === "FILE_GROUPED_WITH") {
    return "grouped with";
  }

  if (relationshipType === "FILE_INCLUDED_IN_EXECUTION") {
    return "included in execution";
  }

  return "used in plan";
}

async function upsertOrganizationHistoryObject({
  name,
  pathLabel,
  source,
}: {
  name: string;
  pathLabel: string;
  source: KnowledgeSource;
}) {
  return upsertKnowledgeObject({
    confidence: source.confidence,
    description: `${name} appears as part of organization history for ${pathLabel}.`,
    evidence: sourceEvidence(source),
    firstSeen: source.occurredAt,
    lastSeen: source.occurredAt,
    name,
    objectType: "RESOURCE",
    provenanceSummary: source.provenanceSummary,
    sourceKey: `${source.sourceKey}:${normalizeKnowledgeName(name)}`,
    status: "PROVISIONAL",
    trustLevel: "PROVISIONAL",
  });
}

async function createOrganizationHistoryRelationship({
  currentRelativePath,
  destinationRelativePath,
  occurredAt,
  provenanceSummary,
  relatedPlans,
  relatedRecommendations,
  relationshipType,
  sourceKey,
  title,
}: {
  currentRelativePath: string;
  destinationRelativePath: string;
  occurredAt: Date;
  provenanceSummary: string;
  relatedPlans?: string[];
  relatedRecommendations?: string[];
  relationshipType: KnowledgeRelationshipType;
  sourceKey: string;
  title: string;
}) {
  const sourcePath = normalizeEvidencePath(currentRelativePath);
  const destinationPath = normalizeEvidencePath(destinationRelativePath);

  if (
    !sourcePath ||
    !destinationPath ||
    isSystemFixturePath(sourcePath) ||
    isSystemFixturePath(destinationPath)
  ) {
    return;
  }

  const source: KnowledgeSource = {
    appearedIn: title,
    confidence: 0.5,
    evidence: {
      appearedIn: [title],
      relatedFiles: [sourcePath, destinationPath],
      relatedPlans: relatedPlans ?? [],
      relatedRecommendations: relatedRecommendations ?? [],
      timeline: [
        `Current location: ${sourcePath}`,
        `Planned or completed location: ${destinationPath}`,
      ],
      whyProposed: [
        "Observed in organization history. This records a file organization action, not a knowledge topic.",
      ],
    },
    occurredAt,
    provenanceSummary,
    sourceId: sourceKey,
    sourceKey,
    sourceKind: "ORGANIZATION_HISTORY",
    sourcePriority: "LOW",
    status: "PROVISIONAL",
    text: "",
    trustLevel: "PROVISIONAL",
  };
  const sourceObject = await upsertOrganizationHistoryObject({
    name: `File: ${fileNameFromRelativePath(sourcePath)}`,
    pathLabel: sourcePath,
    source,
  });
  const targetObject = await upsertOrganizationHistoryObject({
    name: `Location: ${destinationPath}`,
    pathLabel: destinationPath,
    source,
  });
  const actionLabel = organizationActionLabel(relationshipType);

  await upsertKnowledgeRelationship(sourceObject.id, targetObject.id, {
    confidence: source.confidence,
    evidence: sourceEvidence(source),
    explanation: `Observed in organization history. ${sourcePath} was ${actionLabel} ${destinationPath}. This is a historical organization action, not a standalone knowledge topic.`,
    provenanceSummary,
    relationshipType,
    sourceKey: `${sourceKey}:relationship`,
    status: "PROVISIONAL",
    trustLevel: "PROVISIONAL",
  });
}

async function createOrganizationHistoryRelationshipForRecommendation(
  recommendation: {
    currentRelativePath: string;
    id: string;
    proposedFileName: string | null;
    proposedRelativePath: string | null;
    reviewedAt: Date | null;
    suggestionType: string;
    title: string;
    updatedAt: Date;
    revisions: {
      revisedFileName: string | null;
      revisedRelativePath: string | null;
    }[];
  },
) {
  const relationshipType = organizationRelationshipTypeForSuggestion(
    recommendation.suggestionType,
  );
  const destination = destinationForRecommendation(recommendation);

  if (!relationshipType || !destination) {
    return;
  }

  await createOrganizationHistoryRelationship({
    currentRelativePath: recommendation.currentRelativePath,
    destinationRelativePath: destination,
    occurredAt: recommendation.reviewedAt ?? recommendation.updatedAt,
    provenanceSummary:
      "The Librarian recorded this as organization history after Deanne reviewed a recommendation.",
    relatedRecommendations: [recommendation.id],
    relationshipType,
    sourceKey: `organization-history:recommendation:${recommendation.id}`,
    title: `Reviewed recommendation: ${recommendation.title}`,
  });
}

function planActionRecords(value: Prisma.JsonValue) {
  if (!Array.isArray(value)) {
    return [];
  }

  const records: Record<string, unknown>[] = [];

  for (const item of value) {
    if (isRecord(item)) {
      records.push(item);
    }
  }

  return records;
}

async function createOrganizationHistoryRelationshipsForPlan(plan: {
  actions: Prisma.JsonValue;
  id: string;
  scanSession: {
    connectedFolder: {
      displayName: string;
    };
  };
  updatedAt: Date;
}) {
  for (const action of planActionRecords(plan.actions)) {
    const actionType = stringFromRecord(action, ["actionType"]) ?? "";
    const suggestionType = stringFromRecord(action, ["suggestionType"]);
    const relationshipType = organizationRelationshipTypeForPlanAction(
      actionType,
      suggestionType,
    );
    const sourcePath = stringFromRecord(action, [
      "sourceRelativePath",
      "currentRelativePath",
    ]);
    const destinationPath = stringFromRecord(action, [
      "plannedRelativePath",
      "plannedFolderPath",
      "destinationRelativePath",
      "proposedRelativePath",
    ]);

    if (!relationshipType || !sourcePath || !destinationPath) {
      continue;
    }

    const suggestionId = stringFromRecord(action, ["suggestionId"]);
    const actionId = stringFromRecord(action, ["id"]) ?? normalizeKnowledgeName(
      `${actionType}:${sourcePath}:${destinationPath}`,
    );

    await createOrganizationHistoryRelationship({
      currentRelativePath: sourcePath,
      destinationRelativePath: destinationPath,
      occurredAt: plan.updatedAt,
      provenanceSummary:
        "The Librarian recorded this as organization history from an Organization Plan.",
      relatedPlans: [plan.id],
      relatedRecommendations: suggestionId ? [suggestionId] : [],
      relationshipType,
      sourceKey: `organization-history:plan:${plan.id}:${actionId}`,
      title: `Organization Plan: ${plan.scanSession.connectedFolder.displayName}`,
    });
  }
}

function memoryObjectType(memoryType: string): KnowledgeObjectType {
  if (memoryType === "PREFERENCE") {
    return "PREFERENCE";
  }

  if (memoryType === "RELATIONSHIP") {
    return "CONCEPT";
  }

  if (memoryType === "TERM") {
    return "CONCEPT";
  }

  return "TOPIC";
}

function preferenceTermsFromText(value: string) {
  const quoted = [...value.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  if (quoted.length >= 2) {
    return { preferred: quoted[0], replaced: quoted[1] };
  }

  const arrow = value.match(/(.+?)\s*(?:->|→| to )\s*(.+)/i);

  if (arrow?.[1] && arrow[2]) {
    return {
      preferred: arrow[2].trim(),
      replaced: arrow[1].trim(),
    };
  }

  const over = value.match(/prefers?\s+(.+?)\s+over\s+(.+)/i);

  if (over?.[1] && over[2]) {
    return {
      preferred: over[1].trim(),
      replaced: over[2].trim(),
    };
  }

  return null;
}

async function backfillMemoryKnowledge() {
  const prisma = getPrismaClient();
  const entries = await prisma.memoryEntry.findMany({
    orderBy: { updatedAt: "desc" },
    take: backfillLimit,
    where: { status: trustedMemoryStatus },
  });

  for (const entry of entries) {
    const source: KnowledgeSource = {
      appearedIn: `Memory: ${entry.title}`,
      approvedAt: entry.updatedAt,
      approvedBy: "Deanne",
      confidence: Math.max(entry.confidence, 0.72),
      evidence: {
        appearedIn: [`Memory: ${entry.title}`],
        timeline: [
          `First seen: ${entry.firstSeen.toLocaleDateString("en-US")}`,
          `Last seen: ${entry.lastSeen.toLocaleDateString("en-US")}`,
        ],
        whyProposed: [
          "This came from approved Memory, so it can be represented as trusted Knowledge Graph material.",
        ],
      },
      occurredAt: entry.lastSeen,
      provenanceSummary:
        "The Librarian created this graph item from approved Memory.",
      sourceId: entry.id,
      sourceKey: `memory:${entry.id}`,
      sourceKind: "MEMORY",
      sourcePriority: "HIGH",
      status: "APPROVED",
      text: `${entry.title}. ${entry.description}. ${jsonToText(entry.evidence)}`,
      trustLevel: "HUMAN_APPROVED",
    };
    const primary = await upsertKnowledgeObject({
      approvedAt: entry.updatedAt,
      approvedBy: "Deanne",
      confidence: source.confidence,
      description: entry.description,
      evidence: sourceEvidence(source),
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      name: entry.title,
      objectType: memoryObjectType(entry.memoryType),
      provenanceSummary: source.provenanceSummary,
      sourceKey: source.sourceKey,
      status: "APPROVED",
      trustLevel: "HUMAN_APPROVED",
    });
    const objects = await createObjectsForSource(source);

    objects.unshift({
      object: {
        id: primary.id,
        name: primary.name,
        objectType: primary.objectType,
      },
      sourceKey: source.sourceKey,
    });
    await createRelationshipsForSource(source, objects);

    if (entry.memoryType === "PREFERENCE") {
      const preference = preferenceTermsFromText(`${entry.title}. ${entry.description}`);

      if (preference) {
        const preferred = await upsertKnowledgeObject({
          approvedAt: entry.updatedAt,
          approvedBy: "Deanne",
          confidence: source.confidence,
          description: `Deanne has approved ${preference.preferred} as preferred language in this context.`,
          evidence: sourceEvidence(source),
          firstSeen: entry.firstSeen,
          lastSeen: entry.lastSeen,
          name: preference.preferred,
          objectType: "CONCEPT",
          provenanceSummary: source.provenanceSummary,
          sourceKey: `${source.sourceKey}:preferred`,
          status: "APPROVED",
          trustLevel: "HUMAN_APPROVED",
        });
        const replaced = await upsertKnowledgeObject({
          approvedAt: entry.updatedAt,
          approvedBy: "Deanne",
          confidence: source.confidence,
          description: `${preference.replaced} is the earlier wording in this approved preference.`,
          evidence: sourceEvidence(source),
          firstSeen: entry.firstSeen,
          lastSeen: entry.lastSeen,
          name: preference.replaced,
          objectType: "CONCEPT",
          provenanceSummary: source.provenanceSummary,
          sourceKey: `${source.sourceKey}:replaced`,
          status: "APPROVED",
          trustLevel: "HUMAN_APPROVED",
        });

        await upsertKnowledgeRelationship(preferred.id, replaced.id, {
          confidence: source.confidence,
          evidence: sourceEvidence(source),
          explanation: `Deanne has repeatedly preferred "${preference.preferred}" over "${preference.replaced}" in reviewed decisions.`,
          provenanceSummary: source.provenanceSummary,
          relationshipType: "PREFERRED_OVER",
          sourceKey: `${source.sourceKey}:preferred-over`,
          status: "APPROVED",
          trustLevel: "HUMAN_APPROVED",
        });
      }
    }
  }
}

async function backfillNotebookKnowledge() {
  const prisma = getPrismaClient();
  const entries = await prisma.notebookEntry.findMany({
    orderBy: { updatedAt: "desc" },
    take: backfillLimit,
    where: {
      status: { in: [...usableNotebookStatuses] },
    },
  });

  for (const entry of entries) {
    const source: KnowledgeSource = {
      appearedIn: `Notebook: ${entry.title}`,
      confidence: entry.approvedForMemory ? 0.7 : 0.52,
      evidence: {
        appearedIn: [`Notebook: ${entry.title}`],
        relatedNotebookEntryIds: [entry.id],
      },
      occurredAt: entry.updatedAt,
      provenanceSummary:
        "The Librarian proposed this graph item from a Notebook reflection. It stays provisional until reviewed.",
      sourceId: entry.id,
      sourceKey: `notebook:${entry.id}`,
      sourceKind: "NOTEBOOK",
      sourcePriority: entry.approvedForMemory ? "HIGH" : "MEDIUM",
      status: "PROVISIONAL",
      text: `${entry.title}. ${entry.summary}. ${entry.body}`,
      trustLevel: "PROVISIONAL",
    };
    const objects = await createObjectsForSource(source);

    await createRelationshipsForSource(source, objects);
  }
}

async function backfillObservationKnowledge() {
  const prisma = getPrismaClient();
  const decisions = await prisma.humanDecision.findMany({
    include: {
      observationSession: {
        include: {
          libraryDocument: {
            select: {
              originalFileName: true,
              scannedFiles: {
                select: {
                  id: true,
                  relativePath: true,
                  sessionId: true,
                },
                take: 1,
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: backfillLimit,
    where: { decisionType: { not: "REJECT" } },
  });

  for (const decision of decisions) {
    const session = decision.observationSession;

    if (!reviewedObservationStatuses.has(session.status)) {
      continue;
    }

    const scannedFile = session.libraryDocument.scannedFiles[0] ?? null;
    const source: KnowledgeSource = {
      appearedIn: `Reviewed observation: ${session.libraryDocument.originalFileName}`,
      confidence: Math.max(session.confidence, 0.55),
      evidence: {
        appearedIn: [
          `Reviewed observation: ${session.libraryDocument.originalFileName}`,
        ],
        relatedFiles: scannedFile ? [scannedFile.relativePath] : [],
      },
      occurredAt: decision.createdAt,
      provenanceSummary:
        "The Librarian proposed this graph item from an observation that Deanne reviewed.",
      sourceId: session.id,
      sourceKey: `observation:${session.id}:${decision.id}`,
      sourceKind: "OBSERVATION",
      sourcePriority: "MEDIUM",
      status: "PROVISIONAL",
      text: [
        jsonToText(session.observations),
        jsonToText(session.interpretations),
        jsonToText(session.explanation),
        decision.note ?? "",
        decision.editedSuggestion ?? "",
      ].join(" "),
      trustLevel: "PROVISIONAL",
    };
    const objects = await createObjectsForSource(source);

    await createRelationshipsForSource(source, objects);
  }
}

async function backfillRecommendationKnowledge() {
  const prisma = getPrismaClient();
  const recommendations = await prisma.organizationSuggestion.findMany({
    include: {
      revisions: { orderBy: { createdAt: "desc" }, take: 1 },
      scannedFile: {
        select: {
          relativePath: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: backfillLimit,
    where: { status: { in: [...reviewedRecommendationStatuses] } },
  });

  for (const recommendation of recommendations) {
    await createOrganizationHistoryRelationshipForRecommendation(recommendation);

    const latestRevision = recommendation.revisions[0] ?? null;
    const source: KnowledgeSource = {
      appearedIn: `Reviewed recommendation: ${recommendation.title}`,
      confidence: Math.max(recommendation.confidence, 0.5),
      evidence: {
        appearedIn: [`Reviewed recommendation: ${recommendation.title}`],
        relatedFiles: [recommendation.currentRelativePath],
        relatedRecommendations: [recommendation.id],
      },
      occurredAt: recommendation.reviewedAt ?? recommendation.updatedAt,
      provenanceSummary:
        "The Librarian proposed this graph item from a reviewed organization recommendation.",
      sourceId: recommendation.id,
      sourceKey: `recommendation:${recommendation.id}`,
      sourceKind: "RECOMMENDATION",
      sourcePriority: "MEDIUM",
      status: "PROVISIONAL",
      text: [
        recommendation.explanation,
        latestRevision?.context ?? "",
      ].join(" "),
      trustLevel: "PROVISIONAL",
    };
    const objects = await createObjectsForSource(source);

    await createRelationshipsForSource(source, objects);
  }
}

async function backfillAudioKnowledge() {
  const prisma = getPrismaClient();
  const recordings = await prisma.audioRecordingMetadata.findMany({
    include: {
      scannedFile: {
        select: {
          relativePath: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: backfillLimit,
  });

  for (const recording of recordings) {
    const text = [
      recording.summary ?? "",
      jsonToText(recording.machineLabels),
      jsonToText(recording.provisionalTopics),
      jsonToText(recording.provisionalPeople),
      jsonToText(recording.provisionalProjects),
      jsonToText(recording.provisionalActionItems),
      jsonToText(recording.provisionalQuestions),
    ].join(" ");

    if (!text.trim()) {
      continue;
    }

    const source: KnowledgeSource = {
      appearedIn: `Audio recording: ${recording.scannedFile.relativePath}`,
      confidence: recording.transcriptionStatus === "COMPLETED" ? 0.52 : 0.38,
      evidence: {
        appearedIn: [`Audio recording: ${recording.scannedFile.relativePath}`],
        relatedFiles: [recording.scannedFile.relativePath],
      },
      occurredAt: recording.updatedAt,
      provenanceSummary:
        "The Librarian proposed these graph items from provisional audio metadata. Deanne must review them before they become trusted Memory.",
      sourceId: recording.id,
      sourceKey: `audio-recording:${recording.id}`,
      sourceKind: "AUDIO_RECORDING",
      sourcePriority: "MEDIUM",
      status: "PROVISIONAL",
      text,
      trustLevel: "PROVISIONAL",
    };
    const objects = await createObjectsForSource(source);

    await createRelationshipsForSource(source, objects);
  }
}

async function backfillVideoKnowledge() {
  const prisma = getPrismaClient();
  const videos = await prisma.videoRecordingMetadata.findMany({
    include: {
      scannedFile: {
        select: {
          relativePath: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: backfillLimit,
  });

  for (const video of videos) {
    const text = [
      video.summary ?? "",
      jsonToText(video.machineLabels),
      jsonToText(video.provisionalTopics),
      jsonToText(video.provisionalPeople),
      jsonToText(video.provisionalProjects),
      jsonToText(video.provisionalQuestions),
      jsonToText(video.chapterSuggestions),
      jsonToText(video.selectedFrameDescriptions),
    ].join(" ");

    if (!text.trim()) {
      continue;
    }

    const source: KnowledgeSource = {
      appearedIn: `Video recording: ${video.scannedFile.relativePath}`,
      confidence: video.transcriptionStatus === "COMPLETED" ? 0.54 : 0.4,
      evidence: {
        appearedIn: [`Video recording: ${video.scannedFile.relativePath}`],
        relatedFiles: [video.scannedFile.relativePath],
      },
      occurredAt: video.updatedAt,
      provenanceSummary:
        "The Librarian proposed these graph items from provisional video metadata, transcript snippets, and selected-frame notes. Deanne must review them before they become trusted Memory.",
      sourceId: video.id,
      sourceKey: `video-recording:${video.id}`,
      sourceKind: "VIDEO_RECORDING",
      sourcePriority: "MEDIUM",
      status: "PROVISIONAL",
      text,
      trustLevel: "PROVISIONAL",
    };
    const objects = await createObjectsForSource(source);

    await createRelationshipsForSource(source, objects);
  }
}

async function backfillOrganizationPlanKnowledge() {
  const prisma = getPrismaClient();
  const plans = await prisma.organizationPlan.findMany({
    include: {
      scanSession: {
        select: {
          connectedFolder: {
            select: { displayName: true },
          },
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: backfillLimit,
    where: { status: { not: "CANCELLED" } },
  });

  for (const plan of plans) {
    await createOrganizationHistoryRelationshipsForPlan(plan);
  }
}

export async function cleanupWorkflowKnowledgeNoise() {
  const prisma = getPrismaClient();
  const candidates = await prisma.knowledgeObject.findMany({
    select: {
      id: true,
      name: true,
      objectType: true,
      status: true,
      trustLevel: true,
    },
    where: {
      canonicalObjectId: null,
      objectType: { in: ["TOPIC", "CONCEPT", "FRAMEWORK"] },
      status: { not: "ARCHIVED" },
      trustLevel: { not: "HUMAN_APPROVED" },
    },
  });
  const noisyObjects = candidates.filter((object) =>
    isWorkflowKnowledgeName(object.name),
  );

  for (const object of noisyObjects) {
    await prisma.$transaction(async (transaction) => {
      const relationships = await transaction.knowledgeRelationship.findMany({
        select: {
          id: true,
          relationshipType: true,
          status: true,
        },
        where: {
          OR: [{ sourceObjectId: object.id }, { targetObjectId: object.id }],
          status: { not: "ARCHIVED" },
        },
      });
      const existingRevision =
        await transaction.knowledgeObjectRevision.findFirst({
          select: { id: true },
          where: {
            actionType: "REJECTED_SYSTEM_NOISE",
            objectId: object.id,
          },
        });

      await transaction.knowledgeObject.update({
        data: {
          status: "ARCHIVED",
          trustLevel: "EXCLUDED",
        },
        where: { id: object.id },
      });

      if (!existingRevision) {
        await transaction.knowledgeObjectRevision.create({
          data: {
            actionType: "REJECTED_SYSTEM_NOISE",
            createdBy: "System",
            note: "Archived because this looked like workflow or execution language, not knowledge Deanne approved.",
            objectId: object.id,
            previousStatus: object.status,
            revisedStatus: "ARCHIVED",
          },
        });
      }

      if (relationships.length === 0) {
        return;
      }

      await transaction.knowledgeRelationship.updateMany({
        data: {
          status: "ARCHIVED",
          trustLevel: "EXCLUDED",
        },
        where: {
          id: { in: relationships.map((relationship) => relationship.id) },
        },
      });

      for (const relationship of relationships) {
        const existingRelationshipRevision =
          await transaction.knowledgeRelationshipRevision.findFirst({
            select: { id: true },
            where: {
              actionType: "ARCHIVE_SYSTEM_NOISE_RELATIONSHIP",
              relationshipId: relationship.id,
            },
          });

        if (existingRelationshipRevision) {
          continue;
        }

        await transaction.knowledgeRelationshipRevision.create({
          data: {
            actionType: "ARCHIVE_SYSTEM_NOISE_RELATIONSHIP",
            createdBy: "System",
            note: "Archived because this relationship depended on workflow or execution language, not reviewed knowledge.",
            previousStatus: relationship.status,
            previousType: relationship.relationshipType,
            relationshipId: relationship.id,
            revisedStatus: "ARCHIVED",
            revisedType: relationship.relationshipType,
          },
        });
      }
    });
  }
}

export async function backfillKnowledgeGraph() {
  await backfillMemoryKnowledge();
  await backfillNotebookKnowledge();
  await backfillAudioKnowledge();
  await backfillVideoKnowledge();
  await backfillObservationKnowledge();
  await backfillRecommendationKnowledge();
  await backfillOrganizationPlanKnowledge();
  await cleanupWorkflowKnowledgeNoise();
}

export async function ensureKnowledgeGraphBackfill() {
  if (!backfillPromise) {
    backfillPromise = backfillKnowledgeGraph().catch((error: unknown) => {
      backfillPromise = null;
      throw error;
    });
  }

  await backfillPromise;
}

const objectSelect = {
  approvedAt: true,
  approvedBy: true,
  canonicalObjectId: true,
  confidence: true,
  createdAt: true,
  description: true,
  evidence: true,
  firstSeen: true,
  id: true,
  lastSeen: true,
  name: true,
  normalizedName: true,
  objectType: true,
  occurrenceCount: true,
  provenanceSummary: true,
  sourceRelations: { select: { id: true } },
  status: true,
  targetRelations: { select: { id: true } },
  trustLevel: true,
  updatedAt: true,
} satisfies Prisma.KnowledgeObjectSelect;

const relationshipSelect = {
  approvedAt: true,
  confidence: true,
  createdAt: true,
  evidence: true,
  explanation: true,
  id: true,
  provenanceSummary: true,
  relationshipType: true,
  sourceObject: {
    select: {
      name: true,
      objectType: true,
    },
  },
  sourceObjectId: true,
  status: true,
  targetObject: {
    select: {
      name: true,
      objectType: true,
    },
  },
  targetObjectId: true,
  trustLevel: true,
} satisfies Prisma.KnowledgeRelationshipSelect;

export async function getKnowledgeReviewPageData(): Promise<KnowledgeReviewPageData> {
  await ensureKnowledgeGraphBackfill();
  const prisma = getPrismaClient();
  const [objects, relationships, mergeTargets] = await Promise.all([
    prisma.knowledgeObject.findMany({
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      select: objectSelect,
      take: 160,
      where: { canonicalObjectId: null, status: { not: "ARCHIVED" } },
    }),
    prisma.knowledgeRelationship.findMany({
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      select: relationshipSelect,
      take: 160,
      where: { status: { not: "ARCHIVED" } },
    }),
    prisma.knowledgeObject.findMany({
      orderBy: [{ status: "asc" }, { name: "asc" }],
      select: objectSelect,
      take: 120,
      where: { canonicalObjectId: null, status: { not: "ARCHIVED" } },
    }),
  ]);

  return {
    mergeTargets: mergeTargets.map(toKnowledgeObjectSummary),
    objects: objects.map(toKnowledgeObjectSummary),
    relationships: relationships.map(toKnowledgeRelationshipSummary),
  };
}

export async function getKnowledgeGraphPageData(): Promise<KnowledgeGraphPageData> {
  await ensureKnowledgeGraphBackfill();
  const prisma = getPrismaClient();
  const [objects, relationships] = await Promise.all([
    prisma.knowledgeObject.findMany({
      orderBy: [{ status: "asc" }, { occurrenceCount: "desc" }, { updatedAt: "desc" }],
      select: objectSelect,
      take: 80,
      where: { canonicalObjectId: null, status: { not: "ARCHIVED" } },
    }),
    prisma.knowledgeRelationship.findMany({
      orderBy: [{ status: "asc" }, { confidence: "desc" }, { createdAt: "desc" }],
      select: relationshipSelect,
      take: 140,
      where: { status: { not: "ARCHIVED" } },
    }),
  ]);

  return {
    objects: objects.map(toKnowledgeObjectSummary),
    relationships: relationships.map(toKnowledgeRelationshipSummary),
  };
}

export async function getKnowledgeHomepagePreview(): Promise<KnowledgeHomepagePreview> {
  await ensureKnowledgeGraphBackfill();
  const prisma = getPrismaClient();
  const [growingTopic, newlyApproved, needsReview, crossFileTopic] =
    await Promise.all([
      prisma.knowledgeObject.findFirst({
        orderBy: [{ occurrenceCount: "desc" }, { updatedAt: "desc" }],
        select: objectSelect,
        where: {
          canonicalObjectId: null,
          objectType: { in: ["TOPIC", "CONCEPT", "FRAMEWORK"] },
          status: { not: "ARCHIVED" },
        },
      }),
      prisma.knowledgeObject.findFirst({
        orderBy: { approvedAt: "desc" },
        select: objectSelect,
        where: { canonicalObjectId: null, status: "APPROVED" },
      }),
      prisma.knowledgeObject.findFirst({
        orderBy: [{ confidence: "desc" }, { updatedAt: "desc" }],
        select: objectSelect,
        where: { canonicalObjectId: null, status: "PROVISIONAL" },
      }),
      prisma.knowledgeObject.findFirst({
        orderBy: [{ occurrenceCount: "desc" }, { lastSeen: "desc" }],
        select: objectSelect,
        where: {
          canonicalObjectId: null,
          occurrenceCount: { gte: 2 },
          status: { not: "ARCHIVED" },
        },
      }),
    ]);

  return {
    crossFileTopic: crossFileTopic ? toKnowledgeObjectSummary(crossFileTopic) : null,
    growingTopic: growingTopic ? toKnowledgeObjectSummary(growingTopic) : null,
    needsReview: needsReview ? toKnowledgeObjectSummary(needsReview) : null,
    newlyApproved: newlyApproved ? toKnowledgeObjectSummary(newlyApproved) : null,
  };
}

function sourceLinksFromEvidence(
  object: KnowledgeObjectSummary,
): NotebookSourceLink[] {
  const links: NotebookSourceLink[] = [];
  const evidence = object.evidence;

  for (const entryId of evidence.relatedNotebookEntryIds.slice(0, 6)) {
    links.push({
      href: getNotebookEntryRoute(entryId),
      kind: "Notebook Reflection",
      label: "View Related Reflection",
    });
  }

  for (const recommendationId of evidence.relatedRecommendations.slice(0, 6)) {
    links.push({
      href: getKnowledgeGraphRoute(),
      kind: "Recommendation",
      label: `Recommendation context ${recommendationId.slice(0, 6)}`,
    });
  }

  for (const planId of evidence.relatedPlans.slice(0, 6)) {
    links.push({
      href: getKnowledgeGraphRoute(),
      kind: "Organization Plan",
      label: `Organization Plan context ${planId.slice(0, 6)}`,
    });
  }

  return links;
}

export async function getKnowledgeTopicPageData(
  topicId: string,
): Promise<KnowledgeTopicPageData | null> {
  await ensureKnowledgeGraphBackfill();
  const prisma = getPrismaClient();
  const object = await prisma.knowledgeObject.findUnique({
    include: {
      mergedObjects: { select: objectSelect },
      revisions: {
        orderBy: { createdAt: "desc" },
        select: {
          actionType: true,
          createdAt: true,
          createdBy: true,
          id: true,
          note: true,
          previousName: true,
          revisedName: true,
        },
      },
    },
    where: { id: topicId },
  });

  if (!object) {
    return null;
  }

  const [incoming, outgoing, relatedObjects] = await Promise.all([
    prisma.knowledgeRelationship.findMany({
      orderBy: [{ status: "asc" }, { confidence: "desc" }],
      select: relationshipSelect,
      where: { targetObjectId: topicId },
    }),
    prisma.knowledgeRelationship.findMany({
      orderBy: [{ status: "asc" }, { confidence: "desc" }],
      select: relationshipSelect,
      where: { sourceObjectId: topicId },
    }),
    prisma.knowledgeObject.findMany({
      orderBy: [{ status: "asc" }, { occurrenceCount: "desc" }],
      select: objectSelect,
      take: 18,
      where: {
        OR: [
          {
            sourceRelations: {
              some: {
                targetObjectId: topicId,
              },
            },
          },
          {
            targetRelations: {
              some: {
                sourceObjectId: topicId,
              },
            },
          },
        ],
        id: { not: topicId },
      },
    }),
  ]);

  const summary = toKnowledgeObjectSummary(object);

  return {
    incomingRelationships: incoming.map(toKnowledgeRelationshipSummary),
    mergedObjects: object.mergedObjects.map(toKnowledgeObjectSummary),
    object: summary,
    outgoingRelationships: outgoing.map(toKnowledgeRelationshipSummary),
    relatedObjects: relatedObjects.map(toKnowledgeObjectSummary),
    revisions: object.revisions.map(toKnowledgeRevisionSummary),
    sourceLinks: sourceLinksFromEvidence(summary),
  };
}

export async function getRelatedKnowledgeForNotebookEntry(
  entryId: string,
): Promise<KnowledgeReference[]> {
  await ensureKnowledgeGraphBackfill();
  const prisma = getPrismaClient();
  const objects = await prisma.knowledgeObject.findMany({
    orderBy: [{ status: "asc" }, { confidence: "desc" }],
    select: objectSelect,
    take: 8,
    where: {
      canonicalObjectId: null,
      evidence: {
        path: ["relatedNotebookEntryIds"],
        array_contains: entryId,
      },
      status: { not: "ARCHIVED" },
    },
  });

  return objects.map((object) => {
    const summary = toKnowledgeObjectSummary(object);

    return {
      href: getKnowledgeTopicRoute(summary.id),
      id: summary.id,
      label: summary.name,
      status: summary.status,
      type: summary.objectType,
    };
  });
}

export async function getKnowledgeContextForRecommendations(
  suggestionIds: string[],
) {
  if (suggestionIds.length === 0) {
    return {};
  }

  await ensureKnowledgeGraphBackfill();
  const prisma = getPrismaClient();
  const objects = await prisma.knowledgeObject.findMany({
    orderBy: [{ status: "asc" }, { confidence: "desc" }],
    select: objectSelect,
    take: 40,
    where: {
      canonicalObjectId: null,
      OR: suggestionIds.map((suggestionId) => ({
        evidence: {
          path: ["relatedRecommendations"],
          array_contains: suggestionId,
        },
      })),
      status: { not: "ARCHIVED" },
    },
  });
  const grouped: Record<string, KnowledgeReference[]> = {};

  for (const object of objects) {
    const summary = toKnowledgeObjectSummary(object);

    for (const suggestionId of summary.evidence.relatedRecommendations) {
      if (!suggestionIds.includes(suggestionId)) {
        continue;
      }

      grouped[suggestionId] = [
        ...(grouped[suggestionId] ?? []),
        {
          href: getKnowledgeTopicRoute(summary.id),
          id: summary.id,
          label: summary.name,
          status: summary.status,
          type: summary.objectType,
        },
      ].slice(0, 4);
    }
  }

  return grouped;
}

export async function approveKnowledgeObject(objectId: string) {
  const prisma = getPrismaClient();

  return prisma.knowledgeObject.update({
    data: {
      approvedAt: new Date(),
      approvedBy: "Deanne",
      revisions: {
        create: {
          actionType: "APPROVE",
          createdBy: "Deanne",
          revisedStatus: "APPROVED",
        },
      },
      status: "APPROVED",
      trustLevel: "HUMAN_APPROVED",
    },
    where: { id: objectId },
  });
}

export async function rejectKnowledgeObject(objectId: string, note?: string) {
  const prisma = getPrismaClient();

  return prisma.knowledgeObject.update({
    data: {
      revisions: {
        create: {
          actionType: "REJECT",
          createdBy: "Deanne",
          note,
          revisedStatus: "REJECTED",
        },
      },
      status: "REJECTED",
      trustLevel: "EXCLUDED",
    },
    where: { id: objectId },
  });
}

export async function keepKnowledgeObjectProvisional(
  objectId: string,
  note?: string,
) {
  const prisma = getPrismaClient();

  return prisma.knowledgeObject.update({
    data: {
      revisions: {
        create: {
          actionType: "KEEP_PROVISIONAL",
          createdBy: "Deanne",
          note,
          revisedStatus: "PROVISIONAL",
        },
      },
      status: "PROVISIONAL",
      trustLevel: "PROVISIONAL",
    },
    where: { id: objectId },
  });
}

export async function reviseKnowledgeObject({
  description,
  name,
  note,
  objectId,
  objectType,
}: {
  description?: string | null;
  name?: string | null;
  note?: string | null;
  objectId: string;
  objectType?: KnowledgeObjectType | null;
}) {
  const prisma = getPrismaClient();
  const existing = await prisma.knowledgeObject.findUnique({
    where: { id: objectId },
  });

  if (!existing) {
    throw new Error("Knowledge item not found.");
  }

  const nextName = name?.trim() || existing.name;
  const nextType = objectType ?? (existing.objectType as KnowledgeObjectType);
  const normalizedName = normalizeKnowledgeName(nextName);

  return prisma.knowledgeObject.update({
    data: {
      description: description?.trim() || existing.description,
      name: nextName,
      normalizedName,
      objectType: nextType,
      revisions: {
        create: {
          actionType: "REVISE",
          createdBy: "Deanne",
          note,
          previousName: existing.name,
          previousType: existing.objectType,
          revisedName: nextName,
          revisedType: nextType,
        },
      },
    },
    where: { id: objectId },
  });
}

export async function approveKnowledgeRelationship(relationshipId: string) {
  const prisma = getPrismaClient();

  return prisma.knowledgeRelationship.update({
    data: {
      approvedAt: new Date(),
      revisions: {
        create: {
          actionType: "APPROVE",
          createdBy: "Deanne",
          revisedStatus: "APPROVED",
        },
      },
      status: "APPROVED",
      trustLevel: "HUMAN_APPROVED",
    },
    where: { id: relationshipId },
  });
}

export async function rejectKnowledgeRelationship(
  relationshipId: string,
  note?: string,
) {
  const prisma = getPrismaClient();

  return prisma.knowledgeRelationship.update({
    data: {
      revisions: {
        create: {
          actionType: "REJECT",
          createdBy: "Deanne",
          note,
          revisedStatus: "REJECTED",
        },
      },
      status: "REJECTED",
      trustLevel: "EXCLUDED",
    },
    where: { id: relationshipId },
  });
}

export async function keepKnowledgeRelationshipProvisional(
  relationshipId: string,
  note?: string,
) {
  const prisma = getPrismaClient();

  return prisma.knowledgeRelationship.update({
    data: {
      revisions: {
        create: {
          actionType: "KEEP_PROVISIONAL",
          createdBy: "Deanne",
          note,
          revisedStatus: "PROVISIONAL",
        },
      },
      status: "PROVISIONAL",
      trustLevel: "PROVISIONAL",
    },
    where: { id: relationshipId },
  });
}

export async function reviseKnowledgeRelationship({
  explanation,
  note,
  relationshipId,
}: {
  explanation?: string | null;
  note?: string | null;
  relationshipId: string;
}) {
  const prisma = getPrismaClient();
  const existing = await prisma.knowledgeRelationship.findUnique({
    where: { id: relationshipId },
  });

  if (!existing) {
    throw new Error("Knowledge relationship not found.");
  }

  return prisma.knowledgeRelationship.update({
    data: {
      explanation: explanation?.trim() || existing.explanation,
      revisions: {
        create: {
          actionType: "REVISE",
          createdBy: "Deanne",
          note,
          revisedExplanation: explanation?.trim() || existing.explanation,
        },
      },
    },
    where: { id: relationshipId },
  });
}

export async function mergeKnowledgeObject({
  canonicalObjectId,
  mergedObjectId,
  reason,
}: {
  canonicalObjectId: string;
  mergedObjectId: string;
  reason?: string | null;
}) {
  if (canonicalObjectId === mergedObjectId) {
    throw new Error("Choose two different knowledge items to merge.");
  }

  const prisma = getPrismaClient();

  return prisma.$transaction(async (tx) => {
    const [canonical, merged] = await Promise.all([
      tx.knowledgeObject.findUnique({ where: { id: canonicalObjectId } }),
      tx.knowledgeObject.findUnique({ where: { id: mergedObjectId } }),
    ]);

    if (!canonical || !merged) {
      throw new Error("Knowledge item not found.");
    }

    await tx.knowledgeObjectMerge.upsert({
      create: {
        canonicalObjectId,
        createdBy: "Deanne",
        mergedObjectId,
        provenanceSummary:
          "Deanne merged duplicate knowledge items. The original record remains in history.",
        reason,
      },
      update: {
        reason,
      },
      where: {
        canonicalObjectId_mergedObjectId: {
          canonicalObjectId,
          mergedObjectId,
        },
      },
    });

    await tx.knowledgeObject.update({
      data: {
        canonicalObjectId,
        revisions: {
          create: {
            actionType: "MERGE_INTO",
            createdBy: "Deanne",
            note: reason,
            previousName: merged.name,
            revisedName: canonical.name,
            revisedStatus: "ARCHIVED",
          },
        },
        status: "ARCHIVED",
        trustLevel: "EXCLUDED",
      },
      where: { id: mergedObjectId },
    });

    const relationships = await tx.knowledgeRelationship.findMany({
      where: {
        OR: [
          { sourceObjectId: mergedObjectId },
          { targetObjectId: mergedObjectId },
        ],
      },
    });

    for (const relationship of relationships) {
      const nextSource =
        relationship.sourceObjectId === mergedObjectId
          ? canonicalObjectId
          : relationship.sourceObjectId;
      const nextTarget =
        relationship.targetObjectId === mergedObjectId
          ? canonicalObjectId
          : relationship.targetObjectId;

      if (nextSource === nextTarget) {
        await tx.knowledgeRelationship.update({
          data: {
            revisions: {
              create: {
                actionType: "ARCHIVE_AFTER_MERGE",
                createdBy: "Deanne",
                note: "This relationship became internal to a merged knowledge item.",
                revisedStatus: "ARCHIVED",
              },
            },
            status: "ARCHIVED",
            trustLevel: "EXCLUDED",
          },
          where: { id: relationship.id },
        });
        continue;
      }

      const nextKey = relationshipKeyFor(
        nextSource,
        nextTarget,
        relationship.relationshipType,
      );
      const duplicate = await tx.knowledgeRelationship.findUnique({
        where: { relationshipKey: nextKey },
      });

      if (duplicate && duplicate.id !== relationship.id) {
        await tx.knowledgeRelationship.update({
          data: {
            revisions: {
              create: {
                actionType: "ARCHIVE_DUPLICATE_AFTER_MERGE",
                createdBy: "Deanne",
                note: "A canonical relationship already exists after the merge.",
                revisedStatus: "ARCHIVED",
              },
            },
            status: "ARCHIVED",
            trustLevel: "EXCLUDED",
          },
          where: { id: relationship.id },
        });
        continue;
      }

      await tx.knowledgeRelationship.update({
        data: {
          relationshipKey: nextKey,
          revisions: {
            create: {
              actionType: "MOVE_AFTER_MERGE",
              createdBy: "Deanne",
              note: "Relationship moved to the canonical knowledge item.",
            },
          },
          sourceObjectId: nextSource,
          targetObjectId: nextTarget,
        },
        where: { id: relationship.id },
      });
    }

    return canonical;
  });
}

export function trustedReasoningFilter(): Prisma.KnowledgeObjectWhereInput {
  return {
    canonicalObjectId: null,
    status: "APPROVED",
    trustLevel: "HUMAN_APPROVED",
  };
}
