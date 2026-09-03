import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";

import {
  ConnectedLibraryError,
  requireScannedFilePermission,
} from "./connected-libraries";
import { isAudioFileType, jsonAudioHumanLabels, jsonStringArray } from "./audio-metadata";
import { recordChecksumDuplicateSuggestionsForSession } from "./checksum-duplicates";
import { jsonImageHumanLabels } from "./image-metadata";
import { readScannedFile } from "./reader";
import {
  currentRecommendationGenerationVersion,
  isCurrentRecommendationGeneration,
} from "./recommendation-generation";
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

type SuggestionDraft = {
  suggestionType: OrganizationSuggestionType;
  proposedRelativePath?: string | null;
  proposedFileName?: string | null;
  title: string;
  explanation: string;
  confidence: number;
  whySuggested: string[];
  supportingInformation: string[];
};

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
  siblingFiles: Array<{
    id: string;
    relativePath: string;
    fileType: string;
    checksum: string | null;
    audioFingerprint?: string | null;
    imageFingerprint?: string | null;
    videoFingerprint?: string | null;
    sizeBytes?: bigint | null;
  }>;
  reviewedObservationText: string[];
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
    machineLabels: string[];
    privacyState: string;
    provisionalTopics: string[];
    relatedSignals: string[];
    summary: string | null;
  } | null;
  videoMetadata: {
    duplicateConfidence: number | null;
    duplicateKind: string | null;
    duplicateOfScannedFileId: string | null;
    durationSeconds: number | null;
    humanLabels: string[];
    machineLabels: string[];
    privacyState: string;
    provisionalTopics: string[];
    summary: string | null;
    videoFingerprint: string | null;
  } | null;
};

