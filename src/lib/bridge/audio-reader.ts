import path from "node:path";

import type { Prisma } from "@prisma/client";

import {
  OpenAIProviderConfigurationError,
  requestOpenAIAudioTranscription,
} from "@/lib/ai/openai-client";
import { getPrismaClient } from "@/lib/db/prisma";
import { sanitizeReadingWarning } from "@/lib/reading-room/utils";

import { findExactChecksumDuplicateForScannedFile } from "./checksum-duplicates";
import {
  ConnectedLibraryFileResolutionError,
  resolveConnectedLibraryFile,
} from "./connected-library-file-resolver";
import {
  extractAudioMetadata,
  isAudioFileType,
  jsonAudioHumanLabels,
  jsonStringArray,
} from "./audio-metadata";
import { scannedFileSummary, type StoredScannedFile } from "./scan-sessions";
import type {
  AudioHumanLabel,
  AudioPrivacyState,
  AudioTranscriptionStatus,
  BridgeAudioMetadataDraft,
  BridgeReadFileApiSuccess,
  BridgeReadPreview,
  BridgeScannedFileSummary,
} from "./types";

type ScannedAudioFileForRead = Omit<StoredScannedFile, "audioMetadata"> & {
  localPath: string;
  sessionId: string;
  libraryDocumentId: string | null;
  audioMetadata?: {
    humanLabels: Prisma.JsonValue;
    privacyState: string;
  } | null;
  scanSession: {
    connectedFolder: {
      displayName: string;
      localPath: string;
    };
  };
};

type AudioTranscriptionResult = {
  text: string;
  status: AudioTranscriptionStatus;
  confidence: number | null;
  errorCategory: string | null;
  warnings: string[];
};

type AudioAnalysis = {
  machineLabels: string[];
  provisionalTopics: string[];
  provisionalPeople: string[];
  provisionalProjects: string[];
  provisionalActionItems: string[];
  provisionalQuestions: string[];
  summary: string;
};

type AudioDuplicateResult = {
  duplicateKind: string | null;
  duplicateOfScannedFileId: string | null;
  duplicateConfidence: number | null;
};

export class BridgeAudioReaderError extends Error {
  statusCode: number;
  category: string;

  constructor(message: string, statusCode = 400, category = "AUDIO_READ_FAILED") {
    super(message);
    this.name = "BridgeAudioReaderError";
    this.statusCode = statusCode;
    this.category = category;
  }
}

const previewCharacterLimit = 1_200;
const transientTranscriptCharacterLimit = 80_000;
const audioStopWords = new Set([
  "about",
  "after",
  "again",
  "audio",
  "because",
  "before",
  "bridge",
  "could",
  "deanne",
  "recording",
  "recordings",
  "should",
  "that",
  "their",
  "there",
  "these",
  "thing",
  "things",
  "this",
  "those",
  "through",
  "voice",
  "with",
  "would",
]);

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function safeAudioFailureMessage() {
  return "The Librarian could not inspect this audio file safely.";
}

async function resolveScannedAudioPath(scannedFile: ScannedAudioFileForRead) {
  try {
    const resolvedFile = await resolveConnectedLibraryFile({
      itemLabel: "audio file",
      scannedFileId: scannedFile.id,
    });

    return {
      filePath: resolvedFile.filePath,
      fileStats: resolvedFile.fileStats,
    };
  } catch (error) {
    if (error instanceof ConnectedLibraryFileResolutionError) {
      throw new BridgeAudioReaderError(
        error.message,
        error.statusCode,
        error.category,
      );
    }

    throw error;
  }
}

function previewFromText(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, previewCharacterLimit);
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function fileNameFromRelativePath(relativePath: string) {
  return path.basename(relativePath.split(path.posix.sep).join(path.sep));
}

