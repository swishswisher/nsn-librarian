import path from "node:path";

import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";

export type WorkingEvidenceKind =
  | "PROVISIONAL_OBSERVATION"
  | "TRUSTED_OBSERVATION"
  | "APPROVED_MEMORY"
  | "CONTENT";

export type ScanWorkingKnowledgeInputFile = {
  connectedLibraryId: string;
  fileType: string;
  id: string;
  observationSessions: Array<{
    explanation: unknown;
    interpretations: unknown;
    observations: unknown;
    observerType: string;
    status: string;
  }>;
  previewText: string | null;
  relativePath: string;
};

export type ScanWorkingKnowledgeMemory = {
  description: string;
  evidence: unknown;
  id: string;
  memoryType: string;
  title: string;
};

export type ScanWorkingKnowledgeRelationship = {
  confidence: number;
  evidenceKinds: WorkingEvidenceKind[];
  leftFileId: string;
  rightFileId: string;
  supportingTopicConfidence: Record<string, number>;
  supportingTopics: string[];
  sharedTopics: string[];
  sharedTerms: string[];
};

export type ScanWorkingKnowledgeCluster = {
  confidence: number;
  id: string;
  label: string;
  memberFileIds: string[];
  memberRelativePaths: string[];
  semanticTopics: string[];
  sharedTerms: string[];
  sharedSubjects: string[];
};

export type ScanWorkingKnowledgeFile = {
  approvedMemoryEvidence: string[];
  connectedLibraryId: string;
  fileName: string;
  fileType: string;
  id: string;
  normalizedIdentity: string;
  provisionalWorkingEvidence: string[];
  relativePath: string;
  semanticPreview: string;
  semanticTerms: string[];
  supportingTopics: string[];
  trustedObservationEvidence: string[];
};

export type ScanWorkingKnowledgeIndex = {
  clusters: ScanWorkingKnowledgeCluster[];
  files: ScanWorkingKnowledgeFile[];
  relationships: ScanWorkingKnowledgeRelationship[];
  scanSessionId: string;
};

type WeightedTerms = Map<
  string,
  {
    sources: Set<WorkingEvidenceKind | "CONTENT">;
    weight: number;
  }
>;

const ignoredSemanticTerms = new Set([
  "about",
  "after",
  "again",
  "also",
  "appears",
  "associated",
  "approved",
  "assistance",
  "assistant",
  "automatic",
  "based",
  "because",
  "before",
  "being",
  "belong",
  "cautious",
  "content",
  "contains",
  "could",
  "deanne",
  "decision",
  "distinct",
  "document",
  "documentation",
  "evidence",
  "file",
  "fictional",
  "fixture",
  "generated",
  "have",
  "help",
  "human",
  "information",
  "intended",
  "include",
  "included",
  "includes",
  "item",
  "librarian",
  "later",
  "listed",
  "made",
  "meaning",
  "material",
  "memory",
  "might",
  "needs",
  "note",
  "notes",
  "observation",
  "openai",
  "possible",
  "present",
  "provisional",
  "readable",
  "record",
  "records",
  "remain",
  "related",
  "relationship",
  "recommendation",
  "recommendations",
  "review",
  "required",
  "signal",
  "subject",
  "suggestion",
  "suggests",
  "summary",
  "synthetic",
  "their",
  "theme",
  "there",
  "these",
  "thing",
  "this",
  "those",
  "understanding",
  "uncertainty",
  "used",
  "using",
  "useful",
  "working",
  "which",
  "while",
  "with",
  "would",
]);

const ignoredJsonKeys = new Set([
  "actionType",
  "basedOnObservationIds",
  "confidence",
  "id",
  "label",
  "requiresHumanApproval",
  "uncertainty",
]);

