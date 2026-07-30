import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import type { Observation } from "@/lib/librarian-mind";
import type { KnowledgeItemKind, RelatedKnowledgeItem } from "@/types/library";

const visibleConnectionStatuses = ["NEW", "CONFIRMED"] as const;
const minimumSimilarityScore = 0.22;

const stopWords = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "before",
  "being",
  "between",
  "both",
  "could",
  "cautious",
  "clean",
  "concept",
  "concepts",
  "deanne",
  "decision",
  "decisions",
  "document",
  "documents",
  "enough",
  "every",
  "from",
  "future",
  "have",
  "help",
  "human",
  "include",
  "includes",
  "item",
  "itemkind",
  "items",
  "knowledge",
  "language",
  "later",
  "library",
  "librarian",
  "making",
  "may",
  "mentioned",
  "mentions",
  "milestone",
  "might",
  "needs",
  "noticed",
  "observation",
  "observations",
  "observe",
  "observed",
  "only",
  "patterns",
  "possible",
  "purpose",
  "reading",
  "recorded",
  "related",
  "repeatedly",
  "review",
  "room",
  "repeated",
  "same",
  "several",
  "should",
  "signal",
  "signals",
  "source",
  "suggest",
  "suggested",
  "suggestion",
  "suggestions",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "text",
  "unclear",
  "until",
  "which",
  "while",
  "with",
  "without",
  "words",
  "would",
]);

type StoredObservationSession = {
  id: string;
  createdAt: Date;
  libraryDocumentId: string;
  observations: Prisma.JsonValue;
  interpretations: Prisma.JsonValue;
  explanation: Prisma.JsonValue;
  planSuggestions: Prisma.JsonValue;
  libraryDocument: {
    id: string;
    itemKind: KnowledgeItemKind;
    originalFileName: string;
    extension: string | null;
    mimeType: string | null;
  };
};

type PreparedSession = {
  id: string;
  documentId: string;
  title: string;
  itemKind: KnowledgeItemKind;
  titleTerms: Map<string, number>;
  summaryTerms: Map<string, number>;
  allTerms: Map<string, number>;
  phrases: Set<string>;
  observationLabels: Set<string>;
};

export type DeterministicConnectionSuggestion = {
  sourceObservationSessionId: string;
  targetObservationSessionId: string;
  similarityScore: number;
  confidence: number;
  sharedTerms: string[];
  reasoning: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asArray<T>(value: Prisma.JsonValue): T[] {
  return Array.isArray(value) ? (value as unknown as T[]) : [];
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value: string) {
  return normalizeText(value)
    .split(/\s+/)
    .filter(
      (token) =>
        token.length >= 4 && !/^\d+$/.test(token) && !stopWords.has(token),
    );
}

function termCounts(textParts: string[]) {
  const counts = new Map<string, number>();

  for (const token of tokenize(textParts.join(" "))) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return counts;
}

function termsAboveThreshold(counts: Map<string, number>, threshold = 1) {
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([term]) => term),
  );
}

function extractPhrases(textParts: string[]) {
  const tokens = tokenize(textParts.join(" "));
  const phrases = new Set<string>();

  for (let index = 0; index < tokens.length - 1; index += 1) {
    phrases.add(`${tokens[index]} ${tokens[index + 1]}`);
  }

  return phrases;
}

function sharedItems(left: Iterable<string>, right: Iterable<string>) {
  const rightSet = new Set(right);

  return [...new Set(left)].filter((item) => rightSet.has(item));
}

function sharedTermsByWeight(
  leftTerms: Map<string, number>,
  rightTerms: Map<string, number>,
  leftExtraTerms: Iterable<string>,
  rightExtraTerms: Iterable<string>,
) {
  const leftCandidates = new Set([
    ...termsAboveThreshold(leftTerms, 2),
    ...leftExtraTerms,
  ]);
  const rightCandidates = new Set([
    ...termsAboveThreshold(rightTerms, 2),
    ...rightExtraTerms,
  ]);

  return sharedItems(leftCandidates, rightCandidates)
    .sort(
      (left, right) =>
        (rightTerms.get(right) ?? 0) +
        (leftTerms.get(right) ?? 0) -
        ((rightTerms.get(left) ?? 0) + (leftTerms.get(left) ?? 0)),
    )
    .slice(0, 10);
}