function formatDuration(seconds: number | null) {
  if (seconds === null) {
    return "duration not recorded";
  }

  const roundedSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(roundedSeconds / 60);
  const secondsPart = roundedSeconds % 60;

  if (minutes < 60) {
    return `${minutes}:${secondsPart.toString().padStart(2, "0")}`;
  }

  const hours = Math.floor(minutes / 60);
  const minutesPart = minutes % 60;

  return `${hours}:${minutesPart.toString().padStart(2, "0")}:${secondsPart
    .toString()
    .padStart(2, "0")}`;
}

function splitSentences(value: string) {
  return cleanText(value)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(
      (token) =>
        token.length >= 4 && !/^\d+$/.test(token) && !audioStopWords.has(token),
    );
}

function rankedTerms(value: string, take = 8) {
  const counts = new Map<string, number>();

  for (const token of tokenize(value)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, take)
    .map(([term]) => term);
}

function labelWhen(
  text: string,
  label: string,
  terms: string[],
  labels: string[],
) {
  if (terms.some((term) => text.includes(term))) {
    labels.push(label);
  }
}

function analyzeAudioContent(
  fileName: string,
  relativePath: string,
  transcriptText: string,
  metadata: BridgeAudioMetadataDraft,
): AudioAnalysis {
  const analysisText = `${relativePath} ${fileName} ${transcriptText}`.toLowerCase();
  const machineLabels: string[] = [];

  labelWhen(analysisText, "workshop recording", ["workshop", "training", "class"], machineLabels);
  labelWhen(analysisText, "therapy session notes", ["therapy", "session", "client"], machineLabels);
  labelWhen(analysisText, "interview", ["interview", "guest", "host"], machineLabels);
  labelWhen(analysisText, "meeting", ["meeting", "agenda", "minutes"], machineLabels);
  labelWhen(analysisText, "brainstorming", ["brainstorm", "ideas", "concept"], machineLabels);
  labelWhen(analysisText, "dictation", ["dictation", "draft", "note to self"], machineLabels);
  labelWhen(analysisText, "voice memo", ["voice memo", "memo", "quick note"], machineLabels);
  labelWhen(analysisText, "scripture discussion", ["scripture", "bible", "devotional"], machineLabels);
  labelWhen(analysisText, "website content candidate", ["website", "article", "public", "blog"], machineLabels);

  if (
    metadata.durationSeconds === null ||
    metadata.durationSeconds < 4 ||
    analysisText.includes("inaudible")
  ) {
    machineLabels.push("poor audio quality");
  }

  if (machineLabels.length === 0) {
    machineLabels.push("audio recording");
  }

  const topTerms = rankedTerms(`${relativePath} ${transcriptText}`, 10);
  const topics = topTerms.slice(0, 8);
  const projects = topTerms.filter((term) =>
    ["workshop", "website", "podcast", "research", "bridge", "notebook"].includes(term),
  );
  const provisionalPeople = [
    ...new Set(
      transcriptText.match(/\b[A-Z][a-z]{2,}\b/g)?.filter(
        (name) =>
          ![
            "The",
            "This",
            "That",
            "And",
            "But",
            "For",
            "With",
            "Audio",
            "Librarian",
          ].includes(name),
      ) ?? [],
    ),
  ].slice(0, 8);
  const sentences = splitSentences(transcriptText);
  const actionItems = sentences
    .filter((sentence) => /\b(need to|should|follow up|todo|action|remember)\b/i.test(sentence))
    .slice(0, 5);
  const questions = sentences
    .filter((sentence) => sentence.endsWith("?"))
    .slice(0, 5);
  const summary =
    transcriptText.trim().length > 0
      ? `I heard audio that appears to touch on ${topics.slice(0, 4).join(", ") || "several review topics"}. Deanne should review the transcript before trusting the labels.`
      : `I recorded audio metadata for this file, but no transcript is available. Deanne can still label it before it influences organization.`;

  return {
    machineLabels: [...new Set(machineLabels)].slice(0, 8),
    provisionalActionItems: actionItems,
    provisionalPeople,
    provisionalProjects: [...new Set(projects)].slice(0, 6),
    provisionalQuestions: questions,
    provisionalTopics: topics,
    summary,
  };
}