const semanticTopicFamilies = [
  {
    id: "becoming",
    label: "growth and becoming",
    terms: ["becoming", "growth", "identity", "change", "future"],
    supportTerms: ["becoming", "growth", "identity", "change", "future"],
  },
  {
    id: "recovery",
    label: "recovery and healing",
    terms: ["recovery", "healing", "repair", "restore", "resilience"],
    supportTerms: ["recovery", "healing", "repair", "restore", "resilience"],
  },
  {
    id: "attachment-regulation",
    label: "attachment and regulation",
    terms: ["attachment", "regulation", "nervous", "safety"],
    supportTerms: ["attachment", "regulation", "nervous", "safety"],
  },
  {
    id: "clinical-tools",
    label: "clinical and teaching tools",
    terms: ["worksheet", "exercise", "practice", "clinical"],
    supportTerms: ["worksheet", "exercise", "practice", "clinical"],
  },
  {
    id: "operations-finance",
    label: "finance and office operations",
    terms: [
      "invoice",
      "invoicing",
      "payment",
      "pay",
      "paying",
      "expense",
      "expenses",
      "financial",
      "finance",
      "budget",
      "receipt",
      "accounting",
    ],
    supportTerms: [
      "invoice",
      "invoicing",
      "payment",
      "pay",
      "paying",
      "expense",
      "expenses",
      "financial",
      "finance",
      "budget",
      "receipt",
      "accounting",
    ],
  },
  {
    id: "workshops",
    label: "workshops and facilitation",
    terms: [
      "workshop",
      "training",
      "facilitation",
      "facilitator",
      "orientation",
      "curriculum",
      "boundaries",
    ],
    supportTerms: [
      "workshop",
      "training",
      "facilitation",
      "facilitator",
      "orientation",
      "curriculum",
      "seminar",
      "course",
    ],
  },
  {
    id: "research",
    label: "research and references",
    terms: ["research", "study", "source", "citation", "reference"],
    supportTerms: ["research", "study", "source", "citation", "reference"],
  },
  {
    id: "website",
    label: "website and public material",
    terms: ["article", "newsletter", "website", "public", "blog"],
    supportTerms: ["article", "newsletter", "website", "public", "blog"],
  },
] as const;

function normalizedText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizedTerm(value: string) {
  let normalized = value;

  if (normalized.length > 4 && normalized.endsWith("ies")) {
    normalized = `${normalized.slice(0, -3)}y`;
  } else if (normalized.length > 4 && normalized.endsWith("s") && !normalized.endsWith("ss")) {
    normalized = normalized.slice(0, -1);
  }

  for (const suffix of [
    "ation",
    "ition",
    "ial",
    "ment",
    "ing",
    "ator",
    "er",
    "or",
    "al",
    "ate",
    "e",
  ]) {
    if (normalized.length - suffix.length >= 4 && normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length);
      break;
    }
  }

  return normalized;
}

// Clustering works with stemmed terms, so generic-language filtering must use
// that same representation rather than the original surface words.
const normalizedIgnoredSemanticTerms = new Set(
  [...ignoredSemanticTerms].map((term) => normalizedTerm(term)),
);

export function workingKnowledgeTerms(value: string) {
  return [
    ...new Set(
      (normalizedText(value).match(/[a-z0-9]+/g) ?? [])
        .map(normalizedTerm)
        .filter(
          (term) =>
            term.length >= 4 &&
            !normalizedIgnoredSemanticTerms.has(term) &&
            !/^\d+$/.test(term),
        ),
    ),
  ];
}

function semanticTopicTerms(topicId: string) {
  const topic = semanticTopicFamilies.find((candidate) => candidate.id === topicId);
  return new Set(topic?.terms.flatMap(workingKnowledgeTerms) ?? []);
}

function semanticTopicSupportTerms(topicId: string) {
  const topic = semanticTopicFamilies.find((candidate) => candidate.id === topicId);
  return new Set(topic?.supportTerms.flatMap(workingKnowledgeTerms) ?? []);
}

