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
};

type TermAggregate = {
  sessionCount: number;
  titles: string[];
  lastSeen: Date;
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
        });
        continue;
      }

      existing.sessionCount += 1;
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
      });
      return;
    }

    if (existing.titles.includes(title)) {
      return;
    }

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

    return true;
  }

  if (existing.status !== activeMemoryStatus) {
    return false;
  }

  const existingEvidence = evidenceFromJson(existing.evidence);
  const mergedEvidence = mergeEvidence(existingEvidence, candidate.evidence);
  const hasNewEvidence = mergedEvidence.length > existingEvidence.length;

  if (!hasNewEvidence && existing.occurrenceCount >= candidate.occurrenceCount) {
    return false;
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

  if (!session || session.status !== "APPROVED") {
    return 0;
  }

  const approvedSessions = await prisma.observationSession.findMany({
    where: { status: "APPROVED" },
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

  for (const candidate of await relationshipCandidatesForSession(
    sessionId,
    session.createdAt,
  )) {
    addCandidate(candidates, candidate);
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
    if (await upsertMemoryCandidate(candidate)) {
      changedCount += 1;
    }
  }

  return changedCount;
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