async function transcribeAudio(filePath: string): Promise<AudioTranscriptionResult> {
  try {
    const transcription = await requestOpenAIAudioTranscription({ filePath });

    return {
      confidence: 0.66,
      errorCategory: null,
      status: "COMPLETED",
      text: transcription.text.slice(0, transientTranscriptCharacterLimit),
      warnings: transcription.warnings,
    };
  } catch (error) {
    if (error instanceof OpenAIProviderConfigurationError) {
      return {
        confidence: null,
        errorCategory: "AUDIO_TRANSCRIPTION_UNAVAILABLE",
        status: "UNAVAILABLE",
        text: "",
        warnings: [
          "Audio transcription was unavailable, so the Librarian used audio metadata and the file name only.",
        ],
      };
    }

    return {
      confidence: null,
      errorCategory: "AUDIO_TRANSCRIPTION_FAILED",
      status: "FAILED",
      text: "",
      warnings: [
        "Audio transcription could not be completed safely. The recording still needs human review.",
      ],
    };
  }
}

async function detectAudioDuplicate(
  scannedFile: ScannedAudioFileForRead,
  metadata: BridgeAudioMetadataDraft,
): Promise<AudioDuplicateResult> {
  const prisma = getPrismaClient();
  const exact = await findExactChecksumDuplicateForScannedFile(scannedFile.id);

  if (exact) {
    return {
      duplicateConfidence: 0.98,
      duplicateKind: "EXACT_DUPLICATE",
      duplicateOfScannedFileId: exact.id,
    };
  }

  if (metadata.audioFingerprint) {
    const likely = await prisma.audioRecordingMetadata.findFirst({
      select: {
        scannedFileId: true,
      },
      where: {
        audioFingerprint: metadata.audioFingerprint,
        scannedFileId: {
          not: scannedFile.id,
        },
      },
    });

    if (likely) {
      return {
        duplicateConfidence: 0.74,
        duplicateKind: "LIKELY_DUPLICATE",
        duplicateOfScannedFileId: likely.scannedFileId,
      };
    }
  }

  if (metadata.durationSeconds !== null) {
    const candidates = await prisma.audioRecordingMetadata.findMany({
      select: {
        durationSeconds: true,
        scannedFileId: true,
      },
      take: 30,
      where: {
        durationSeconds: {
          not: null,
        },
        scannedFileId: {
          not: scannedFile.id,
        },
      },
    });
    const trimmed = candidates.find(
      (candidate) =>
        candidate.durationSeconds !== null &&
        Math.abs(candidate.durationSeconds - metadata.durationSeconds!) <= 3,
    );

    if (trimmed) {
      return {
        duplicateConfidence: 0.62,
        duplicateKind: "TRIMMED_OR_REENCODED_DUPLICATE",
        duplicateOfScannedFileId: trimmed.scannedFileId,
      };
    }
  }

  return {
    duplicateConfidence: null,
    duplicateKind: null,
    duplicateOfScannedFileId: null,
  };
}

