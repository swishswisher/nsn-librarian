import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { Prisma } from "@prisma/client";

import {
  OpenAIProviderConfigurationError,
  requestOpenAIAudioTranscription,
} from "@/lib/ai/openai-client";
import { getPrismaClient } from "@/lib/db/prisma";
import { sanitizeReadingWarning } from "@/lib/reading-room/utils";

import {
  ConnectedLibraryFileResolutionError,
  resolveConnectedLibraryFile,
} from "./connected-library-file-resolver";
import { scannedFileSummary, type StoredScannedFile } from "./scan-sessions";
import {
  defaultFrameDescriptions,
  extractVideoMetadata,
  isVideoFileType,
  jsonStringArray,
  jsonVideoHumanLabels,
  videoMimeTypeForFileType,
  videoSampleTimestamps,
} from "./video-metadata";
import type {
  BridgeReadFileApiSuccess,
  BridgeReadPreview,
  BridgeScannedFileSummary,
  BridgeVideoChapterSuggestion,
  BridgeVideoFrameDescription,
  BridgeVideoMetadataDraft,
  VideoHumanLabel,
  VideoPrivacyState,
  VideoProcessingStatus,
} from "./types";

type ScannedVideoFileForRead = Omit<StoredScannedFile, "videoMetadata"> & {
  localPath: string;
  sessionId: string;
  libraryDocumentId: string | null;
  videoMetadata?: {
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

type VideoTranscriptionResult = {
  text: string;
  status: VideoProcessingStatus;
  confidence: number | null;
  errorCategory: string | null;
  warnings: string[];
};

type VideoFrameSamplingResult = {
  status: VideoProcessingStatus;
  errorCategory: string | null;
  descriptions: BridgeVideoFrameDescription[];
  warnings: string[];
};

type VideoAnalysis = {
  machineLabels: string[];
  provisionalTopics: string[];
  provisionalPeople: string[];
  provisionalProjects: string[];
  provisionalQuestions: string[];
  relatedSignals: string[];
  summary: string;
  chapterSuggestions: BridgeVideoChapterSuggestion[];
};

type VideoDuplicateResult = {
  duplicateKind: string | null;
  duplicateOfScannedFileId: string | null;
  duplicateConfidence: number | null;
};

export class BridgeVideoReaderError extends Error {
  statusCode: number;
  category: string;

  constructor(message: string, statusCode = 400, category = "VIDEO_READ_FAILED") {
    super(message);
    this.name = "BridgeVideoReaderError";
    this.statusCode = statusCode;
    this.category = category;
  }
}

const previewCharacterLimit = 1_200;
const transientTranscriptCharacterLimit = 80_000;
const maxTranscriptionSeconds = 900;
const maxTemporaryVideoProcessingBytes = 800 * 1024 * 1024;
const transcriptionRequestTimeoutMs = 55_000;
const videoStopWords = new Set([
  "about",
  "after",
  "again",
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
  "this",
  "those",
  "through",
  "video",
  "videos",
  "with",
  "would",
]);

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function configuredFfmpegPath() {
  return process.env.NSN_VIDEO_FFMPEG_PATH?.trim() || "ffmpeg";
}

function safeVideoFailureMessage() {
  return "The Librarian could not inspect this video file safely.";
}

async function resolveScannedVideoPath(scannedFile: ScannedVideoFileForRead) {
  try {
    const resolvedFile = await resolveConnectedLibraryFile({
      itemLabel: "video file",
      scannedFileId: scannedFile.id,
    });

    return {
      filePath: resolvedFile.filePath,
      fileStats: resolvedFile.fileStats,
    };
  } catch (error) {
    if (error instanceof ConnectedLibraryFileResolutionError) {
      throw new BridgeVideoReaderError(
        error.message,
        error.statusCode,
        error.category,
      );
    }

    throw error;
  }
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; category: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    let finished = false;
    const timeout = setTimeout(() => {
      if (!finished) {
        child.kill("SIGKILL");
        finished = true;
        resolve({ category: "VIDEO_TOOL_TIMEOUT", ok: false });
      }
    }, timeoutMs);

    child.on("error", () => {
      if (!finished) {
        clearTimeout(timeout);
        finished = true;
        resolve({ category: "VIDEO_TOOL_UNAVAILABLE", ok: false });
      }
    });
    child.on("close", (code) => {
      if (!finished) {
        clearTimeout(timeout);
        finished = true;
        resolve(code === 0 ? { ok: true } : { category: "VIDEO_TOOL_FAILED", ok: false });
      }
    });
  });
}

function withVideoTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  category: string,
) {
  let timeoutId: ReturnType<typeof setTimeout>;

  return new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new BridgeVideoReaderError(safeVideoFailureMessage(), 408, category));
    }, timeoutMs);

    task.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
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
        token.length >= 4 && !/^\d+$/.test(token) && !videoStopWords.has(token),
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

function labelWhen(text: string, label: string, terms: string[], labels: string[]) {
  if (terms.some((term) => text.includes(term))) {
    labels.push(label);
  }
}

async function extractTemporaryAudio(
  filePath: string,
  tempDir: string,
  durationSeconds: number | null,
) {
  const audioPath = path.join(tempDir, "video-audio.wav");
  const args = [
    "-y",
    "-i",
    filePath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-t",
    Math.min(durationSeconds ?? maxTranscriptionSeconds, maxTranscriptionSeconds).toString(),
    audioPath,
  ];
  const result = await runProcess(configuredFfmpegPath(), args, 45_000);

  return result.ok ? { ok: true as const, audioPath } : result;
}

async function transcribeVideoAudio(
  filePath: string,
  metadata: BridgeVideoMetadataDraft,
  sizeBytes: number,
): Promise<VideoTranscriptionResult> {
  if (metadata.hasAudioTrack === false) {
    return {
      confidence: null,
      errorCategory: null,
      status: "UNAVAILABLE",
      text: "",
      warnings: ["No audio track was detected, so transcription was skipped."],
    };
  }

  if (sizeBytes > maxTemporaryVideoProcessingBytes) {
    return {
      confidence: null,
      errorCategory: "VIDEO_TOO_LARGE_FOR_TEMPORARY_TRANSCRIPTION",
      status: "UNAVAILABLE",
      text: "",
      warnings: [
        "This video is too large for temporary transcription in the current local preview.",
      ],
    };
  }

  let tempDir: string | null = null;

  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "nsn-video-audio-"));
    const extracted = await extractTemporaryAudio(
      filePath,
      tempDir,
      metadata.durationSeconds,
    );

    if (!extracted.ok) {
      return {
        confidence: null,
        errorCategory: extracted.category,
        status: "UNAVAILABLE",
        text: "",
        warnings: [
          "Video audio could not be extracted temporarily, so transcription was skipped.",
        ],
      };
    }

    const transcription = await withVideoTimeout(
      requestOpenAIAudioTranscription({
        filePath: extracted.audioPath,
      }),
      transcriptionRequestTimeoutMs,
      "AI_TRANSCRIPTION_TIMEOUT",
    );

    return {
      confidence: 0.64,
      errorCategory: null,
      status: "COMPLETED",
      text: transcription.text.slice(0, transientTranscriptCharacterLimit),
      warnings: transcription.warnings,
    };
  } catch (error) {
    if (error instanceof OpenAIProviderConfigurationError) {
      return {
        confidence: null,
        errorCategory: "AI_TRANSCRIPTION_UNAVAILABLE",
        status: "UNAVAILABLE",
        text: "",
        warnings: [
          "Video transcription was unavailable, so the Librarian used video metadata and file naming only.",
        ],
      };
    }

    if (error instanceof BridgeVideoReaderError) {
      return {
        confidence: null,
        errorCategory: error.category,
        status: "FAILED",
        text: "",
        warnings: [
          "Video transcription took too long or stopped safely. Metadata and frame notes are still available for review.",
        ],
      };
    }

    return {
      confidence: null,
      errorCategory: "AI_TRANSCRIPTION_FAILED",
      status: "FAILED",
      text: "",
      warnings: [
        "Video transcription could not be completed safely. The recording still needs human review.",
      ],
    };
  } finally {
    if (tempDir) {
      await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

async function sampleVideoFrames(
  filePath: string,
  metadata: BridgeVideoMetadataDraft,
  sizeBytes: number,
): Promise<VideoFrameSamplingResult> {
  if (sizeBytes > maxTemporaryVideoProcessingBytes) {
    return {
      descriptions: defaultFrameDescriptions(metadata),
      errorCategory: "VIDEO_TOO_LARGE_FOR_TEMPORARY_FRAME_SAMPLING",
      status: "UNAVAILABLE",
      warnings: [
        "This video is too large for temporary frame sampling in the current local preview.",
      ],
    };
  }

  const timestamps = videoSampleTimestamps(metadata.durationSeconds);
  let tempDir: string | null = null;

  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "nsn-video-frames-"));
    const descriptions: BridgeVideoFrameDescription[] = [];

    for (const timestamp of timestamps) {
      const framePath = path.join(tempDir, `frame-${timestamp}.jpg`);
      const result = await runProcess(
        configuredFfmpegPath(),
        [
          "-y",
          "-ss",
          timestamp.toString(),
          "-i",
          filePath,
          "-frames:v",
          "1",
          "-q:v",
          "3",
          framePath,
        ],
        12_000,
      );

      if (!result.ok) {
        return {
          descriptions: defaultFrameDescriptions(metadata),
          errorCategory: result.category,
          status: "UNAVAILABLE",
          warnings: [
            "Selected video frames could not be sampled temporarily. The Librarian kept metadata-only frame notes for review.",
          ],
        };
      }

      descriptions.push({
        confidence: 0.44,
        description:
          timestamp === 0
            ? "Opening frame sampled temporarily for review."
            : "Representative frame sampled temporarily for review.",
        label: timestamp === 0 ? "Opening frame" : "Representative frame",
        timestampSeconds: timestamp,
      });
    }

    return {
      descriptions,
      errorCategory: null,
      status: "COMPLETED",
      warnings: [],
    };
  } finally {
    if (tempDir) {
      await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

function chapterSuggestionsFor(
  transcriptText: string,
  metadata: BridgeVideoMetadataDraft,
  topics: string[],
) {
  const duration = metadata.durationSeconds;

  if (!duration || duration < 60) {
    return [
      {
        confidence: 0.35,
        timestampSeconds: 0,
        title: topics[0] ? `Opening: ${topics[0]}` : "Opening section",
      },
    ] satisfies BridgeVideoChapterSuggestion[];
  }

  const sentences = splitSentences(transcriptText);
  const questionIndex = sentences.findIndex((sentence) => sentence.endsWith("?"));
  const midpointTopic = topics[1] ?? topics[0] ?? "main discussion";
  const chapters: BridgeVideoChapterSuggestion[] = [
    {
      confidence: 0.42,
      timestampSeconds: 0,
      title: topics[0] ? `Opening: ${topics[0]}` : "Opening context",
    },
    {
      confidence: 0.4,
      timestampSeconds: Math.round(duration / 3),
      title: `Main section: ${midpointTopic}`,
    },
    {
      confidence: 0.38,
      timestampSeconds:
        questionIndex >= 0 ? Math.round(duration * 0.66) : Math.round(duration * 0.75),
      title: questionIndex >= 0 ? "Questions and review" : "Closing section",
    },
  ];

  return chapters;
}

function analyzeVideoContent(
  fileName: string,
  relativePath: string,
  transcriptText: string,
  metadata: BridgeVideoMetadataDraft,
  frames: BridgeVideoFrameDescription[],
): VideoAnalysis {
  const analysisText = `${relativePath} ${fileName} ${transcriptText}`.toLowerCase();
  const machineLabels: string[] = [];

  labelWhen(analysisText, "workshop recording", ["workshop", "training", "class"], machineLabels);
  labelWhen(analysisText, "presentation", ["presentation", "slides", "deck"], machineLabels);
  labelWhen(analysisText, "interview", ["interview", "guest", "host"], machineLabels);
  labelWhen(analysisText, "screen recording", ["screen", "share", "tutorial", "walkthrough"], machineLabels);
  labelWhen(analysisText, "webinar", ["webinar", "zoom", "session"], machineLabels);
  labelWhen(analysisText, "website video", ["website", "public", "landing", "blog"], machineLabels);
  labelWhen(analysisText, "branding asset", ["brand", "logo", "intro", "outro"], machineLabels);
  labelWhen(analysisText, "talking-head video", ["talking", "speaker", "camera"], machineLabels);

  if (
    metadata.width !== null &&
    metadata.height !== null &&
    (metadata.width < 640 || metadata.height < 360)
  ) {
    machineLabels.push("poor visual quality");
  }

  if (metadata.durationSeconds !== null && metadata.durationSeconds < 8) {
    machineLabels.push("incomplete recording");
  }

  if (
    metadata.width !== null &&
    metadata.height !== null &&
    metadata.width / metadata.height > 1.6 &&
    (analysisText.includes("slides") || analysisText.includes("presentation"))
  ) {
    machineLabels.push("likely slide presentation");
  }

  if (machineLabels.length === 0) {
    machineLabels.push("video recording");
  }

  const topTerms = rankedTerms(`${relativePath} ${transcriptText}`, 10);
  const projects = topTerms.filter((term) =>
    ["workshop", "website", "training", "presentation", "webinar"].includes(term),
  );
  const people = [
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
            "Video",
            "Librarian",
          ].includes(name),
      ) ?? [],
    ),
  ].slice(0, 8);
  const questions = splitSentences(transcriptText)
    .filter((sentence) => sentence.endsWith("?"))
    .slice(0, 6);
  const summary =
    transcriptText.trim().length > 0
      ? `I found a video that appears to touch on ${topTerms.slice(0, 4).join(", ") || "several review topics"}. The transcript and sampled-frame notes are provisional until Deanne reviews them.`
      : `I recorded video metadata and selected-frame notes, but no transcript is available. Deanne can still label it before it influences organization.`;

  return {
    chapterSuggestions: chapterSuggestionsFor(transcriptText, metadata, topTerms),
    machineLabels: [...new Set(machineLabels)].slice(0, 10),
    provisionalPeople: people,
    provisionalProjects: [...new Set(projects)].slice(0, 6),
    provisionalQuestions: questions,
    provisionalTopics: topTerms.slice(0, 8),
    relatedSignals: frames.map(
      (frame) => `${frame.label} at ${formatDuration(frame.timestampSeconds)}`,
    ),
    summary,
  };
}

