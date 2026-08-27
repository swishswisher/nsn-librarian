import { open, readFile } from "node:fs/promises";
import path from "node:path";

import mammoth from "mammoth";

import { BridgeAppError, type BridgeReadResult } from "../types";
import { resolveBridgeRootFile } from "./resolver";
import {
  extractAudioMetadata,
  supportedAudioFileTypeForPath,
} from "../../../src/lib/bridge/audio-metadata";
import {
  defaultFrameDescriptions,
  extractVideoMetadata,
  supportedVideoFileTypeForPath,
} from "../../../src/lib/bridge/video-metadata";

const documentExtensions = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".pdf",
  ".docx",
]);
const audioExtensions = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
const videoExtensions = new Set([".mp4", ".mov", ".m4v"]);
const readableExtensions = new Set([
  ...documentExtensions,
  ...audioExtensions,
  ...videoExtensions,
]);

function htmlToText(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function fileTypeForExtension(extension: string) {
  if (extension === ".txt") {
    return "TEXT";
  }

  if (extension === ".md" || extension === ".markdown") {
    return "MARKDOWN";
  }

  if (extension === ".html" || extension === ".htm") {
    return "HTML";
  }

  if (extension === ".pdf") {
    return "PDF";
  }

  if (extension === ".docx") {
    return "DOCX";
  }

  return "UNSUPPORTED";
}

function textOrUnknown(value: string | number | null) {
  return value === null || value === "" ? "not recorded" : String(value);
}

function secondsText(value: number | null) {
  return value === null ? "not recorded" : `${value} seconds`;
}

function arrayValue() {
  return [] as string[];
}

function mp4BrandText(buffer: Buffer) {
  return buffer.subarray(4, Math.min(buffer.length, 128)).toString("ascii");
}

function hasMp3Frame(buffer: Buffer) {
  for (let index = 0; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 0xff && (buffer[index + 1] & 0xe0) === 0xe0) {
      return true;
    }
  }

  return false;
}

function hasAdtsFrame(buffer: Buffer) {
  for (let index = 0; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 0xff && (buffer[index + 1] & 0xf0) === 0xf0) {
      return true;
    }
  }

  return false;
}

function looksLikeMp4Family(buffer: Buffer) {
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    return true;
  }

  return (
    buffer.indexOf("moov", 0, "ascii") >= 0 ||
    buffer.indexOf("mdat", 0, "ascii") >= 0
  );
}

function isValidAudioHeader(extension: string, buffer: Buffer) {
  if (extension === ".mp3") {
    return buffer.toString("ascii", 0, 3) === "ID3" || hasMp3Frame(buffer);
  }

  if (extension === ".wav") {
    return (
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WAVE"
    );
  }

  if (extension === ".m4a") {
    return looksLikeMp4Family(buffer) && /M4A|isom|mp4|qt  /i.test(mp4BrandText(buffer));
  }

  if (extension === ".aac") {
    return hasAdtsFrame(buffer);
  }

  if (extension === ".flac") {
    return buffer.toString("ascii", 0, 4) === "fLaC";
  }

  if (extension === ".ogg") {
    return buffer.toString("ascii", 0, 4) === "OggS";
  }

  return false;
}

function isValidVideoHeader(extension: string, buffer: Buffer) {
  if (!videoExtensions.has(extension)) {
    return false;
  }

  return looksLikeMp4Family(buffer);
}

async function readHeader(filePath: string, sizeBytes: bigint) {
  const byteLength = Math.min(Number(sizeBytes), 512 * 1024);
  const handle = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);

    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function buildAudioReviewText(input: {
  fileName: string;
  metadata: Awaited<ReturnType<typeof extractAudioMetadata>>;
  relativePath: string;
}) {
  return [
    "Audio review material for human review.",
    `File: ${input.fileName}`,
    `Relative path: ${input.relativePath}`,
    `Container: ${textOrUnknown(input.metadata.container)}`,
    `Codec: ${textOrUnknown(input.metadata.codec)}`,
    `Duration: ${secondsText(input.metadata.durationSeconds)}`,
    `Sample rate: ${textOrUnknown(input.metadata.sampleRateHz)}`,
    `Channels: ${textOrUnknown(input.metadata.channels)}`,
    "Transcript: unavailable. No transcript was invented.",
    "The Librarian recorded audio metadata only. Deanne should review this before it influences Memory or organization decisions.",
  ].join("\n");
}