function buildAudioReviewText(input: {
  analysis: AudioAnalysis;
  fileName: string;
  metadata: BridgeAudioMetadataDraft;
  relativePath: string;
  transcriptText: string;
}) {
  const metadataLines = [
    `File: ${input.fileName}`,
    `Relative path: ${input.relativePath}`,
    `Audio type: ${input.metadata.container ?? "audio"}`,
    `Duration: ${formatDuration(input.metadata.durationSeconds)}`,
    input.metadata.sampleRateHz
      ? `Sample rate: ${input.metadata.sampleRateHz} Hz`
      : null,
    input.metadata.channels ? `Channels: ${input.metadata.channels}` : null,
    input.metadata.bitrateKbps
      ? `Bitrate: ${input.metadata.bitrateKbps} kbps`
      : null,
  ].filter(Boolean);
  const transcriptBlock = input.transcriptText.trim()
    ? `Temporary transcript:\n${input.transcriptText}`
    : "Temporary transcript: unavailable. Review is based on metadata and file naming only.";

  return [
    "Audio review material. The source audio remains in the connected folder.",
    ...metadataLines,
    `Summary: ${input.analysis.summary}`,
    `Possible labels: ${input.analysis.machineLabels.join(", ")}`,
    input.analysis.provisionalTopics.length > 0
      ? `Topics noticed: ${input.analysis.provisionalTopics.join(", ")}`
      : null,
    transcriptBlock,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function scannedAudioFileForRead(scannedFileId: string) {
  const prisma = getPrismaClient();

  return prisma.scannedFile.findUnique({
    include: {
      audioMetadata: {
        select: {
          humanLabels: true,
          privacyState: true,
        },
      },
      scanSession: {
        select: {
          connectedFolder: {
            select: {
              displayName: true,
              localPath: true,
            },
          },
        },
      },
    },
    where: {
      id: scannedFileId,
    },
  });
}

async function markAudioReadFailure(
  scannedFileId: string,
  category: string,
  message: string,
): Promise<BridgeScannedFileSummary> {
  const prisma = getPrismaClient();
  const file = await prisma.scannedFile.update({
    include: {
      audioMetadata: true,
    },
    data: {
      extractedAt: new Date(),
      extractionErrorCategory: category,
      extractionStatus:
        category === "UNSUPPORTED_AUDIO" ||
        category === "UNSUPPORTED_FILE_TYPE"
          ? "UNSUPPORTED"
          : "FAILED",
      processedAt: new Date(),
      processingErrorCategory: category,
      processingStage:
        category === "UNSUPPORTED_AUDIO" ||
        category === "UNSUPPORTED_FILE_TYPE"
          ? "UNSUPPORTED"
          : "FAILED",
      readingStatus:
        category === "UNSUPPORTED_AUDIO" ||
        category === "UNSUPPORTED_FILE_TYPE"
          ? "UNSUPPORTED"
          : "FAILED",
      scanError: sanitizeReadingWarning(message),
    },
    where: {
      id: scannedFileId,
    },
  });

  return scannedFileSummary(file);
}

async function upsertAudioMetadata(input: {
  analysis: AudioAnalysis;
  duplicate: AudioDuplicateResult;
  metadata: BridgeAudioMetadataDraft;
  scannedFile: ScannedAudioFileForRead;
  transcription: AudioTranscriptionResult;
}) {
  const prisma = getPrismaClient();
  const existingLabels = jsonAudioHumanLabels(
    input.scannedFile.audioMetadata?.humanLabels ?? [],
  );
  const existingPrivacy =
    typeof input.scannedFile.audioMetadata?.privacyState === "string"
      ? input.scannedFile.audioMetadata.privacyState
      : "REVIEW_REQUIRED";
  const transcriptSnippet = input.transcription.text
    ? previewFromText(input.transcription.text)
    : null;
  const createData = {
    audioFingerprint: input.metadata.audioFingerprint,
    bitrateKbps: input.metadata.bitrateKbps,
    channels: input.metadata.channels,
    codec: input.metadata.codec,
    container: input.metadata.container,
    duplicateConfidence: input.duplicate.duplicateConfidence,
    duplicateKind: input.duplicate.duplicateKind,
    duplicateOfScannedFileId: input.duplicate.duplicateOfScannedFileId,
    durationSeconds: input.metadata.durationSeconds,
    humanLabels: toJsonInput(existingLabels),
    machineLabels: toJsonInput(input.analysis.machineLabels),
    privacyState: existingPrivacy as AudioPrivacyState,
    provisionalActionItems: toJsonInput(input.analysis.provisionalActionItems),
    provisionalPeople: toJsonInput(input.analysis.provisionalPeople),
    provisionalProjects: toJsonInput(input.analysis.provisionalProjects),
    provisionalQuestions: toJsonInput(input.analysis.provisionalQuestions),
    provisionalTopics: toJsonInput(input.analysis.provisionalTopics),
    sampleRateHz: input.metadata.sampleRateHz,
    sourceCreatedAt: input.metadata.sourceCreatedAt,
    sourceModifiedAt: input.metadata.sourceModifiedAt,
    summary: input.analysis.summary,
    transcriptionConfidence: input.transcription.confidence,
    transcriptionErrorCategory: input.transcription.errorCategory,
    transcriptionStatus: input.transcription.status,
    transcriptSnippet,
  };
  const updateData = {
    audioFingerprint: createData.audioFingerprint,
    bitrateKbps: createData.bitrateKbps,
    channels: createData.channels,
    codec: createData.codec,
    container: createData.container,
    duplicateConfidence: createData.duplicateConfidence,
    duplicateKind: createData.duplicateKind,
    duplicateOfScannedFileId: createData.duplicateOfScannedFileId,
    durationSeconds: createData.durationSeconds,
    machineLabels: createData.machineLabels,
    provisionalActionItems: createData.provisionalActionItems,
    provisionalPeople: createData.provisionalPeople,
    provisionalProjects: createData.provisionalProjects,
    provisionalQuestions: createData.provisionalQuestions,
    provisionalTopics: createData.provisionalTopics,
    sampleRateHz: createData.sampleRateHz,
    sourceCreatedAt: createData.sourceCreatedAt,
    sourceModifiedAt: createData.sourceModifiedAt,
    summary: createData.summary,
    transcriptionConfidence: createData.transcriptionConfidence,
    transcriptionErrorCategory: createData.transcriptionErrorCategory,
    transcriptionStatus: createData.transcriptionStatus,
    transcriptSnippet: createData.transcriptSnippet,
  };

  await prisma.audioRecordingMetadata.upsert({
    create: {
      ...createData,
      scannedFileId: input.scannedFile.id,
    },
    update: updateData,
    where: {
      scannedFileId: input.scannedFile.id,
    },
  });

  if (
    input.duplicate.duplicateKind === "EXACT_DUPLICATE" &&
    input.duplicate.duplicateOfScannedFileId
  ) {
    await prisma.audioRecordingMetadata.updateMany({
      data: {
        duplicateConfidence: 0.98,
        duplicateKind: "EXACT_DUPLICATE",
        duplicateOfScannedFileId: input.scannedFile.id,
      },
      where: {
        scannedFileId: input.duplicate.duplicateOfScannedFileId,
      },
    });
  }
}

export async function readScannedAudioFile(
  scannedFileId: string,
): Promise<BridgeReadFileApiSuccess> {
  const prisma = getPrismaClient();
  const scannedFile = await scannedAudioFileForRead(scannedFileId);

  if (!scannedFile) {
    throw new BridgeAudioReaderError(
      "The Librarian could not find that scanned audio file.",
      404,
      "NOT_FOUND",
    );
  }

  if (!isAudioFileType(scannedFile.fileType)) {
    throw new BridgeAudioReaderError(
      "Unsupported for audio reading.",
      409,
      "UNSUPPORTED_AUDIO",
    );
  }

  if (scannedFile.readStatus === "UNSUPPORTED") {
    await markAudioReadFailure(
      scannedFile.id,
      "UNSUPPORTED_AUDIO",
      "Unsupported for audio reading.",
    );
    throw new BridgeAudioReaderError(
      "Unsupported for audio reading.",
      409,
      "UNSUPPORTED_AUDIO",
    );
  }

  await prisma.scannedFile.update({
    data: {
      extractionErrorCategory: null,
      extractionStatus: "EXTRACTING",
      processingErrorCategory: null,
      processingStage: "READING",
      scanError: null,
    },
    where: {
      id: scannedFile.id,
    },
  });

  try {
    const { filePath, fileStats } = await resolveScannedAudioPath(scannedFile);
    const metadata = await extractAudioMetadata(
      filePath,
      scannedFile.relativePath,
      fileStats,
    ).catch(() => {
      throw new BridgeAudioReaderError(
        "The Librarian could not inspect this audio file metadata safely.",
        422,
        "AUDIO_METADATA_FAILED",
      );
    });
    const transcription = await transcribeAudio(filePath);
    const analysis = analyzeAudioContent(
      fileNameFromRelativePath(scannedFile.relativePath),
      scannedFile.relativePath,
      transcription.text,
      metadata,
    );
    const duplicate = await detectAudioDuplicate(scannedFile, metadata);
    const extractedText = buildAudioReviewText({
      analysis,
      fileName: fileNameFromRelativePath(scannedFile.relativePath),
      metadata,
      relativePath: scannedFile.relativePath,
      transcriptText: transcription.text,
    });

    await upsertAudioMetadata({
      analysis,
      duplicate,
      metadata,
      scannedFile,
      transcription,
    });

    const characterCount = transcription.text.length || extractedText.length;
    const updatedFile = await prisma.scannedFile.update({
      include: {
        audioMetadata: true,
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
        },
      },
      data: {
        characterCount,
        extractedAt: new Date(),
        extractionErrorCategory: null,
        extractionStatus: "COMPLETED",
        previewText: previewFromText(`${analysis.summary} ${transcription.text}`),
        processedAt: new Date(),
        processingErrorCategory: null,
        processingStage: "READ",
        readingStatus: "READ",
        scanError: null,
        sourceCreatedAt: metadata.sourceCreatedAt,
      },
      where: {
        id: scannedFile.id,
      },
    });

    const preview: BridgeReadPreview = {
      characterCount,
      extractedText,
      fileName: fileNameFromRelativePath(scannedFile.relativePath),
      fileType: scannedFile.fileType,
      relativePath: scannedFile.relativePath,
      scannedFileId: scannedFile.id,
      warnings: transcription.warnings.map(sanitizeReadingWarning),
    };

    return {
      file: scannedFileSummary(updatedFile),
      ok: true,
      preview,
    };
  } catch (error) {
    if (error instanceof BridgeAudioReaderError) {
      await markAudioReadFailure(scannedFile.id, error.category, error.message);
      throw error;
    }

    await markAudioReadFailure(
      scannedFile.id,
      "AUDIO_READ_FAILED",
      safeAudioFailureMessage(),
    );
    throw new BridgeAudioReaderError(safeAudioFailureMessage());
  }
}

export async function readScannedAudioFileTransient(scannedFileId: string) {
  const scannedFile = await scannedAudioFileForRead(scannedFileId);

  if (!scannedFile) {
    throw new BridgeAudioReaderError(
      "The Librarian could not find that scanned audio file.",
      404,
      "NOT_FOUND",
    );
  }

  if (
    scannedFile.readingStatus !== "READ" ||
    scannedFile.extractionStatus !== "COMPLETED"
  ) {
    throw new BridgeAudioReaderError(
      "The Librarian has not finished reading this audio file yet.",
      409,
      "NOT_READ",
    );
  }

  const { filePath, fileStats } = await resolveScannedAudioPath(scannedFile);
  const metadata = await extractAudioMetadata(
    filePath,
    scannedFile.relativePath,
    fileStats,
  ).catch(() => {
    throw new BridgeAudioReaderError(
      "The Librarian could not inspect this audio file metadata safely.",
      422,
      "AUDIO_METADATA_FAILED",
    );
  });
  const transcription = await transcribeAudio(filePath);
  const analysis = analyzeAudioContent(
    fileNameFromRelativePath(scannedFile.relativePath),
    scannedFile.relativePath,
    transcription.text,
    metadata,
  );

  return {
    characterCount: transcription.text.length || (scannedFile.previewText ?? "").length,
    extractedText: buildAudioReviewText({
      analysis,
      fileName: fileNameFromRelativePath(scannedFile.relativePath),
      metadata,
      relativePath: scannedFile.relativePath,
      transcriptText: transcription.text || (scannedFile.previewText ?? ""),
    }),
    fileName: fileNameFromRelativePath(scannedFile.relativePath),
    fileType: scannedFile.fileType,
    relativePath: scannedFile.relativePath,
    scannedFileId: scannedFile.id,
    warnings: transcription.warnings.map(sanitizeReadingWarning),
  } satisfies BridgeReadPreview;
}

export async function updateScannedAudioReviewState(input: {
  scannedFileId: string;
  labels?: AudioHumanLabel[];
  privacyState?: AudioPrivacyState;
}): Promise<BridgeScannedFileSummary> {
  const prisma = getPrismaClient();
  const scannedFile = await prisma.scannedFile.findUnique({
    include: {
      audioMetadata: true,
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
      },
    },
    where: {
      id: input.scannedFileId,
    },
  });

  if (!scannedFile || !isAudioFileType(scannedFile.fileType)) {
    throw new BridgeAudioReaderError(
      "The Librarian could not find that audio recording.",
      404,
      "NOT_FOUND",
    );
  }

  const nextLabels = input.labels
    ? [...new Set(input.labels)]
    : jsonAudioHumanLabels(scannedFile.audioMetadata?.humanLabels ?? []);
  const existingPrivacy =
    scannedFile.audioMetadata?.privacyState === "PRIVATE" ||
    scannedFile.audioMetadata?.privacyState === "INTERNAL" ||
    scannedFile.audioMetadata?.privacyState === "REVIEW_REQUIRED" ||
    scannedFile.audioMetadata?.privacyState === "WEBSITE_CANDIDATE" ||
    scannedFile.audioMetadata?.privacyState === "APPROVED_FOR_PUBLIC_USE"
      ? scannedFile.audioMetadata.privacyState
      : "REVIEW_REQUIRED";
  const nextPrivacy = input.privacyState ?? existingPrivacy;

  await prisma.audioRecordingMetadata.upsert({
    create: {
      audioFingerprint: null,
      humanLabels: toJsonInput(nextLabels),
      machineLabels: toJsonInput([]),
      privacyState: nextPrivacy,
      provisionalActionItems: toJsonInput([]),
      provisionalPeople: toJsonInput([]),
      provisionalProjects: toJsonInput([]),
      provisionalQuestions: toJsonInput([]),
      provisionalTopics: toJsonInput([]),
      scannedFileId: scannedFile.id,
      transcriptionStatus: "NOT_REQUESTED",
    },
    update: {
      humanLabels: toJsonInput(nextLabels),
      privacyState: nextPrivacy,
    },
    where: {
      scannedFileId: scannedFile.id,
    },
  });

  if (nextPrivacy === "PRIVATE" || nextLabels.includes("PRIVATE")) {
    await prisma.organizationSuggestion.updateMany({
      data: {
        reviewedAt: new Date(),
        status: "REJECTED",
      },
      where: {
        scannedFileId: scannedFile.id,
        status: "PENDING",
        suggestionType: "WEBSITE_CANDIDATE",
      },
    });
  }

  const refreshedFile = await prisma.scannedFile.findUniqueOrThrow({
    include: {
      audioMetadata: true,
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
      },
    },
    where: {
      id: scannedFile.id,
    },
  });

  return scannedFileSummary(refreshedFile);
}

