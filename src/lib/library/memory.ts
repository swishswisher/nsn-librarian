import { Prisma } from "@prisma/client";

import { currentMemorySourceRows, validMemorySourcesSql, curatedMemorySql, eligibleMemoryObservationSql, memoryReviewAuthoritySql } from "./memory-provenance";
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

function correctionArchives(value: Prisma.JsonValue) {
  return asArray(value).filter((item) => isRecord(item) && item.kind === "HUMAN_CORRECTION_ARCHIVE");
}

function requiredMemorySources(value: Prisma.JsonValue) {
  return asArray(value).flatMap((item) => isRecord(item) && item.kind === "MEMORY_PROVENANCE_REQUIRED"
    ? asStringArray(item.sourceSessionIds as Prisma.JsonValue) : []);
}

function provenanceRequirement(sourceSessionIds: string[]) {
  return { kind: "MEMORY_PROVENANCE_REQUIRED", sourceSessionIds: [...new Set(sourceSessionIds)].sort() };
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

  const currentDecisions = new Set<string>();
  for (const decision of decisions) {
    if (currentDecisions.has(decision.observationSessionId)) continue;
    currentDecisions.add(decision.observationSessionId);
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

async function relationshipCandidatesForSession(sessionId: string, seenAt: Date, prisma: Prisma.TransactionClient) {
  const loadPage = (cursor?: string) => prisma.knowledgeConnection.findMany({
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    where: {
      status: { in: [...visibleConnectionStatuses] },
      supersededAt: null, confidence: { gte: 0.35 },
      sourceObservationSession: { status: "APPROVED" },
      targetObservationSession: { status: "APPROVED" },
      OR: [
        { sourceObservationSessionId: sessionId },
        { targetObservationSessionId: sessionId },
      ],
    },
    orderBy: [{ similarityScore: "desc" }, { createdAt: "desc" }, { id: "desc" }],
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
    take: 50,
  });

  const connections: Awaited<ReturnType<typeof loadPage>> = [];
  let cursor: string | undefined;
  do {
    const page = await loadPage(cursor);
    for (const connection of page) {
      const useful = asStringArray(connection.sharedTerms).slice(0, 4).filter((term) => {
        const normalized = normalizeText(term);
        return normalized.length > 0 && !stopWords.has(normalized) && !/\bfile[a-z0-9]*\b/.test(normalized);
      });
      if (useful.length < 2) continue;
      connections.push(connection);
      if (connections.length === 5) break;
    }
    cursor = page.length === 50 ? page.at(-1)?.id : undefined;
  } while (connections.length < 5 && cursor);

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

async function upsertMemoryCandidate(candidate: MemoryCandidate, prisma: Prisma.TransactionClient) {
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
        evidence: toJsonInput([...candidate.evidence, provenanceRequirement(candidate.sourceSessionIds)]),
        status: activeMemoryStatus,
        firstSeen: candidate.seenAt,
        lastSeen: candidate.seenAt,
        occurrenceCount: Math.max(1, candidate.occurrenceCount),
      },
    });

    return "CREATED" as const;
  }

  if (existing.status !== activeMemoryStatus) {
    if (existing.status === "ARCHIVED" && correctionArchives(existing.evidence).length > 0) {
      {
        await prisma.memoryEntry.update({ where: { id: existing.id }, data: {
          status: activeMemoryStatus, description: candidate.description,
          evidence: toJsonInput([...candidate.evidence, provenanceRequirement(candidate.sourceSessionIds), ...correctionArchives(existing.evidence)]),
          confidence: candidate.confidence, occurrenceCount: candidate.occurrenceCount,
          lastSeen: candidate.seenAt, searchProvenanceComplete: false, searchSourceCount: 0,
        } });
        await prisma.memorySearchSource.deleteMany({ where: { memoryEntryId: existing.id } });
      }
      return "RESTORED" as const;
    }
    return "UNCHANGED" as const;
  }

  const existingEvidence = evidenceFromJson(existing.evidence);
  const mergedEvidence = mergeEvidence(existingEvidence, candidate.evidence);
  const hasNewEvidence = mergedEvidence.length > existingEvidence.length;
  const requiredIds = [...new Set([...requiredMemorySources(existing.evidence), ...candidate.sourceSessionIds])].sort();
  const newRequirements = JSON.stringify(requiredIds) !== JSON.stringify(requiredMemorySources(existing.evidence).sort());

  if (!hasNewEvidence && existing.occurrenceCount >= candidate.occurrenceCount) {
    if (newRequirements) await prisma.memoryEntry.update({ where: { id: existing.id }, data: {
      evidence: toJsonInput([...existingEvidence, provenanceRequirement(requiredIds), ...correctionArchives(existing.evidence)]),
      searchProvenanceComplete: false,
    } });
    return "UNCHANGED" as const;
  }

  await prisma.memoryEntry.update({
    where: { id: existing.id },
    data: {
      description: candidate.description,
      confidence: clampConfidence(
        Math.max(existing.confidence, candidate.confidence) + 0.03,
      ),
      evidence: toJsonInput([...mergedEvidence, provenanceRequirement(requiredIds), ...correctionArchives(existing.evidence)]),
      lastSeen: candidate.seenAt > existing.lastSeen ? candidate.seenAt : existing.lastSeen,
      occurrenceCount: Math.max(
        existing.occurrenceCount + (hasNewEvidence ? 1 : 0),
        candidate.occurrenceCount,
      ),
    },
  });

  return "UPDATED" as const;
}