function buildVideoReviewText(input: {
  fileName: string;
  metadata: Awaited<ReturnType<typeof extractVideoMetadata>>;
  relativePath: string;
}) {
  return [
    "Video review material for human review.",
    `File: ${input.fileName}`,
    `Relative path: ${input.relativePath}`,
    `Container: ${textOrUnknown(input.metadata.container)}`,
    `Codec: ${textOrUnknown(input.metadata.codec)}`,
    `Duration: ${secondsText(input.metadata.durationSeconds)}`,
    `Dimensions: ${
      input.metadata.width && input.metadata.height
        ? `${input.metadata.width} x ${input.metadata.height}`
        : "not recorded"
    }`,
    `Frame rate: ${textOrUnknown(input.metadata.frameRate)}`,
    `Audio track: ${
      input.metadata.hasAudioTrack === null
        ? "not recorded"
        : input.metadata.hasAudioTrack
          ? "detected"
          : "not detected"
    }`,
    "Transcript: unavailable. No transcript was invented.",
    "The Librarian recorded video metadata only. Deanne should review this before it influences Memory or organization decisions.",
  ].join("\n");
}

async function extractAudioReview(
  filePath: string,
  relativePath: string,
  fileName: string,
) {
  const metadata = await extractAudioMetadata(filePath, relativePath);
  const extractedText = buildAudioReviewText({
    fileName,
    metadata,
    relativePath,
  });

  return {
    characterCount: extractedText.length,
    extractedText,
    fileName,
    fileType: supportedAudioFileTypeForPath(relativePath) ?? "AUDIO",
    relativePath,
    warnings: [
      "Audio transcription was unavailable, so the Librarian used metadata and the file name only.",
    ],
    audioMetadata: {
      ...metadata,
      machineLabels: arrayValue(),
      provisionalActionItems: arrayValue(),
      provisionalPeople: arrayValue(),
      provisionalProjects: arrayValue(),
      provisionalQuestions: arrayValue(),
      provisionalTopics: arrayValue(),
      summary:
        "I recorded audio metadata for this file, but no transcript is available. Deanne can still review it before it influences organization.",
      transcriptSnippet: null,
      transcriptionConfidence: null,
      transcriptionErrorCategory: "AUDIO_TRANSCRIPTION_UNAVAILABLE",
      transcriptionStatus: "UNAVAILABLE" as const,
    },
  } satisfies BridgeReadResult;
}

async function extractVideoReview(
  filePath: string,
  relativePath: string,
  fileName: string,
) {
  const metadata = await extractVideoMetadata(filePath, relativePath);
  const frames = defaultFrameDescriptions(metadata);
  const extractedText = buildVideoReviewText({
    fileName,
    metadata,
    relativePath,
  });
  const transcriptionUnavailable =
    metadata.hasAudioTrack === false
      ? null
      : "VIDEO_TRANSCRIPTION_UNAVAILABLE";

  return {
    characterCount: extractedText.length,
    extractedText,
    fileName,
    fileType: supportedVideoFileTypeForPath(relativePath) ?? "VIDEO",
    relativePath,
    warnings:
      metadata.hasAudioTrack === false
        ? ["No audio track was detected, so transcription was skipped."]
        : [
            "Video transcription was unavailable, so the Librarian used metadata and the file name only.",
          ],
    videoMetadata: {
      ...metadata,
      chapterSuggestions: [],
      frameAnalysisErrorCategory: "VIDEO_FRAME_ANALYSIS_UNAVAILABLE",
      frameAnalysisStatus: "UNAVAILABLE" as const,
      machineLabels: arrayValue(),
      provisionalPeople: arrayValue(),
      provisionalProjects: arrayValue(),
      provisionalQuestions: arrayValue(),
      provisionalTopics: arrayValue(),
      relatedSignals: arrayValue(),
      selectedFrameDescriptions: frames,
      summary:
        "I recorded video metadata for this file, but no transcript is available. Deanne can still review it before it influences organization.",
      transcriptSnippet: null,
      transcriptionConfidence: null,
      transcriptionErrorCategory: transcriptionUnavailable,
      transcriptionStatus: "UNAVAILABLE" as const,
    },
  } satisfies BridgeReadResult;
}