function explanationText(value: Prisma.JsonValue) {
  if (!isRecord(value)) {
    return {
      summary: "",
      evidence: [] as string[],
      uncertainty: "",
    };
  }

  return {
    summary: getText(value.summary),
    evidence: asStringArray(value.evidence),
    uncertainty: getText(value.uncertainty),
  };
}

function prepareSession(session: StoredObservationSession): PreparedSession {
  const observations = asArray<Observation>(session.observations);
  const contentObservations = observations.filter(
    (observation) => observation.label !== "ITEM_KIND_CONTEXT",
  );
  const explanation = explanationText(session.explanation);

  const observationText = contentObservations.flatMap((observation) => [
    observation.description,
    ...observation.evidence,
  ]);
  const allText = [
    session.libraryDocument.originalFileName,
    explanation.summary,
    ...observationText,
  ];

  return {
    id: session.id,
    documentId: session.libraryDocumentId,
    title: session.libraryDocument.originalFileName,
    itemKind: session.libraryDocument.itemKind,
    titleTerms: termCounts([session.libraryDocument.originalFileName]),
    summaryTerms: termCounts([explanation.summary]),
    allTerms: termCounts(allText),
    phrases: extractPhrases([
      session.libraryDocument.originalFileName,
      explanation.summary,
      ...observationText,
    ]),
    observationLabels: new Set(
      contentObservations
        .map((observation) => observation.label)
        .filter((label) => label !== "ITEM_KIND_CONTEXT"),
    ),
  };
}

function roundedScore(value: number) {
  return Math.round(Math.min(Math.max(value, 0), 0.95) * 100) / 100;
}

function reasoningFor(signals: {
  sharedTerms: string[];
  sharedPhrases: string[];
  sharedTitleTerms: string[];
  sharedSummaryTerms: string[];
  sharedObservationLabels: string[];
  sameKind: boolean;
}) {
  if (signals.sharedPhrases.length > 0 && signals.sharedTerms.length >= 2) {
    return "These items appear related. The Librarian noticed repeated concepts and phrases appearing in both items.";
  }

  if (signals.sharedTitleTerms.length > 0 && signals.sharedSummaryTerms.length > 0) {
    return "These items appear related. The Librarian noticed similar title language and summary language.";
  }

  if (signals.sharedObservationLabels.length > 0 && signals.sharedTerms.length >= 2) {
    return "These items appear related. The Librarian noticed several repeated concepts in observations for both items.";
  }

  if (signals.sameKind && signals.sharedTerms.length >= 3) {
    return "These items appear related. They share several repeated concepts and are the same kind of library item.";
  }

  return "These items appear related. The Librarian noticed repeated concepts appearing in both items.";
}