async function attachMemorySources(candidate: MemoryCandidate, tx: Prisma.TransactionClient) {
  const entry = await tx.memoryEntry.findUnique({ where: { memoryKey: candidate.memoryKey } });
  if (!entry || entry.status !== "ACTIVE") return false;
  const sourceIds = [...new Set([...requiredMemorySources(entry.evidence), ...candidate.sourceSessionIds])];
  const rows = await currentMemorySourceRows(tx, sourceIds);
  await tx.memorySearchSource.createMany({ data: rows.map((row) => ({ memoryEntryId: entry.id, ...row })), skipDuplicates: true });
  const covered = new Set(rows.map((row) => row.observationSessionId));
  const [verified] = await tx.$queryRaw<Array<{ valid: boolean; count: bigint }>>(Prisma.sql`
    SELECT (${validMemorySourcesSql()}) AS valid,
      (SELECT count(*) FROM "MemorySearchSource" source WHERE source."memoryEntryId" = memory.id) AS count
    FROM "MemoryEntry" memory WHERE memory.id = ${entry.id}
  `);
  const count = Number(verified?.count ?? 0);
  const complete = sourceIds.length > 0 && sourceIds.every((id) => covered.has(id)) &&
    verified?.valid === true && count >= entry.searchSourceCount;
  // Missing historical contributors cannot silently become a smaller manifest.
  // Only explicit human reconciliation/restoration resets that obligation.
  const searchSourceCount = complete ? count : Math.max(count, entry.searchSourceCount);
  if (entry.searchProvenanceComplete !== complete || entry.searchSourceCount !== searchSourceCount) {
    await tx.memoryEntry.update({ where: { id: entry.id }, data: {
      searchProvenanceComplete: complete, searchSourceCount,
    } });
  }
  return complete;
}

export async function invalidateCorrectedMemorySources(tx: Prisma.TransactionClient, sessionId: string) {
  await tx.memoryEntry.updateMany({
    where: { status: "ACTIVE", searchProvenanceComplete: true,
      searchSources: { some: { observationSessionId: sessionId } } },
    data: { searchProvenanceComplete: false, searchProvenanceCheckedAt: new Date() },
  });
}