type MemoryMatch = {
  title: string;
  memoryType: string;
  overlap: string[];
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
  "deanne",
  "document",
  "documents",
  "file",
  "files",
  "final",
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
  "with",
  "without",
  "workshop",
  "would",
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

function confidence(value: number) {
  return Math.round(Math.min(Math.max(value, 0.25), 0.95) * 100) / 100;
}

function titleCaseTerm(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
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

function bestExistingFolder(rule: TopicRule, folders: string[]) {
  const ruleTokens = new Set(tokenize(rule.folder));

  return folders.find((folder) => {
    const folderTokens = new Set(tokenize(folder));

    return [...ruleTokens].some((token) => folderTokens.has(token));
  });
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

function scoreRule(rule: TopicRule, terms: Set<string>, memoryMatches: MemoryMatch[]) {
  const directMatches = rule.terms.filter((term) => terms.has(term));
  const memoryScore = memoryMatches.filter((memory) =>
    memory.overlap.some((term) => rule.terms.includes(term)),
  ).length;

  return {
    directMatches,
    memoryScore,
    score: directMatches.length + memoryScore,
  };
}

function bestRuleFor(context: SuggestionContext) {
  const analysisTerms = new Set(
    tokenize(
      [
        context.contentText.slice(0, maxAnalysisCharacters),
        context.currentRelativePath,
        context.reviewedObservationText.join(" "),
        context.preferredTerms.join(" "),
      ].join(" "),
    ),
  );

  return topicRules
    .map((rule) => ({
      rule,
      ...scoreRule(rule, analysisTerms, context.memoryMatches),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.rule.folder.localeCompare(right.rule.folder);
    })[0];
}

function memorySupport(context: SuggestionContext) {
  return context.memoryMatches.map(
    (memory) =>
      `Approved Memory used: ${memory.title} (${memory.overlap.join(", ")})`,
  );
}

function reviewedObservationSupport(context: SuggestionContext) {
  if (context.reviewedObservationText.length === 0) {
    return [
      "No approved or modified observation was used as trusted evidence for this suggestion.",
    ];
  }

  return [
    "Reviewed observation used: Deanne has already reviewed an observation for this item.",
  ];
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
  draft: Omit<SuggestionDraft, "supportingInformation"> & {
    supportingInformation?: string[];
  },
): SuggestionDraft {
  return {
    ...draft,
    confidence: confidence(draft.confidence),
    supportingInformation: [
      ...pathSupport(context),
      ...memorySupport(context),
      ...reviewedObservationSupport(context),
      ...(draft.supportingInformation ?? []),
    ].slice(0, 12),
  };
}

function possibleDuplicateDraft(context: SuggestionContext) {
  if (context.audioMetadata?.duplicateKind) {
    return makeDraft(context, {
      confidence: context.audioMetadata.duplicateConfidence ?? 0.68,
      explanation:
        "The Librarian noticed this recording may match another audio file. This is only a review prompt; nothing should be deleted automatically.",
      suggestionType: "POSSIBLE_DUPLICATE",
      title: "Review as a possible duplicate recording",
      whySuggested: [
        `Audio duplicate signal: ${context.audioMetadata.duplicateKind.replaceAll("_", " ").toLowerCase()}.`,
        "The Bridge never deletes recordings from a duplicate suggestion.",
      ],
      supportingInformation: context.audioMetadata.duplicateOfScannedFileId
        ? ["A related recording had similar audio metadata or checksum."]
        : [],
    });
  }

  if (context.videoMetadata?.duplicateKind) {
    return makeDraft(context, {
      confidence: context.videoMetadata.duplicateConfidence ?? 0.68,
      explanation:
        "The Librarian noticed this video may match another recording. This is only a review prompt; nothing should be deleted automatically.",
      suggestionType: "POSSIBLE_DUPLICATE",
      title: "Review as a possible duplicate video",
      whySuggested: [
        `Video duplicate signal: ${context.videoMetadata.duplicateKind.replaceAll("_", " ").toLowerCase()}.`,
        "The Bridge never deletes recordings from a duplicate suggestion.",
      ],
      supportingInformation: context.videoMetadata.duplicateOfScannedFileId
        ? ["A related video had similar metadata, duration, checksum, or frame signals."]
        : [],
    });
  }

  if (context.imageMetadata?.duplicateKind) {
    return makeDraft(context, {
      confidence: context.imageMetadata.duplicateConfidence ?? 0.68,
      explanation:
        "The Librarian noticed this image may match another image file. This is only a review prompt; nothing should be deleted automatically.",
      suggestionType: "POSSIBLE_DUPLICATE",
      title: "Review as a possible duplicate image",
      whySuggested: [
        `Image duplicate signal: ${context.imageMetadata.duplicateKind.replaceAll("_", " ").toLowerCase()}.`,
        "The Bridge never deletes images from a duplicate suggestion.",
      ],
      supportingInformation: context.imageMetadata.duplicateOfScannedFileId
        ? ["A related image had similar metadata, checksum, or visual size signals."]
        : [],
    });
  }

  if (!context.checksum) {
    return null;
  }

  const duplicates = context.siblingFiles
    .filter(
      (file) =>
        file.id !== context.scannedFileId &&
        file.checksum === context.checksum &&
        file.sizeBytes !== BigInt(0) &&
        normalizeBridgeRelativePath(file.relativePath) !== context.currentRelativePath,
    )
    .slice(0, 4);

  if (duplicates.length === 0) {
    return null;
  }

  return makeDraft(context, {
    confidence: 0.92,
    explanation:
      "The Librarian found another scanned file with the same checksum. That makes this a possible duplicate to review, not a deletion instruction.",
    suggestionType: "POSSIBLE_DUPLICATE",
    title: "Review as a possible duplicate",
    whySuggested: [
      "A matching checksum appeared in the same scan session.",
      "The Bridge remains read-only; this does not delete either file.",
    ],
    supportingInformation: duplicates.map(
      (file) => `Similar file: ${file.relativePath}`,
    ),
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
        file.id !== context.scannedFileId && isImageFileType(file.fileType),
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
        candidate.overlap.length >= 2 ||
        /\b(duplicate|duplicates|copy|resized|small|thumbnail)\b/.test(pathText),
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

function audioMoveDraft(context: SuggestionContext) {
  if (!context.audioMetadata || !isAudioFileType(context.fileType)) {
    return null;
  }

  const text = audioLabelText(context);
  const target =
    text.includes("workshop")
      ? {
          folder: "Audio/Workshops",
          title: "Consider moving this into the workshop recordings",
          reason:
            "This is an audio recording about a workshop, so it may belong with other workshop recordings.",
        }
      : text.includes("meeting")
        ? {
            folder: "Audio/Meetings",
            title: "Consider moving this into meeting recordings",
            reason: "The recording appears connected to a meeting or agenda.",
          }
        : text.includes("podcast")
          ? {
              folder: "Audio/Podcasts",
              title: "Consider moving this into podcast recordings",
              reason: "The recording appears connected to podcast material.",
            }
          : text.includes("research")
            ? {
                folder: "Audio/Research",
                title: "Consider moving this into audio research",
                reason: "The recording appears connected to research material.",
              }
            : null;

  if (!target) {
    return null;
  }

  const currentFolder = folderFromRelativePath(context.currentRelativePath);

  if (normalizeText(currentFolder) === normalizeText(target.folder)) {
    return null;
  }

  return makeDraft(context, {
    confidence: 0.61,
    explanation: target.reason,
    proposedRelativePath: joinRelativePath(target.folder, context.fileName),
    suggestionType: "MOVE_FILE",
    title: target.title,
    whySuggested: [
      target.reason,
      "Audio labels and transcript snippets are provisional until Deanne reviews them.",
    ],
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

  const text = videoLabelText(context);
  const target =
    text.includes("workshop")
      ? {
          folder: "Video/Workshops",
          reason: "The video appears connected to workshop material.",
          title: "Consider moving this into workshop recordings",
        }
      : text.includes("presentation") || text.includes("slide")
        ? {
            folder: "Video/Presentations",
            reason: "The video appears connected to presentation or slide material.",
            title: "Consider moving this into presentation recordings",
          }
        : text.includes("webinar")
          ? {
              folder: "Video/Webinars",
              reason: "The video appears connected to webinar material.",
              title: "Consider moving this into webinar recordings",
            }
          : text.includes("interview")
            ? {
                folder: "Video/Interviews",
                reason: "The video appears connected to interview material.",
                title: "Consider moving this into interview recordings",
              }
            : null;

  if (!target) {
    return null;
  }

  const currentFolder = folderFromRelativePath(context.currentRelativePath);

  if (normalizeText(currentFolder) === normalizeText(target.folder)) {
    return null;
  }

  return makeDraft(context, {
    confidence: 0.61,
    explanation: target.reason,
    proposedRelativePath: joinRelativePath(target.folder, context.fileName),
    suggestionType: "MOVE_FILE",
    title: target.title,
    whySuggested: [
      target.reason,
      "Video labels, transcript snippets, and frame notes are provisional until Deanne reviews them.",
    ],
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

  if (!best || best.score < 2) {
    return [];
  }

  const existingFolder = bestExistingFolder(best.rule, context.folderStructure);
  const destinationFolder = existingFolder ?? best.rule.folder;
  const currentFolder = folderFromRelativePath(context.currentRelativePath);
  const proposedRelativePath = joinRelativePath(destinationFolder, context.fileName);
  const drafts: SuggestionDraft[] = [];

  if (!existingFolder) {
    drafts.push(
      makeDraft(context, {
        confidence: 0.56 + best.score * 0.04,
        explanation:
          "The Librarian noticed a recurring topic that does not yet have a matching folder in this scan session. This is only a plan for review.",
        proposedRelativePath: normalizeBridgeRelativePath(destinationFolder),
        suggestionType: "CREATE_FOLDER",
        title: `Consider a ${best.rule.folder} folder`,
        whySuggested: [
          best.rule.explanation,
          `Repeated concepts: ${best.directMatches.join(", ") || best.rule.folder}`,
        ],
        supportingInformation: [
          `Existing folders checked: ${
            context.folderStructure.length > 0
              ? context.folderStructure.slice(0, 6).join(", ")
              : "none in this scan session"
          }`,
        ],
      }),
    );
  }

  if (normalizeText(currentFolder) !== normalizeText(destinationFolder)) {
    const matchedConcepts =
      best.directMatches.join(", ") || best.rule.folder.toLowerCase();

    drafts.push(
      makeDraft(context, {
        confidence: 0.58 + best.score * 0.05,
        explanation: `${best.rule.explanation} The file contains the matching terms ${matchedConcepts}, so ${destinationFolder} may be a useful location.`,
        proposedRelativePath,
        suggestionType: "MOVE_FILE",
        title: `Consider placing this with ${best.rule.folder}`,
        whySuggested: [
          best.rule.explanation,
          `Repeated concepts: ${best.directMatches.join(", ") || best.rule.folder}`,
        ],
        supportingInformation: existingFolder
          ? [`Matching folder already exists in this scan: ${existingFolder}`]
          : [`Suggested folder: ${best.rule.folder}`],
      }),
    );
  }

  return drafts;
}

function renameDraft(context: SuggestionContext, topTerms: string[]) {
  if (!fileNameLooksGeneric(context.fileName)) {
    return null;
  }

  const proposedFileName = proposedFileNameFromTerms(
    [...context.preferredTerms, ...topTerms],
    context.fileName,
  );

  if (normalizeText(proposedFileName) === normalizeText(context.fileName)) {
    return null;
  }

  return makeDraft(context, {
    confidence: 0.62,
    explanation:
      "The current file name looks generic. The Librarian can suggest a clearer name, but Deanne decides whether it is right.",
    proposedFileName,
    suggestionType: "RENAME_FILE",
    title: `Consider renaming this file to ${proposedFileName}`,
    whySuggested: [
      "The current file name does not describe the contents clearly.",
      `Readable terms noticed: ${topTerms.slice(0, 4).join(", ")}`,
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
    tokenize(
      [
        context.contentText.slice(0, maxAnalysisCharacters),
        context.reviewedObservationText.join(" "),
      ].join(" "),
    ),
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
  const termSet = new Set(topTerms.slice(0, 6));
  const similarFiles = context.siblingFiles
    .filter((file) => file.id !== context.scannedFileId)
    .map((file) => ({
      file,
      overlap: tokenize(file.relativePath).filter((term) => termSet.has(term)),
    }))
    .filter((entry) => entry.overlap.length > 0)
    .slice(0, 4);

  if (similarFiles.length === 0) {
    return null;
  }

  const groupName = titleCaseTerm(similarFiles[0]?.overlap[0] ?? topTerms[0] ?? "Related");
  const sharedTerms = [
    ...new Set(similarFiles.flatMap((entry) => entry.overlap)),
  ].slice(0, 5);
  const relatedPaths = similarFiles
    .map((entry) => entry.file.relativePath)
    .slice(0, 2);

  return makeDraft(context, {
    confidence: 0.55 + Math.min(similarFiles.length, 3) * 0.05,
    explanation: `This file shares the wording ${sharedTerms.join(", ")} with ${relatedPaths.join(
      " and ",
    )}, so it may be easier to find beside those related files.`,
    proposedRelativePath: joinRelativePath(groupName, context.fileName),
    suggestionType: "GROUP_WITH_FILES",
    title: `Review this with related ${groupName} files`,
    whySuggested: [
      "Other files in this scan session share visible wording or folder patterns.",
      `Shared wording: ${sharedTerms.join(", ")}`,
    ],
    supportingInformation: similarFiles.map(
      (entry) => `Similar file or folder pattern: ${entry.file.relativePath}`,
    ),
  });
}

function keepUnchangedDraft(context: SuggestionContext) {
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

  return makeDraft(context, {
    confidence: 0.5,
    explanation:
      "The Librarian did not find enough reviewed evidence to justify changing this file's location or name right now.",
    suggestionType: "KEEP_UNCHANGED",
    title: "Keep this file unchanged for now",
    whySuggested: [
      "A cautious no-change plan is safer when the organization signal is weak.",
      "Nothing should move without Deanne's approval.",
    ],
  });
}

function buildDrafts(context: SuggestionContext) {
  const topTerms = rankedTerms(
    [
      context.contentText.slice(0, maxAnalysisCharacters),
      context.reviewedObservationText.join(" "),
      context.currentRelativePath,
      context.preferredTerms.join(" "),
    ].join(" "),
    12,
  );
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
    usefulDrafts.push(keepUnchangedDraft(context));
  }

  return usefulDrafts
    .sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }

      return left.title.localeCompare(right.title);
    })
    .slice(0, 6);
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
    : "KEEP_UNCHANGED";
}

function normalizeSuggestionStatus(value: string): OrganizationSuggestionStatus {
  return organizationSuggestionStatuses.has(value as OrganizationSuggestionStatus)
    ? (value as OrganizationSuggestionStatus)
    : "PENDING";
}

export function summarizeOrganizationSuggestion(
  suggestion: StoredSuggestion,
): BridgeOrganizationSuggestionSummary {
  return {
    confidence: suggestion.confidence,
    createdAt: suggestion.createdAt.toISOString(),
    currentRelativePath: suggestion.currentRelativePath,
    explanation: suggestion.explanation,
    id: suggestion.id,
    invalidatedAt: suggestion.invalidatedAt?.toISOString() ?? null,
    invalidatedReason: suggestion.invalidatedReason,
    proposedFileName: suggestion.proposedFileName,
    proposedRelativePath: suggestion.proposedRelativePath,
    recommendationGenerationId: suggestion.recommendationGenerationId,
    recommendationGenerationVersion: suggestion.recommendationGenerationVersion,
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
    supportingInformation: asStringArray(suggestion.supportingInformation),
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

async function scannedFileContext(scannedFileId: string, contentText: string) {
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
          imageFingerprint: true,
          machineLabels: true,
          privacyState: true,
          provisionalTopics: true,
          relatedSignals: true,
          summary: true,
        },
      },
      videoMetadata: {
        select: {
          duplicateConfidence: true,
          duplicateKind: true,
          duplicateOfScannedFileId: true,
          durationSeconds: true,
          humanLabels: true,
          machineLabels: true,
          privacyState: true,
          provisionalTopics: true,
          summary: true,
          videoFingerprint: true,
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
          scannedFiles: {
            select: {
              audioMetadata: {
                select: {
                  audioFingerprint: true,
                },
              },
              imageMetadata: {
                select: {
                  imageFingerprint: true,
                },
              },
              videoMetadata: {
                select: {
                  videoFingerprint: true,
                },
              },
              checksum: true,
              fileType: true,
              id: true,
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
  const analysisText = [
    contentText.slice(0, maxAnalysisCharacters),
    scannedFile.relativePath,
    reviewedText.join(" "),
  ].join(" ");
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

  return {
    checksum: scannedFile.checksum,
    contentText,
    currentRelativePath: normalizeBridgeRelativePath(scannedFile.relativePath),
    fileName: fileNameFromRelativePath(scannedFile.relativePath),
    fileType: scannedFile.fileType,
    folderStructure: collectFolderStructure(
      scannedFile.scanSession.scannedFiles.map((file) => file.relativePath),
    ),
    memoryMatches,
    preferredTerms,
    reviewedObservationText: reviewedText,
    scanSessionId: scannedFile.sessionId,
    scannedFileId: scannedFile.id,
    siblingFiles: scannedFile.scanSession.scannedFiles.map((file) => ({
      audioFingerprint: file.audioMetadata?.audioFingerprint ?? null,
      checksum: file.checksum,
      fileType: file.fileType,
      imageFingerprint: file.imageMetadata?.imageFingerprint ?? null,
      id: file.id,
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
        }
      : null,
    videoMetadata: scannedFile.videoMetadata
      ? {
          duplicateConfidence: scannedFile.videoMetadata.duplicateConfidence,
          duplicateKind: scannedFile.videoMetadata.duplicateKind,
          duplicateOfScannedFileId:
            scannedFile.videoMetadata.duplicateOfScannedFileId,
          durationSeconds: scannedFile.videoMetadata.durationSeconds,
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

async function persistDrafts(context: SuggestionContext, drafts: SuggestionDraft[]) {
  const prisma = getPrismaClient();
  const suggestions: BridgeOrganizationSuggestionSummary[] = [];
  const cleanedDrafts: SuggestionDraft[] = [];
  const seenDraftSignatures = new Set<string>();

  for (const rawDraft of drafts) {
    const draft = cleanDraftPaths(rawDraft);
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

      if (hasOnlyCurrentPendingSuggestions) {
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
          reviewedAt: null,
          status: "PENDING",
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
              supportingInformation: toJsonInput(draft.supportingInformation),
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

  const context = await scannedFileContext(scannedFileId, contentText);
  const drafts = buildDrafts(context);
  const result = await persistDrafts(context, drafts);

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
        where: {
          invalidatedAt: null,
          recommendationGenerationVersion: currentRecommendationGenerationVersion,
        },
      },
    },
    where: {
      id: sessionId,
    },
  });

  if (!session) {
    return null;
  }

  return {
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
    suggestions: session.organizationSuggestions.map(
      summarizeOrganizationSuggestion,
    ),
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