export function compareObservationSessions(
  sourceSession: StoredObservationSession,
  targetSession: StoredObservationSession,
): DeterministicConnectionSuggestion | null {
  if (sourceSession.libraryDocumentId === targetSession.libraryDocumentId) {
    return null;
  }

  const source = prepareSession(sourceSession);
  const target = prepareSession(targetSession);
  const sharedTitleTerms = sharedItems(
    source.titleTerms.keys(),
    target.titleTerms.keys(),
  );
  const sharedSummaryTerms = sharedItems(
    source.summaryTerms.keys(),
    target.summaryTerms.keys(),
  );
  const sharedObservationLabels = sharedItems(
    source.observationLabels,
    target.observationLabels,
  );
  const sharedPhrases = sharedItems(source.phrases, target.phrases).slice(0, 4);
  const sharedTerms = sharedTermsByWeight(
    source.allTerms,
    target.allTerms,
    [...source.titleTerms.keys(), ...source.summaryTerms.keys()],
    [...target.titleTerms.keys(), ...target.summaryTerms.keys()],
  );
  const sameKind = source.itemKind === target.itemKind && source.itemKind !== "UNKNOWN";
  const signalCount = [
    sharedTerms.length >= 2,
    sharedPhrases.length > 0,
    sharedTitleTerms.length > 0,
    sharedSummaryTerms.length > 0,
    sharedObservationLabels.length > 0,
    sameKind,
  ].filter(Boolean).length;
  const similarityScore = roundedScore(
    (Math.min(sharedTerms.length, 8) / 8) * 0.42 +
      (Math.min(sharedPhrases.length, 3) / 3) * 0.18 +
      (Math.min(sharedTitleTerms.length, 3) / 3) * 0.14 +
      (Math.min(sharedSummaryTerms.length, 5) / 5) * 0.14 +
      (Math.min(sharedObservationLabels.length, 2) / 2) * 0.08 +
      (sameKind ? 0.04 : 0),
  );

  if (
    similarityScore < minimumSimilarityScore ||
    (sharedTerms.length < 2 &&
      sharedPhrases.length === 0 &&
      sharedTitleTerms.length === 0)
  ) {
    return null;
  }

  const confidence = roundedScore(similarityScore * 0.82 + signalCount * 0.02);
  const visibleSharedTerms = [...new Set([...sharedTerms, ...sharedPhrases])].slice(
    0,
    12,
  );

  return {
    sourceObservationSessionId: source.id,
    targetObservationSessionId: target.id,
    similarityScore,
    confidence,
    sharedTerms: visibleSharedTerms,
    reasoning: reasoningFor({
      sharedTerms,
      sharedPhrases,
      sharedTitleTerms,
      sharedSummaryTerms,
      sharedObservationLabels,
      sameKind,
    }),
  };
}

export async function createKnowledgeConnectionsForSession(sessionId: string) {
  const prisma = getPrismaClient();
  const sourceSession = await prisma.observationSession.findUnique({
    where: { id: sessionId },
    include: {
      libraryDocument: {
        select: {
          id: true,
          itemKind: true,
          originalFileName: true,
          extension: true,
          mimeType: true,
        },
      },
    },
  });

  if (!sourceSession) {
    return 0;
  }

  const previousSessions = await prisma.observationSession.findMany({
    where: {
      id: { not: sourceSession.id },
      createdAt: { lt: sourceSession.createdAt },
      libraryDocumentId: { not: sourceSession.libraryDocumentId },
    },
    orderBy: { createdAt: "desc" },
    take: 75,
    include: {
      libraryDocument: {
        select: {
          id: true,
          itemKind: true,
          originalFileName: true,
          extension: true,
          mimeType: true,
        },
      },
    },
  });

  const suggestions = previousSessions
    .map((targetSession) =>
      compareObservationSessions(sourceSession, targetSession),
    )
    .filter(
      (suggestion): suggestion is DeterministicConnectionSuggestion =>
        suggestion !== null,
    );

  if (suggestions.length === 0) {
    return 0;
  }

  const result = await prisma.knowledgeConnection.createMany({
    data: suggestions.map((suggestion) => ({
      sourceObservationSessionId: suggestion.sourceObservationSessionId,
      targetObservationSessionId: suggestion.targetObservationSessionId,
      similarityScore: suggestion.similarityScore,
      confidence: suggestion.confidence,
      sharedTerms: toJsonInput(suggestion.sharedTerms),
      reasoning: suggestion.reasoning,
      status: "NEW",
    })),
  });

  return result.count;
}