async function reconcileCorrectedMemory(
  sessionId: string,
  sessions: StoredSessionForMemory[],
  candidates: Map<string, MemoryCandidate>,
  prisma: Prisma.TransactionClient,
) {
  const entries = await prisma.memoryEntry.findMany({
    where: { status: "ACTIVE", searchSources: { some: { observationSessionId: sessionId } } },
    include: { searchSources: true },
  });
  const prepared = sessions.map(prepareSession);
  const aggregate = aggregateApprovedTerms(prepared);
  for (const entry of entries) {
    const support = new Map<string, MemoryCandidate>();
    const sourceIds = new Set(entry.searchSources.map((source) => source.observationSessionId));
    const current = candidates.get(entry.memoryKey);
    if (current) addCandidate(support, current);
    for (const source of prepared.filter((item) => sourceIds.has(item.id) && item.id !== sessionId)) {
      for (const candidate of [...termCandidatesForSession(source, aggregate), ...themeCandidatesForSession(source)]) {
        if (candidate.memoryKey === entry.memoryKey) addCandidate(support, candidate);
      }
      const stored = sessions.find((item) => item.id === source.id);
      if (stored?.status === "APPROVED" && entry.memoryType === "RELATIONSHIP") {
        for (const candidate of await relationshipCandidatesForSession(source.id, source.seenAt, prisma)) {
          if (candidate.memoryKey === entry.memoryKey) addCandidate(support, candidate);
        }
      }
    }
    const replacement = support.get(entry.memoryKey);
    if (!replacement) {
      // Keep the original evidence and provenance as archived history.
      await prisma.memoryEntry.update({ where: { id: entry.id }, data: {
        status: "ARCHIVED", searchProvenanceComplete: false, searchProvenanceCheckedAt: new Date(),
        evidence: toJsonInput([...asArray(entry.evidence), {
          kind: "HUMAN_CORRECTION_ARCHIVE", observationSessionId: sessionId, archivedAt: new Date().toISOString(),
          previousEvidence: asArray(entry.evidence).filter((item) => !isRecord(item) || item.kind !== "HUMAN_CORRECTION_ARCHIVE"),
          sourceSessionIds: [...sourceIds],
        }]),
      } });
      continue;
    }
    const retainedIds = [...new Set(replacement.sourceSessionIds)].sort();
    const oldIds = [...sourceIds].sort();
    if (entry.searchProvenanceComplete && JSON.stringify(oldIds) === JSON.stringify(retainedIds) &&
        JSON.stringify(evidenceFromJson(entry.evidence)) === JSON.stringify(replacement.evidence)) continue;
    {
      await prisma.memoryEntry.update({ where: { id: entry.id }, data: {
        description: replacement.description,
        evidence: toJsonInput([...replacement.evidence, provenanceRequirement(replacement.sourceSessionIds), ...correctionArchives(entry.evidence)]),
        confidence: replacement.confidence, occurrenceCount: replacement.memoryType === "THEME"
          ? retainedIds.length : replacement.occurrenceCount,
        lastSeen: replacement.seenAt, searchProvenanceComplete: false, searchSourceCount: 0,
      } });
      await prisma.memorySearchSource.deleteMany({ where: {
        memoryEntryId: entry.id, observationSessionId: { notIn: retainedIds },
      } });
    }
    await attachMemorySources(replacement, prisma);
  }
}

export async function buildMemoryFromApprovedSession(sessionId: string) {
  return getPrismaClient().$transaction((tx) => buildMemoryInTransaction(sessionId, tx),
    { isolationLevel: "Serializable", timeout: 120_000 });
}

