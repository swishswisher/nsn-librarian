import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";

import {
  ConnectedLibraryError,
  requireScannedFilePermission,
} from "./connected-libraries";
import { isAudioFileType, jsonAudioHumanLabels, jsonStringArray } from "./audio-metadata";
import {
  findExactChecksumDuplicateForScannedFile,
  recordChecksumDuplicateSuggestionsForSession,
} from "./checksum-duplicates";
import { jsonImageHumanLabels } from "./image-metadata";
import { readScannedFile } from "./reader";
import {
  recommendationSupportForStorage,
  recommendationSupportFromJson,
  reconcileRecommendationDrafts,
  type RecommendationDraft,
  type RecommendationDuplicateMatch,
} from "./recommendation-reconciliation";
import {
  currentRecommendationGenerationVersion,
  isCurrentRecommendationGeneration,
} from "./recommendation-generation";
import type {
  ScanWorkingKnowledgeCluster,
  ScanWorkingKnowledgeFile,
  ScanWorkingKnowledgeIndex,
  ScanWorkingKnowledgeRelationship,
} from "./scan-working-knowledge";
import {
  workingKnowledgeSupportsTopic,
  workingKnowledgeTerms,
} from "./scan-working-knowledge";
import {
  demonstrablyDistinctPhysicalFiles,
  normalizePhysicalRelativePath,
  samePhysicalFilePresentation,
} from "./physical-file-identity";
import { scannedFileSummary } from "./scan-sessions";
import { isImageFileType } from "./media-kind";
import { isVideoFileType, jsonVideoHumanLabels } from "./video-metadata";
import type {
  BridgeOrganizationSuggestionReviewPageData,
  BridgeOrganizationSuggestionSummary,
  BridgeScannedFileSummary,
  OrganizationSuggestionStatus,
  OrganizationSuggestionType,
} from "./types";

export class OrganizationSuggestionError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "OrganizationSuggestionError";
    this.statusCode = statusCode;
  }
}

type StoredSuggestion = {
  id: string;
  scannedFileId: string;
  scanSessionId: string;
  suggestionType: string;
  currentRelativePath: string;
  proposedRelativePath: string | null;
  proposedFileName: string | null;
  title: string;
  explanation: string;
  confidence: number;
  status: string;
  whySuggested: Prisma.JsonValue;
  supportingInformation: Prisma.JsonValue;
  recommendationGenerationId: string;
  recommendationGenerationVersion: string;
  invalidatedAt: Date | null;
  invalidatedReason: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
  revisions: {
    id: string;
    revisedRelativePath: string | null;
    revisedFileName: string | null;
    context: string | null;
    createdAt: Date;
  }[];
};

type SuggestionDraft = RecommendationDraft;

type TopicRule = {
  id: string;
  folder: string;
  terms: string[];
  explanation: string;
};

type SuggestionContext = {
  contentText: string;
  currentRelativePath: string;
  fileName: string;
  fileType: string;
  scannedFileId: string;
  scanSessionId: string;
  checksum: string | null;
  folderStructure: string[];
  connectedLibraryName: string;
  duplicateMatches: Array<
    RecommendationDuplicateMatch & {
      scannedFileId: string;
    }
  >;
  provisionalWorkingEvidence: string[];
  siblingFiles: Array<{
    id: string;
    localPath: string;
    relativePath: string;
    fileType: string;
    checksum: string | null;
    audioFingerprint?: string | null;
    imageFingerprint?: string | null;
    videoFingerprint?: string | null;
    sizeBytes?: bigint | null;
  }>;
  reviewedObservationText: string[];
  semanticClusters: ScanWorkingKnowledgeCluster[];
  semanticFiles: ScanWorkingKnowledgeFile[];
  semanticRelationships: ScanWorkingKnowledgeRelationship[];
  memoryMatches: MemoryMatch[];
  preferredTerms: string[];
  audioMetadata: {
    audioFingerprint: string | null;
    duplicateConfidence: number | null;
    duplicateKind: string | null;
    duplicateOfScannedFileId: string | null;
    durationSeconds: number | null;
    humanLabels: string[];
    machineLabels: string[];
    privacyState: string;
    provisionalTopics: string[];
    summary: string | null;
  } | null;
  imageMetadata: {
    duplicateConfidence: number | null;
    duplicateKind: string | null;
    duplicateOfScannedFileId: string | null;
    humanLabels: string[];
    imageFingerprint: string | null;
    height: number | null;
    machineLabels: string[];
    privacyState: string;
    provisionalTopics: string[];
    relatedSignals: string[];
    summary: string | null;
    width: number | null;
  } | null;
  videoMetadata: {
    duplicateConfidence: number | null;
    duplicateKind: string | null;
    duplicateOfScannedFileId: string | null;
    durationSeconds: number | null;
    height: number | null;
    humanLabels: string[];
    machineLabels: string[];
    privacyState: string;
    provisionalTopics: string[];
    summary: string | null;
    videoFingerprint: string | null;
    width: number | null;
  } | null;
};

type MemoryMatch = {
  title: string;
  memoryType: string;
  overlap: string[];
};

type DuplicateEvidenceFile = {
  audioFingerprint: string | null;
  audioDurationSeconds: number | null;
  checksum: string | null;
  connectedLibraryId: string;
  connectedLibraryName: string;
  fileName: string;
  height: number | null;
  imageFingerprint: string | null;
  relativePath: string;
  scannedFileId: string;
  sizeBytes: bigint | null;
  videoDurationSeconds: number | null;
  videoFingerprint: string | null;
  width: number | null;
};

const trustedObservationStatuses = new Set(["APPROVED", "MODIFIED"]);
const organizationSuggestionStatuses = new Set<OrganizationSuggestionStatus>([
  "PENDING",
  "APPROVED",
  "MODIFIED",
  "REJECTED",
  "LEFT_UNCHANGED",
]);
const organizationSuggestionTypes = new Set<OrganizationSuggestionType>([
  "MOVE_FILE",
  "RENAME_FILE",
  "CREATE_FOLDER",
  "GROUP_WITH_FILES",
  "POSSIBLE_DUPLICATE",
  "WEBSITE_CANDIDATE",
  "KEEP_UNCHANGED",
  "INSUFFICIENT_EVIDENCE",
]);
const invalidPathCharacters = /[<>:"\\|?*\u0000]/;
const maxAnalysisCharacters = 60_000;

const stopWords = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "before",
  "bridge",
  "copy",
  "could",
  "content",
  "deanne",
  "document",
  "documents",
  "docx",
  "extension",
  "file",
  "files",
  "filename",
  "final",
  "format",
  "from",
  "have",
  "item",
  "items",
  "knowledge",
  "large",
  "library",
  "librarian",
  "long",
  "loose",
  "manual",
  "memory",
  "name",
  "mixed",
  "might",
  "notes",
  "only",
  "organization",
  "path",
  "random",
  "read",
  "review",
  "reviewed",
  "scan",
  "scanned",
  "same",
  "session",
  "should",
  "suggest",
  "suggestion",
  "suggestions",
  "that",
  "their",
  "there",
  "these",
  "this",
  "those",
  "thought",
  "thoughts",
  "through",
  "test",
  "text",
  "with",
  "without",
  "would",
  "html",
  "markdown",
  "jpeg",
  "webp",
  "tiff",
  "heic",
  "heif",
  "uppercase",
  "lowercase",
]);

const topicRules: TopicRule[] = [
  {
    id: "becoming",
    folder: "Becoming",
    terms: ["becoming", "growth", "identity", "change", "future"],
    explanation:
      "The text appears to point toward growth, identity, or becoming.",
  },
  {
    id: "recovery",
    folder: "Recovery",
    terms: ["recovery", "healing", "repair", "restore", "resilience"],
    explanation:
      "The text appears to point toward recovery, healing, or repair.",
  },
  {
    id: "attachment-regulation",
    folder: "Attachment and Regulation",
    terms: ["attachment", "regulation", "nervous", "safety", "system"],
    explanation:
      "The text appears to connect attachment, regulation, and felt safety.",
  },
  {
    id: "clinical-tools",
    folder: "Clinical Tools",
    terms: ["worksheet", "exercise", "client", "practice", "clinical"],
    explanation:
      "The text appears practical enough to review as a clinical or teaching tool.",
  },
  {
    id: "operations-finance",
    folder: "Finance",
    terms: [
      "invoice",
      "payment",
      "expense",
      "expenses",
      "financial",
      "finance",
      "budget",
      "receipt",
      "accounting",
    ],
    explanation:
      "The text appears to concern operational finance, payments, expenses, or invoices.",
  },
  {
    id: "workshops",
    folder: "Workshops",
    terms: [
      "workshop",
      "training",
      "facilitation",
      "orientation",
      "curriculum",
      "boundaries",
    ],
    explanation:
      "The text appears to concern workshop, training, orientation, or facilitation material.",
  },
  {
    id: "research",
    folder: "Research",
    terms: ["research", "study", "source", "citation", "reference"],
    explanation:
      "The text appears to behave like reference or research material.",
  },
  {
    id: "website",
    folder: "Website Candidates",
    terms: ["article", "newsletter", "website", "public", "blog"],
    explanation:
      "The text may be useful later as public-facing or website material.",
  },
];

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: Prisma.JsonValue): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: Prisma.JsonValue | unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
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

function rankedTerms(value: string, take = 10) {
  const counts = new Map<string, number>();

  for (const token of tokenize(value)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, take)
    .map(([term]) => term);
}

function semanticAnalysisText(input: {
  contentText: string;
  currentRelativePath: string;
  provisionalWorkingEvidence: string[];
  reviewedObservationText: string[];
}) {
  const contentTerms = new Set(tokenize(input.contentText));
  const pathTerms = new Set(tokenize(input.currentRelativePath));
  const observationTerms = [
    ...input.provisionalWorkingEvidence,
    ...input.reviewedObservationText,
  ].flatMap((text) =>
    tokenize(text).filter(
      (term) => !pathTerms.has(term) || contentTerms.has(term),
    ),
  );

  return [input.contentText, observationTerms.join(" ")].join(" ");
}

function confidence(value: number) {
  return Math.round(Math.min(Math.max(value, 0.25), 0.98) * 100) / 100;
}

function hashSuggestionKey(parts: string[]) {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

function hasDrivePrefix(value: string) {
  return /^[a-zA-Z]:($|[\\/])/.test(value);
}

function invalidPathSegment(segment: string) {
  return (
    !segment.trim() ||
    segment === "." ||
    segment === ".." ||
    invalidPathCharacters.test(segment)
  );
}

export function normalizeBridgeRelativePath(value: string, allowRoot = false) {
  const trimmed = value.trim().replace(/\\/g, "/");

  if (!trimmed) {
    if (allowRoot) {
      return "";
    }

    throw new OrganizationSuggestionError(
      "Use a relative destination inside the connected folder.",
      400,
    );
  }

  if (path.posix.isAbsolute(trimmed) || hasDrivePrefix(trimmed)) {
    throw new OrganizationSuggestionError(
      "Use a relative destination inside the connected folder.",
      400,
    );
  }

  const normalized = path.posix.normalize(trimmed);

  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new OrganizationSuggestionError(
      "Use a relative destination inside the connected folder.",
      400,
    );
  }

  if (normalized === ".") {
    if (allowRoot) {
      return "";
    }

    throw new OrganizationSuggestionError(
      "Use a relative destination inside the connected folder.",
      400,
    );
  }

  if (normalized.split("/").some(invalidPathSegment)) {
    throw new OrganizationSuggestionError(
      "Use folder and file names that can be safely reviewed later.",
      400,
    );
  }

  return normalized;
}

export function normalizeBridgeFileName(value: string) {
  const trimmed = value.trim();

  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    hasDrivePrefix(trimmed) ||
    invalidPathSegment(trimmed)
  ) {
    throw new OrganizationSuggestionError(
      "Use a valid file name before saving the edited suggestion.",
      400,
    );
  }

  return trimmed;
}

function fileNameFromRelativePath(relativePath: string) {
  return path.posix.basename(relativePath);
}

function folderFromRelativePath(relativePath: string) {
  const directory = path.posix.dirname(relativePath);

  return directory === "." ? "" : directory;
}

function joinRelativePath(folder: string, fileName: string) {
  return normalizeBridgeRelativePath(
    folder ? path.posix.join(folder, fileName) : fileName,
  );
}

function proposedFileNameFromTerms(terms: string[], currentFileName: string) {
  const extension = path.posix.extname(currentFileName).toLowerCase();
  const usableTerms = terms
    .filter((term) => /^[a-z0-9]+$/.test(term))
    .slice(0, 4);
  const baseName = usableTerms.length > 0 ? usableTerms.join("-") : "library-item";

  return normalizeBridgeFileName(`${baseName}${extension}`);
}