async function detectVideoDuplicate(
  scannedFile: ScannedVideoFileForRead,
  metadata: BridgeVideoMetadataDraft,
): Promise<VideoDuplicateResult> {
  const prisma = getPrismaClient();

  if (scannedFile.checksum) {
    const exact = await prisma.scannedFile.findFirst({
      select: { id: true },
      where: {
        checksum: scannedFile.checksum,
        id: { not: scannedFile.id },
        readStatus: "SUPPORTED",
      },
    });

    if (exact) {
      return {
        duplicateConfidence: 0.98,
        duplicateKind: "EXACT_DUPLICATE",
        duplicateOfScannedFileId: exact.id,
      };
    }
  }

  if (metadata.videoFingerprint) {
    const likely = await prisma.videoRecordingMetadata.findFirst({
      select: { scannedFileId: true },
      where: {
        scannedFileId: { not: scannedFile.id },
        videoFingerprint: metadata.videoFingerprint,
      },
    });

    if (likely) {
      return {
        duplicateConfidence: 0.74,
        duplicateKind: "REENCODED_OR_LOWER_RESOLUTION_DUPLICATE",
        duplicateOfScannedFileId: likely.scannedFileId,
      };
    }
  }

  if (metadata.durationSeconds !== null) {
    const candidates = await prisma.videoRecordingMetadata.findMany({
      select: {
        durationSeconds: true,
        height: true,
        scannedFileId: true,
        width: true,
      },
      take: 40,
      where: {
        durationSeconds: { not: null },
        scannedFileId: { not: scannedFile.id },
      },
    });
    const nearDuration = candidates.find(
      (candidate) =>
        candidate.durationSeconds !== null &&
        Math.abs(candidate.durationSeconds - metadata.durationSeconds!) <= 5,
    );

    if (nearDuration) {
      const lowerResolution =
        metadata.width !== null &&
        metadata.height !== null &&
        nearDuration.width !== null &&
        nearDuration.height !== null &&
        metadata.width * metadata.height !== nearDuration.width * nearDuration.height;

      return {
        duplicateConfidence: lowerResolution ? 0.68 : 0.61,
        duplicateKind: lowerResolution
          ? "LOWER_RESOLUTION_COPY"
          : "TRIMMED_OR_LIKELY_DUPLICATE",
        duplicateOfScannedFileId: nearDuration.scannedFileId,
      };
    }
  }

  return {
    duplicateConfidence: null,
    duplicateKind: null,
    duplicateOfScannedFileId: null,
  };
}

