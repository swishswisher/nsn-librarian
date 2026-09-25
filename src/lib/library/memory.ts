import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import type { MemoryEntrySummary, MemoryPageData, MemoryType } from "@/types/library";

const activeMemoryStatus = "ACTIVE";
const visibleConnectionStatuses = ["NEW", "CONFIRMED"] as const;

const stopWords = new Set([
  "about",
  "above",
  "after",
  "again",
  "also",
  "appears",
  "approved",
  "approve",
  "around",
  "because",
  "before",
  "being",
  "between",
  "both",
  "category",
  "cautious",
  "classification",
  "consider",
  "could",
  "deanne",
  "decision",
  "decisions",
  "document",
  "documents",
  "enough",
  "every",
  "future",
  "file",
  "from",
  "have",
  "help",
  "human",
  "include",
  "includes",
  "itemkind",
  "item",
  "items",
  "knowledge",
  "language",
  "library",
  "librarian",
  "making",
  "memory",
  "milestone",
  "might",
  "mind",
  "must",
  "needs",
  "needed",
  "noted",
  "notice",
  "noticed",
  "observation",
  "observations",
  "observe",
  "observed",
  "only",
  "pattern",
  "patterns",
  "possible",
  "purpose",
  "reading",
  "review",
  "reviewed",
  "room",
  "same",
  "session",
  "should",
  "signal",
  "signals",
  "similar",
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
  "treated",
  "during",
  "test",
  "until",
  "using",
  "verification",
  "which",
  "while",
  "with",
  "without",
  "would",
]);

type StoredSessionForMemory = {
  id: string;
  status: string;
  createdAt: Date;
  confidence: number;
  observations: Prisma.JsonValue;
  interpretations: Prisma.JsonValue;
  explanation: Prisma.JsonValue;
  planSuggestions: Prisma.JsonValue;
  libraryDocument: {
    originalFileName: string;
    previewText: string | null;
    rawText: string | null;
  };
  humanDecisions: {
    decisionType: string;
    note: string | null;
    editedSuggestion: string | null;
    createdAt: Date;
  }[];
};

type PreparedSession = {
  id: string;
  title: string;
  seenAt: Date;
  terms: Map<string, number>;
  uniqueTerms: Set<string>;
  evidenceText: string[];
};

type MemoryCandidate = {
  memoryKey: string;
  memoryType: MemoryType;
  title: string;
  description: string;
  confidence: number;
  evidence: string[];
  seenAt: Date;
  occurrenceCount: number;
  sourceSessionIds: string[];
};

type TermAggregate = {
  sessionCount: number;
  titles: string[];
  lastSeen: Date;
  sourceSessionIds: string[];
};

type PreferenceAggregate = TermAggregate & {
  sourceTerm: string;
  targetTerm: string;
};