function fileNameLooksGeneric(fileName: string) {
  const baseName = normalizeText(path.posix.basename(fileName, path.posix.extname(fileName)));

  return (
    baseName.length < 5 ||
    /^(another|doc|docx|document|file|filea|fileb|new text document|sample|scan|untitled)( \d+)?$/.test(
      baseName,
    ) ||
    /^doc ?\d+$/.test(baseName) ||
    /^file ?[a-z0-9]?$/.test(baseName)
  );
}

function collectFolderStructure(relativePaths: string[]) {
  const folders = new Set<string>();

  for (const relativePath of relativePaths) {
    const normalized = normalizeBridgeRelativePath(relativePath);
    const parts = normalized.split("/");

    for (let index = 1; index < parts.length; index += 1) {
      folders.add(parts.slice(0, index).join("/"));
    }
  }

  return [...folders].sort((left, right) => left.localeCompare(right));
}

function filesUnderFolder(context: SuggestionContext, folder: string) {
  const normalizedFolder = normalizeBridgeRelativePath(folder).toLowerCase();
  const prefix = `${normalizedFolder}/`;

  return context.siblingFiles.filter((file) => {
    if (file.id === context.scannedFileId) {
      return false;
    }

    const relativePath = normalizeBridgeRelativePath(
      file.relativePath,
    ).toLowerCase();

    return relativePath.startsWith(prefix);
  });
}

function establishedFolderForRule(
  rule: TopicRule,
  context: SuggestionContext,
) {
  const normalizedRuleFolder = normalizeText(path.posix.basename(rule.folder));
  const ruleTerms = new Set(tokenize(rule.folder));

  return context.folderStructure
    .map((folder) => {
      const folderName = path.posix.basename(folder);
      const folderTerms = new Set(tokenize(folderName));
      const exactName = normalizeText(folderName) === normalizedRuleFolder;
      const sharedTerms = [...ruleTerms].filter((term) =>
        folderTerms.has(term),
      );
      const files = filesUnderFolder(context, folder);

      return {
        exactName,
        fileCount: files.length,
        folder,
        sharedTerms,
      };
    })
    .filter(
      (candidate) =>
        candidate.fileCount >= 2 &&
        (candidate.exactName || candidate.sharedTerms.length >= 2),
    )
    .sort(
      (left, right) =>
        Number(right.exactName) - Number(left.exactName) ||
        right.fileCount - left.fileCount ||
        left.folder.localeCompare(right.folder),
    )[0];
}

function textFromJson(value: Prisma.JsonValue) {
  const textParts: string[] = [];

  for (const item of asArray(value)) {
    if (!isRecord(item)) {
      continue;
    }

    for (const key of ["description", "label", "reason", "uncertainty"]) {
      const maybeText = item[key];

      if (typeof maybeText === "string") {
        textParts.push(maybeText);
      }
    }

    textParts.push(...asStringArray(item.evidence));
  }

  if (isRecord(value)) {
    for (const key of ["summary", "uncertainty"]) {
      const maybeText = value[key];

      if (typeof maybeText === "string") {
        textParts.push(maybeText);
      }
    }

    textParts.push(...asStringArray(value.evidence));
  }

  return textParts;
}

function reviewedObservationText(
  sessions: Array<{
    status: string;
    observations: Prisma.JsonValue;
    interpretations: Prisma.JsonValue;
    explanation: Prisma.JsonValue;
    planSuggestions: Prisma.JsonValue;
  }>,
) {
  return sessions
    .filter((session) => trustedObservationStatuses.has(session.status))
    .flatMap((session) => [
      ...textFromJson(session.observations),
      ...textFromJson(session.interpretations),
      ...textFromJson(session.explanation),
      ...textFromJson(session.planSuggestions),
    ])
    .filter((item) => item.trim().length > 0);
}

function provisionalObservationText(
  sessions: Array<{
    status: string;
    observations: Prisma.JsonValue;
    interpretations: Prisma.JsonValue;
    explanation: Prisma.JsonValue;
    planSuggestions: Prisma.JsonValue;
  }>,
) {
  return sessions
    .filter((session) => session.status === "AWAITING_REVIEW")
    .flatMap((session) => [
      ...textFromJson(session.observations),
      ...textFromJson(session.interpretations),
      ...textFromJson(session.explanation),
    ])
    .filter((item) => item.trim().length > 0);
}

function memoryText(entry: {
  title: string;
  description: string;
  evidence: Prisma.JsonValue;
}) {
  return [
    entry.title,
    entry.description,
    ...asStringArray(entry.evidence),
  ].join(" ");
}

function activeMemoryMatches(
  memoryEntries: Array<{
    memoryType: string;
    title: string;
    description: string;
    evidence: Prisma.JsonValue;
  }>,
  analysisTerms: Set<string>,
) {
  return memoryEntries
    .map((entry): MemoryMatch | null => {
      const memoryTerms = [...new Set(tokenize(memoryText(entry)))];
      const overlap = memoryTerms.filter((term) => analysisTerms.has(term));

      if (overlap.length === 0) {
        return null;
      }

      return {
        memoryType: entry.memoryType,
        overlap: overlap.slice(0, 5),
        title: entry.title,
      };
    })
    .filter((entry): entry is MemoryMatch => entry !== null)
    .slice(0, 8);
}

function preferredTermsFromMemory(
  memoryEntries: Array<{
    memoryType: string;
    title: string;
  }>,
  analysisText: string,
) {
  const normalizedAnalysisText = normalizeText(analysisText);
  const terms: string[] = [];

  for (const entry of memoryEntries) {
    if (entry.memoryType !== "PREFERENCE") {
      continue;
    }

    const match = entry.title.match(/^Prefer "(.+)" over "(.+)"$/i);

    if (!match) {
      continue;
    }

    const preferred = match[1]?.trim();
    const previous = match[2]?.trim();

    if (
      preferred &&
      previous &&
      normalizedAnalysisText.includes(normalizeText(previous))
    ) {
      terms.push(...tokenize(preferred));
    }
  }

  return [...new Set(terms)];
}

function scoreRule(
  rule: TopicRule,
  semanticTerms: Set<string>,
  memoryMatches: MemoryMatch[],
) {
  const directMatches = rule.terms.filter(
    (term) =>
      semanticTerms.has(term) ||
      workingKnowledgeTerms(term).some((normalized) => semanticTerms.has(normalized)),
  );
  const memoryScore = memoryMatches.filter((memory) =>
    memory.overlap.some((term) => rule.terms.includes(term)),
  ).length;

  return {
    directMatches,
    memoryScore,
    score: directMatches.length * 2 + memoryScore,
  };
}