export function normalizeAudioHumanLabelsInput(value: unknown): AudioHumanLabel[] {
  return [...new Set(jsonAudioHumanLabels(value))];
}

export function normalizeAudioPrivacyInput(value: unknown): AudioPrivacyState | null {
  if (typeof value !== "string") {
    return null;
  }

  if (
    value === "PRIVATE" ||
    value === "INTERNAL" ||
    value === "REVIEW_REQUIRED" ||
    value === "WEBSITE_CANDIDATE" ||
    value === "APPROVED_FOR_PUBLIC_USE"
  ) {
    return value;
  }

  return null;
}

export function audioHumanLabelValues() {
  return [
    "WORKSHOP",
    "CLIENT",
    "PRIVATE",
    "WEBSITE",
    "PODCAST",
    "MEETING",
    "RESEARCH",
    "ARCHIVE",
  ] satisfies AudioHumanLabel[];
}

export function audioPrivacyStateValues() {
  return [
    "PRIVATE",
    "INTERNAL",
    "REVIEW_REQUIRED",
    "WEBSITE_CANDIDATE",
    "APPROVED_FOR_PUBLIC_USE",
  ] satisfies AudioPrivacyState[];
}

export function existingAudioHumanLabels(value: unknown) {
  return jsonStringArray(value);
}