function semanticTopicsForTerms(terms: Iterable<string>) {
  const availableTerms = new Set(terms);

  return semanticTopicFamilies
    .filter((topic) =>
      topic.terms.some((term) =>
        availableTerms.has(workingKnowledgeTerms(term)[0] ?? ""),
      ),
    )
    .map((topic) => topic.id);
}

function semanticSupportingTopicsForTerms(terms: Iterable<string>) {
  const availableTerms = new Set(terms);

  return semanticTopicFamilies
    .filter((topic) =>
      topic.supportTerms.some((term) =>
        availableTerms.has(workingKnowledgeTerms(term)[0] ?? ""),
      ),
    )
    .map((topic) => topic.id);
}

function independentlySupportingTopics(weightedTerms: WeightedTerms) {
  return semanticTopicFamilies
    .filter((topic) =>
      topic.supportTerms.some((term) => {
        const normalized = workingKnowledgeTerms(term)[0] ?? "";
        const sources = weightedTerms.get(normalized)?.sources;

        return Boolean(
          sources?.has("CONTENT") || sources?.has("TRUSTED_OBSERVATION"),
        );
      }),
    )
    .map((topic) => topic.id);
}

function destinationSupportStrength(
  weightedTerms: WeightedTerms,
  topicId: string,
) {
  const supportTerms = semanticTopicSupportTerms(topicId);
  const matchingTerms = [...supportTerms].filter((term) => weightedTerms.has(term));
  const sources = new Set<WorkingEvidenceKind>();

  for (const term of matchingTerms) {
    for (const source of weightedTerms.get(term)?.sources ?? []) {
      sources.add(source);
    }
  }

  let score = sources.has("TRUSTED_OBSERVATION") ? 0.78 : 0.66;
  score += Math.min(Math.max(matchingTerms.length - 1, 0), 3) * 0.04;

  if (sources.has("APPROVED_MEMORY")) {
    score += 0.04;
  }

  return Math.min(0.92, Math.round(score * 100) / 100);
}

export function workingKnowledgeSupportsTopic(value: string, topicId: string) {
  return semanticSupportingTopicsForTerms(workingKnowledgeTerms(value)).some(
    (topic) => topic === topicId,
  );
}

function semanticTopicLabel(topicId: string) {
  return semanticTopicFamilies.find((topic) => topic.id === topicId)?.label ?? topicId;
}

function displaySemanticTerm(term: string) {
  const displayTerms: Record<string, string> = {
    expens: "expense",
    facilit: "facilitation",
    financ: "finance",
    invoic: "invoice",
    pay: "payment",
  };

  return displayTerms[term] ?? term;
}

function jsonText(value: unknown, parentKey = ""): string[] {
  if (typeof value === "string") {
    return ignoredJsonKeys.has(parentKey) || !value.trim() ? [] : [value.trim()];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => jsonText(item, parentKey));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    ignoredJsonKeys.has(key) ? [] : jsonText(item, key),
  );
}

function uniqueText(values: string[], take = 20) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(
    0,
    take,
  );
}

function observationEvidence(file: ScanWorkingKnowledgeInputFile) {
  const provisionalWorkingEvidence: string[] = [];
  const trustedObservationEvidence: string[] = [];

  for (const session of file.observationSessions) {
    if (session.status === "REJECTED") {
      continue;
    }

    const text = uniqueText([
      ...jsonText(session.observations),
      ...jsonText(session.interpretations),
      ...jsonText(session.explanation),
    ]);

    if (session.status === "APPROVED" || session.status === "MODIFIED") {
      trustedObservationEvidence.push(...text);
    } else if (session.status === "AWAITING_REVIEW") {
      provisionalWorkingEvidence.push(...text);
    }
  }

  return {
    provisionalWorkingEvidence: uniqueText(provisionalWorkingEvidence),
    trustedObservationEvidence: uniqueText(trustedObservationEvidence),
  };
}