function buildVideoReviewText(input: {
  analysis: VideoAnalysis;
  duplicate: VideoDuplicateResult;
  fileName: string;
  frames: BridgeVideoFrameDescription[];
  metadata: BridgeVideoMetadataDraft;
  relativePath: string;
  transcriptText: string;
}) {
  const metadataLines = [
    `File: ${input.fileName}`,
    `Relative path: ${input.relativePath}`,
    `Video type: ${input.metadata.container ?? "video"}`,
    `Duration: ${formatDuration(input.metadata.durationSeconds)}`,
    input.metadata.width && input.metadata.height
      ? `Frame size: ${input.metadata.width} x ${input.metadata.height}`
      : null,
    input.metadata.frameRate ? `Frame rate: ${input.metadata.frameRate} fps` : null,
    input.metadata.bitrateKbps
      ? `Bitrate: ${input.metadata.bitrateKbps} kbps`
      : null,
    input.metadata.hasAudioTrack === null
      ? null
      : `Audio track: ${input.metadata.hasAudioTrack ? "detected" : "not detected"}`,
  ].filter(Boolean);
  const chapterLines = input.analysis.chapterSuggestions.map(
    (chapter) =>
      `${formatDuration(chapter.timestampSeconds)} - ${chapter.title} (${Math.round(
        chapter.confidence * 100,
      )}% confidence)`,
  );
  const frameLines = input.frames.map(
    (frame) => `${formatDuration(frame.timestampSeconds)} - ${frame.description}`,
  );
  const transcriptBlock = input.transcriptText.trim()
    ? `Temporary transcript:\n${input.transcriptText}`
    : "Temporary transcript: unavailable. Review is based on metadata, file naming, and frame-sampling notes only.";

  return [
    "Video review material. The source video remains in the connected folder.",
    ...metadataLines,
    `Summary: ${input.analysis.summary}`,
    `Possible labels: ${input.analysis.machineLabels.join(", ")}`,
    input.analysis.provisionalTopics.length > 0
      ? `Topics noticed: ${input.analysis.provisionalTopics.join(", ")}`
      : null,
    chapterLines.length > 0 ? `Chapter suggestions:\n${chapterLines.join("\n")}` : null,
    frameLines.length > 0 ? `Selected-frame notes:\n${frameLines.join("\n")}` : null,
    input.duplicate.duplicateKind
      ? `Duplicate signal: ${input.duplicate.duplicateKind.replaceAll("_", " ").toLowerCase()}`
      : null,
    transcriptBlock,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function scannedVideoFileForRead(scannedFileId: string) {
  const prisma = getPrismaClient();

  return prisma.scannedFile.findUnique({
    include: {
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
      videoMetadata: {
        select: {
          humanLabels: true,
          privacyState: true,
        },
      },
    },
    where: { id: scannedFileId },
  });
}

async function markVideoReadFailure(
  scannedFileId: string,
  category: string,
  message: string,
): Promise<BridgeScannedFileSummary> {
  const prisma = getPrismaClient();
  const file = await prisma.scannedFile.update({
    include: { videoMetadata: true },
    data: {
      extractedAt: new Date(),
      extractionErrorCategory: category,
      extractionStatus:
        category === "UNSUPPORTED_FILE_TYPE" ? "UNSUPPORTED" : "FAILED",
      processedAt: new Date(),
      processingErrorCategory: category,
      processingStage:
        category === "UNSUPPORTED_FILE_TYPE" ? "UNSUPPORTED" : "FAILED",
      readingStatus:
        category === "UNSUPPORTED_FILE_TYPE" ? "UNSUPPORTED" : "FAILED",
      scanError: sanitizeReadingWarning(message),
    },
    where: { id: scannedFileId },
  });

  return scannedFileSummary(file);
}

async function upsertVideoMetadata(input: {
  analysis: VideoAnalysis;
  duplicate: VideoDuplicateResult;
  frames: VideoFrameSamplingResult;
  metadata: BridgeVideoMetadataDraft;
  scannedFile: ScannedVideoFileForRead;
  transcription: VideoTranscriptionResult;
}) {
  const prisma = getPrismaClient();
  const existingLabels = jsonVideoHumanLabels(
    input.scannedFile.videoMetadata?.humanLabels ?? [],
  );
  const existingPrivacy =
    typeof input.scannedFile.videoMetadata?.privacyState === "string"
      ? input.scannedFile.videoMetadata.privacyState
      : "REVIEW_REQUIRED";
  const transcriptSnippet = input.transcription.text
    ? previewFromText(input.transcription.text)
    : null;
  const createData = {
    bitrateKbps: input.metadata.bitrateKbps,
    chapterSuggestions: toJsonInput(input.analysis.chapterSuggestions),
    codec: input.metadata.codec,
    container: input.metadata.container,
    duplicateConfidence: input.duplicate.duplicateConfidence,
    duplicateKind: input.duplicate.duplicateKind,
    duplicateOfScannedFileId: input.duplicate.duplicateOfScannedFileId,
    durationSeconds: input.metadata.durationSeconds,
    frameAnalysisErrorCategory: input.frames.errorCategory,
    frameAnalysisStatus: input.frames.status,
    frameRate: input.metadata.frameRate,
    hasAudioTrack: input.metadata.hasAudioTrack,
    height: input.metadata.height,
    humanLabels: toJsonInput(existingLabels),
    machineLabels: toJsonInput(input.analysis.machineLabels),
    privacyState: existingPrivacy as VideoPrivacyState,
    provisionalPeople: toJsonInput(input.analysis.provisionalPeople),
    provisionalProjects: toJsonInput(input.analysis.provisionalProjects),
    provisionalQuestions: toJsonInput(input.analysis.provisionalQuestions),
    provisionalTopics: toJsonInput(input.analysis.provisionalTopics),
    relatedSignals: toJsonInput(input.analysis.relatedSignals),
    selectedFrameDescriptions: toJsonInput(input.frames.descriptions),
    sourceCreatedAt: input.metadata.sourceCreatedAt,
    sourceModifiedAt: input.metadata.sourceModifiedAt,
    summary: input.analysis.summary,
    transcriptionConfidence: input.transcription.confidence,
    transcriptionErrorCategory: input.transcription.errorCategory,
    transcriptionStatus: input.transcription.status,
    transcriptSnippet,
    videoFingerprint: input.metadata.videoFingerprint,
    width: input.metadata.width,
  };
  const updateData = {
    bitrateKbps: createData.bitrateKbps,
    chapterSuggestions: createData.chapterSuggestions,
    codec: createData.codec,
    container: createData.container,
    duplicateConfidence: createData.duplicateConfidence,
    duplicateKind: createData.duplicateKind,
    duplicateOfScannedFileId: createData.duplicateOfScannedFileId,
    durationSeconds: createData.durationSeconds,
    frameAnalysisErrorCategory: createData.frameAnalysisErrorCategory,
    frameAnalysisStatus: createData.frameAnalysisStatus,
    frameRate: createData.frameRate,
    hasAudioTrack: createData.hasAudioTrack,
    height: createData.height,
    machineLabels: createData.machineLabels,
    provisionalPeople: createData.provisionalPeople,
    provisionalProjects: createData.provisionalProjects,
    provisionalQuestions: createData.provisionalQuestions,
    provisionalTopics: createData.provisionalTopics,
    relatedSignals: createData.relatedSignals,
    selectedFrameDescriptions: createData.selectedFrameDescriptions,
    sourceCreatedAt: createData.sourceCreatedAt,
    sourceModifiedAt: createData.sourceModifiedAt,
    summary: createData.summary,
    transcriptionConfidence: createData.transcriptionConfidence,
    transcriptionErrorCategory: createData.transcriptionErrorCategory,
    transcriptionStatus: createData.transcriptionStatus,
    transcriptSnippet: createData.transcriptSnippet,
    videoFingerprint: createData.videoFingerprint,
    width: createData.width,
  };

  await prisma.videoRecordingMetadata.upsert({
    create: {
      ...createData,
      scannedFileId: input.scannedFile.id,
    },
    update: updateData,
    where: { scannedFileId: input.scannedFile.id },
  });
}

export async function readScannedVideoFile(
  scannedFileId: string,
): Promise<BridgeReadFileApiSuccess> {
  const prisma = getPrismaClient();
  const scannedFile = await scannedVideoFileForRead(scannedFileId);

  if (!scannedFile) {
    throw new BridgeVideoReaderError(
      "The Librarian could not find that scanned video file.",
      404,
      "NOT_FOUND",
    );
  }

  if (!isVideoFileType(scannedFile.fileType)) {
    throw new BridgeVideoReaderError(
      "Unsupported for video reading.",
      409,
      "UNSUPPORTED_FILE_TYPE",
    );
  }

  if (scannedFile.readStatus === "UNSUPPORTED") {
    await markVideoReadFailure(
      scannedFile.id,
      "UNSUPPORTED_FILE_TYPE",
      "Unsupported for video reading.",
    );
    throw new BridgeVideoReaderError(
      "Unsupported for video reading.",
      409,
      "UNSUPPORTED_FILE_TYPE",
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
    where: { id: scannedFile.id },
  });

  try {
    const { filePath, fileStats } = await resolveScannedVideoPath(scannedFile);
    const metadata = await extractVideoMetadata(
      filePath,
      scannedFile.relativePath,
      fileStats,
    );
    const [transcription, frames] = await Promise.all([
      transcribeVideoAudio(filePath, metadata, fileStats.size),
      sampleVideoFrames(filePath, metadata, fileStats.size),
    ]);
    const analysis = analyzeVideoContent(
      fileNameFromRelativePath(scannedFile.relativePath),
      scannedFile.relativePath,
      transcription.text,
      metadata,
      frames.descriptions,
    );
    const duplicate = await detectVideoDuplicate(scannedFile, metadata);
    const extractedText = buildVideoReviewText({
      analysis,
      duplicate,
      fileName: fileNameFromRelativePath(scannedFile.relativePath),
      frames: frames.descriptions,
      metadata,
      relativePath: scannedFile.relativePath,
      transcriptText: transcription.text,
    });

    await upsertVideoMetadata({
      analysis,
      duplicate,
      frames,
      metadata,
      scannedFile,
      transcription,
    });

    const characterCount = transcription.text.length || extractedText.length;
    const updatedFile = await prisma.scannedFile.update({
      include: {
        libraryDocument: {
          select: {
            observationSessions: {
              select: { status: true },
            },
          },
        },
        organizationSuggestions: {
          select: { status: true },
        },
        videoMetadata: true,
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
      where: { id: scannedFile.id },
    });
    const preview: BridgeReadPreview = {
      characterCount,
      extractedText,
      fileName: fileNameFromRelativePath(scannedFile.relativePath),
      fileType: scannedFile.fileType,
      relativePath: scannedFile.relativePath,
      scannedFileId: scannedFile.id,
      warnings: [...transcription.warnings, ...frames.warnings].map(
        sanitizeReadingWarning,
      ),
    };

    return {
      file: scannedFileSummary(updatedFile),
      ok: true,
      preview,
    };
  } catch (error) {
    if (error instanceof BridgeVideoReaderError) {
      await markVideoReadFailure(scannedFile.id, error.category, error.message);
      throw error;
    }

    await markVideoReadFailure(
      scannedFile.id,
      "VIDEO_READ_FAILED",
      safeVideoFailureMessage(),
    );
    throw new BridgeVideoReaderError(safeVideoFailureMessage());
  }
}

export async function readScannedVideoFileTransient(scannedFileId: string) {
  const scannedFile = await scannedVideoFileForRead(scannedFileId);

  if (!scannedFile) {
    throw new BridgeVideoReaderError(
      "The Librarian could not find that scanned video file.",
      404,
      "NOT_FOUND",
    );
  }

  if (
    scannedFile.readingStatus !== "READ" ||
    scannedFile.extractionStatus !== "COMPLETED"
  ) {
    throw new BridgeVideoReaderError(
      "The Librarian has not finished reading this video file yet.",
      409,
      "NOT_READ",
    );
  }

  const { filePath, fileStats } = await resolveScannedVideoPath(scannedFile);
  const metadata = await extractVideoMetadata(
    filePath,
    scannedFile.relativePath,
    fileStats,
  );
  const frames = defaultFrameDescriptions(metadata);
  const analysis = analyzeVideoContent(
    fileNameFromRelativePath(scannedFile.relativePath),
    scannedFile.relativePath,
    scannedFile.previewText ?? "",
    metadata,
    frames,
  );

  return {
    characterCount: scannedFile.previewText?.length ?? 0,
    extractedText: buildVideoReviewText({
      analysis,
      duplicate: {
        duplicateConfidence: null,
        duplicateKind: null,
        duplicateOfScannedFileId: null,
      },
      fileName: fileNameFromRelativePath(scannedFile.relativePath),
      frames,
      metadata,
      relativePath: scannedFile.relativePath,
      transcriptText: scannedFile.previewText ?? "",
    }),
    fileName: fileNameFromRelativePath(scannedFile.relativePath),
    fileType: scannedFile.fileType,
    relativePath: scannedFile.relativePath,
    scannedFileId: scannedFile.id,
    warnings: [
      "Full video transcription is temporary. This preview uses saved summary and snippet text when available.",
    ],
  } satisfies BridgeReadPreview;
}

export async function getScannedVideoPlaybackSource(scannedFileId: string) {
  const scannedFile = await scannedVideoFileForRead(scannedFileId);

  if (!scannedFile || !isVideoFileType(scannedFile.fileType)) {
    throw new BridgeVideoReaderError(
      "The Librarian could not find that video recording.",
      404,
      "NOT_FOUND",
    );
  }

  const { filePath, fileStats } = await resolveScannedVideoPath(scannedFile);

  return {
    contentType: videoMimeTypeForFileType(scannedFile.fileType),
    filePath,
    fileSize: fileStats.size,
    stream: () => createReadStream(filePath),
  };
}

export async function updateScannedVideoReviewState(input: {
  scannedFileId: string;
  labels?: VideoHumanLabel[];
  privacyState?: VideoPrivacyState;
}): Promise<BridgeScannedFileSummary> {
  const prisma = getPrismaClient();
  const scannedFile = await prisma.scannedFile.findUnique({
    include: {
      libraryDocument: {
        select: {
          observationSessions: {
            select: { status: true },
          },
        },
      },
      organizationSuggestions: {
        select: { status: true },
      },
      videoMetadata: true,
    },
    where: { id: input.scannedFileId },
  });

  if (!scannedFile || !isVideoFileType(scannedFile.fileType)) {
    throw new BridgeVideoReaderError(
      "The Librarian could not find that video recording.",
      404,
      "NOT_FOUND",
    );
  }

  const nextLabels = input.labels
    ? [...new Set(input.labels)]
    : jsonVideoHumanLabels(scannedFile.videoMetadata?.humanLabels ?? []);
  const existingPrivacy =
    scannedFile.videoMetadata?.privacyState === "PRIVATE" ||
    scannedFile.videoMetadata?.privacyState === "INTERNAL" ||
    scannedFile.videoMetadata?.privacyState === "REVIEW_REQUIRED" ||
    scannedFile.videoMetadata?.privacyState === "WEBSITE_CANDIDATE" ||
    scannedFile.videoMetadata?.privacyState === "APPROVED_FOR_PUBLIC_USE"
      ? scannedFile.videoMetadata.privacyState
      : "REVIEW_REQUIRED";
  const nextPrivacy = input.privacyState ?? existingPrivacy;

  await prisma.videoRecordingMetadata.upsert({
    create: {
      chapterSuggestions: toJsonInput([]),
      frameAnalysisStatus: "NOT_REQUESTED",
      humanLabels: toJsonInput(nextLabels),
      machineLabels: toJsonInput([]),
      privacyState: nextPrivacy,
      provisionalPeople: toJsonInput([]),
      provisionalProjects: toJsonInput([]),
      provisionalQuestions: toJsonInput([]),
      provisionalTopics: toJsonInput([]),
      relatedSignals: toJsonInput([]),
      scannedFileId: scannedFile.id,
      selectedFrameDescriptions: toJsonInput([]),
      transcriptionStatus: "NOT_REQUESTED",
    },
    update: {
      humanLabels: toJsonInput(nextLabels),
      privacyState: nextPrivacy,
    },
    where: { scannedFileId: scannedFile.id },
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
      libraryDocument: {
        select: {
          observationSessions: {
            select: { status: true },
          },
        },
      },
      organizationSuggestions: {
        select: { status: true },
      },
      videoMetadata: true,
    },
    where: { id: scannedFile.id },
  });

  return scannedFileSummary(refreshedFile);
}

export function normalizeVideoHumanLabelsInput(value: unknown): VideoHumanLabel[] {
  return [...new Set(jsonVideoHumanLabels(value))];
}

export function normalizeVideoPrivacyInput(value: unknown): VideoPrivacyState | null {
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

export function existingVideoHumanLabels(value: unknown) {
  return jsonStringArray(value);
}
