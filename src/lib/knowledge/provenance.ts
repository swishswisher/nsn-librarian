import type { Prisma } from "@prisma/client";

import type {
  KnowledgeEvidenceSummary,
  KnowledgeObjectType,
} from "@/types/library";

const stopWords = new Set([
  "about",
  "after",
  "again",
  "also",
  "approved",
  "around",
  "because",
  "before",
  "being",
  "bridge",
  "could",
  "deanne",
  "decision",
  "decisions",
  "document",
  "documents",
  "entry",
  "file",
  "files",
  "from",
  "have",
  "human",
  "item",
  "items",
  "knowledge",
  "library",
  "librarian",
  "machine",
  "memory",
  "might",
  "notebook",
  "observation",
  "observations",
  "organization",
  "plan",
  "plans",
  "provisional",
  "recommendation",
  "recommendations",
  "reflection",
  "review",
  "reviewed",
  "scan",
  "scanned",
  "session",
  "should",
  "source",
  "suggestion",
  "suggestions",
  "that",
  "their",
  "there",
  "these",
  "this",
  "those",
  "through",
  "trusted",
  "with",
  "without",
  "would",
]);

const workflowKnowledgeStopPhrases = [
  "action",
  "actions",
  "approved",
  "batch",
  "batches",
  "bridge",
  "codex",
  "codex execution test",
  "create folder",
  "current",
  "current location",
  "destination",
  "developer",
  "duplicate action wording",
  "execute",
  "executed",
  "execution",
  "execution run",
  "file",
  "files",
  "folder",
  "folders",
  "manual milestone",
  "milestone",
  "modified",
  "modifying",
  "monitoring",
  "move",
  "move source",
  "moved",
  "moving",
  "organization",
  "organization plan",
  "organization suggestions",
  "organized",
  "organize",
  "planned",
  "planned location",
  "plan",
  "recommendation",
  "recommendation ready",
  "recommendations",
  "rejected",
  "rename",
  "renamed",
  "review",
  "reviewed",
  "route",
  "routes",
  "scan",
  "scan session",
  "scanned",
  "smoke test",
  "source",
  "status",
  "statuses",
  "temporary",
  "test",
  "tests",
  "undo",
];

export const workflowKnowledgeStopTerms = new Set(
  workflowKnowledgeStopPhrases.map((term) => normalizeKnowledgeName(term)),
);

const workflowKnowledgeStopTokens = new Set(
  [...workflowKnowledgeStopTerms]
    .flatMap((term) => term.split(" "))
    .filter(Boolean),
);

const systemNoiseMarkerTokens = new Set([
  "codex",
  "developer",
  "fixture",
  "fixtures",
  "manual",
  "milestone",
  "smoke",
  "temp",
  "temporary",
  "test",
  "tests",
]);

const knownTerms: Array<{
  name: string;
  objectType: KnowledgeObjectType;
  terms: string[];
}> = [
  {
    name: "Attachment and regulation",
    objectType: "FRAMEWORK",
    terms: ["attachment", "regulation", "nervous system", "felt safety"],
  },
  {
    name: "Becoming",
    objectType: "CONCEPT",
    terms: ["becoming", "identity", "growth", "future self"],
  },
  {
    name: "Recovery",
    objectType: "CONCEPT",
    terms: ["recovery", "healing", "repair", "restoration"],
  },
  {
    name: "Clinical practice",
    objectType: "PROJECT",
    terms: ["clinical", "worksheet", "client", "practice", "therapy"],
  },
  {
    name: "Teaching material",
    objectType: "WORKSHOP",
    terms: ["teaching", "workshop", "lesson", "training"],
  },
  {
    name: "Website articles",
    objectType: "WEBSITE_ARTICLE",
    terms: ["website", "article", "newsletter", "public-facing", "blog"],
  },
  {
    name: "Human approval",
    objectType: "DECISION",
    terms: ["approval", "decides", "human review", "nothing moves"],
  },
];