function addWeightedTerms(
  target: WeightedTerms,
  values: string[],
  source: WorkingEvidenceKind | "CONTENT",
  weight: number,
) {
  for (const term of values.flatMap(workingKnowledgeTerms)) {
    const existing = target.get(term) ?? { sources: new Set(), weight: 0 };
    existing.sources.add(source);
    existing.weight += weight;
    target.set(term, existing);
  }
}

function memoryText(memory: ScanWorkingKnowledgeMemory) {
  return [memory.title, memory.description, ...jsonText(memory.evidence)].join(" ");
}

function matchingMemory(
  memory: ScanWorkingKnowledgeMemory[],
  semanticText: string,
) {
  const terms = new Set(workingKnowledgeTerms(semanticText));

  return memory
    .filter((entry) => workingKnowledgeTerms(memoryText(entry)).some((term) => terms.has(term)))
    .map((entry) => `${entry.title}: ${entry.description}`)
    .slice(0, 8);
}

function identityFor(connectedLibraryId: string, relativePath: string) {
  const normalizedPath = path.posix
    .normalize(relativePath.trim().replace(/\\/g, "/"))
    .replace(/^\.\//, "")
    .toLowerCase();

  return `${connectedLibraryId}:${normalizedPath}`;
}

function evidenceKindsForSharedTerm(
  left: WeightedTerms,
  right: WeightedTerms,
  term: string,
) {
  const kinds: WorkingEvidenceKind[] = [];
  const leftSources = left.get(term)?.sources ?? new Set();
  const rightSources = right.get(term)?.sources ?? new Set();

  if (
    leftSources.has("TRUSTED_OBSERVATION") &&
    rightSources.has("TRUSTED_OBSERVATION")
  ) {
    kinds.push("TRUSTED_OBSERVATION");
  } else if (
    (leftSources.has("TRUSTED_OBSERVATION") ||
      leftSources.has("PROVISIONAL_OBSERVATION")) &&
    (rightSources.has("TRUSTED_OBSERVATION") ||
      rightSources.has("PROVISIONAL_OBSERVATION"))
  ) {
    kinds.push("PROVISIONAL_OBSERVATION");
  }

  if (
    leftSources.has("APPROVED_MEMORY") &&
    rightSources.has("APPROVED_MEMORY")
  ) {
    kinds.push("APPROVED_MEMORY");
  }

  if (leftSources.has("CONTENT") && rightSources.has("CONTENT")) {
    kinds.push("CONTENT");
  }

  return kinds;
}

function evidenceKindsForSharedTopic(
  left: WeightedTerms,
  right: WeightedTerms,
  topicId: string,
) {
  const topicTerms = semanticTopicTerms(topicId);
  const leftSources = new Set<WorkingEvidenceKind>();
  const rightSources = new Set<WorkingEvidenceKind>();

  for (const term of topicTerms) {
    for (const source of left.get(term)?.sources ?? []) {
      leftSources.add(source);
    }
    for (const source of right.get(term)?.sources ?? []) {
      rightSources.add(source);
    }
  }

  if (
    leftSources.has("TRUSTED_OBSERVATION") &&
    rightSources.has("TRUSTED_OBSERVATION")
  ) {
    return ["TRUSTED_OBSERVATION"] as WorkingEvidenceKind[];
  }

  if (
    (leftSources.has("TRUSTED_OBSERVATION") ||
      leftSources.has("PROVISIONAL_OBSERVATION")) &&
    (rightSources.has("TRUSTED_OBSERVATION") ||
      rightSources.has("PROVISIONAL_OBSERVATION"))
  ) {
    return ["PROVISIONAL_OBSERVATION"] as WorkingEvidenceKind[];
  }

  if (leftSources.has("CONTENT") && rightSources.has("CONTENT")) {
    return ["CONTENT"] as WorkingEvidenceKind[];
  }

  return [];
}

function relationshipConfidence(
  left: WeightedTerms,
  right: WeightedTerms,
  sharedTerms: string[],
  sharedTopics: string[],
) {
  let score = 0;

  for (const term of sharedTerms) {
    const evidenceKinds = evidenceKindsForSharedTerm(left, right, term);

    if (evidenceKinds.includes("TRUSTED_OBSERVATION")) {
      score += 0.38;
    } else if (evidenceKinds.includes("APPROVED_MEMORY")) {
      score += 0.36;
    } else if (evidenceKinds.includes("PROVISIONAL_OBSERVATION")) {
      score += 0.28;
    } else {
      score += 0.14;
    }
  }

  for (const topic of sharedTopics) {
    const topicAlreadyRepresented = sharedTerms.some((term) =>
      semanticTopicTerms(topic).has(term),
    );

    if (topicAlreadyRepresented) {
      continue;
    }

    const evidenceKinds = evidenceKindsForSharedTopic(left, right, topic);

    if (evidenceKinds.includes("TRUSTED_OBSERVATION")) {
      score += 0.38;
    } else if (evidenceKinds.includes("PROVISIONAL_OBSERVATION")) {
      score += 0.28;
    } else if (evidenceKinds.includes("CONTENT")) {
      score += 0.2;
    }
  }

  return Math.min(0.92, Math.round(score * 100) / 100);
}

function titleCaseTerms(terms: string[]) {
  return terms
    .slice(0, 3)
    .map((term) => term.charAt(0).toUpperCase() + term.slice(1))
    .join(" / ");
}

export function buildScanWorkingKnowledge(input: {
  files: ScanWorkingKnowledgeInputFile[];
  memory?: ScanWorkingKnowledgeMemory[];
  scanSessionId: string;
}): ScanWorkingKnowledgeIndex {
  const memory = input.memory ?? [];
  const weightedByFileId = new Map<string, WeightedTerms>();
  const files = [...input.files]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((file): ScanWorkingKnowledgeFile => {
      const evidence = observationEvidence(file);
      const semanticText = [
        file.previewText ?? "",
        ...evidence.provisionalWorkingEvidence,
        ...evidence.trustedObservationEvidence,
      ].join(" ");
      const approvedMemoryEvidence = matchingMemory(memory, semanticText);
      const weightedTerms: WeightedTerms = new Map();

      addWeightedTerms(weightedTerms, [file.previewText ?? ""], "CONTENT", 1);
      addWeightedTerms(
        weightedTerms,
        evidence.provisionalWorkingEvidence,
        "PROVISIONAL_OBSERVATION",
        2,
      );
      addWeightedTerms(
        weightedTerms,
        evidence.trustedObservationEvidence,
        "TRUSTED_OBSERVATION",
        3,
      );
      addWeightedTerms(
        weightedTerms,
        approvedMemoryEvidence,
        "APPROVED_MEMORY",
        3,
      );
      weightedByFileId.set(file.id, weightedTerms);
      const supportingTopics = independentlySupportingTopics(weightedTerms);

      return {
        approvedMemoryEvidence,
        connectedLibraryId: file.connectedLibraryId,
        fileName: path.posix.basename(file.relativePath),
        fileType: file.fileType,
        id: file.id,
        normalizedIdentity: identityFor(file.connectedLibraryId, file.relativePath),
        provisionalWorkingEvidence: evidence.provisionalWorkingEvidence,
        relativePath: file.relativePath,
        semanticPreview: file.previewText ?? "",
        semanticTerms: [...weightedTerms.entries()]
          .sort(
            (left, right) =>
              right[1].weight - left[1].weight || left[0].localeCompare(right[0]),
          )
          .map(([term]) => term),
        supportingTopics,
        trustedObservationEvidence: evidence.trustedObservationEvidence,
      };
    });
  const relationships: ScanWorkingKnowledgeRelationship[] = [];

  for (let leftIndex = 0; leftIndex < files.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < files.length; rightIndex += 1) {
      const left = files[leftIndex];
      const right = files[rightIndex];
      const leftTerms = weightedByFileId.get(left.id) ?? new Map();
      const rightTerms = weightedByFileId.get(right.id) ?? new Map();
      const sharedTerms = [...leftTerms.keys()]
        .filter((term) => rightTerms.has(term))
        .sort((a, b) => {
          const aWeight =
            (leftTerms.get(a)?.weight ?? 0) + (rightTerms.get(a)?.weight ?? 0);
          const bWeight =
            (leftTerms.get(b)?.weight ?? 0) + (rightTerms.get(b)?.weight ?? 0);
          return bWeight - aWeight || a.localeCompare(b);
        })
        .slice(0, 8);
      const leftTopics = semanticTopicsForTerms(leftTerms.keys());
      const rightTopics = semanticTopicsForTerms(rightTerms.keys());
      const sharedTopics = leftTopics.filter((topic) => rightTopics.includes(topic));
      const leftSupportingTopics = left.supportingTopics;
      const rightSupportingTopics = right.supportingTopics;
      const supportingTopics = leftSupportingTopics.filter((topic) =>
        rightSupportingTopics.includes(topic),
      );
      const supportingTopicConfidence = Object.fromEntries(
        supportingTopics.map((topic) => [
          topic,
          Math.min(
            destinationSupportStrength(leftTerms, topic),
            destinationSupportStrength(rightTerms, topic),
          ),
        ]),
      );
      const meaningfulSharedTopics = sharedTopics.filter(
        (topic) =>
          evidenceKindsForSharedTopic(leftTerms, rightTerms, topic).length > 0,
      );
      const evidenceKinds = [
        ...new Set(
          [
            ...sharedTerms.flatMap((term) =>
              evidenceKindsForSharedTerm(leftTerms, rightTerms, term),
            ),
            ...meaningfulSharedTopics.flatMap((topic) =>
              evidenceKindsForSharedTopic(leftTerms, rightTerms, topic),
            ),
          ],
        ),
      ];
      const confidence = relationshipConfidence(
        leftTerms,
        rightTerms,
        sharedTerms,
        meaningfulSharedTopics,
      );
      const hasMeaningfulSharedTerm = sharedTerms.length > 0;
      const hasMeaningfulTopicEvidence = meaningfulSharedTopics.some(
        (topic) =>
          evidenceKindsForSharedTopic(leftTerms, rightTerms, topic).length > 0,
      );
      const hasStructuredAgreement =
        evidenceKinds.length > 0 &&
        (hasMeaningfulSharedTerm || hasMeaningfulTopicEvidence);
      const qualifies =
        (hasStructuredAgreement && confidence >= 0.45) ||
        (sharedTerms.length >= 3 && confidence >= 0.42) ||
        (hasMeaningfulTopicEvidence && confidence >= 0.2);

      if (qualifies) {
        relationships.push({
          confidence,
          evidenceKinds,
          leftFileId: left.id,
          rightFileId: right.id,
          supportingTopicConfidence,
          supportingTopics,
          sharedTopics: meaningfulSharedTopics,
          sharedTerms: sharedTerms.map(displaySemanticTerm),
        });
      }
    }
  }

  const fileById = new Map(files.map((file) => [file.id, file]));
  const clusters: ScanWorkingKnowledgeCluster[] = [];

  // Build one connected component per semantic subject. A global component
  // would let a weak bridge transfer every subject to every member.
  for (const topic of semanticTopicFamilies) {
    const topicRelationships = relationships.filter((relation) =>
      relation.supportingTopics.includes(topic.id),
    );
    const adjacency = new Map<string, Set<string>>();

    for (const relation of topicRelationships) {
      const left = adjacency.get(relation.leftFileId) ?? new Set<string>();
      const right = adjacency.get(relation.rightFileId) ?? new Set<string>();
      left.add(relation.rightFileId);
      right.add(relation.leftFileId);
      adjacency.set(relation.leftFileId, left);
      adjacency.set(relation.rightFileId, right);
    }

    const visited = new Set<string>();
    for (const file of files) {
      if (visited.has(file.id) || !adjacency.has(file.id)) {
        continue;
      }

      const pending = [file.id];
      const memberIds: string[] = [];
      visited.add(file.id);

      while (pending.length > 0) {
        const current = pending.shift() as string;
        memberIds.push(current);
        for (const related of [...(adjacency.get(current) ?? [])].sort()) {
          if (!visited.has(related)) {
            visited.add(related);
            pending.push(related);
          }
        }
      }

      const memberSet = new Set(memberIds);
      const memberRelationships = topicRelationships.filter(
        (relation) =>
          memberSet.has(relation.leftFileId) && memberSet.has(relation.rightFileId),
      );
      const topicTerms = semanticTopicSupportTerms(topic.id);
      const termCounts = new Map<string, number>();

      for (const relation of memberRelationships) {
        for (const term of relation.sharedTerms) {
          const normalized = workingKnowledgeTerms(term)[0] ?? term;
          if (topicTerms.has(normalized)) {
            termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
          }
        }
      }

      const sharedTerms = [...termCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 8)
        .map(([term]) => term);
      const sortedMembers = memberIds
        .map((id) => fileById.get(id))
        .filter((item): item is ScanWorkingKnowledgeFile => Boolean(item))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      const confidence =
        memberRelationships.reduce(
          (sum, relation) =>
            sum + (relation.supportingTopicConfidence[topic.id] ?? 0),
          0,
        ) /
        memberRelationships.length;

      clusters.push({
        confidence: Math.round(confidence * 100) / 100,
        id: `working-cluster-${clusters.length + 1}`,
        label:
          titleCaseTerms(sharedTerms) ||
          semanticTopicLabel(topic.id) ||
          "Related material",
        memberFileIds: sortedMembers.map((member) => member.id),
        memberRelativePaths: sortedMembers.map((member) => member.relativePath),
        semanticTopics: [topic.id],
        sharedTerms,
        sharedSubjects: [semanticTopicLabel(topic.id)],
      });
    }
  }

  return {
    clusters,
    files,
    relationships: relationships.sort(
      (left, right) =>
        left.leftFileId.localeCompare(right.leftFileId) ||
        left.rightFileId.localeCompare(right.rightFileId),
    ),
    scanSessionId: input.scanSessionId,
  };
}

