import type { Prisma } from "@prisma/client";

import { runOpenAIObservation } from "@/lib/ai/openai-observer";
import type { AIObservationResult } from "@/lib/ai/types";
import { getPrismaClient } from "@/lib/db/prisma";
import {
  createKnowledgeConnectionsForSession,
  getRelatedKnowledgeForSession,
  getVisibleRelatedConnectionCounts,
} from "@/lib/library/knowledge-connections";
import { runLibrarianMind } from "@/lib/librarian-mind";
import type {
  Explanation,
  Interpretation,
  MindInput,
  MindResult,
  Observation,
  PlanSuggestion,
} from "@/lib/librarian-mind";
import type {
  HumanDecisionType,
  ObservationSessionReview,
  ObservationSessionStatus,
  ReviewQueueItem,
} from "@/types/library";

export const unreadObservationMessage =
  "The Librarian cannot observe this item because it has not been read yet.";
export const aiUnavailableObservationMessage =
  "The Librarian used its basic observation mode because AI observation was unavailable.";

const validDecisionTypes = new Set<HumanDecisionType>([
  "ACCEPT",
  "MODIFY",
  "REJECT",
  "NOTE",
]);

export class ObservationSessionError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ObservationSessionError";
    this.statusCode = statusCode;
  }
}

export type SaveHumanDecisionInput = {
  decisionType: HumanDecisionType;
  note?: string | null;
  editedSuggestion?: string | null;
};