export async function getVisibleRelatedConnectionCounts(sessionIds: string[]) {
  const counts = new Map<string, number>();

  if (sessionIds.length === 0) {
    return counts;
  }

  for (const sessionId of sessionIds) {
    counts.set(sessionId, 0);
  }

  const prisma = getPrismaClient();
  const connections = await prisma.knowledgeConnection.findMany({
    where: {
      status: { in: [...visibleConnectionStatuses] },
      OR: [
        { sourceObservationSessionId: { in: sessionIds } },
        { targetObservationSessionId: { in: sessionIds } },
      ],
    },
    select: {
      sourceObservationSessionId: true,
      targetObservationSessionId: true,
    },
  });

  for (const connection of connections) {
    if (counts.has(connection.sourceObservationSessionId)) {
      counts.set(
        connection.sourceObservationSessionId,
        (counts.get(connection.sourceObservationSessionId) ?? 0) + 1,
      );
    }

    if (counts.has(connection.targetObservationSessionId)) {
      counts.set(
        connection.targetObservationSessionId,
        (counts.get(connection.targetObservationSessionId) ?? 0) + 1,
      );
    }
  }

  return counts;
}

export async function getRelatedItemCountsByDocumentId(documentIds: string[]) {
  const relatedDocuments = new Map<string, Set<string>>();

  if (documentIds.length === 0) {
    return new Map<string, number>();
  }

  for (const documentId of documentIds) {
    relatedDocuments.set(documentId, new Set());
  }

  const prisma = getPrismaClient();
  const connections = await prisma.knowledgeConnection.findMany({
    where: {
      status: { in: [...visibleConnectionStatuses] },
      OR: [
        {
          sourceObservationSession: {
            libraryDocumentId: { in: documentIds },
          },
        },
        {
          targetObservationSession: {
            libraryDocumentId: { in: documentIds },
          },
        },
      ],
    },
    select: {
      sourceObservationSession: {
        select: {
          libraryDocumentId: true,
        },
      },
      targetObservationSession: {
        select: {
          libraryDocumentId: true,
        },
      },
    },
  });

  for (const connection of connections) {
    const sourceDocumentId =
      connection.sourceObservationSession.libraryDocumentId;
    const targetDocumentId =
      connection.targetObservationSession.libraryDocumentId;

    if (relatedDocuments.has(sourceDocumentId)) {
      relatedDocuments.get(sourceDocumentId)?.add(targetDocumentId);
    }

    if (relatedDocuments.has(targetDocumentId)) {
      relatedDocuments.get(targetDocumentId)?.add(sourceDocumentId);
    }
  }

  return new Map(
    [...relatedDocuments.entries()].map(([documentId, relatedIds]) => [
      documentId,
      relatedIds.size,
    ]),
  );
}

export async function getRelatedKnowledgeForSession(
  sessionId: string,
): Promise<RelatedKnowledgeItem[]> {
  const prisma = getPrismaClient();
  const connections = await prisma.knowledgeConnection.findMany({
    where: {
      status: { in: [...visibleConnectionStatuses] },
      OR: [
        { sourceObservationSessionId: sessionId },
        { targetObservationSessionId: sessionId },
      ],
    },
    orderBy: [{ similarityScore: "desc" }, { createdAt: "desc" }],
    include: {
      sourceObservationSession: {
        include: {
          libraryDocument: {
            select: {
              originalFileName: true,
            },
          },
        },
      },
      targetObservationSession: {
        include: {
          libraryDocument: {
            select: {
              originalFileName: true,
            },
          },
        },
      },
    },
    take: 12,
  });

  return connections.map((connection) => {
    const isSource = connection.sourceObservationSessionId === sessionId;
    const relatedSession = isSource
      ? connection.targetObservationSession
      : connection.sourceObservationSession;

    return {
      id: connection.id,
      documentName: relatedSession.libraryDocument.originalFileName,
      observedAt: relatedSession.createdAt.toISOString(),
      similarityScore: connection.similarityScore,
      confidence: connection.confidence,
      sharedTerms: asStringArray(connection.sharedTerms),
      reasoning: connection.reasoning,
      status: connection.status,
    };
  });
}