function bestRuleFor(context: SuggestionContext) {
  const semanticTerms = new Set(
    workingKnowledgeTerms(semanticAnalysisText(context)),
  );

  for (const preferredTerm of context.preferredTerms) {
    semanticTerms.add(preferredTerm);
  }

  return topicRules
    .map((rule) => ({
      rule,
      ...scoreRule(rule, semanticTerms, context.memoryMatches),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.rule.folder.localeCompare(right.rule.folder);
    })[0];
}

function memorySupport(context: SuggestionContext) {
  if (context.memoryMatches.length === 0) {
    return ["Approved Memory: none used."];
  }

  return context.memoryMatches.map(
    (memory) =>
      `Approved Memory used: ${memory.title} (${memory.overlap.join(", ")})`,
  );
}

function reviewedObservationSupport(context: SuggestionContext) {
  if (context.reviewedObservationText.length === 0) {
    return ["Trusted observation: none used."];
  }

  return [
    "Trusted observation: Deanne has approved or modified an observation used here.",
  ];
}

function provisionalWorkingSupport(context: SuggestionContext) {
  if (context.provisionalWorkingEvidence.length === 0) {
    return ["Working understanding: no provisional observation was used."];
  }

  return [
    "Working understanding: provisional observations informed this recommendation, but they are not approved Memory.",
  ];
}

function semanticClusterSupport(context: SuggestionContext, rule: TopicRule) {
  const currentSupportsRule = workingKnowledgeSupportsTopic(
    semanticAnalysisText(context),
    rule.id,
  );

  if (!currentSupportsRule) {
    return undefined;
  }

  const fileById = new Map(context.semanticFiles.map((file) => [file.id, file]));
  const directSupport = context.semanticRelationships.flatMap((relationship) => {
    if (!relationship.supportingTopics.includes(rule.id)) {
      return [];
    }

    const relatedFileId =
      relationship.leftFileId === context.scannedFileId
        ? relationship.rightFileId
        : relationship.rightFileId === context.scannedFileId
          ? relationship.leftFileId
          : null;
    const relatedFile = relatedFileId ? fileById.get(relatedFileId) : null;

    if (!relatedFile?.supportingTopics.includes(rule.id)) {
      return [];
    }

    return [
      {
        confidence: relationship.supportingTopicConfidence[rule.id] ?? 0,
        relatedPath: relatedFile.relativePath,
        sharedTerms: relationship.sharedTerms,
      },
    ];
  });

  if (directSupport.length === 0) {
    return undefined;
  }

  const relatedPaths = [
    ...new Set(directSupport.map((support) => support.relatedPath)),
  ].sort((left, right) => left.localeCompare(right));
  const ruleTerms = [
    ...new Set(
      directSupport.flatMap((support) =>
        support.sharedTerms.filter((term) =>
          rule.terms.some((ruleTerm) =>
            workingKnowledgeTerms(ruleTerm).some(
              (normalized) => normalized === workingKnowledgeTerms(term)[0],
            ),
          ),
        ),
      ),
    ),
  ];
  const sharedSubjects = [
    ...new Set(
      context.semanticClusters
        .filter((cluster) => cluster.semanticTopics.includes(rule.id))
        .flatMap((cluster) => cluster.sharedSubjects),
    ),
  ];

  return {
    confidence:
      directSupport.reduce((sum, support) => sum + support.confidence, 0) /
      directSupport.length,
    relatedPaths,
    ruleTerms,
    sharedSubjects,
  };
}

function pathSupport(context: SuggestionContext) {
  const support = [
    `Current file: ${context.currentRelativePath}`,
    `File type: ${context.fileType}`,
  ];

  if (context.audioMetadata) {
    support.push(
      `Audio review state: ${context.audioMetadata.privacyState.replaceAll("_", " ").toLowerCase()}`,
    );

    if (context.audioMetadata.machineLabels.length > 0) {
      support.push(
        `Audio signals noticed: ${context.audioMetadata.machineLabels.slice(0, 4).join(", ")}`,
      );
    }

    if (context.audioMetadata.summary) {
      support.push(`Audio summary used: ${context.audioMetadata.summary}`);
    }
  }

  if (context.videoMetadata) {
    support.push(
      `Video review state: ${context.videoMetadata.privacyState.replaceAll("_", " ").toLowerCase()}`,
    );

    if (context.videoMetadata.machineLabels.length > 0) {
      support.push(
        `Video signals noticed: ${context.videoMetadata.machineLabels.slice(0, 4).join(", ")}`,
      );
    }

    if (context.videoMetadata.summary) {
      support.push(`Video summary used: ${context.videoMetadata.summary}`);
    }
  }

  if (context.imageMetadata) {
    support.push(
      `Image review state: ${context.imageMetadata.privacyState.replaceAll("_", " ").toLowerCase()}`,
    );

    if (context.imageMetadata.machineLabels.length > 0) {
      support.push(
        `Image signals noticed: ${context.imageMetadata.machineLabels.slice(0, 4).join(", ")}`,
      );
    }

    if (context.imageMetadata.summary) {
      support.push(`Image summary used: ${context.imageMetadata.summary}`);
    }
  }

  if (isImageFileType(context.fileType)) {
    const signals = [
      isPrivateImageContext(context) ? "private" : null,
      /\b(website|public|hero|banner|landing|blog|article)\b/.test(
        imageSignalText(context),
      )
        ? "website candidate"
        : null,
      /\b(duplicate|duplicates|copy|resized|small|thumbnail)\b/.test(
        imageSignalText(context),
      )
        ? "possible duplicate"
        : null,
    ].filter(Boolean);

    support.push(
      signals.length > 0
        ? `Image path signals noticed: ${signals.join(", ")}`
        : "Image metadata used: file type, size, path, and safe header details only.",
    );
  }

  return support;
}

function makeDraft(
  context: SuggestionContext,
  draft: Omit<
    SuggestionDraft,
    | "alternatives"
    | "duplicateEvidence"
    | "evidenceStrength"
    | "requiredFolderPaths"
    | "supportingInformation"
  > & {
    alternatives?: SuggestionDraft["alternatives"];
    duplicateEvidence?: SuggestionDraft["duplicateEvidence"];
    evidenceStrength?: SuggestionDraft["evidenceStrength"];
    requiredFolderPaths?: string[];
    supportingInformation?: string[];
  },
): SuggestionDraft {
  return {
    ...draft,
    alternatives: draft.alternatives ?? [],
    confidence: confidence(draft.confidence),
    duplicateEvidence: draft.duplicateEvidence ?? [],
    evidenceStrength: draft.evidenceStrength ?? "LIMITED",
    requiredFolderPaths: draft.requiredFolderPaths ?? [],
    supportingInformation: [
      ...pathSupport(context),
      ...provisionalWorkingSupport(context),
      ...memorySupport(context),
      ...reviewedObservationSupport(context),
      ...(draft.supportingInformation ?? []),
    ].slice(0, 12),
  };
}

function possibleDuplicateDraft(context: SuggestionContext) {
  const metadata = context.audioMetadata?.duplicateKind
    ? {
        confidence: context.audioMetadata.duplicateConfidence ?? 0.62,
        duplicateKind: context.audioMetadata.duplicateKind,
        duplicateOfScannedFileId:
          context.audioMetadata.duplicateOfScannedFileId,
        noun: "recording",
      }
    : context.videoMetadata?.duplicateKind
      ? {
          confidence: context.videoMetadata.duplicateConfidence ?? 0.62,
          duplicateKind: context.videoMetadata.duplicateKind,
          duplicateOfScannedFileId:
            context.videoMetadata.duplicateOfScannedFileId,
          noun: "video",
        }
      : context.imageMetadata?.duplicateKind
        ? {
            confidence: context.imageMetadata.duplicateConfidence ?? 0.62,
            duplicateKind: context.imageMetadata.duplicateKind,
            duplicateOfScannedFileId:
              context.imageMetadata.duplicateOfScannedFileId,
            noun: "image",
          }
        : null;
  const metadataMatch = metadata?.duplicateOfScannedFileId
    ? context.duplicateMatches.find(
        (match) => match.scannedFileId === metadata.duplicateOfScannedFileId,
      )
    : null;
  const exactMatch = context.duplicateMatches.find((match) =>
    match.signals.some((signal) =>
      /exact (?:content|checksum|hash)|same checksum/i.test(signal),
    ),
  );
  const match = exactMatch ?? metadataMatch;

  if (!match) {
    return null;
  }

  const noun = metadata?.noun ?? "file";
  const duplicateKind = metadata?.duplicateKind
    ? metadata.duplicateKind.replaceAll("_", " ").toLowerCase()
    : "exact checksum match";

  return makeDraft(context, {
    confidence: exactMatch ? 0.98 : (metadata?.confidence ?? 0.52),
    duplicateEvidence: [match],
    explanation: `The Librarian found a specific ${noun} that may contain the same material. Compare both files before deciding what, if anything, to do. Nothing will be deleted automatically.`,
    suggestionType: "POSSIBLE_DUPLICATE",
    title:
      noun === "recording"
        ? "Review as a possible duplicate recording"
        : noun === "video"
          ? "Review as a possible duplicate video"
          : noun === "image"
            ? "Review as a possible duplicate image"
            : "Review as a possible duplicate",
    whySuggested: [
      `Duplicate signal: ${duplicateKind}.`,
      "The machine suggests a comparison. Deanne decides, and neither file is deleted automatically.",
    ],
    supportingInformation: [
      `Specific file to compare: ${match.connectedLibraryName} -> ${match.relativePath}`,
      ...match.signals,
    ],
  });
}

function normalizedImageStem(relativePath: string) {
  const baseName = path.posix
    .basename(relativePath, path.posix.extname(relativePath))
    .toLowerCase()
    .replace(/\b(copy|duplicate|small|resized|resize|thumbnail|thumb)\b/g, " ")
    .replace(/\b\d{2,5}x\d{2,5}\b/g, " ")
    .replace(/[-_()[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return baseName || normalizeText(relativePath);
}

function imageNameOverlap(left: string, right: string) {
  const leftTerms = new Set(tokenize(left));
  const rightTerms = new Set(tokenize(right));

  return [...leftTerms].filter((term) => rightTerms.has(term));
}

function imageDuplicateDraft(context: SuggestionContext) {
  if (!isImageFileType(context.fileType)) {
    return null;
  }

  const currentStem = normalizedImageStem(context.currentRelativePath);
  const pathText = imageSignalText(context);
  const candidates = context.siblingFiles
    .filter(
      (file) =>
        file.id !== context.scannedFileId &&
        normalizePhysicalRelativePath(file.relativePath) !==
          normalizePhysicalRelativePath(context.currentRelativePath) &&
        isImageFileType(file.fileType),
    )
    .map((file) => {
      const candidateStem = normalizedImageStem(file.relativePath);
      const overlap = imageNameOverlap(currentStem, candidateStem);

      return {
        file,
        matchingFingerprint:
          Boolean(context.imageMetadata?.imageFingerprint) &&
          file.imageFingerprint === context.imageMetadata?.imageFingerprint,
        overlap,
        sameStem: normalizeText(currentStem) === normalizeText(candidateStem),
      };
    })
    .filter(
      (candidate) =>
        candidate.matchingFingerprint ||
        candidate.sameStem ||
        candidate.overlap.length >= 2,
    )
    .slice(0, 4);

  if (candidates.length === 0) {
    return null;
  }

  return makeDraft(context, {
    confidence: candidates.some((candidate) => candidate.matchingFingerprint)
      ? 0.76
      : candidates.some((candidate) => candidate.sameStem)
        ? 0.7
        : 0.58,
    explanation:
      "The Librarian noticed image file names or folders that may point to duplicate or resized copies. This is only a review prompt; nothing should be deleted automatically.",
    duplicateEvidence: candidates.map((candidate) => ({
      connectedLibraryName: context.connectedLibraryName,
      relativePath: candidate.file.relativePath,
      signals: [
        candidate.matchingFingerprint ? "Matching image fingerprint." : null,
        candidate.sameStem ? "Matching normalized filename." : null,
        candidate.overlap.length >= 2
          ? `Filename terms in common: ${candidate.overlap.join(", ")}.`
          : null,
        candidate.file.sizeBytes !== null &&
        context.siblingFiles.find((file) => file.id === context.scannedFileId)
          ?.sizeBytes === candidate.file.sizeBytes
          ? "Matching file size."
          : null,
        /\b(resized|small|thumbnail)\b/.test(pathText)
          ? "The current filename indicates a possible resized copy."
          : null,
      ].filter((signal): signal is string => Boolean(signal)),
    })),
    suggestionType: "POSSIBLE_DUPLICATE",
    title: "Review as a possible duplicate image",
    whySuggested: [
      "The image shares visible file-name or folder patterns with another image.",
      "The Bridge never deletes images from a duplicate suggestion.",
    ],
    supportingInformation: candidates.map(
      (candidate) => `Similar image path: ${candidate.file.relativePath}`,
    ),
  });
}

function isPrivateAudioContext(context: SuggestionContext) {
  return Boolean(
    context.audioMetadata &&
      (context.audioMetadata.privacyState === "PRIVATE" ||
        context.audioMetadata.humanLabels.includes("PRIVATE")),
  );
}

function isPrivateVideoContext(context: SuggestionContext) {
  return Boolean(
    context.videoMetadata &&
      (context.videoMetadata.privacyState === "PRIVATE" ||
        context.videoMetadata.humanLabels.includes("PRIVATE")),
  );
}

function imageSignalText(context: SuggestionContext) {
  return [
    ...(context.imageMetadata?.humanLabels ?? []),
    ...(context.imageMetadata?.machineLabels ?? []),
    ...(context.imageMetadata?.provisionalTopics ?? []),
    ...(context.imageMetadata?.relatedSignals ?? []),
    context.currentRelativePath,
    context.fileName,
    context.imageMetadata?.privacyState,
    context.imageMetadata?.summary,
    context.contentText.slice(0, 8_000),
  ]
    .join(" ")
    .toLowerCase();
}

function isPrivateImageContext(context: SuggestionContext) {
  return (
    isImageFileType(context.fileType) &&
    (context.imageMetadata?.privacyState === "PRIVATE" ||
      context.imageMetadata?.humanLabels.includes("PRIVATE") ||
      /\b(private|family|personal)\b/.test(imageSignalText(context)))
  );
}

function audioLabelText(context: SuggestionContext) {
  return [
    ...(context.audioMetadata?.humanLabels ?? []),
    ...(context.audioMetadata?.machineLabels ?? []),
    ...(context.audioMetadata?.provisionalTopics ?? []),
    context.currentRelativePath,
  ]
    .join(" ")
    .toLowerCase();
}

function videoLabelText(context: SuggestionContext) {
  return [
    ...(context.videoMetadata?.humanLabels ?? []),
    ...(context.videoMetadata?.machineLabels ?? []),
    ...(context.videoMetadata?.provisionalTopics ?? []),
    context.currentRelativePath,
  ]
    .join(" ")
    .toLowerCase();
}

function textContainsAnyTerm(value: string, terms: string[]) {
  const availableTerms = new Set(tokenize(value));

  return terms.some((term) => availableTerms.has(term));
}

function mediaMoveEvidence(
  context: SuggestionContext,
  terms: string[],
  metadataText: string,
) {
  const contentText = [
    context.contentText.slice(0, maxAnalysisCharacters),
    context.reviewedObservationText.join(" "),
  ].join(" ");
  const contentMatch = textContainsAnyTerm(contentText, terms);
  const metadataMatch = textContainsAnyTerm(metadataText, terms);
  const pathMatch = textContainsAnyTerm(context.currentRelativePath, terms);
  const sources = [contentMatch, metadataMatch, pathMatch].filter(Boolean).length;

  if (sources < 2 || (!contentMatch && !metadataMatch)) {
    return null;
  }

  return {
    evidenceStrength:
      contentMatch && metadataMatch ? ("STRONG" as const) : ("SUPPORTED" as const),
    supportingInformation: [
      contentMatch ? "The readable or reviewed content supports this category." : null,
      metadataMatch ? "Media labels or summary support this category." : null,
      pathMatch ? "The current filename or folder agrees with this category." : null,
    ].filter((item): item is string => Boolean(item)),
  };
}

function audioMoveDraft(context: SuggestionContext) {
  if (!context.audioMetadata || !isAudioFileType(context.fileType)) {
    return null;
  }

  const metadataText = [
    ...context.audioMetadata.humanLabels,
    ...context.audioMetadata.machineLabels,
    ...context.audioMetadata.provisionalTopics,
    context.audioMetadata.summary,
  ]
    .filter(Boolean)
    .join(" ");
  const target = [
    {
      folder: "Audio/Workshops",
      reason:
        "The recording content and its media context both point to workshop material.",
      terms: ["workshop"],
      title: "Consider moving this into the workshop recordings",
    },
    {
      folder: "Audio/Meetings",
      reason:
        "The recording content and its media context both point to a meeting or agenda.",
      terms: ["meeting", "agenda"],
      title: "Consider moving this into meeting recordings",
    },
    {
      folder: "Audio/Podcasts",
      reason:
        "The recording content and its media context both point to podcast material.",
      terms: ["podcast"],
      title: "Consider moving this into podcast recordings",
    },
    {
      folder: "Audio/Research",
      reason:
        "The recording content and its media context both point to research material.",
      terms: ["research"],
      title: "Consider moving this into audio research",
    },
  ]
    .map((candidate) => ({
      ...candidate,
      evidence: mediaMoveEvidence(
        context,
        candidate.terms,
        metadataText,
      ),
    }))
    .find((candidate) => candidate.evidence !== null);

  if (!target?.evidence) {
    return null;
  }

  const currentFolder = folderFromRelativePath(context.currentRelativePath);

  if (normalizeText(currentFolder) === normalizeText(target.folder)) {
    return null;
  }

  return makeDraft(context, {
    confidence: target.evidence.evidenceStrength === "STRONG" ? 0.74 : 0.64,
    evidenceStrength: target.evidence.evidenceStrength,
    explanation: target.reason,
    proposedRelativePath: joinRelativePath(target.folder, context.fileName),
    suggestionType: "MOVE_FILE",
    title: target.title,
    whySuggested: [
      target.reason,
      "Audio labels and transcript snippets are provisional until Deanne reviews them.",
    ],
    supportingInformation: target.evidence.supportingInformation,
  });
}

function audioWebsiteCandidateDraft(context: SuggestionContext) {
  if (
    !context.audioMetadata ||
    !isAudioFileType(context.fileType) ||
    isPrivateAudioContext(context)
  ) {
    return null;
  }

  const text = audioLabelText(context);

  if (
    !(
      text.includes("website") ||
      text.includes("public") ||
      text.includes("article") ||
      text.includes("podcast")
    )
  ) {
    return null;
  }

  return makeDraft(context, {
    confidence: 0.55,
    explanation:
      "The Librarian noticed this recording may contain material worth reviewing for public use. Approval is required before it can influence any publishing plan.",
    proposedRelativePath: joinRelativePath("Website Candidates/Audio", context.fileName),
    suggestionType: "WEBSITE_CANDIDATE",
    title: "Review this recording as a possible website candidate",
    whySuggested: [
      "The recording includes public-facing or website-oriented signals.",
      "Private recordings are excluded from publishing recommendations.",
    ],
  });
}

function videoMoveDraft(context: SuggestionContext) {
  if (!context.videoMetadata || !isVideoFileType(context.fileType)) {
    return null;
  }

  const metadataText = [
    ...context.videoMetadata.humanLabels,
    ...context.videoMetadata.machineLabels,
    ...context.videoMetadata.provisionalTopics,
    context.videoMetadata.summary,
  ]
    .filter(Boolean)
    .join(" ");
  const target = [
    {
      folder: "Video/Workshops",
      reason:
        "The video content and its media context both point to workshop material.",
      terms: ["workshop"],
      title: "Consider moving this into workshop recordings",
    },
    {
      folder: "Video/Presentations",
      reason:
        "The video content and its media context both point to presentation material.",
      terms: ["presentation", "slide"],
      title: "Consider moving this into presentation recordings",
    },
    {
      folder: "Video/Webinars",
      reason:
        "The video content and its media context both point to webinar material.",
      terms: ["webinar"],
      title: "Consider moving this into webinar recordings",
    },
    {
      folder: "Video/Interviews",
      reason:
        "The video content and its media context both point to interview material.",
      terms: ["interview"],
      title: "Consider moving this into interview recordings",
    },
  ]
    .map((candidate) => ({
      ...candidate,
      evidence: mediaMoveEvidence(
        context,
        candidate.terms,
        metadataText,
      ),
    }))
    .find((candidate) => candidate.evidence !== null);

  if (!target?.evidence) {
    return null;
  }

  const currentFolder = folderFromRelativePath(context.currentRelativePath);

  if (normalizeText(currentFolder) === normalizeText(target.folder)) {
    return null;
  }

  return makeDraft(context, {
    confidence: target.evidence.evidenceStrength === "STRONG" ? 0.74 : 0.64,
    evidenceStrength: target.evidence.evidenceStrength,
    explanation: target.reason,
    proposedRelativePath: joinRelativePath(target.folder, context.fileName),
    suggestionType: "MOVE_FILE",
    title: target.title,
    whySuggested: [
      target.reason,
      "Video labels, transcript snippets, and frame notes are provisional until Deanne reviews them.",
    ],
    supportingInformation: target.evidence.supportingInformation,
  });
}

function videoWebsiteCandidateDraft(context: SuggestionContext) {
  if (
    !context.videoMetadata ||
    !isVideoFileType(context.fileType) ||
    isPrivateVideoContext(context)
  ) {
    return null;
  }

  const text = videoLabelText(context);

  if (
    !(
      text.includes("website") ||
      text.includes("public") ||
      text.includes("webinar") ||
      text.includes("branding")
    )
  ) {
    return null;
  }

  return makeDraft(context, {
    confidence: 0.56,
    explanation:
      "The Librarian noticed this video may contain material worth reviewing for public use. Approval is required before it can influence any publishing plan.",
    proposedRelativePath: joinRelativePath("Website Candidates/Video", context.fileName),
    suggestionType: "WEBSITE_CANDIDATE",
    title: "Review this video as a possible website candidate",
    whySuggested: [
      "The video includes public-facing, webinar, or branding signals.",
      "Private videos are excluded from publishing recommendations.",
    ],
  });
}

function imageWebsiteCandidateDraft(context: SuggestionContext) {
  if (!isImageFileType(context.fileType) || isPrivateImageContext(context)) {
    return null;
  }

  const text = imageSignalText(context);

  if (!/\b(website|public|hero|banner|landing|blog|article|social)\b/.test(text)) {
    return null;
  }

  return makeDraft(context, {
    confidence: 0.56,
    explanation:
      "The Librarian noticed visible image path signals that may be useful for public-facing material. This is only a candidate label for review.",
    proposedRelativePath: joinRelativePath("Website Candidates/Images", context.fileName),
    suggestionType: "WEBSITE_CANDIDATE",
    title: "Review this image as a possible website candidate",
    whySuggested: [
      "The image file or folder includes public-facing or website-oriented wording.",
      "Private images are excluded from publishing recommendations.",
    ],
  });
}

function moveAndFolderDrafts(context: SuggestionContext) {
  const best = bestRuleFor(context);

  if (!best) {
    return [];
  }

  const establishedFolder = establishedFolderForRule(best.rule, context);
  const clusterSupport = semanticClusterSupport(context, best.rule);
  const hasSupportedMeaning =
    best.directMatches.length >= 2 ||
    (best.directMatches.length >= 1 && best.memoryScore >= 1) ||
    (best.directMatches.length >= 1 && Boolean(clusterSupport));
  const hasStrongMeaning =
    best.directMatches.length >= 3 ||
    (best.directMatches.length >= 2 && best.memoryScore >= 1) ||
    (best.directMatches.length >= 1 && Boolean(clusterSupport));

  if (
    (!establishedFolder && !hasStrongMeaning) ||
    (establishedFolder && !hasSupportedMeaning)
  ) {
    return [];
  }

  const destinationFolder = establishedFolder?.folder ?? best.rule.folder;
  const currentFolder = folderFromRelativePath(context.currentRelativePath);
  const proposedRelativePath = joinRelativePath(destinationFolder, context.fileName);
  const drafts: SuggestionDraft[] = [];
  const matchedConcepts = best.directMatches.join(", ");
  const folderEvidence = establishedFolder
    ? `${establishedFolder.fileCount} existing files are already stored under ${establishedFolder.folder}.`
    : clusterSupport
      ? `${clusterSupport.relatedPaths.length} related ${clusterSupport.relatedPaths.length === 1 ? "file" : "files"} in this scan share the working subjects ${[
          ...clusterSupport.sharedSubjects,
          ...clusterSupport.ruleTerms,
        ].join(", ")}.`
      : `${matchedConcepts} appear together in the readable or reviewed content.`;

  if (!establishedFolder) {
    drafts.push(
      makeDraft(context, {
        confidence:
          0.68 +
          Math.min(best.directMatches.length, 4) * 0.02 +
          (clusterSupport ? 0.04 : 0),
        evidenceStrength: "STRONG",
        explanation: `The readable or reviewed content repeatedly supports ${matchedConcepts}. There is no established matching folder in this scan, so creating ${best.rule.folder} is presented only as a dependency of the proposed move.`,
        proposedRelativePath: normalizeBridgeRelativePath(destinationFolder),
        suggestionType: "CREATE_FOLDER",
        title: `Consider a ${best.rule.folder} folder`,
        whySuggested: [
          best.rule.explanation,
          `Content concepts: ${matchedConcepts}`,
        ],
        supportingInformation: [
          folderEvidence,
          ...(clusterSupport
            ? clusterSupport.relatedPaths
                .slice(0, 3)
                .map((relativePath) => `Related file: ${relativePath}`)
            : []),
          ...(clusterSupport?.sharedSubjects.length
            ? [`Shared working subjects: ${clusterSupport.sharedSubjects.join(", ")}`]
            : []),
          "A category folder is proposed only because several related content signals agree.",
        ],
      }),
    );
  }

  if (normalizeText(currentFolder) !== normalizeText(destinationFolder)) {
    drafts.push(
      makeDraft(context, {
        confidence:
          0.68 +
          Math.min(best.directMatches.length, 4) * 0.02 +
          (establishedFolder ? 0.04 : 0) +
          (clusterSupport ? 0.04 : 0),
        evidenceStrength: "STRONG",
        explanation: `The readable or reviewed content includes the related concepts ${matchedConcepts}. ${folderEvidence} Together, that evidence supports reviewing ${destinationFolder} as a destination.`,
        proposedRelativePath,
        suggestionType: "MOVE_FILE",
        title: `Consider placing this with ${best.rule.folder}`,
        whySuggested: [
          best.rule.explanation,
          `Content concepts: ${matchedConcepts}`,
        ],
        supportingInformation: [
          folderEvidence,
          ...(clusterSupport
            ? clusterSupport.relatedPaths
                .slice(0, 3)
                .map((relativePath) => `Related file: ${relativePath}`)
            : []),
          ...(clusterSupport?.sharedSubjects.length
            ? [`Shared working subjects: ${clusterSupport.sharedSubjects.join(", ")}`]
            : []),
          ...(best.memoryScore > 0
            ? ["Approved Memory corroborates this topic classification."]
            : []),
        ],
      }),
    );
  }

  return drafts;
}

function renameDraft(context: SuggestionContext, topTerms: string[]) {
  if (!fileNameLooksGeneric(context.fileName)) {
    return null;
  }

  const meaningfulTerms = [
    ...new Set([...context.preferredTerms, ...topTerms]),
  ].slice(0, 4);
  const hasStrongEvidence =
    topTerms.length >= 3 ||
    (topTerms.length >= 2 && context.preferredTerms.length > 0);

  if (topTerms.length < 2) {
    return null;
  }

  const proposedFileName = proposedFileNameFromTerms(
    meaningfulTerms,
    context.fileName,
  );

  if (normalizeText(proposedFileName) === normalizeText(context.fileName)) {
    return null;
  }

  return makeDraft(context, {
    confidence: hasStrongEvidence ? 0.69 : 0.58,
    evidenceStrength: hasStrongEvidence ? "STRONG" : "SUPPORTED",
    explanation: `The current filename is generic, while the readable or reviewed content repeatedly emphasizes ${meaningfulTerms.join(", ")}. Those content-derived terms support reviewing a clearer name.`,
    proposedFileName,
    suggestionType: "RENAME_FILE",
    title: `Consider renaming this file to ${proposedFileName}`,
    whySuggested: [
      "The current file name does not describe the contents clearly.",
      `Content-derived terms: ${meaningfulTerms.join(", ")}`,
    ],
  });
}

function websiteCandidateDraft(context: SuggestionContext) {
  if (
    isPrivateAudioContext(context) ||
    isPrivateVideoContext(context) ||
    isPrivateImageContext(context)
  ) {
    return null;
  }

  const analysisTerms = new Set(
    tokenize(semanticAnalysisText(context)),
  );
  const websiteRule = topicRules.find((rule) => rule.id === "website");
  const matches = websiteRule
    ? websiteRule.terms.filter((term) => analysisTerms.has(term))
    : [];

  if (matches.length < 2) {
    return null;
  }

  return makeDraft(context, {
    confidence: 0.57 + matches.length * 0.05,
    explanation:
      "The Librarian noticed language that may later be useful for public-facing material. This is a candidate label only.",
    proposedRelativePath: joinRelativePath("Website Candidates", context.fileName),
    suggestionType: "WEBSITE_CANDIDATE",
    title: "Review as a possible website candidate",
    whySuggested: [
      "The item includes public-facing or article-like language.",
      `Signals noticed: ${matches.join(", ")}`,
    ],
  });
}

function groupWithFilesDraft(context: SuggestionContext, topTerms: string[]) {
  const semanticTerms = new Set(topTerms.slice(0, 10));
  const sourceFileNameTerms = new Set(tokenize(context.fileName));
  const currentFolder = normalizeText(
    folderFromRelativePath(context.currentRelativePath),
  );
  const candidatesByFolder = new Map<
    string,
    Array<{
      file: SuggestionContext["siblingFiles"][number];
      overlap: string[];
    }>
  >();

  for (const file of context.siblingFiles) {
    if (file.id === context.scannedFileId) {
      continue;
    }

    const folder = folderFromRelativePath(file.relativePath);
    const overlap = [
      ...new Set(
        tokenize(file.relativePath).filter((term) => semanticTerms.has(term)),
      ),
    ];

    if (!folder || overlap.length === 0 || normalizeText(folder) === currentFolder) {
      continue;
    }

    const entries = candidatesByFolder.get(folder) ?? [];

    entries.push({ file, overlap });
    candidatesByFolder.set(folder, entries);
  }

  const candidate = [...candidatesByFolder.entries()]
    .map(([folder, entries]) => {
      const sharedTerms = [
        ...new Set(entries.flatMap((entry) => entry.overlap)),
      ];
      const folderTerms = new Set(tokenize(folder));
      const filenameAgreement = sharedTerms.filter((term) =>
        sourceFileNameTerms.has(term),
      );
      const folderAgreement = sharedTerms.filter((term) =>
        folderTerms.has(term),
      );
      const establishedPattern =
        entries.length >= 2 && sharedTerms.length >= 2;
      const strongThreeWayAgreement =
        entries.some((entry) => entry.overlap.length >= 2) &&
        filenameAgreement.length >= 2 &&
        folderAgreement.length >= 1;

      return {
        entries,
        establishedPattern,
        filenameAgreement,
        folder,
        folderAgreement,
        qualifies: establishedPattern || strongThreeWayAgreement,
        score:
          entries.length * 4 +
          sharedTerms.length * 2 +
          filenameAgreement.length +
          folderAgreement.length,
        sharedTerms,
        strongThreeWayAgreement,
      };
    })
    .filter((entry) => entry.qualifies)
    .sort(
      (left, right) =>
        right.score - left.score || left.folder.localeCompare(right.folder),
    )[0];

  if (!candidate) {
    return null;
  }

  const sharedTerms = candidate.sharedTerms.slice(0, 5);
  const relatedPaths = candidate.entries
    .map((entry) => entry.file.relativePath)
    .slice(0, 3);
  const patternDescription = candidate.establishedPattern
    ? `${candidate.entries.length} existing files under ${candidate.folder} use the same specific content concepts.`
    : `The content, filename, and existing folder ${candidate.folder} agree on the specific concepts ${sharedTerms.join(", ")}.`;

  return makeDraft(context, {
    confidence: candidate.establishedPattern ? 0.75 : 0.72,
    evidenceStrength: "STRONG",
    explanation: `The readable or reviewed content is about ${sharedTerms.join(", ")}. ${patternDescription} This supports reviewing that established folder as a destination.`,
    proposedRelativePath: joinRelativePath(candidate.folder, context.fileName),
    suggestionType: "GROUP_WITH_FILES",
    title: `Review this with related files in ${candidate.folder}`,
    whySuggested: [
      "The proposed folder is supported by content meaning and an existing file pattern.",
      `Specific shared concepts: ${sharedTerms.join(", ")}`,
    ],
    supportingInformation: [
      patternDescription,
      ...relatedPaths.map((relativePath) => `Relevant existing file: ${relativePath}`),
    ],
  });
}

function fallbackRecommendationDraft(context: SuggestionContext) {
  if (isPrivateAudioContext(context)) {
    return makeDraft(context, {
      confidence: 0.72,
      explanation:
        "Deanne has marked this recording private, so the safest recommendation is to leave it unchanged unless she decides otherwise.",
      suggestionType: "KEEP_UNCHANGED",
      title: "Keep this private recording unchanged",
      whySuggested: [
        "Private audio should not receive publishing recommendations.",
        "Nothing should move without Deanne's approval.",
      ],
    });
  }

  if (isPrivateVideoContext(context)) {
    return makeDraft(context, {
      confidence: 0.72,
      explanation:
        "Deanne has marked this video private, so the safest recommendation is to leave it unchanged unless she decides otherwise.",
      suggestionType: "KEEP_UNCHANGED",
      title: "Keep this private video unchanged",
      whySuggested: [
        "Private video should not receive publishing recommendations.",
        "Nothing should move without Deanne's approval.",
      ],
    });
  }

  if (isPrivateImageContext(context)) {
    return makeDraft(context, {
      confidence: 0.72,
      explanation:
        "This image appears to carry private path signals, so the safest recommendation is to leave it unchanged unless Deanne decides otherwise.",
      suggestionType: "KEEP_UNCHANGED",
      title: "Keep this private image unchanged",
      whySuggested: [
        "Private images should not receive publishing recommendations.",
        "Nothing should move without Deanne's approval.",
      ],
    });
  }

  const best = bestRuleFor(context);
  const establishedFolder = best
    ? establishedFolderForRule(best.rule, context)
    : null;
  const currentFolder = folderFromRelativePath(context.currentRelativePath);
  const affirmativePattern = Boolean(
    best &&
      ((establishedFolder &&
        normalizeText(establishedFolder.folder) === normalizeText(currentFolder) &&
        (best.directMatches.length >= 1 || best.memoryScore >= 1)) ||
        (best.memoryScore >= 1 &&
          best.directMatches.length >= 2 &&
          normalizeText(best.rule.folder) === normalizeText(currentFolder))),
  );

  if (affirmativePattern) {
    const evidence = establishedFolder
      ? `${establishedFolder.fileCount} existing files are already stored under ${establishedFolder.folder}.`
      : "Approved Memory and the readable content support this folder as an established topic location.";

    return makeDraft(context, {
      confidence: 0.76,
      explanation: `The current folder is supported by an established organization pattern. ${evidence} The Librarian found affirmative evidence to leave this file here.`,
      suggestionType: "KEEP_UNCHANGED",
      title: "Keep this file in its supported folder",
      whySuggested: [
        "The current location matches a supported topic pattern.",
        evidence,
        "Nothing should move without Deanne's approval.",
      ],
      supportingInformation: [evidence],
    });
  }

  return makeDraft(context, {
    confidence: 0.42,
    explanation:
      "The Librarian does not have enough evidence to recommend a change yet.",
    suggestionType: "INSUFFICIENT_EVIDENCE",
    title: "Not enough evidence to recommend a change",
    whySuggested: [
      "The available organization evidence is limited or inconclusive.",
      "This is not a recommendation that the current location is correct.",
    ],
  });
}

function buildDrafts(context: SuggestionContext) {
  const topTerms = rankedTerms(semanticAnalysisText(context), 12);
  const drafts: Array<SuggestionDraft | null> = [
    possibleDuplicateDraft(context),
    imageDuplicateDraft(context),
    audioMoveDraft(context),
    videoMoveDraft(context),
    ...moveAndFolderDrafts(context),
    renameDraft(context, topTerms),
    audioWebsiteCandidateDraft(context),
    videoWebsiteCandidateDraft(context),
    imageWebsiteCandidateDraft(context),
    websiteCandidateDraft(context),
    groupWithFilesDraft(context, topTerms),
  ];
  const usefulDrafts = drafts.filter(
    (draft): draft is SuggestionDraft => draft !== null,
  );

  if (usefulDrafts.length === 0) {
    usefulDrafts.push(fallbackRecommendationDraft(context));
  }

  return usefulDrafts.sort((left, right) => {
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }

    return left.title.localeCompare(right.title);
  });
}

function cleanDraftPaths(draft: SuggestionDraft) {
  return {
    ...draft,
    proposedFileName: draft.proposedFileName
      ? normalizeBridgeFileName(draft.proposedFileName)
      : null,
    proposedRelativePath: draft.proposedRelativePath
      ? normalizeBridgeRelativePath(draft.proposedRelativePath)
      : null,
  };
}

function suggestionKeyFor(
  context: SuggestionContext,
  draft: SuggestionDraft,
  recommendationGenerationId: string,
) {
  return hashSuggestionKey([
    recommendationGenerationId,
    context.scannedFileId,
    draft.suggestionType,
    context.currentRelativePath,
    draft.proposedRelativePath ?? "",
    draft.proposedFileName ?? "",
    draft.title,
  ]);
}

function suggestionContentSignatureFor(input: {
  currentRelativePath: string;
  proposedFileName: string | null;
  proposedRelativePath: string | null;
  scannedFileId: string;
  suggestionType: string;
  title: string;
}) {
  return hashSuggestionKey([
    input.scannedFileId,
    input.suggestionType,
    input.currentRelativePath,
    input.proposedRelativePath ?? "",
    input.proposedFileName ?? "",
    input.title,
  ]);
}

function draftContentSignatureFor(
  context: SuggestionContext,
  draft: SuggestionDraft,
) {
  return suggestionContentSignatureFor({
    currentRelativePath: context.currentRelativePath,
    proposedFileName: draft.proposedFileName ?? null,
    proposedRelativePath: draft.proposedRelativePath ?? null,
    scannedFileId: context.scannedFileId,
    suggestionType: draft.suggestionType,
    title: draft.title,
  });
}

function normalizeSuggestionType(value: string): OrganizationSuggestionType {
  return organizationSuggestionTypes.has(value as OrganizationSuggestionType)
    ? (value as OrganizationSuggestionType)
    : "INSUFFICIENT_EVIDENCE";
}

function normalizeSuggestionStatus(value: string): OrganizationSuggestionStatus {
  return organizationSuggestionStatuses.has(value as OrganizationSuggestionStatus)
    ? (value as OrganizationSuggestionStatus)
    : "PENDING";
}

export function summarizeOrganizationSuggestion(
  suggestion: StoredSuggestion,
): BridgeOrganizationSuggestionSummary {
  const support = recommendationSupportFromJson(
    suggestion.supportingInformation,
  );

  return {
    alternatives: support.alternatives,
    confidence: suggestion.confidence,
    createdAt: suggestion.createdAt.toISOString(),
    currentRelativePath: suggestion.currentRelativePath,
    duplicateEvidence: support.duplicateEvidence,
    evidenceStrength: support.evidenceStrength,
    explanation: suggestion.explanation,
    id: suggestion.id,
    invalidatedAt: suggestion.invalidatedAt?.toISOString() ?? null,
    invalidatedReason: suggestion.invalidatedReason,
    proposedFileName: suggestion.proposedFileName,
    proposedRelativePath: suggestion.proposedRelativePath,
    recommendationGenerationId: suggestion.recommendationGenerationId,
    recommendationGenerationVersion: suggestion.recommendationGenerationVersion,
    requiredFolderPaths: support.requiredFolderPaths,
    reviewedAt: suggestion.reviewedAt?.toISOString() ?? null,
    revisions: suggestion.revisions.map((revision) => ({
      context: revision.context,
      createdAt: revision.createdAt.toISOString(),
      id: revision.id,
      revisedFileName: revision.revisedFileName,
      revisedRelativePath: revision.revisedRelativePath,
    })),
    scanSessionId: suggestion.scanSessionId,
    scannedFileId: suggestion.scannedFileId,
    status: normalizeSuggestionStatus(suggestion.status),
    suggestionType: normalizeSuggestionType(suggestion.suggestionType),
    supportingInformation: support.details,
    title: suggestion.title,
    whySuggested: asStringArray(suggestion.whySuggested),
  };
}

async function refreshedScannedFileSummary(
  scannedFileId: string,
): Promise<BridgeScannedFileSummary> {
  const prisma = getPrismaClient();
  const file = await prisma.scannedFile.findUnique({
    include: {
      audioMetadata: true,
      imageMetadata: true,
      videoMetadata: true,
      libraryDocument: {
        select: {
          observationSessions: {
            select: {
              status: true,
            },
          },
        },
      },
      organizationSuggestions: {
        select: {
          status: true,
          suggestionType: true,
        },
        where: {
          invalidatedAt: null,
          recommendationGenerationVersion: currentRecommendationGenerationVersion,
        },
      },
    },
    where: {
      id: scannedFileId,
    },
  });

  if (!file) {
    throw new OrganizationSuggestionError(
      "The Librarian could not find that scanned file.",
      404,
    );
  }

  return scannedFileSummary(file);
}

function duplicateNameSignals(leftFileName: string, rightFileName: string) {
  const leftStem = normalizeText(
    path.posix.basename(leftFileName, path.posix.extname(leftFileName)),
  );
  const rightStem = normalizeText(
    path.posix.basename(rightFileName, path.posix.extname(rightFileName)),
  );
  const overlap = [...new Set(tokenize(leftStem))].filter((term) =>
    new Set(tokenize(rightStem)).has(term),
  );

  if (leftStem && leftStem === rightStem) {
    return ["Matching normalized filename."];
  }

  return overlap.length >= 2
    ? [`Filename terms in common: ${overlap.join(", ")}.`]
    : [];
}

function duplicateSignals(
  source: DuplicateEvidenceFile,
  target: DuplicateEvidenceFile,
) {
  const signals: string[] = [];

  if (
    source.checksum?.trim() &&
    source.checksum === target.checksum &&
    source.sizeBytes !== BigInt(0) &&
    target.sizeBytes !== BigInt(0)
  ) {
    signals.push("Exact content match: the non-empty files have the same checksum.");
  }

  if (
    source.audioFingerprint &&
    source.audioFingerprint === target.audioFingerprint
  ) {
    signals.push("Matching audio fingerprint.");
  }

  if (
    source.videoFingerprint &&
    source.videoFingerprint === target.videoFingerprint
  ) {
    signals.push("Matching video fingerprint.");
  }

  if (
    source.imageFingerprint &&
    source.imageFingerprint === target.imageFingerprint
  ) {
    signals.push("Matching image fingerprint.");
  }

  if (
    source.sizeBytes !== null &&
    source.sizeBytes !== BigInt(0) &&
    source.sizeBytes === target.sizeBytes
  ) {
    signals.push(`Matching file size: ${source.sizeBytes.toString()} bytes.`);
  }

  if (
    source.audioDurationSeconds !== null &&
    target.audioDurationSeconds !== null &&
    Math.abs(source.audioDurationSeconds - target.audioDurationSeconds) <= 3
  ) {
    signals.push(
      `Similar audio duration: ${source.audioDurationSeconds.toFixed(1)} and ${target.audioDurationSeconds.toFixed(1)} seconds.`,
    );
  }

  if (
    source.videoDurationSeconds !== null &&
    target.videoDurationSeconds !== null &&
    Math.abs(source.videoDurationSeconds - target.videoDurationSeconds) <= 5
  ) {
    signals.push(
      `Similar video duration: ${source.videoDurationSeconds.toFixed(1)} and ${target.videoDurationSeconds.toFixed(1)} seconds.`,
    );
  }

  if (
    source.width !== null &&
    source.height !== null &&
    target.width !== null &&
    target.height !== null &&
    source.width === target.width &&
    source.height === target.height
  ) {
    signals.push(`Matching dimensions: ${source.width} x ${source.height}.`);
  }

  signals.push(...duplicateNameSignals(source.fileName, target.fileName));

  return [...new Set(signals)];
}

async function scannedFileContext(
  scannedFileId: string,
  contentText: string,
  workingKnowledge?: ScanWorkingKnowledgeIndex,
) {
  const prisma = getPrismaClient();
  const scannedFile = await prisma.scannedFile.findUnique({
    include: {
      audioMetadata: {
        select: {
          audioFingerprint: true,
          duplicateConfidence: true,
          duplicateKind: true,
          duplicateOfScannedFileId: true,
          durationSeconds: true,
          humanLabels: true,
          machineLabels: true,
          privacyState: true,
          provisionalTopics: true,
          summary: true,
        },
      },
      imageMetadata: {
        select: {
          duplicateConfidence: true,
          duplicateKind: true,
          duplicateOfScannedFileId: true,
          humanLabels: true,
          height: true,
          imageFingerprint: true,
          machineLabels: true,
          privacyState: true,
          provisionalTopics: true,
          relatedSignals: true,
          summary: true,
          width: true,
        },
      },
      videoMetadata: {
        select: {
          duplicateConfidence: true,
          duplicateKind: true,
          duplicateOfScannedFileId: true,
          durationSeconds: true,
          height: true,
          humanLabels: true,
          machineLabels: true,
          privacyState: true,
          provisionalTopics: true,
          summary: true,
          videoFingerprint: true,
          width: true,
        },
      },
      libraryDocument: {
        select: {
          id: true,
          observationSessions: {
            select: {
              explanation: true,
              interpretations: true,
              observations: true,
              planSuggestions: true,
              status: true,
            },
          },
        },
      },
      scanSession: {
        include: {
          connectedFolder: {
            select: {
              bridgeRootId: true,
              canonicalConnectedLibraryId: true,
              displayName: true,
              folderFingerprint: true,
              id: true,
              localPath: true,
              platform: true,
            },
          },
          scannedFiles: {
            select: {
              audioMetadata: {
                select: {
                  audioFingerprint: true,
                  durationSeconds: true,
                },
              },
              imageMetadata: {
                select: {
                  height: true,
                  imageFingerprint: true,
                  width: true,
                },
              },
              videoMetadata: {
                select: {
                  durationSeconds: true,
                  height: true,
                  videoFingerprint: true,
                  width: true,
                },
              },
              checksum: true,
              fileType: true,
              id: true,
              localPath: true,
              relativePath: true,
              sizeBytes: true,
            },
          },
        },
      },
    },
    where: {
      id: scannedFileId,
    },
  });

  if (!scannedFile) {
    throw new OrganizationSuggestionError(
      "The Librarian could not find that scanned file.",
      404,
    );
  }

  if (
    scannedFile.readingStatus !== "READ" ||
    scannedFile.extractionStatus !== "COMPLETED"
  ) {
    throw new OrganizationSuggestionError(
      "Read this file before asking for organization recommendations.",
      409,
    );
  }

  if (
    !scannedFile.libraryDocument ||
    scannedFile.libraryDocument.observationSessions.length === 0
  ) {
    throw new OrganizationSuggestionError(
      "Examine this file before asking for organization recommendations.",
      409,
    );
  }

  const reviewedText = reviewedObservationText(
    scannedFile.libraryDocument.observationSessions,
  );
  const provisionalText = provisionalObservationText(
    scannedFile.libraryDocument.observationSessions,
  );
  const analysisText = semanticAnalysisText({
    contentText: contentText.slice(0, maxAnalysisCharacters),
    currentRelativePath: scannedFile.relativePath,
    provisionalWorkingEvidence: provisionalText,
    reviewedObservationText: reviewedText,
  });
  const analysisTerms = new Set(tokenize(analysisText));
  const memoryEntries = await prisma.memoryEntry.findMany({
    orderBy: [{ occurrenceCount: "desc" }, { lastSeen: "desc" }],
    take: 80,
    where: {
      status: "ACTIVE",
    },
  });
  const memoryMatches = activeMemoryMatches(memoryEntries, analysisTerms);
  const preferredTerms = preferredTermsFromMemory(memoryEntries, analysisText);
  const exactDuplicate = await findExactChecksumDuplicateForScannedFile(
    scannedFile.id,
  );
  const duplicateTargetIds = [
    exactDuplicate?.id,
    scannedFile.audioMetadata?.duplicateOfScannedFileId,
    scannedFile.imageMetadata?.duplicateOfScannedFileId,
    scannedFile.videoMetadata?.duplicateOfScannedFileId,
  ].filter((id): id is string => Boolean(id));
  const duplicateTargets =
    duplicateTargetIds.length > 0
      ? await prisma.scannedFile.findMany({
          select: {
            audioMetadata: {
              select: {
                audioFingerprint: true,
                durationSeconds: true,
              },
            },
            checksum: true,
            id: true,
            imageMetadata: {
              select: {
                height: true,
                imageFingerprint: true,
                width: true,
              },
            },
            localPath: true,
            relativePath: true,
            scanSession: {
              select: {
                connectedFolder: {
                  select: {
                    bridgeRootId: true,
                    canonicalConnectedLibraryId: true,
                    displayName: true,
                    folderFingerprint: true,
                    id: true,
                    localPath: true,
                    platform: true,
                  },
                },
              },
            },
            sizeBytes: true,
            videoMetadata: {
              select: {
                durationSeconds: true,
                height: true,
                videoFingerprint: true,
                width: true,
              },
            },
          },
          where: {
            id: {
              in: duplicateTargetIds,
            },
          },
        })
      : [];
  const sourceEvidence: DuplicateEvidenceFile = {
    audioDurationSeconds:
      scannedFile.audioMetadata?.durationSeconds ?? null,
    audioFingerprint: scannedFile.audioMetadata?.audioFingerprint ?? null,
    checksum: scannedFile.checksum,
    connectedLibraryId: scannedFile.scanSession.connectedFolder.id,
    connectedLibraryName: scannedFile.scanSession.connectedFolder.displayName,
    fileName: fileNameFromRelativePath(scannedFile.relativePath),
    height:
      scannedFile.imageMetadata?.height ??
      scannedFile.videoMetadata?.height ??
      null,
    imageFingerprint: scannedFile.imageMetadata?.imageFingerprint ?? null,
    relativePath: scannedFile.relativePath,
    scannedFileId: scannedFile.id,
    sizeBytes: scannedFile.sizeBytes,
    videoDurationSeconds:
      scannedFile.videoMetadata?.durationSeconds ?? null,
    videoFingerprint: scannedFile.videoMetadata?.videoFingerprint ?? null,
    width:
      scannedFile.imageMetadata?.width ??
      scannedFile.videoMetadata?.width ??
      null,
  };
  const duplicateMatches = duplicateTargets.flatMap((target) => {
    if (
      !demonstrablyDistinctPhysicalFiles(
        {
          localPath: scannedFile.localPath,
          relativePath: scannedFile.relativePath,
          scanSession: { connectedFolder: scannedFile.scanSession.connectedFolder },
        },
        {
          localPath: target.localPath,
          relativePath: target.relativePath,
          scanSession: { connectedFolder: target.scanSession.connectedFolder },
        },
      )
    ) {
      return [];
    }

    const targetEvidence: DuplicateEvidenceFile = {
      audioDurationSeconds: target.audioMetadata?.durationSeconds ?? null,
      audioFingerprint: target.audioMetadata?.audioFingerprint ?? null,
      checksum: target.checksum,
      connectedLibraryId: target.scanSession.connectedFolder.id,
      connectedLibraryName: target.scanSession.connectedFolder.displayName,
      fileName: fileNameFromRelativePath(target.relativePath),
      height: target.imageMetadata?.height ?? target.videoMetadata?.height ?? null,
      imageFingerprint: target.imageMetadata?.imageFingerprint ?? null,
      relativePath: target.relativePath,
      scannedFileId: target.id,
      sizeBytes: target.sizeBytes,
      videoDurationSeconds: target.videoMetadata?.durationSeconds ?? null,
      videoFingerprint: target.videoMetadata?.videoFingerprint ?? null,
      width: target.imageMetadata?.width ?? target.videoMetadata?.width ?? null,
    };
    const signals = duplicateSignals(sourceEvidence, targetEvidence);

    return signals.length > 0
      ? [
          {
            connectedLibraryName: targetEvidence.connectedLibraryName,
            relativePath: targetEvidence.relativePath,
            scannedFileId: targetEvidence.scannedFileId,
            signals,
          },
        ]
      : [];
  });

  return {
    checksum: scannedFile.checksum,
    contentText,
    currentRelativePath: normalizeBridgeRelativePath(scannedFile.relativePath),
    connectedLibraryName: scannedFile.scanSession.connectedFolder.displayName,
    duplicateMatches,
    fileName: fileNameFromRelativePath(scannedFile.relativePath),
    fileType: scannedFile.fileType,
    folderStructure: collectFolderStructure(
      scannedFile.scanSession.scannedFiles.map((file) => file.relativePath),
    ),
    memoryMatches,
    preferredTerms,
    provisionalWorkingEvidence: provisionalText,
    reviewedObservationText: reviewedText,
    scanSessionId: scannedFile.sessionId,
    scannedFileId: scannedFile.id,
    semanticClusters:
      workingKnowledge?.clusters.filter((cluster) =>
        cluster.memberFileIds.includes(scannedFile.id),
      ) ?? [],
    semanticFiles: workingKnowledge?.files ?? [],
    semanticRelationships:
      workingKnowledge?.relationships.filter(
        (relationship) =>
          relationship.leftFileId === scannedFile.id ||
          relationship.rightFileId === scannedFile.id,
      ) ?? [],
    siblingFiles: scannedFile.scanSession.scannedFiles.map((file) => ({
      audioFingerprint: file.audioMetadata?.audioFingerprint ?? null,
      checksum: file.checksum,
      fileType: file.fileType,
      imageFingerprint: file.imageMetadata?.imageFingerprint ?? null,
      id: file.id,
      localPath: file.localPath,
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      videoFingerprint: file.videoMetadata?.videoFingerprint ?? null,
    })),
    audioMetadata: scannedFile.audioMetadata
      ? {
          audioFingerprint: scannedFile.audioMetadata.audioFingerprint,
          duplicateConfidence: scannedFile.audioMetadata.duplicateConfidence,
          duplicateKind: scannedFile.audioMetadata.duplicateKind,
          duplicateOfScannedFileId:
            scannedFile.audioMetadata.duplicateOfScannedFileId,
          durationSeconds: scannedFile.audioMetadata.durationSeconds,
          humanLabels: jsonAudioHumanLabels(
            scannedFile.audioMetadata.humanLabels,
          ),
          machineLabels: jsonStringArray(scannedFile.audioMetadata.machineLabels),
          privacyState: scannedFile.audioMetadata.privacyState,
          provisionalTopics: jsonStringArray(
            scannedFile.audioMetadata.provisionalTopics,
          ),
          summary: scannedFile.audioMetadata.summary,
        }
      : null,
    imageMetadata: scannedFile.imageMetadata
      ? {
          duplicateConfidence: scannedFile.imageMetadata.duplicateConfidence,
          duplicateKind: scannedFile.imageMetadata.duplicateKind,
          duplicateOfScannedFileId:
            scannedFile.imageMetadata.duplicateOfScannedFileId,
          humanLabels: jsonImageHumanLabels(
            scannedFile.imageMetadata.humanLabels,
          ),
          height: scannedFile.imageMetadata.height,
          imageFingerprint: scannedFile.imageMetadata.imageFingerprint,
          machineLabels: jsonStringArray(scannedFile.imageMetadata.machineLabels),
          privacyState: scannedFile.imageMetadata.privacyState,
          provisionalTopics: jsonStringArray(
            scannedFile.imageMetadata.provisionalTopics,
          ),
          relatedSignals: jsonStringArray(
            scannedFile.imageMetadata.relatedSignals,
          ),
          summary: scannedFile.imageMetadata.summary,
          width: scannedFile.imageMetadata.width,
        }
      : null,
    videoMetadata: scannedFile.videoMetadata
      ? {
          duplicateConfidence: scannedFile.videoMetadata.duplicateConfidence,
          duplicateKind: scannedFile.videoMetadata.duplicateKind,
          duplicateOfScannedFileId:
            scannedFile.videoMetadata.duplicateOfScannedFileId,
          durationSeconds: scannedFile.videoMetadata.durationSeconds,
          height: scannedFile.videoMetadata.height,
          humanLabels: jsonVideoHumanLabels(
            scannedFile.videoMetadata.humanLabels,
          ),
          machineLabels: jsonStringArray(scannedFile.videoMetadata.machineLabels),
          privacyState: scannedFile.videoMetadata.privacyState,
          provisionalTopics: jsonStringArray(
            scannedFile.videoMetadata.provisionalTopics,
          ),
          summary: scannedFile.videoMetadata.summary,
          videoFingerprint: scannedFile.videoMetadata.videoFingerprint,
          width: scannedFile.videoMetadata.width,
        }
      : null,
  } satisfies SuggestionContext;
}

async function storedSuggestionById(id: string) {
  const prisma = getPrismaClient();

  return prisma.organizationSuggestion.findUnique({
    include: {
      revisions: {
        orderBy: {
          createdAt: "desc",
        },
      },
    },
    where: {
      id,
    },
  });
}

function newRecommendationGenerationId(context: SuggestionContext) {
  return `org-rec-${context.scanSessionId}-${context.scannedFileId}-${randomUUID()}`;
}

async function persistDrafts(
  context: SuggestionContext,
  drafts: SuggestionDraft[],
  options: { replaceChecksumBootstrap?: boolean } = {},
) {
  const prisma = getPrismaClient();
  const suggestions: BridgeOrganizationSuggestionSummary[] = [];
  const cleanedDrafts: SuggestionDraft[] = [];
  const seenDraftSignatures = new Set<string>();
  const reconciledDrafts = reconcileRecommendationDrafts(
    context.currentRelativePath,
    drafts.map(cleanDraftPaths),
  );
  const safeReconciledDrafts = reconciledDrafts.flatMap((draft) => {
    if (draft.suggestionType !== "POSSIBLE_DUPLICATE") {
      return [draft];
    }

    const duplicateEvidence = draft.duplicateEvidence.filter(
      (match) =>
        !samePhysicalFilePresentation(
          {
            connectedLibraryName: context.connectedLibraryName,
            relativePath: context.currentRelativePath,
          },
          match,
        ),
    );

    return duplicateEvidence.length > 0
      ? [
          {
            ...draft,
            duplicateEvidence,
            supportingInformation: draft.supportingInformation.filter(
              (detail) =>
                !draft.duplicateEvidence.some(
                  (match) =>
                    !duplicateEvidence.includes(match) &&
                    detail ===
                      `Specific file to compare: ${match.connectedLibraryName} -> ${match.relativePath}`,
                ),
            ),
          },
        ]
      : [];
  });
  const draftsToPersist =
    safeReconciledDrafts.length > 0
      ? safeReconciledDrafts
      : [cleanDraftPaths(fallbackRecommendationDraft(context))];

  for (const draft of draftsToPersist) {
    const signature = draftContentSignatureFor(context, draft);

    if (seenDraftSignatures.has(signature)) {
      continue;
    }

    seenDraftSignatures.add(signature);
    cleanedDrafts.push(draft);
  }

  const recommendationGenerationId = newRecommendationGenerationId(context);
  let createdCount = 0;
  let existingCount = 0;
  let createdGenerationId: string | null = null;

  await prisma.$transaction(
    async (transaction) => {
      const activeSuggestions = await transaction.organizationSuggestion.findMany({
        include: {
          revisions: {
            orderBy: {
              createdAt: "desc",
            },
          },
        },
        where: {
          invalidatedAt: null,
          scannedFileId: context.scannedFileId,
        },
      });
      const activeCurrentSuggestions = activeSuggestions.filter(
        (suggestion) =>
          isCurrentRecommendationGeneration(
            suggestion.recommendationGenerationVersion,
          ),
      );
      const hasOnlyCurrentSuggestions =
        activeSuggestions.length === activeCurrentSuggestions.length;
      const hasOnlyCurrentPendingSuggestions =
        hasOnlyCurrentSuggestions &&
        activeCurrentSuggestions.length > 0 &&
        activeCurrentSuggestions.every(
          (suggestion) =>
            normalizeSuggestionStatus(suggestion.status) === "PENDING",
        );
      const hasOnlyChecksumBootstrapSuggestions =
        activeCurrentSuggestions.length > 0 &&
        activeCurrentSuggestions.every((suggestion) =>
          suggestion.recommendationGenerationId.startsWith("checksum-duplicates-"),
        );

      if (
        hasOnlyCurrentPendingSuggestions &&
        !(options.replaceChecksumBootstrap && hasOnlyChecksumBootstrapSuggestions)
      ) {
        existingCount = activeCurrentSuggestions.length;
        suggestions.push(
          ...activeCurrentSuggestions
            .sort((left, right) => left.title.localeCompare(right.title))
            .map(summarizeOrganizationSuggestion),
        );
        return;
      }

      await transaction.organizationSuggestion.updateMany({
        data: {
          invalidatedAt: new Date(),
          invalidatedReason:
            "This recommendation was replaced by a newer recommendation generation for the same scanned file.",
        },
        where: {
          invalidatedAt: null,
          scannedFileId: context.scannedFileId,
        },
      });

      if (cleanedDrafts.length > 0) {
        await transaction.organizationSuggestion.createMany({
          data: cleanedDrafts.map((draft) => {
            const suggestionKey = suggestionKeyFor(
              context,
              draft,
              recommendationGenerationId,
            );

            return {
              confidence: draft.confidence,
              currentRelativePath: context.currentRelativePath,
              explanation: draft.explanation,
              proposedFileName: draft.proposedFileName,
              proposedRelativePath: draft.proposedRelativePath,
              recommendationGenerationId,
              recommendationGenerationVersion: currentRecommendationGenerationVersion,
              scanSessionId: context.scanSessionId,
              scannedFileId: context.scannedFileId,
              status: "PENDING",
              suggestionKey,
              suggestionType: draft.suggestionType,
              supportingInformation: toJsonInput(
                recommendationSupportForStorage(draft),
              ),
              title: draft.title,
              whySuggested: toJsonInput(draft.whySuggested),
            };
          }),
        });

        createdCount = cleanedDrafts.length;
        createdGenerationId = recommendationGenerationId;
      }
    },
    {
      timeout: 15_000,
    },
  );

  if (createdGenerationId) {
    const createdSuggestions = await prisma.organizationSuggestion.findMany({
      include: {
        revisions: {
          orderBy: {
            createdAt: "desc",
          },
        },
      },
      orderBy: {
        title: "asc",
      },
      where: {
        recommendationGenerationId: createdGenerationId,
      },
    });

    suggestions.push(...createdSuggestions.map(summarizeOrganizationSuggestion));
  }

  return {
    createdCount,
    existingCount,
    suggestions,
  };
}

export async function generateOrganizationSuggestionsForScannedFile(
  scannedFileId: string,
) {
  const readResult = await readScannedFile(scannedFileId);

  return generateOrganizationSuggestionsForScannedFileWithText(
    scannedFileId,
    readResult.preview.extractedText,
  );
}

export async function generateOrganizationSuggestionsForScannedFileWithText(
  scannedFileId: string,
  contentText: string,
  options: {
    replaceChecksumBootstrap?: boolean;
    workingKnowledge?: ScanWorkingKnowledgeIndex;
  } = {},
) {
  const prisma = getPrismaClient();

  try {
    await requireScannedFilePermission(
      scannedFileId,
      "recommendationPermission",
      "prepare organization recommendations",
    );
  } catch (error) {
    if (error instanceof ConnectedLibraryError) {
      throw new OrganizationSuggestionError(error.message, error.statusCode);
    }

    throw error;
  }

  const initialFile = await prisma.scannedFile.findUnique({
    select: {
      extractionStatus: true,
      readingStatus: true,
    },
    where: {
      id: scannedFileId,
    },
  });

  if (!initialFile) {
    throw new OrganizationSuggestionError(
      "The Librarian could not find that scanned file.",
      404,
    );
  }

  if (
    initialFile.readingStatus !== "READ" ||
    initialFile.extractionStatus !== "COMPLETED"
  ) {
    throw new OrganizationSuggestionError(
      "Read this file before asking for organization recommendations.",
      409,
    );
  }

  const context = await scannedFileContext(
    scannedFileId,
    contentText,
    options.workingKnowledge,
  );
  const drafts = buildDrafts(context);
  const result = await persistDrafts(context, drafts, {
    replaceChecksumBootstrap: options.replaceChecksumBootstrap,
  });

  await prisma.scannedFile.update({
    data: {
      processedAt: new Date(),
      processingErrorCategory: null,
      processingStage: isImageFileType(context.fileType)
        ? "RECOMMENDATIONS_READY"
        : "SUGGESTIONS_GENERATED",
    },
    where: {
      id: scannedFileId,
    },
  });

  return {
    ...result,
    file: await refreshedScannedFileSummary(scannedFileId),
  };
}

export async function getOrganizationSuggestionsForScanSession(
  sessionId: string,
): Promise<BridgeOrganizationSuggestionReviewPageData | null> {
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findUnique({
    include: {
      connectedFolder: {
        select: {
          displayName: true,
        },
      },
      organizationSuggestions: {
        include: {
          revisions: {
            orderBy: {
              createdAt: "desc",
            },
          },
        },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      },
    },
    where: {
      id: sessionId,
    },
  });

  if (!session) {
    return null;
  }

  const activeSuggestions = session.organizationSuggestions.filter(
    (suggestion) => suggestion.invalidatedAt === null,
  );
  const currentSuggestions = activeSuggestions.filter(
    (suggestion) =>
      isCurrentRecommendationGeneration(
        suggestion.recommendationGenerationVersion,
      ),
  );
  const historicalSuggestions = session.organizationSuggestions.filter(
    (suggestion) => suggestion.invalidatedAt !== null,
  );
  const historyByGeneration = new Map<
    string,
    {
      approved: number;
      createdAt: Date;
      generationId: string;
      generationVersion: string;
      invalidatedAt: Date;
      leftUnchanged: number;
      modified: number;
      pending: number;
      rejected: number;
      total: number;
    }
  >();

  for (const suggestion of historicalSuggestions) {
    const existing = historyByGeneration.get(
      suggestion.recommendationGenerationId,
    ) ?? {
      approved: 0,
      createdAt: suggestion.createdAt,
      generationId: suggestion.recommendationGenerationId,
      generationVersion: suggestion.recommendationGenerationVersion,
      invalidatedAt: suggestion.invalidatedAt as Date,
      leftUnchanged: 0,
      modified: 0,
      pending: 0,
      rejected: 0,
      total: 0,
    };
    const status = normalizeSuggestionStatus(suggestion.status);

    existing.createdAt =
      suggestion.createdAt < existing.createdAt
        ? suggestion.createdAt
        : existing.createdAt;
    existing.invalidatedAt =
      suggestion.invalidatedAt && suggestion.invalidatedAt > existing.invalidatedAt
        ? suggestion.invalidatedAt
        : existing.invalidatedAt;
    existing.total += 1;

    if (status === "APPROVED") {
      existing.approved += 1;
    } else if (status === "MODIFIED") {
      existing.modified += 1;
    } else if (status === "REJECTED") {
      existing.rejected += 1;
    } else if (status === "LEFT_UNCHANGED") {
      existing.leftUnchanged += 1;
    } else {
      existing.pending += 1;
    }

    historyByGeneration.set(suggestion.recommendationGenerationId, existing);
  }

  return {
    regeneration: {
      activeRecommendationCount: activeSuggestions.length,
      currentGenerationCount: currentSuggestions.length,
      currentGenerationVersion: currentRecommendationGenerationVersion,
      earlierGenerationCount:
        activeSuggestions.length - currentSuggestions.length,
      historicalRecommendationCount: historicalSuggestions.length,
      historicalReviewedCount: historicalSuggestions.filter(
        (suggestion) => normalizeSuggestionStatus(suggestion.status) !== "PENDING",
      ).length,
      history: [...historyByGeneration.values()]
        .sort(
          (left, right) =>
            right.invalidatedAt.getTime() - left.invalidatedAt.getTime(),
        )
        .map((generation) => ({
          ...generation,
          createdAt: generation.createdAt.toISOString(),
          invalidatedAt: generation.invalidatedAt.toISOString(),
        })),
      reviewedRecommendationCount: activeSuggestions.filter(
        (suggestion) => normalizeSuggestionStatus(suggestion.status) !== "PENDING",
      ).length,
    },
    session: {
      completedAt: session.completedAt?.toISOString() ?? null,
      connectedLibraryId: session.connectedFolderId,
      failedFiles: session.failedFiles,
      folderDisplayName: session.connectedFolder.displayName,
      id: session.id,
      startedAt: session.startedAt.toISOString(),
      status:
        session.status === "PENDING" ||
        session.status === "SCANNING" ||
        session.status === "READING" ||
        session.status === "EXAMINING" ||
        session.status === "GENERATING_SUGGESTIONS" ||
        session.status === "COMPLETED" ||
        session.status === "COMPLETED_WITH_ERRORS" ||
        session.status === "FAILED"
          ? session.status
          : "FAILED",
      supportedFiles: session.supportedFiles,
      totalFiles: session.filesScanned,
      unsupportedFiles: session.unsupportedFiles,
    },
    suggestions: currentSuggestions.map(summarizeOrganizationSuggestion),
  };
}

export async function prepareOrganizationRecommendationRegeneration(
  scanSessionId: string,
  options: { confirmedReviewedDecisions?: boolean } = {},
) {
  const prisma = getPrismaClient();
  const normalizedScanSessionId = scanSessionId.trim();

  if (!normalizedScanSessionId) {
    throw new OrganizationSuggestionError(
      "The Librarian could not match these recommendations to a scan session.",
      400,
    );
  }

  const session = await prisma.scanSession.findUnique({
    select: {
      id: true,
      organizationSuggestions: {
        select: {
          id: true,
          status: true,
        },
        where: {
          invalidatedAt: null,
        },
      },
    },
    where: {
      id: normalizedScanSessionId,
    },
  });

  if (!session) {
    throw new OrganizationSuggestionError(
      "The Librarian could not find that scan session.",
      404,
    );
  }

  const reviewedRecommendationCount = session.organizationSuggestions.filter(
    (suggestion) => normalizeSuggestionStatus(suggestion.status) !== "PENDING",
  ).length;

  if (reviewedRecommendationCount > 0 && !options.confirmedReviewedDecisions) {
    throw new OrganizationSuggestionError(
      "This scan has reviewed recommendations. Confirm regeneration to keep those decisions in history and prepare a new set for review.",
      409,
    );
  }

  const invalidatedAt = new Date();
  const superseded = await prisma.organizationSuggestion.updateMany({
    data: {
      invalidatedAt,
      invalidatedReason:
        reviewedRecommendationCount > 0
          ? "This recommendation was retained in history after Deanne confirmed a new recommendation pass."
          : "This pending recommendation was superseded by a new recommendation pass.",
    },
    where: {
      id: {
        in: session.organizationSuggestions.map((suggestion) => suggestion.id),
      },
      invalidatedAt: null,
      scanSessionId: normalizedScanSessionId,
    },
  });

  return {
    reviewedRecommendationCount,
    supersededRecommendationCount: superseded.count,
  };
}

export async function getOrganizationSuggestionsForConnectedLibraries(take = 160) {
  const prisma = getPrismaClient();
  const suggestions = await prisma.organizationSuggestion.findMany({
    include: {
      revisions: {
        orderBy: {
          createdAt: "desc",
        },
      },
      scanSession: {
        select: {
          connectedFolder: {
            select: {
              displayName: true,
              id: true,
            },
          },
        },
      },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take,
    where: {
      invalidatedAt: null,
      recommendationGenerationVersion: currentRecommendationGenerationVersion,
    },
  });
  const librariesById = new Map<string, string>();
  const libraryIdBySuggestionId: Record<string, string> = {};
  const libraryNameBySuggestionId: Record<string, string> = {};

  for (const suggestion of suggestions) {
    const library = suggestion.scanSession.connectedFolder;

    librariesById.set(library.id, library.displayName);
    libraryIdBySuggestionId[suggestion.id] = library.id;
    libraryNameBySuggestionId[suggestion.id] = library.displayName;
  }

  return {
    libraries: [...librariesById.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    libraryIdBySuggestionId,
    libraryNameBySuggestionId,
    suggestions: suggestions.map(summarizeOrganizationSuggestion),
  };
}

export type ReviewOrganizationSuggestionInput = {
  action: "APPROVE" | "MODIFY" | "REJECT" | "LEAVE_UNCHANGED";
  scanSessionId: string;
  destinationFolder?: string;
  fileName?: string;
  context?: string;
};

function statusForAction(
  action: ReviewOrganizationSuggestionInput["action"],
): OrganizationSuggestionStatus {
  if (action === "APPROVE") {
    return "APPROVED";
  }

  if (action === "MODIFY") {
    return "MODIFIED";
  }

  if (action === "REJECT") {
    return "REJECTED";
  }

  return "LEFT_UNCHANGED";
}

function revisionPathFor(
  suggestion: StoredSuggestion,
  input: ReviewOrganizationSuggestionInput,
) {
  const currentFolder = folderFromRelativePath(
    suggestion.proposedRelativePath ?? suggestion.currentRelativePath,
  );
  const currentFileName =
    suggestion.proposedFileName ??
    fileNameFromRelativePath(suggestion.proposedRelativePath ?? suggestion.currentRelativePath);
  const destinationFolder =
    input.destinationFolder === undefined
      ? currentFolder
      : normalizeBridgeRelativePath(input.destinationFolder, true);
  const fileName =
    input.fileName === undefined
      ? currentFileName
      : normalizeBridgeFileName(input.fileName);

  if (
    destinationFolder === currentFolder &&
    normalizeText(fileName) === normalizeText(currentFileName) &&
    !input.context?.trim()
  ) {
    throw new OrganizationSuggestionError(
      "Change the destination, filename, or context before saving an edited suggestion.",
      400,
    );
  }

  return {
    revisedFileName: fileName,
    revisedRelativePath: joinRelativePath(destinationFolder, fileName),
  };
}

function revisionMatches(
  revision: StoredSuggestion["revisions"][number] | undefined,
  nextRevision: {
    revisedFileName: string;
    revisedRelativePath: string;
  },
  context: string | null,
) {
  if (!revision) {
    return false;
  }

  return (
    revision.revisedFileName === nextRevision.revisedFileName &&
    revision.revisedRelativePath === nextRevision.revisedRelativePath &&
    (revision.context ?? null) === context
  );
}

function assertPendingReviewStatus(status: OrganizationSuggestionStatus) {
  if (status === "PENDING") {
    return;
  }

  throw new OrganizationSuggestionError(
    "This recommendation has already been reviewed. Refresh the page to see its current status.",
    409,
  );
}

export async function reviewOrganizationSuggestion(
  suggestionId: string,
  input: ReviewOrganizationSuggestionInput,
) {
  const prisma = getPrismaClient();

  if (
    input.action !== "APPROVE" &&
    input.action !== "MODIFY" &&
    input.action !== "REJECT" &&
    input.action !== "LEAVE_UNCHANGED"
  ) {
    throw new OrganizationSuggestionError("Choose a review action first.", 400);
  }

  const scanSessionId = input.scanSessionId.trim();

  if (!scanSessionId) {
    throw new OrganizationSuggestionError(
      "The Librarian could not match this recommendation to a scan session.",
      400,
    );
  }

  const existing = await storedSuggestionById(suggestionId);

  if (!existing) {
    throw new OrganizationSuggestionError(
      "The Librarian could not find that organization suggestion.",
      404,
    );
  }

  if (existing.scanSessionId !== scanSessionId) {
    throw new OrganizationSuggestionError(
      "The Librarian could not find that recommendation in this scan session.",
      404,
    );
  }

  if (existing.invalidatedAt) {
    throw new OrganizationSuggestionError(
      "This recommendation has been replaced by newer review information. Regenerate recommendations before reviewing it.",
      409,
    );
  }

  if (
    !isCurrentRecommendationGeneration(existing.recommendationGenerationVersion)
  ) {
    throw new OrganizationSuggestionError(
      "This recommendation came from an older recommendation pass. Regenerate recommendations before reviewing it.",
      409,
    );
  }

  if (
    existing.suggestionType === "INSUFFICIENT_EVIDENCE" &&
    input.action !== "LEAVE_UNCHANGED"
  ) {
    throw new OrganizationSuggestionError(
      "This item needs more evidence before it can be treated as an organization action. You can leave it unresolved for now.",
      422,
    );
  }

  const nextStatus = statusForAction(input.action);
  const currentStatus = normalizeSuggestionStatus(existing.status);
  const context = input.context?.trim() || null;

  if (input.action !== "MODIFY" && currentStatus === nextStatus) {
    return summarizeOrganizationSuggestion(existing);
  }

  if (input.action === "MODIFY") {
    const revision = revisionPathFor(existing, input);

    if (currentStatus === "MODIFIED") {
      if (revisionMatches(existing.revisions[0], revision, context)) {
        return summarizeOrganizationSuggestion(existing);
      }

      assertPendingReviewStatus(currentStatus);
    }

    assertPendingReviewStatus(currentStatus);

    await prisma.$transaction(async (transaction) => {
      const updated = await transaction.organizationSuggestion.updateMany({
        data: {
          reviewedAt: new Date(),
          status: nextStatus,
        },
        where: {
          id: suggestionId,
          scanSessionId,
          status: "PENDING",
        },
      });

      if (updated.count !== 1) {
        throw new OrganizationSuggestionError(
          "This recommendation was updated by another review. Refresh the page and try again.",
          409,
        );
      }

      await transaction.organizationSuggestionRevision.create({
        data: {
          context,
          revisedFileName: revision.revisedFileName,
          revisedRelativePath: revision.revisedRelativePath,
          suggestionId,
        },
      });
    });
  } else {
    assertPendingReviewStatus(currentStatus);

    const updated = await prisma.organizationSuggestion.updateMany({
      data: {
        reviewedAt: new Date(),
        status: nextStatus,
      },
      where: {
        id: suggestionId,
        scanSessionId,
        status: "PENDING",
      },
    });

    if (updated.count !== 1) {
      throw new OrganizationSuggestionError(
        "This recommendation was updated by another review. Refresh the page and try again.",
        409,
      );
    }
  }

  const updated = await storedSuggestionById(suggestionId);

  if (!updated) {
    throw new OrganizationSuggestionError(
      "The Librarian could not reload that organization suggestion.",
      404,
    );
  }

  return summarizeOrganizationSuggestion(updated);
}

export async function resetOrganizationSuggestionDecision(
  suggestionId: string,
  scanSessionId: string,
) {
  const prisma = getPrismaClient();
  const normalizedScanSessionId = scanSessionId.trim();

  if (!normalizedScanSessionId) {
    throw new OrganizationSuggestionError(
      "The Librarian could not match this recommendation to a scan session.",
      400,
    );
  }

  const existing = await storedSuggestionById(suggestionId);

  if (!existing) {
    throw new OrganizationSuggestionError(
      "The Librarian could not find that organization suggestion.",
      404,
    );
  }

  if (existing.scanSessionId !== normalizedScanSessionId) {
    throw new OrganizationSuggestionError(
      "The Librarian could not find that recommendation in this scan session.",
      404,
    );
  }

  if (normalizeSuggestionStatus(existing.status) !== "PENDING") {
    await prisma.$transaction([
      prisma.organizationSuggestion.update({
        data: {
          reviewedAt: null,
          status: "PENDING",
        },
        where: {
          id: suggestionId,
        },
      }),
      prisma.organizationPlan.updateMany({
        data: {
          status: "CANCELLED",
        },
        where: {
          scanSessionId: normalizedScanSessionId,
          status: {
            in: ["DRAFT", "READY_FOR_EXECUTION"],
          },
        },
      }),
    ]);
  }

  await recordChecksumDuplicateSuggestionsForSession(normalizedScanSessionId);

  const updated = await storedSuggestionById(suggestionId);

  if (!updated) {
    throw new OrganizationSuggestionError(
      "The Librarian could not reload that organization suggestion.",
      404,
    );
  }

  return summarizeOrganizationSuggestion(updated);
}

export async function resetOrganizationSuggestionDecisionsForScanSession(
  scanSessionId: string,
) {
  const prisma = getPrismaClient();
  const normalizedScanSessionId = scanSessionId.trim();

  if (!normalizedScanSessionId) {
    throw new OrganizationSuggestionError(
      "The Librarian could not match these recommendations to a scan session.",
      400,
    );
  }

  const session = await prisma.scanSession.findUnique({
    select: {
      id: true,
    },
    where: {
      id: normalizedScanSessionId,
    },
  });

  if (!session) {
    throw new OrganizationSuggestionError(
      "The Librarian could not find that scan session.",
      404,
    );
  }

  const [cancelledPlans, result] = await prisma.$transaction([
    prisma.organizationPlan.updateMany({
      data: {
        status: "CANCELLED",
      },
      where: {
        scanSessionId: normalizedScanSessionId,
        status: {
          in: ["DRAFT", "READY_FOR_EXECUTION"],
        },
      },
    }),
    prisma.organizationSuggestion.updateMany({
      data: {
        reviewedAt: null,
        status: "PENDING",
      },
      where: {
        scanSessionId: normalizedScanSessionId,
        status: {
          not: "PENDING",
        },
      },
    }),
  ]);

  await recordChecksumDuplicateSuggestionsForSession(normalizedScanSessionId);

  return {
    cancelledPlanCount: cancelledPlans.count,
    resetCount: result.count,
    suggestions:
      (await getOrganizationSuggestionsForScanSession(normalizedScanSessionId))
        ?.suggestions ?? [],
  };
}