async function extractText(filePath: string, extension: string) {
  if (extension === ".txt" || extension === ".md" || extension === ".markdown") {
    try {
      return {
        text: await readFile(filePath, "utf8"),
        warnings: [] as string[],
      };
    } catch {
      throw new BridgeAppError(
        "This file could not be read safely.",
        "FILE_UNREADABLE",
        422,
      );
    }
  }

  if (extension === ".html" || extension === ".htm") {
    try {
      return {
        text: htmlToText(await readFile(filePath, "utf8")),
        warnings: [] as string[],
      };
    } catch {
      throw new BridgeAppError(
        "This file could not be read safely.",
        "FILE_UNREADABLE",
        422,
      );
    }
  }

  if (extension === ".pdf") {
    let parser: {
      destroy: () => Promise<void>;
      getText: () => Promise<{ text: string }>;
    } | null = null;

    try {
      // Keep the PDF runtime out of the Vercel web application's startup path.
      // It is needed only by the local Bridge when Deanne explicitly reads a PDF.
      const [{ CanvasFactory }, { PDFParse }] = await Promise.all([
        import("pdf-parse/worker"),
        import("pdf-parse"),
      ]);
      const buffer = await readFile(filePath);
      parser = new PDFParse({
        CanvasFactory,
        data: new Uint8Array(buffer),
        isEvalSupported: false,
        useWorkerFetch: false,
      });
      const pdf = await parser.getText();

      return {
        text: pdf.text,
        warnings: [] as string[],
      };
    } catch (error) {
      if (error instanceof BridgeAppError) {
        throw error;
      }

      throw new BridgeAppError(
        "This PDF appears damaged or could not be read safely.",
        "PDF_PARSE_FAILED",
        422,
      );
    } finally {
      await parser?.destroy().catch(() => undefined);
    }
  }

  if (extension === ".docx") {
    let result;

    try {
      result = await mammoth.extractRawText({ path: filePath });
    } catch {
      throw new BridgeAppError(
        "This file appears damaged or could not be read safely.",
        "FILE_CORRUPT",
        422,
      );
    }

    return {
      text: result.value,
      warnings: result.messages.map((message) => message.message),
    };
  }

  throw new BridgeAppError(
    "Unsupported for reading.",
    "UNSUPPORTED_FILE_TYPE",
    409,
  );
}

export async function readBridgeRootFile(
  rootId: string,
  relativePath: string,
): Promise<BridgeReadResult> {
  const safeFile = await resolveBridgeRootFile(rootId, relativePath);
  const extension = path.posix.extname(safeFile.relativePath).toLowerCase();

  if (!readableExtensions.has(extension)) {
    throw new BridgeAppError(
      "Unsupported for reading.",
      "UNSUPPORTED_FILE_TYPE",
      409,
    );
  }

  if (audioExtensions.has(extension)) {
    const header = await readHeader(safeFile.localPath, safeFile.sizeBytes);

    if (!isValidAudioHeader(extension, header)) {
      throw new BridgeAppError(
        "This audio file appears damaged or could not be read safely.",
        "AUDIO_DECODE_FAILED",
        422,
      );
    }

    return extractAudioReview(
      safeFile.localPath,
      safeFile.relativePath,
      safeFile.fileName,
    );
  }

  if (videoExtensions.has(extension)) {
    const header = await readHeader(safeFile.localPath, safeFile.sizeBytes);

    if (!isValidVideoHeader(extension, header)) {
      throw new BridgeAppError(
        "This video file appears damaged or could not be read safely.",
        "VIDEO_DECODE_FAILED",
        422,
      );
    }

    return extractVideoReview(
      safeFile.localPath,
      safeFile.relativePath,
      safeFile.fileName,
    );
  }

  const result = await extractText(safeFile.localPath, extension);
  const extractedText = result.text.trim();

  if (!extractedText) {
    const emptyFile = safeFile.sizeBytes === BigInt(0);

    throw new BridgeAppError(
      emptyFile
        ? "This file is empty."
        : "The Bridge could not find readable text in this file.",
      emptyFile ? "FILE_EMPTY" : "FILE_UNREADABLE",
      422,
    );
  }

  return {
    characterCount: extractedText.length,
    extractedText,
    fileName: safeFile.fileName,
    fileType: fileTypeForExtension(extension),
    relativePath: safeFile.relativePath,
    warnings: result.warnings,
  };
}