export async function loadScanWorkingKnowledge(
  scanSessionId: string,
): Promise<ScanWorkingKnowledgeIndex> {
  const prisma = getPrismaClient();
  const [files, memory] = await Promise.all([
    prisma.scannedFile.findMany({
      orderBy: { relativePath: "asc" },
      select: {
        fileType: true,
        id: true,
        libraryDocument: {
          select: {
            observationSessions: {
              orderBy: { createdAt: "desc" },
              select: {
                explanation: true,
                interpretations: true,
                observations: true,
                observerType: true,
                status: true,
              },
            },
          },
        },
        previewText: true,
        relativePath: true,
        scanSession: { select: { connectedFolderId: true } },
      },
      where: {
        extractionStatus: "COMPLETED",
        readStatus: "SUPPORTED",
        readingStatus: "READ",
        sessionId: scanSessionId,
      },
    }),
    prisma.memoryEntry.findMany({
      orderBy: [{ occurrenceCount: "desc" }, { lastSeen: "desc" }],
      select: {
        description: true,
        evidence: true,
        id: true,
        memoryType: true,
        title: true,
      },
      take: 80,
      where: { status: "ACTIVE" },
    }),
  ]);

  return buildScanWorkingKnowledge({
    files: files.map((file) => ({
      connectedLibraryId: file.scanSession.connectedFolderId,
      fileType: file.fileType,
      id: file.id,
      observationSessions: file.libraryDocument?.observationSessions ?? [],
      previewText: file.previewText,
      relativePath: file.relativePath,
    })),
    memory: memory as Array<ScanWorkingKnowledgeMemory & { evidence: Prisma.JsonValue }>,
    scanSessionId,
  });
}