const themeRules: Array<{
  key: string;
  title: string;
  terms: string[];
  minimumMatches: number;
  description: string;
}> = [
  {
    key: "attachment-regulation",
    title: "Attachment and regulation",
    terms: ["attachment", "regulation", "nervous", "system", "safety"],
    minimumMatches: 2,
    description:
      "Approved observations keep returning to attachment, regulation, and felt safety.",
  },
  {
    key: "clinical-practice",
    title: "Clinical practice",
    terms: ["clinical", "therapy", "worksheet", "assessment", "practice"],
    minimumMatches: 2,
    description:
      "Approved observations keep pointing toward practical clinical use.",
  },
  {
    key: "couples-relationships",
    title: "Couples and relationships",
    terms: ["couples", "relationship", "repair", "partner", "intimacy"],
    minimumMatches: 1,
    description:
      "Approved observations keep connecting this material to couples and relationship work.",
  },
  {
    key: "teaching-material",
    title: "Teaching material",
    terms: ["teaching", "workshop", "lesson", "guide"],
    minimumMatches: 1,
    description:
      "Approved observations keep suggesting this knowledge may support teaching or guided learning.",
  },
  {
    key: "human-approval",
    title: "Human approval and control",
    terms: ["approval", "control", "decides", "authority", "consent"],
    minimumMatches: 1,
    description:
      "Approved observations keep emphasizing human authority over machine suggestions.",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: Prisma.JsonValue): unknown[] {
  return Array.isArray(value) ? value : [];
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

function memoryKeyFor(memoryType: MemoryType, value: string) {
  const normalized = normalizeText(value).replace(/\s+/g, "-") || "unknown";

  return `${memoryType}:${normalized}`;
}

function clampConfidence(value: number) {
  return Math.round(Math.min(Math.max(value, 0), 0.95) * 100) / 100;
}

function mergeEvidence(left: string[], right: string[]) {
  return [...new Set([...left, ...right])]
    .filter((item) => item.trim().length > 0)
    .slice(0, 12);
}

function evidenceFromJson(value: Prisma.JsonValue) {
  return asStringArray(value).slice(0, 12);
}

function collectSessionText(session: StoredSessionForMemory) {
  if (session.status === "MODIFIED") {
    const corrected = session.humanDecisions.find(
      (decision) => decision.decisionType === "MODIFY" && decision.editedSuggestion?.trim(),
    );

    if (!corrected?.editedSuggestion) {
      return [];
    }

    const replacement = parseEditedPreference(corrected.editedSuggestion);

    return [replacement?.targetTerm ?? corrected.editedSuggestion];
  }

  const textParts = [
    session.libraryDocument.rawText ?? session.libraryDocument.previewText ?? "",
  ];

  for (const observation of asArray(session.observations)) {
    if (!isRecord(observation) || observation.label === "ITEM_KIND_CONTEXT") {
      continue;
    }

    textParts.push(...asStringArray(observation.evidence));
  }

  if (isRecord(session.explanation)) {
    textParts.push(
      ...asStringArray(session.explanation.evidence).filter((evidence) => {
        const normalized = evidence.toLowerCase();

        return (
          !normalized.includes("itemkind") &&
          !normalized.includes("source:") &&
          !normalized.includes("reading_room")
        );
      }),
    );
  }

  return textParts.filter((part) => part.trim().length > 0);
}

function prepareSession(session: StoredSessionForMemory): PreparedSession {
  const evidenceText = collectSessionText(session);
  const terms = new Map<string, number>();

  for (const token of tokenize(evidenceText.join(" "))) {
    terms.set(token, (terms.get(token) ?? 0) + 1);
  }

  return {
    id: session.id,
    title: session.libraryDocument.originalFileName,
    seenAt: session.createdAt,
    terms,
    uniqueTerms: new Set(terms.keys()),
    evidenceText,
  };
}

function topTerms(terms: Map<string, number>, minimumCount: number) {
  return [...terms.entries()]
    .filter(([, count]) => count >= minimumCount)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8);
}

function aggregateApprovedTerms(sessions: PreparedSession[]) {
  const aggregate = new Map<string, TermAggregate>();

  for (const session of sessions) {
    for (const term of session.uniqueTerms) {
      const existing = aggregate.get(term);

      if (!existing) {
        aggregate.set(term, {
          sessionCount: 1,
          titles: [session.title],
          lastSeen: session.seenAt,
          sourceSessionIds: [session.id],
        });
        continue;
      }

      existing.sessionCount += 1;
      existing.sourceSessionIds = [...new Set([...existing.sourceSessionIds, session.id])];
      existing.titles = [...new Set([...existing.titles, session.title])].slice(
        0,
        5,
      );

      if (session.seenAt > existing.lastSeen) {
        existing.lastSeen = session.seenAt;
      }
    }
  }

  return aggregate;
}

function addCandidate(
  candidates: Map<string, MemoryCandidate>,
  candidate: MemoryCandidate,
) {
  const existing = candidates.get(candidate.memoryKey);

  if (!existing) {
    candidates.set(candidate.memoryKey, candidate);
    return;
  }

  candidates.set(candidate.memoryKey, {
    ...existing,
    confidence: Math.max(existing.confidence, candidate.confidence),
    evidence: mergeEvidence(existing.evidence, candidate.evidence),
    seenAt: candidate.seenAt > existing.seenAt ? candidate.seenAt : existing.seenAt,
    occurrenceCount: Math.max(existing.occurrenceCount, candidate.occurrenceCount),
    sourceSessionIds: [...new Set([...existing.sourceSessionIds, ...candidate.sourceSessionIds])],
  });
}

function termCandidatesForSession(
  session: PreparedSession,
  approvedTermAggregate: Map<string, TermAggregate>,
) {
  const candidates = new Map<string, MemoryCandidate>();

  for (const [term, count] of topTerms(session.terms, 2)) {
    addCandidate(candidates, {
      memoryKey: memoryKeyFor("TERM", term),
      memoryType: "TERM",
      title: term,
      description: `Deanne approved observations where "${term}" appeared as a recurring term.`,
      confidence: clampConfidence(0.5 + Math.min(count, 5) * 0.06),
      evidence: [
        `Approved item: ${session.title}`,
        `Recurring term: ${term}`,
      ],
      seenAt: session.seenAt,
      occurrenceCount: 1,
      sourceSessionIds: [session.id],
    });
  }

  const repeatedAggregateTerms = [...session.uniqueTerms]
    .map((term) => [term, approvedTermAggregate.get(term)] as const)
    .filter((entry): entry is readonly [string, TermAggregate] => {
      const aggregate = entry[1];

      return aggregate !== undefined && aggregate.sessionCount >= 2;
    })
    .sort(
      (left, right) =>
        right[1].sessionCount - left[1].sessionCount ||
        left[0].localeCompare(right[0]),
    )
    .slice(0, 8);

  for (const [term, aggregate] of repeatedAggregateTerms) {
    addCandidate(candidates, {
      memoryKey: memoryKeyFor("TERM", term),
      memoryType: "TERM",
      title: term,
      description: `The term "${term}" has appeared across multiple approved observations.`,
      confidence: clampConfidence(0.48 + Math.min(aggregate.sessionCount, 6) * 0.06),
      evidence: [
        `Approved items: ${aggregate.titles.join(", ")}`,
        `Recurring term: ${term}`,
      ],
      seenAt: aggregate.lastSeen,
      occurrenceCount: aggregate.sessionCount,
      sourceSessionIds: aggregate.sourceSessionIds,
    });
  }

  return [...candidates.values()];
}

function themeCandidatesForSession(session: PreparedSession) {
  return themeRules
    .map((rule): MemoryCandidate | null => {
      const matchedTerms = rule.terms.filter((term) => session.uniqueTerms.has(term));

      if (matchedTerms.length < rule.minimumMatches) {
        return null;
      }

      return {
        memoryKey: memoryKeyFor("THEME", rule.key),
        memoryType: "THEME",
        title: rule.title,
        description: rule.description,
        confidence: clampConfidence(0.52 + Math.min(matchedTerms.length, 5) * 0.07),
        evidence: [
          `Approved item: ${session.title}`,
          `Repeated concepts: ${matchedTerms.join(", ")}`,
        ],
        seenAt: session.seenAt,
        occurrenceCount: 1,
        sourceSessionIds: [session.id],
      };
    })
    .filter((candidate): candidate is MemoryCandidate => candidate !== null);
}

function cleanEditedTerm(value: string) {
  return value
    .trim()
    .replace(/^["'`]+|["'`.]+$/g, "")
    .replace(/\s+/g, " ");
}

function parseEditedPreference(value: string) {
  const patterns = [
    /^(.{2,80}?)\s*(?:->|→|=>)\s*(.{2,80}?)$/u,
    /^replace\s+(.{2,80}?)\s+with\s+(.{2,80}?)$/iu,
    /^change\s+(.{2,80}?)\s+(?:to|into)\s+(.{2,80}?)$/iu,
  ];

  for (const pattern of patterns) {
    const match = value.trim().match(pattern);

    if (!match) {
      continue;
    }

    const sourceTerm = cleanEditedTerm(match[1] ?? "");
    const targetTerm = cleanEditedTerm(match[2] ?? "");

    if (
      sourceTerm.length > 0 &&
      targetTerm.length > 0 &&
      normalizeText(sourceTerm) !== normalizeText(targetTerm)
    ) {
      return {
        sourceTerm,
        targetTerm,
      };
    }
  }

  return null;
}

function preferenceCandidatesFromDecisions(
  decisions: Array<{
    observationSessionId: string;
    decisionType: string;
    note: string | null;
    editedSuggestion: string | null;
    createdAt: Date;
    observationSession: {
      status: string;
      libraryDocument: {
        originalFileName: string;
      };
    };
  }>,
) {
  const modifiedPreferences = new Map<string, PreferenceAggregate>();

  function addModifiedPreference(
    preference: {
      sourceTerm: string;
      targetTerm: string;
    },
    title: string,
    seenAt: Date,
    sessionId: string,
  ) {
    const preferenceKey = `${normalizeText(preference.sourceTerm)}:${normalizeText(
      preference.targetTerm,
    )}`;
    const existing = modifiedPreferences.get(preferenceKey);

    if (!existing) {
      modifiedPreferences.set(preferenceKey, {
        sessionCount: 1,
        sourceTerm: preference.sourceTerm,
        targetTerm: preference.targetTerm,
        titles: [title],
        lastSeen: seenAt,
        sourceSessionIds: [sessionId],
      });
      return;
    }

    existing.sourceSessionIds = [...new Set([...existing.sourceSessionIds, sessionId])];
    if (existing.titles.includes(title)) return;

    existing.sessionCount += 1;
    existing.titles = [...new Set([...existing.titles, title])].slice(0, 5);

    if (seenAt > existing.lastSeen) {
      existing.lastSeen = seenAt;
    }
  }

  for (const decision of decisions) {
    if (decision.decisionType !== "MODIFY" || !decision.editedSuggestion) {
      continue;
    }

    if (
      decision.observationSession.status !== "APPROVED" &&
      decision.observationSession.status !== "MODIFIED"
    ) {
      continue;
    }

    const preference = parseEditedPreference(decision.editedSuggestion);

    if (!preference) {
      continue;
    }

    addModifiedPreference(
      preference,
      decision.observationSession.libraryDocument.originalFileName,
      decision.createdAt,
      decision.observationSessionId,
    );
  }

  const candidates: MemoryCandidate[] = [];

  for (const aggregate of modifiedPreferences.values()) {
    if (aggregate.sessionCount < 2) {
      continue;
    }

    candidates.push({
      memoryKey: memoryKeyFor(
        "PREFERENCE",
        `prefer-${aggregate.targetTerm}-over-${aggregate.sourceTerm}`,
      ),
      memoryType: "PREFERENCE",
      title: `Prefer "${aggregate.targetTerm}" over "${aggregate.sourceTerm}"`,
      description:
        "Deanne has repeatedly modified review language in this direction.",
      confidence: clampConfidence(0.48 + Math.min(aggregate.sessionCount, 5) * 0.07),
      evidence: [`Modified review edits: ${aggregate.titles.join(", ")}`],
      seenAt: aggregate.lastSeen,
      occurrenceCount: aggregate.sessionCount,
      sourceSessionIds: aggregate.sourceSessionIds,
    });
  }

  return candidates;
}

async function relationshipCandidatesForSession(sessionId: string, seenAt: Date) {
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
    take: 5,
  });

  return connections
    .map((connection): MemoryCandidate | null => {
      const sharedTerms = asStringArray(connection.sharedTerms).slice(0, 4);
      const usefulSharedTerms = sharedTerms.filter((term) => {
        const normalized = normalizeText(term);

        return (
          normalized.length > 0 &&
          !stopWords.has(normalized) &&
          !/\bfile[a-z0-9]*\b/.test(normalized)
        );
      });

      if (usefulSharedTerms.length < 2 || connection.confidence < 0.35) {
        return null;
      }

      const currentSession =
        connection.sourceObservationSessionId === sessionId
          ? connection.sourceObservationSession
          : connection.targetObservationSession;
      const relatedSession =
        connection.sourceObservationSessionId === sessionId
          ? connection.targetObservationSession
          : connection.sourceObservationSession;
      const relationshipTitle = `Related items around ${usefulSharedTerms
        .slice(0, 2)
        .join(" and ")}`;

      return {
        memoryKey: memoryKeyFor(
          "RELATIONSHIP",
          usefulSharedTerms.slice(0, 3).join(" "),
        ),
        memoryType: "RELATIONSHIP",
        title: relationshipTitle,
        description:
          "Deanne approved an observation that appears connected to other library items through repeated concepts.",
        confidence: clampConfidence(connection.confidence),
        evidence: [
          `Approved item: ${currentSession.libraryDocument.originalFileName}`,
          `Related item: ${relatedSession.libraryDocument.originalFileName}`,
          `Shared concepts: ${usefulSharedTerms.join(", ")}`,
          connection.reasoning,
        ],
        seenAt,
        occurrenceCount: 1,
        sourceSessionIds: [connection.sourceObservationSessionId, connection.targetObservationSessionId],
      };
    })
    .filter((candidate): candidate is MemoryCandidate => candidate !== null);
}

async function upsertMemoryCandidate(candidate: MemoryCandidate) {
  const prisma = getPrismaClient();
  const existing = await prisma.memoryEntry.findUnique({
    where: { memoryKey: candidate.memoryKey },
  });

  if (!existing) {
    await prisma.memoryEntry.create({
      data: {
        memoryKey: candidate.memoryKey,
        memoryType: candidate.memoryType,
        title: candidate.title,
        description: candidate.description,
        confidence: candidate.confidence,
        evidence: toJsonInput(candidate.evidence),
        status: activeMemoryStatus,
        firstSeen: candidate.seenAt,
        lastSeen: candidate.seenAt,
        occurrenceCount: Math.max(1, candidate.occurrenceCount),
      },
    });

    return "CREATED" as const;
  }

  if (existing.status !== activeMemoryStatus) {
    return "UNCHANGED" as const;
  }

  const existingEvidence = evidenceFromJson(existing.evidence);
  const mergedEvidence = mergeEvidence(existingEvidence, candidate.evidence);
  const hasNewEvidence = mergedEvidence.length > existingEvidence.length;

  if (!hasNewEvidence && existing.occurrenceCount >= candidate.occurrenceCount) {
    return "UNCHANGED" as const;
  }

  await prisma.memoryEntry.update({
    where: { id: existing.id },
    data: {
      description: candidate.description,
      confidence: clampConfidence(
        Math.max(existing.confidence, candidate.confidence) + 0.03,
      ),
      evidence: toJsonInput(mergedEvidence),
      lastSeen: candidate.seenAt > existing.lastSeen ? candidate.seenAt : existing.lastSeen,
      occurrenceCount: Math.max(
        existing.occurrenceCount + (hasNewEvidence ? 1 : 0),
        candidate.occurrenceCount,
      ),
    },
  });

  return "UPDATED" as const;
}

async function attachMemorySources(candidate: MemoryCandidate, created: boolean) {
  const prisma = getPrismaClient();
  const sourceIds = [...new Set(candidate.sourceSessionIds)];
  if (!sourceIds.length) return false;
  const sources = await prisma.observationSession.findMany({
    select: { id: true, libraryDocument: { select: { scannedFiles: {
      select: { scanSession: { select: { connectedFolderId: true } } },
    } } } },
    where: { id: { in: sourceIds } },
  });
  if (sources.length !== sourceIds.length || sources.some((source) => !source.libraryDocument.scannedFiles.length)) return false;
  const rows = sources.flatMap((source) => [...new Set(source.libraryDocument.scannedFiles
    .map((file) => file.scanSession.connectedFolderId))].map((connectedLibraryId) => ({
      observationSessionId: source.id, connectedLibraryId,
    })));
  const entry = await prisma.memoryEntry.findUnique({
    select: { id: true, searchProvenanceComplete: true, status: true },
    where: { memoryKey: candidate.memoryKey },
  });
  if (!entry || entry.status !== "ACTIVE") return false;
  await prisma.$transaction(async (tx) => {
    if (entry.searchProvenanceComplete) await tx.memoryEntry.update({
      data: { searchProvenanceComplete: false }, where: { id: entry.id },
    });
    await tx.memorySearchSource.createMany({
      data: rows.map((row) => ({ memoryEntryId: entry.id, ...row })), skipDuplicates: true,
    });
    const searchSourceCount = await tx.memorySearchSource.count({ where: { memoryEntryId: entry.id } });
    if (created || entry.searchProvenanceComplete) await tx.memoryEntry.update({
      data: { searchProvenanceComplete: true, searchSourceCount }, where: { id: entry.id },
    });
  });
  return true;
}

export async function buildMemoryFromApprovedSession(sessionId: string) {
  const prisma = getPrismaClient();
  const session = await prisma.observationSession.findUnique({
    where: { id: sessionId },
    include: {
      libraryDocument: {
        select: {
          originalFileName: true,
          previewText: true,
          rawText: true,
        },
      },
      humanDecisions: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (
    !session ||
    (session.status !== "APPROVED" && session.status !== "MODIFIED") ||
    (session.status === "MODIFIED" &&
      !session.humanDecisions.some(
        (decision) => decision.decisionType === "MODIFY" && decision.editedSuggestion?.trim(),
      ))
  ) {
    return 0;
  }

  const approvedSessions = await prisma.observationSession.findMany({
    where: { status: { in: ["APPROVED", "MODIFIED"] } },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      libraryDocument: {
        select: {
          originalFileName: true,
          previewText: true,
          rawText: true,
        },
      },
      humanDecisions: {
        orderBy: { createdAt: "desc" },
      },
    },
  });
  const preparedApprovedSessions = approvedSessions.map((approvedSession) =>
    prepareSession(approvedSession),
  );
  const currentPreparedSession = prepareSession(session);
  const candidates = new Map<string, MemoryCandidate>();

  for (const candidate of termCandidatesForSession(
    currentPreparedSession,
    aggregateApprovedTerms(preparedApprovedSessions),
  )) {
    addCandidate(candidates, candidate);
  }

  for (const candidate of themeCandidatesForSession(currentPreparedSession)) {
    addCandidate(candidates, candidate);
  }

  if (session.status === "APPROVED") {
    for (const candidate of await relationshipCandidatesForSession(
      sessionId,
      session.createdAt,
    )) {
      addCandidate(candidates, candidate);
    }
  }

  const humanDecisions = await prisma.humanDecision.findMany({
    where: {
      decisionType: "MODIFY",
      editedSuggestion: { not: null },
      observationSession: {
        status: { in: ["APPROVED", "MODIFIED"] },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 150,
    include: {
      observationSession: {
        select: {
          status: true,
          libraryDocument: {
            select: {
              originalFileName: true,
            },
          },
        },
      },
    },
  });

  for (const candidate of preferenceCandidatesFromDecisions(humanDecisions)) {
    addCandidate(candidates, candidate);
  }

  let changedCount = 0;

  for (const candidate of candidates.values()) {
    const existing = await prisma.memoryEntry.findUnique({
      select: { id: true }, where: { memoryKey: candidate.memoryKey },
    });
    if (existing && !await attachMemorySources(candidate, false)) {
      await prisma.memoryEntry.update({
        data: { searchProvenanceComplete: false }, where: { id: existing.id },
      });
    }
    const result = await upsertMemoryCandidate(candidate);
    if (result === "CREATED") await attachMemorySources(candidate, true);
    if (result !== "UNCHANGED") {
      changedCount += 1;
    }
  }

  return changedCount;
}

export async function backfillHistoricalMemorySearchSources(limit = 20) {
  const prisma = getPrismaClient();
  const entries = await prisma.memoryEntry.findMany({
    take: Math.min(20, Math.max(1, limit)), orderBy: { id: "asc" },
    include: { searchSources: { select: { connectedLibraryId: true, observationSessionId: true } } },
    where: { status: "ACTIVE", searchProvenanceComplete: false,
      searchProvenanceCheckedAt: null },
  });
  let reconstructed = 0;
  for (const entry of entries) {
    const evidence = evidenceFromJson(entry.evidence);
    const approvedItem = evidence.find((part) => part.startsWith("Approved item: "));
    const strictShape = entry.occurrenceCount === 1 && evidence.length === 2 &&
      approvedItem && evidence.filter((part) => part.startsWith("Approved item: ")).length === 1 &&
      ((entry.memoryType === "TERM" && evidence.some((part) => part.startsWith("Recurring term: "))) ||
        (entry.memoryType === "THEME" && evidence.some((part) => part.startsWith("Repeated concepts: "))));
    if (strictShape) {
      const title = approvedItem.slice("Approved item: ".length);
      const sessions = await prisma.observationSession.findMany({
        take: 2,
        where: { status: { in: ["APPROVED", "MODIFIED"] }, libraryDocument: { originalFileName: title } },
        include: { libraryDocument: { select: { originalFileName: true, previewText: true, rawText: true,
          scannedFiles: { select: { relativePath: true, scanSession: {
            select: { connectedFolderId: true },
          } } },
        } }, humanDecisions: { orderBy: { createdAt: "desc" } } },
      });
      if (sessions.length === 1) {
        const source = sessions[0];
        const physicalFiles = new Set(source.libraryDocument.scannedFiles.map((file) =>
          `${file.scanSession.connectedFolderId}\0${file.relativePath.replaceAll("\\", "/").toLowerCase()}`));
        const candidate = [
          ...termCandidatesForSession(prepareSession(source), new Map()),
          ...themeCandidatesForSession(prepareSession(source)),
        ].find((item) => item.memoryKey === entry.memoryKey &&
          JSON.stringify(item.evidence) === JSON.stringify(evidence));
        if (physicalFiles.size === 1 && candidate) {
          const connectedLibraryId = source.libraryDocument.scannedFiles[0].scanSession.connectedFolderId;
          const existingSourcesMatch = entry.searchSources.every((existing) =>
            existing.connectedLibraryId === connectedLibraryId && existing.observationSessionId === source.id);
          if (existingSourcesMatch) {
            await prisma.$transaction(async (tx) => {
              await tx.memorySearchSource.createMany({ data: [{
                memoryEntryId: entry.id, observationSessionId: source.id, connectedLibraryId,
              }], skipDuplicates: true });
              await tx.memoryEntry.update({ data: {
                searchProvenanceComplete: true, searchSourceCount: 1,
                searchProvenanceCheckedAt: new Date(),
              }, where: { id: entry.id } });
            });
            reconstructed += 1;
            continue;
          }
        }
      }
    }
    await prisma.memoryEntry.update({
      data: { searchProvenanceCheckedAt: new Date() }, where: { id: entry.id },
    });
  }
  return { checked: entries.length, reconstructed,
    remaining: await prisma.memoryEntry.count({ where: { status: "ACTIVE",
      searchProvenanceComplete: false, searchProvenanceCheckedAt: null } }) };
}

function summarizeMemoryEntry(entry: {
  id: string;
  memoryType: MemoryType;
  title: string;
  description: string;
  confidence: number;
  evidence: Prisma.JsonValue;
  status: "ACTIVE" | "ARCHIVED";
  firstSeen: Date;
  lastSeen: Date;
  occurrenceCount: number;
}): MemoryEntrySummary {
  return {
    id: entry.id,
    memoryType: entry.memoryType,
    title: entry.title,
    description: entry.description,
    confidence: entry.confidence,
    evidence: evidenceFromJson(entry.evidence),
    status: entry.status,
    firstSeen: entry.firstSeen.toISOString(),
    lastSeen: entry.lastSeen.toISOString(),
    occurrenceCount: entry.occurrenceCount,
  };
}

export async function getMemoryPageData(): Promise<MemoryPageData> {
  const prisma = getPrismaClient();
  const [themes, preferredTerms, recurringConcepts, humanPreferences, recentlyLearned] =
    await Promise.all([
      prisma.memoryEntry.findMany({
        where: { status: activeMemoryStatus, memoryType: "THEME" },
        orderBy: [{ occurrenceCount: "desc" }, { lastSeen: "desc" }],
        take: 12,
      }),
      prisma.memoryEntry.findMany({
        where: { status: activeMemoryStatus, memoryType: "TERM" },
        orderBy: [{ occurrenceCount: "desc" }, { lastSeen: "desc" }],
        take: 12,
      }),
      prisma.memoryEntry.findMany({
        where: {
          status: activeMemoryStatus,
          memoryType: { in: ["RELATIONSHIP", "NOTE"] },
        },
        orderBy: [{ occurrenceCount: "desc" }, { lastSeen: "desc" }],
        take: 12,
      }),
      prisma.memoryEntry.findMany({
        where: { status: activeMemoryStatus, memoryType: "PREFERENCE" },
        orderBy: [{ occurrenceCount: "desc" }, { lastSeen: "desc" }],
        take: 12,
      }),
      prisma.memoryEntry.findMany({
        where: { status: activeMemoryStatus },
        orderBy: [{ lastSeen: "desc" }, { updatedAt: "desc" }],
        take: 8,
      }),
    ]);

  return {
    themes: themes.map(summarizeMemoryEntry),
    preferredTerms: preferredTerms.map(summarizeMemoryEntry),
    recurringConcepts: recurringConcepts.map(summarizeMemoryEntry),
    humanPreferences: humanPreferences.map(summarizeMemoryEntry),
    recentlyLearned: recentlyLearned.map(summarizeMemoryEntry),
  };
}