async function buildMemoryInTransaction(sessionId: string, prisma: Prisma.TransactionClient) {
  // Authority rows are locked before derived parents, matching human review's
  // observation -> Memory lock order. Never lock a source after writing Memory.
  await prisma.$queryRaw(Prisma.sql`SELECT id FROM "ObservationSession" WHERE id = ${sessionId} FOR SHARE`);
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
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      },
    },
  });

  if (
    !session ||
    (session.status !== "APPROVED" && session.status !== "MODIFIED" && session.status !== "REJECTED") ||
    (session.status === "MODIFIED" &&
      !session.humanDecisions.some(
        (decision) => decision.decisionType === "MODIFY" && decision.editedSuggestion?.trim(),
      ))
  ) {
    return 0;
  }

  const reapprovedAfterCorrection = session.status === "APPROVED" && session.humanDecisions.some(
    (decision) => decision.decisionType === "MODIFY" || decision.decisionType === "REJECT",
  );
  const contributionSources = session.status === "MODIFIED" || session.status === "REJECTED" || reapprovedAfterCorrection
    ? await prisma.memorySearchSource.findMany({
      select: { observationSessionId: true },
      where: { memoryEntry: { status: "ACTIVE", searchSources: {
        some: { observationSessionId: sessionId },
      } } },
    }) : [];
  const approvedIds = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT observation.id FROM "ObservationSession" observation WHERE ${eligibleMemoryObservationSql}
    ORDER BY observation."createdAt" DESC, observation.id DESC LIMIT 100
  `);
  const approvedSessions = await prisma.observationSession.findMany({
    where: { id: { in: approvedIds.map((row) => row.id) } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      },
    },
  });
  const missingSources = contributionSources.map((source) => source.observationSessionId)
    .filter((id) => !approvedSessions.some((source) => source.id === id));
  if (missingSources.length) approvedSessions.push(...await prisma.observationSession.findMany({
    where: { id: { in: missingSources }, status: { in: ["APPROVED", "MODIFIED"] } },
    include: { libraryDocument: { select: { originalFileName: true, previewText: true, rawText: true } },
      humanDecisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] } },
  }));
  const preparedApprovedSessions = approvedSessions.map((approvedSession) =>
    prepareSession(approvedSession),
  );
  const candidates = new Map<string, MemoryCandidate>();

  if (session.status !== "REJECTED") {
    const currentPreparedSession = prepareSession(session);
    for (const candidate of termCandidatesForSession(
      currentPreparedSession,
      aggregateApprovedTerms(preparedApprovedSessions),
    )) {
      addCandidate(candidates, candidate);
    }

    for (const candidate of themeCandidatesForSession(currentPreparedSession)) {
      addCandidate(candidates, candidate);
    }
  }

  if (session.status === "APPROVED") {
    for (const candidate of await relationshipCandidatesForSession(
      sessionId,
      session.createdAt, prisma,
    )) {
      addCandidate(candidates, candidate);
    }
  }

  const loadPreferenceDecisions = (ids: string[]) => prisma.humanDecision.findMany({
    where: { id: { in: ids } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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

  const humanDecisions: Awaited<ReturnType<typeof loadPreferenceDecisions>> = [];
  let decisionCursor: string | undefined;
  do {
    const page = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT decision.id FROM "HumanDecision" decision JOIN "ObservationSession" observation
        ON observation.id = decision."observationSessionId"
      WHERE ${eligibleMemoryObservationSql} AND decision."decisionType" = 'MODIFY'
        AND length(btrim(decision."editedSuggestion")) > 0
        AND decision.id = (SELECT authority.id FROM "HumanDecision" authority
          WHERE authority."observationSessionId" = observation.id AND ${memoryReviewAuthoritySql}
          ORDER BY authority."createdAt" DESC, authority.id DESC LIMIT 1)
        AND ${decisionCursor ? Prisma.sql`(decision."createdAt", decision.id) <
          (SELECT previous."createdAt", previous.id FROM "HumanDecision" previous WHERE previous.id = ${decisionCursor})` : Prisma.sql`true`}
      ORDER BY decision."createdAt" DESC, decision.id DESC LIMIT 150
    `);
    for (const decision of await loadPreferenceDecisions(page.map((row) => row.id))) {
      if (decision.editedSuggestion && parseEditedPreference(decision.editedSuggestion)) humanDecisions.push(decision);
      if (humanDecisions.length === 150) break;
    }
    decisionCursor = page.length === 150 ? page.at(-1)?.id : undefined;
  } while (humanDecisions.length < 150 && decisionCursor);

  const missingPreferenceSources = contributionSources.map((source) => source.observationSessionId)
    .filter((id) => !humanDecisions.some((decision) => decision.observationSessionId === id));
  if (missingPreferenceSources.length) humanDecisions.push(...await prisma.humanDecision.findMany({
    where: { observationSessionId: { in: missingPreferenceSources },
      observationSession: { status: { in: ["APPROVED", "MODIFIED"] } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], distinct: ["observationSessionId"],
    include: { observationSession: { select: { status: true,
      libraryDocument: { select: { originalFileName: true } } } } },
  }));
  for (const candidate of preferenceCandidatesFromDecisions(humanDecisions)) {
    addCandidate(candidates, candidate);
  }

  const existingRequirements = await prisma.memoryEntry.findMany({
    where: { memoryKey: { in: [...candidates.keys()] } }, select: { evidence: true,
      searchSources: { select: { observationSessionId: true } } },
  });
  const sourceIds = [...new Set([...candidates.values()].flatMap((candidate) => candidate.sourceSessionIds)
    .concat(existingRequirements.flatMap((entry) => [...requiredMemorySources(entry.evidence),
      ...entry.searchSources.map((source) => source.observationSessionId)])))].sort();
  for (let offset = 0; offset < sourceIds.length; offset += 500) await prisma.$queryRaw(Prisma.sql`
    SELECT id FROM "ObservationSession" WHERE id IN (${Prisma.join(sourceIds.slice(offset, offset + 500))}) ORDER BY id FOR SHARE
  `);

  if (session.status === "MODIFIED" || session.status === "REJECTED" || reapprovedAfterCorrection) {
    await reconcileCorrectedMemory(sessionId, approvedSessions, candidates, prisma);
  }
  if (session.status === "REJECTED") return 0;

  let changedCount = 0;

  for (const candidate of candidates.values()) {
    const result = await upsertMemoryCandidate(candidate, prisma);
    await attachMemorySources(candidate, prisma);
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
        } }, humanDecisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] } },
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
            const complete = await prisma.$transaction(async (tx) => {
              await tx.$queryRaw(Prisma.sql`SELECT id FROM "ObservationSession" WHERE id = ${source.id} FOR SHARE`);
              const result = await attachMemorySources(candidate, tx);
              await tx.memoryEntry.update({ where: { id: entry.id }, data: { searchProvenanceCheckedAt: new Date() } });
              return result;
            }, { isolationLevel: "Serializable" });
            if (!complete) continue;
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
  async function category(types?: string[], recent = false) {
    const order = recent ? Prisma.sql`memory."lastSeen" DESC, memory."updatedAt" DESC, memory.id DESC`
      : Prisma.sql`memory."occurrenceCount" DESC, memory."lastSeen" DESC, memory.id DESC`;
    const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT memory.id FROM "MemoryEntry" memory WHERE (${curatedMemorySql})
        AND ${types ? Prisma.sql`memory."memoryType"::text IN (${Prisma.join(types)})` : Prisma.sql`true`}
      ORDER BY ${order} LIMIT ${recent ? 8 : 12}
    `);
    const entries = await prisma.memoryEntry.findMany({ where: { id: { in: ids.map((entry) => entry.id) } } });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    return ids.flatMap(({ id }) => byId.has(id) ? [byId.get(id)!] : []);
  }
  const [themes, preferredTerms, recurringConcepts, humanPreferences, recentlyLearned] = await Promise.all([
    category(["THEME"]), category(["TERM"]), category(["RELATIONSHIP", "NOTE"]), category(["PREFERENCE"]), category(undefined, true),
  ]);

  return {
    themes: themes.map(summarizeMemoryEntry),
    preferredTerms: preferredTerms.map(summarizeMemoryEntry),
    recurringConcepts: recurringConcepts.map(summarizeMemoryEntry),
    humanPreferences: humanPreferences.map(summarizeMemoryEntry),
    recentlyLearned: recentlyLearned.map(summarizeMemoryEntry),
  };
}