export type ReadableObservationDocument = {
  id: string;
  itemKind: MindInput["itemKind"];
  originalFileName: string;
  extension: string | null;
  mimeType: string | null;
  rawText: string | null;
  previewText: string | null;
  wordCount: number | null;
};

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function asArray<T>(value: Prisma.JsonValue): T[] {
  return Array.isArray(value) ? (value as unknown as T[]) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getText(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function getNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function hasOpenAIKey() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function averageConfidence(values: number[]) {
  const usableValues = values.filter((value) => Number.isFinite(value));

  if (usableValues.length === 0) {
    return 0;
  }

  return Number(
    (
      usableValues.reduce((total, value) => total + value, 0) /
      usableValues.length
    ).toFixed(2),
  );
}

function boundedConfidence(value: number, fallback = 0.5) {
  return Number.isFinite(value)
    ? Number(Math.min(1, Math.max(0, value)).toFixed(2))
    : fallback;
}

function sanitizeAIWarning(warning: string) {
  const normalized = warning.toLowerCase();

  if (
    normalized.includes("openai response") ||
    normalized.includes("openai returned")
  ) {
    return "AI observation returned with limited detail and should be reviewed carefully.";
  }

  return warning;
}

function asExplanation(value: Prisma.JsonValue): Explanation {
  if (!isRecord(value)) {
    return {
      summary: "The Librarian noticed patterns that need review.",
      evidence: [],
      uncertainty: "Human review is needed before this becomes a decision.",
      confidence: 0,
    };
  }

  return {
    summary: getText(
      value.summary,
      "The Librarian noticed patterns that need review.",
    ),
    evidence: Array.isArray(value.evidence)
      ? value.evidence.filter((item): item is string => typeof item === "string")
      : [],
    uncertainty: getText(
      value.uncertainty,
      "Human review is needed before this becomes a decision.",
    ),
    confidence: getNumber(value.confidence, 0),
  };
}

function cleanEvidence(evidence: string[]) {
  return evidence.filter((item) => {
    const normalized = item.toLowerCase();

    return (
      !normalized.includes("itemkind") &&
      !normalized.includes("source:") &&
      !normalized.includes("reading_room")
    );
  });
}

function userFacingObservations(observations: Observation[]) {
  return observations
    .filter((observation) => observation.label !== "ITEM_KIND_CONTEXT")
    .map((observation) => ({
      id: observation.id,
      description: observation.description,
      evidence: cleanEvidence(observation.evidence),
      uncertainty: observation.uncertainty,
      confidence: observation.confidence,
    }));
}

function userFacingInterpretations(interpretations: Interpretation[]) {
  return interpretations.map((interpretation) => ({
    id: interpretation.id,
    description: interpretation.description,
    uncertainty: interpretation.uncertainty,
    confidence: interpretation.confidence,
  }));
}

function userFacingPlanSuggestions(planSuggestions: PlanSuggestion[]) {
  return planSuggestions.map((suggestion) => ({
    id: suggestion.id,
    label: suggestion.label,
    description: suggestion.description,
    reason: suggestion.reason,
    confidence: suggestion.confidence,
  }));
}

export function observationProviderLabel(observerType: string) {
  return observerType === "OPENAI"
    ? "Observed with AI assistance"
    : "Observed with basic observation mode";
}

function aiObservationResultToMindResult(
  title: string,
  aiResult: AIObservationResult,
): MindResult {
  const observations: Observation[] = aiResult.observations.map(
    (observation, index) => ({
      id: `openai-observation-${index + 1}`,
      label: "POSSIBLE_PURPOSE",
      description: observation.text,
      evidence: observation.evidence,
      confidence: boundedConfidence(observation.confidence),
      uncertainty:
        observation.uncertainty ||
        "This is an AI-assisted observation and still needs human review.",
    }),
  );
  const themeInterpretations: Interpretation[] = aiResult.possibleThemes.map(
    (theme, index) => ({
      id: `openai-theme-${index + 1}`,
      label: "POSSIBLE_TOPIC_SIGNAL",
      description: `${theme.name} may be present. ${theme.reason}`,
      basedOnObservationIds: observations.map((observation) => observation.id),
      confidence: boundedConfidence(theme.confidence),
      uncertainty:
        theme.uncertainty ||
        "This possible theme is not trusted until Deanne reviews it.",
    }),
  );
  const relationshipInterpretations: Interpretation[] =
    aiResult.possibleRelationships.map((relationship, index) => ({
      id: `openai-relationship-${index + 1}`,
      label: "POSSIBLE_LIBRARY_PLACEMENT",
      description: `${relationship.targetHint} could be related to this item. ${relationship.reason}`,
      basedOnObservationIds: observations.map((observation) => observation.id),
      confidence: boundedConfidence(relationship.confidence),
      uncertainty:
        relationship.uncertainty ||
        "This possible relationship is only a suggestion for review.",
    }));
  const questionInterpretations: Interpretation[] = aiResult.questions.map(
    (question, index) => ({
      id: `openai-question-${index + 1}`,
      label: "HUMAN_REVIEW_NEEDED",
      description: question.question,
      basedOnObservationIds: observations.map((observation) => observation.id),
      confidence: 0.58,
      uncertainty: question.reason,
    }),
  );
  const interpretations = [
    ...themeInterpretations,
    ...relationshipInterpretations,
    ...questionInterpretations,
  ];
  const evidence = observations
    .flatMap((observation) => observation.evidence)
    .slice(0, 8);
  const planSuggestions: PlanSuggestion[] = [
    {
      id: "openai-plan-human-review",
      actionType: "NEEDS_HUMAN_REVIEW",
      label: "Review AI-assisted observation",
      description:
        "Ask Deanne to accept, modify, reject, or note these observations before they can shape Memory.",
      reason:
        "AI assistance can notice patterns, but it cannot decide what this item means.",
      confidence: 0.82,
      requiresHumanApproval: true,
    },
  ];

  if (aiResult.possibleRelationships.length > 0) {
    planSuggestions.push({
      id: "openai-plan-related-review",
      actionType: "CONNECT_WITH_RELATED",
      label: "Review possible relationships",
      description:
        "Consider whether any suggested relationships should be kept, changed, or rejected.",
      reason:
        "Possible relationships remain suggestions until a human reviews them.",
      confidence: 0.62,
      requiresHumanApproval: true,
    });
  }

  if (aiResult.questions.length > 0) {
    planSuggestions.push({
      id: "openai-plan-answer-questions",
      actionType: "REVIEW_LATER",
      label: "Answer review questions",
      description:
        "Use the questions as prompts for human review, not as automatic decisions.",
      reason: "Questions help preserve uncertainty and keep Deanne in control.",
      confidence: 0.6,
      requiresHumanApproval: true,
    });
  }

  return {
    observations,
    interpretations,
    connections: [],
    explanation: {
      summary: `I used AI assistance to observe cautious signals in ${title}. They may help review, but they are not decisions.`,
      evidence,
      uncertainty:
        aiResult.uncertainty ||
        "AI observations must wait for Deanne's review before they can shape Memory.",
      confidence: boundedConfidence(
        aiResult.confidence,
        averageConfidence([
          ...observations.map((observation) => observation.confidence),
          ...interpretations.map((interpretation) => interpretation.confidence),
        ]),
      ),
    },
    planSuggestions,
    overallConfidence: boundedConfidence(
      aiResult.confidence,
      averageConfidence([
        ...observations.map((observation) => observation.confidence),
        ...interpretations.map((interpretation) => interpretation.confidence),
        ...planSuggestions.map((suggestion) => suggestion.confidence),
      ]),
    ),
    warnings: aiResult.warnings.map(sanitizeAIWarning),
  };
}

async function observeWithDeterministicMind(
  document: ReadableObservationDocument,
  extraWarnings: string[] = [],
  source: MindInput["source"] = "READING_ROOM",
): Promise<{ result: MindResult; observerType: "DETERMINISTIC" }> {
  const result = await runLibrarianMind({
    knowledgeItemId: document.id,
    title: document.originalFileName,
    itemKind: document.itemKind,
    contentText: document.rawText,
    previewText: document.previewText,
    metadata: {
      extension: document.extension,
      mimeType: document.mimeType,
      wordCount: document.wordCount,
    },
    source,
  });

  return {
    result: {
      ...result,
      warnings: [...extraWarnings, ...result.warnings],
    },
    observerType: "DETERMINISTIC",
  };
}

async function observeWithOpenAIOrFallback(
  document: ReadableObservationDocument,
  source: MindInput["source"] = "READING_ROOM",
) {
  if (!hasOpenAIKey()) {
    return observeWithDeterministicMind(document, [
      aiUnavailableObservationMessage,
    ], source);
  }

  try {
    const aiResult = await runOpenAIObservation({
      title: document.originalFileName,
      itemKind: document.itemKind,
      contentText: document.rawText,
      previewText: document.previewText,
      metadata: {
        extension: document.extension,
        mimeType: document.mimeType,
        wordCount: document.wordCount,
      },
    });

    return {
      result: aiObservationResultToMindResult(
        document.originalFileName,
        aiResult,
      ),
      observerType: "OPENAI" as const,
    };
  } catch {
    return observeWithDeterministicMind(document, [
      aiUnavailableObservationMessage,
    ], source);
  }
}

function decisionStatusFor(
  decisionType: HumanDecisionType,
): ObservationSessionStatus | null {
  if (decisionType === "ACCEPT") {
    return "APPROVED";
  }

  if (decisionType === "MODIFY") {
    return "MODIFIED";
  }

  if (decisionType === "REJECT") {
    return "REJECTED";
  }

  return null;
}

export function isHumanDecisionType(value: unknown): value is HumanDecisionType {
  return typeof value === "string" && validDecisionTypes.has(value as HumanDecisionType);
}

export async function createObservationSessionFromReadableDocument(
  document: ReadableObservationDocument,
  source: MindInput["source"] = "READING_ROOM",
) {
  if (!document.rawText || document.rawText.trim().length === 0) {
    throw new ObservationSessionError(unreadObservationMessage, 409);
  }

  const prisma = getPrismaClient();
  const { observerType, result } = await observeWithOpenAIOrFallback(
    document,
    source,
  );

  const session = await prisma.observationSession.create({
    data: {
      libraryDocumentId: document.id,
      observerType,
      status: "AWAITING_REVIEW",
      observations: toJsonInput(result.observations),
      interpretations: toJsonInput(result.interpretations),
      explanation: toJsonInput(result.explanation),
      planSuggestions: toJsonInput(result.planSuggestions),
      confidence: result.overallConfidence,
      warnings: toJsonInput(result.warnings),
    },
    select: {
      id: true,
    },
  });
  const connectionCount = await createKnowledgeConnectionsForSession(session.id);

  return {
    sessionId: session.id,
    result,
    observerType,
    connectionCount,
  };
}

export async function createObservationSessionForDocument(documentId: string) {
  const prisma = getPrismaClient();
  const document = await prisma.libraryDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      itemKind: true,
      originalFileName: true,
      extension: true,
      mimeType: true,
      rawText: true,
      previewText: true,
      wordCount: true,
      extractionStatus: true,
    },
  });

  if (!document) {
    throw new ObservationSessionError(
      "The Librarian could not find that library item.",
      404,
    );
  }

  if (
    document.extractionStatus !== "COMPLETED" ||
    !document.rawText ||
    document.rawText.trim().length === 0
  ) {
    throw new ObservationSessionError(unreadObservationMessage, 409);
  }

  return createObservationSessionFromReadableDocument(document, "READING_ROOM");
}