export function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function normalizeKnowledgeName(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function displayNameFromNormalized(value: string) {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function isWorkflowKnowledgeName(value: string) {
  const normalized = normalizeKnowledgeName(value);

  if (!normalized) {
    return false;
  }

  if (workflowKnowledgeStopTerms.has(normalized)) {
    return true;
  }

  const tokens = normalized.split(" ").filter(Boolean);

  if (tokens.length === 0) {
    return false;
  }

  const everyTokenIsWorkflowLanguage = tokens.every(
    (token) =>
      stopWords.has(token) ||
      workflowKnowledgeStopTokens.has(token) ||
      /^\d+$/.test(token) ||
      token.length <= 2,
  );

  if (everyTokenIsWorkflowLanguage) {
    return true;
  }

  const hasSystemNoiseMarker = tokens.some((token) =>
    systemNoiseMarkerTokens.has(token),
  );

  if (!hasSystemNoiseMarker) {
    return false;
  }

  const meaningfulTokens = tokens.filter(
    (token) =>
      !stopWords.has(token) &&
      !workflowKnowledgeStopTokens.has(token) &&
      !systemNoiseMarkerTokens.has(token) &&
      !/^\d+$/.test(token) &&
      token.length > 2,
  );

  return meaningfulTokens.length === 0;
}

export function tokenizeKnowledgeText(value: string) {
  return normalizeKnowledgeName(value)
    .split(/\s+/)
    .filter(
      (token) =>
        token.length >= 4 &&
        !/^\d+$/.test(token) &&
        !stopWords.has(token) &&
        !workflowKnowledgeStopTokens.has(token),
    );
}

export function compactText(value: string, maxLength = 220) {
  const text = value.trim().replace(/\s+/g, " ");

  if (text.length <= maxLength) {
    return text;
  }

  const sentence = text.match(/^.{80,220}?[.!?](\s|$)/)?.[0]?.trim();

  return sentence ?? `${text.slice(0, maxLength - 3).trim()}...`;
}

export function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function evidenceFromJson(value: Prisma.JsonValue): KnowledgeEvidenceSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return emptyKnowledgeEvidence();
  }

  const record = value as Record<string, unknown>;

  return {
    appearedIn: asStringArray(record.appearedIn),
    relatedFiles: asStringArray(record.relatedFiles),
    relatedNotebookEntryIds: asStringArray(record.relatedNotebookEntryIds),
    relatedPlans: asStringArray(record.relatedPlans),
    relatedRecommendations: asStringArray(record.relatedRecommendations),
    timeline: asStringArray(record.timeline),
    whyProposed: asStringArray(record.whyProposed),
  };
}

export function emptyKnowledgeEvidence(): KnowledgeEvidenceSummary {
  return {
    appearedIn: [],
    relatedFiles: [],
    relatedNotebookEntryIds: [],
    relatedPlans: [],
    relatedRecommendations: [],
    timeline: [],
    whyProposed: [],
  };
}

export function mergeKnowledgeEvidence(
  left: Partial<KnowledgeEvidenceSummary> | null | undefined,
  right: Partial<KnowledgeEvidenceSummary> | null | undefined,
): KnowledgeEvidenceSummary {
  const base = emptyKnowledgeEvidence();
  const keys = Object.keys(base) as Array<keyof KnowledgeEvidenceSummary>;
  const merged = { ...base };

  for (const key of keys) {
    merged[key] = [
      ...new Set([...(left?.[key] ?? []), ...(right?.[key] ?? [])]),
    ].slice(0, 24);
  }

  return merged;
}

export function rankedTermsFromText(value: string, take = 8) {
  const counts = new Map<string, number>();

  for (const token of tokenizeKnowledgeText(value)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, take)
    .map(([term]) => term);
}

export function extractKnowledgeCandidates(value: string) {
  const normalized = normalizeKnowledgeName(value);
  const candidates: Array<{ name: string; objectType: KnowledgeObjectType }> = [];

  for (const rule of knownTerms) {
    const matched = rule.terms.some((term) =>
      normalized.includes(normalizeKnowledgeName(term)),
    );

    if (matched) {
      candidates.push({ name: rule.name, objectType: rule.objectType });
    }
  }

  for (const term of rankedTermsFromText(value, 6)) {
    candidates.push({
      name: displayNameFromNormalized(term),
      objectType: inferObjectType(term),
    });
  }

  return dedupeCandidates(candidates)
    .filter((candidate) => !isWorkflowKnowledgeName(candidate.name))
    .slice(0, 8);
}

function inferObjectType(value: string): KnowledgeObjectType {
  const normalized = normalizeKnowledgeName(value);

  if (/\b(framework|model|method|system)\b/.test(normalized)) {
    return "FRAMEWORK";
  }

  if (/\b(project|site|website|publication)\b/.test(normalized)) {
    return "PROJECT";
  }

  if (/\b(workshop|class|training|teaching)\b/.test(normalized)) {
    return "WORKSHOP";
  }

  if (/\b(article|resource|worksheet|guide)\b/.test(normalized)) {
    return "RESOURCE";
  }

  return "TOPIC";
}

function dedupeCandidates(
  candidates: Array<{ name: string; objectType: KnowledgeObjectType }>,
) {
  const seen = new Set<string>();
  const deduped: Array<{ name: string; objectType: KnowledgeObjectType }> = [];

  for (const candidate of candidates) {
    const key = `${candidate.objectType}:${normalizeKnowledgeName(candidate.name)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

export function relationshipKeyFor(
  sourceObjectId: string,
  targetObjectId: string,
  relationshipType: string,
) {
  if (
    relationshipType === "RELATED_TO" ||
    relationshipType === "GROUPED_WITH" ||
    relationshipType === "DUPLICATES"
  ) {
    const [left, right] = [sourceObjectId, targetObjectId].sort();

    return `${relationshipType}:${left}:${right}`;
  }

  return `${relationshipType}:${sourceObjectId}:${targetObjectId}`;
}

export function safeConfidence(value: number) {
  return Math.round(Math.min(Math.max(value, 0.2), 0.98) * 100) / 100;
}