export async function getObservationReviewQueueItems(): Promise<ReviewQueueItem[]> {
  const prisma = getPrismaClient();
  const sessions = await prisma.observationSession.findMany({
    where: { status: "AWAITING_REVIEW" },
    orderBy: { createdAt: "desc" },
    include: {
      libraryDocument: {
        select: {
          originalFileName: true,
        },
      },
    },
    take: 30,
  });
  const relatedConnectionCounts = await getVisibleRelatedConnectionCounts(
    sessions.map((session) => session.id),
  );

  return sessions.map((session) => {
    const explanation = asExplanation(session.explanation);

    return {
      id: session.id,
      documentName: session.libraryDocument.originalFileName,
      observedAt: session.createdAt.toISOString(),
      observerType: session.observerType,
      confidence: session.confidence,
      summary: explanation.summary,
      status: session.status,
      relatedConnectionCount: relatedConnectionCounts.get(session.id) ?? 0,
    };
  });
}

export async function getObservationSessionReview(
  sessionId: string,
): Promise<ObservationSessionReview | null> {
  const prisma = getPrismaClient();
  const session = await prisma.observationSession.findUnique({
    where: { id: sessionId },
    include: {
      libraryDocument: {
        select: {
          originalFileName: true,
        },
      },
      humanDecisions: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!session) {
    return null;
  }

  const observations = asArray<Observation>(session.observations);
  const interpretations = asArray<Interpretation>(session.interpretations);
  const planSuggestions = asArray<PlanSuggestion>(session.planSuggestions);
  const relatedKnowledge = await getRelatedKnowledgeForSession(sessionId);

  return {
    id: session.id,
    documentName: session.libraryDocument.originalFileName,
    observedAt: session.createdAt.toISOString(),
    observerType: session.observerType,
    status: session.status,
    confidence: session.confidence,
    observations: userFacingObservations(observations),
    interpretations: userFacingInterpretations(interpretations),
    explanation: asExplanation(session.explanation),
    planSuggestions: userFacingPlanSuggestions(planSuggestions),
    warnings: asArray<string>(session.warnings),
    relatedKnowledge,
    decisions: session.humanDecisions.map((decision) => ({
      id: decision.id,
      decisionType: decision.decisionType,
      note: decision.note,
      editedSuggestion: decision.editedSuggestion,
      createdAt: decision.createdAt.toISOString(),
    })),
  };
}

export async function saveHumanDecision(
  sessionId: string,
  input: SaveHumanDecisionInput,
) {
  if (!isHumanDecisionType(input.decisionType)) {
    throw new ObservationSessionError("Choose a review action first.", 400);
  }

  const prisma = getPrismaClient();
  const note = input.note?.trim() || null;
  const editedSuggestion = input.editedSuggestion?.trim() || null;

  return prisma.$transaction(async (tx) => {
    const existingSession = await tx.observationSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
      },
    });

    if (!existingSession) {
      throw new ObservationSessionError(
        "The Librarian could not find that observation.",
        404,
      );
    }

    const decision = await tx.humanDecision.create({
      data: {
        observationSessionId: sessionId,
        decisionType: input.decisionType,
        note,
        editedSuggestion,
      },
      select: {
        id: true,
      },
    });

    const nextStatus = decisionStatusFor(input.decisionType);

    if (!nextStatus) {
      return {
        decisionId: decision.id,
        status: existingSession.status as ObservationSessionStatus,
      };
    }

    const updatedSession = await tx.observationSession.update({
      where: { id: sessionId },
      data: { status: nextStatus },
      select: { status: true },
    });

    return {
      decisionId: decision.id,
      status: updatedSession.status as ObservationSessionStatus,
    };
  });
}
