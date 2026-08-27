import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import type {
  BridgeVideoChapterSuggestion,
  BridgeVideoFrameDescription,
  BridgeVideoMetadataDraft,
  BridgeVideoMetadataSummary,
  VideoHumanLabel,
  VideoPrivacyState,
  VideoProcessingStatus,
} from "./types";

const supportedVideoExtensions = new Map<string, string>([
  [".mp4", "VIDEO_MP4"],
  [".mov", "VIDEO_MOV"],
  [".m4v", "VIDEO_M4V"],
  [".avi", "VIDEO_AVI"],
  [".mkv", "VIDEO_MKV"],
  [".webm", "VIDEO_WEBM"],
]);

const videoPrivacyStates = new Set<VideoPrivacyState>([
  "PRIVATE",
  "INTERNAL",
  "REVIEW_REQUIRED",
  "WEBSITE_CANDIDATE",
  "APPROVED_FOR_PUBLIC_USE",
]);

const videoProcessingStatuses = new Set<VideoProcessingStatus>([
  "NOT_REQUESTED",
  "PROCESSING",
  "COMPLETED",
  "UNAVAILABLE",
  "FAILED",
]);

const videoHumanLabels = new Set<VideoHumanLabel>([
  "WORKSHOP",
  "PRESENTATION",
  "WEBSITE",
  "INTERNAL",
  "PRIVATE",
  "INTERVIEW",
  "WEBINAR",
  "TRAINING",
  "ARCHIVE",
  "DUPLICATE_CANDIDATE",
]);

type ParsedVideoMetadata = Pick<
  BridgeVideoMetadataDraft,
  | "bitrateKbps"
  | "codec"
  | "container"
  | "durationSeconds"
  | "frameRate"
  | "hasAudioTrack"
  | "height"
  | "width"
>;

type FfprobeStream = {
  codec_name?: unknown;
  codec_type?: unknown;
  width?: unknown;
  height?: unknown;
  avg_frame_rate?: unknown;
  r_frame_rate?: unknown;
};

type FfprobeOutput = {
  format?: {
    bit_rate?: unknown;
    duration?: unknown;
    format_name?: unknown;
  };
  streams?: FfprobeStream[];
};

export function supportedVideoFileTypeForPath(fileName: string) {
  return supportedVideoExtensions.get(path.extname(fileName).toLowerCase()) ?? null;
}

export function isVideoFileType(fileType: string) {
  return fileType.startsWith("VIDEO_");
}

export function videoMimeTypeForExtension(extension: string | null) {
  if (extension === "mp4" || extension === "m4v") {
    return "video/mp4";
  }

  if (extension === "mov") {
    return "video/quicktime";
  }

  if (extension === "avi") {
    return "video/x-msvideo";
  }

  if (extension === "mkv") {
    return "video/x-matroska";
  }

  if (extension === "webm") {
    return "video/webm";
  }

  return null;
}

export function videoMimeTypeForFileType(fileType: string) {
  if (fileType === "VIDEO_MP4" || fileType === "VIDEO_M4V") {
    return "video/mp4";
  }

  if (fileType === "VIDEO_MOV") {
    return "video/quicktime";
  }

  if (fileType === "VIDEO_AVI") {
    return "video/x-msvideo";
  }

  if (fileType === "VIDEO_MKV") {
    return "video/x-matroska";
  }

  if (fileType === "VIDEO_WEBM") {
    return "video/webm";
  }

  return "application/octet-stream";
}

function nullablePositiveNumber(value: unknown) {
  const numberValue =
    typeof value === "string" ? Number.parseFloat(value) : Number(value);

  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function nullablePositiveInt(value: unknown) {
  const numberValue = nullablePositiveNumber(value);

  return numberValue === null ? null : Math.round(numberValue);
}

function roundNullable(value: number | null, decimals = 2) {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  const scale = 10 ** decimals;

  return Math.round(value * scale) / scale;
}

function fractionToNumber(value: unknown) {
  if (typeof value !== "string" || !value.includes("/")) {
    return nullablePositiveNumber(value);
  }

  const [numerator, denominator] = value.split("/").map(Number);

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }

  return numerator / denominator;
}

function normalizeMetadata(
  parsed: Partial<ParsedVideoMetadata>,
  fallbackContainer: string,
): ParsedVideoMetadata {
  return {
    bitrateKbps:
      parsed.bitrateKbps === null || parsed.bitrateKbps === undefined
        ? null
        : nullablePositiveInt(parsed.bitrateKbps),
    codec: parsed.codec ?? null,
    container: parsed.container ?? fallbackContainer,
    durationSeconds: roundNullable(parsed.durationSeconds ?? null, 1),
    frameRate: roundNullable(parsed.frameRate ?? null, 2),
    hasAudioTrack: parsed.hasAudioTrack ?? null,
    height: nullablePositiveInt(parsed.height),
    width: nullablePositiveInt(parsed.width),
  };
}

function configuredFfprobePath() {
  return process.env.NSN_VIDEO_FFPROBE_PATH?.trim() || "ffprobe";
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: true; stdout: string } | { ok: false }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let finished = false;
    const timeout = setTimeout(() => {
      if (!finished) {
        child.kill("SIGKILL");
        finished = true;
        resolve({ ok: false });
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (!finished) {
        clearTimeout(timeout);
        finished = true;
        resolve({ ok: false });
      }
    });
    child.on("close", (code) => {
      if (!finished) {
        clearTimeout(timeout);
        finished = true;
        resolve(code === 0 ? { ok: true, stdout } : { ok: false });
      }
    });
  });
}

async function ffprobeMetadata(filePath: string) {
  const result = await runProcess(
    configuredFfprobePath(),
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,bit_rate,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate",
      "-of",
      "json",
      filePath,
    ],
    8_000,
  );

  if (!result.ok) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout) as FfprobeOutput;
    const streams = parsed.streams ?? [];
    const videoStream = streams.find((stream) => stream.codec_type === "video");
    const hasAudioTrack = streams.some((stream) => stream.codec_type === "audio");
    const frameRate =
      fractionToNumber(videoStream?.avg_frame_rate) ??
      fractionToNumber(videoStream?.r_frame_rate);
    const bitRate = nullablePositiveNumber(parsed.format?.bit_rate);
    const formatName =
      typeof parsed.format?.format_name === "string"
        ? parsed.format.format_name.split(",")[0]
        : null;

    return normalizeMetadata(
      {
        bitrateKbps: bitRate ? bitRate / 1000 : null,
        codec:
          typeof videoStream?.codec_name === "string"
            ? videoStream.codec_name
            : null,
        container: formatName?.toUpperCase() ?? null,
        durationSeconds: nullablePositiveNumber(parsed.format?.duration),
        frameRate,
        hasAudioTrack,
        height: nullablePositiveInt(videoStream?.height),
        width: nullablePositiveInt(videoStream?.width),
      },
      "VIDEO",
    );
  } catch {
    return null;
  }
}

async function readRange(filePath: string, length: number, position = 0) {
  const handle = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);

    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function readUInt64BEAsNumber(buffer: Buffer, offset: number) {
  if (offset + 8 > buffer.length) {
    return null;
  }

  const value =
    (BigInt(buffer.readUInt32BE(offset)) << BigInt(32)) |
    BigInt(buffer.readUInt32BE(offset + 4));

  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

function parseMp4Like(buffer: Buffer, fallbackContainer: string): ParsedVideoMetadata {
  let offset = 0;
  let durationSeconds: number | null = null;
  const trackText = buffer.toString("ascii");
  const hasAudioTrack = trackText.includes("soun")
    ? true
    : trackText.includes("vide")
      ? false
      : null;

  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const atomSize = size === 1 ? readUInt64BEAsNumber(buffer, offset + 8) : size;
    const headerSize = size === 1 ? 16 : 8;

    if (!atomSize || atomSize < headerSize || offset + atomSize > buffer.length) {
      break;
    }

    if (type === "mvhd") {
      const version = buffer[offset + headerSize];
      const timescaleOffset = offset + headerSize + (version === 1 ? 20 : 12);
      const durationOffset = offset + headerSize + (version === 1 ? 24 : 16);
      const timescale =
        timescaleOffset + 4 <= buffer.length
          ? buffer.readUInt32BE(timescaleOffset)
          : 0;
      const duration =
        version === 1
          ? readUInt64BEAsNumber(buffer, durationOffset)
          : durationOffset + 4 <= buffer.length
            ? buffer.readUInt32BE(durationOffset)
            : null;

      durationSeconds =
        timescale > 0 && duration !== null ? duration / timescale : null;
      break;
    }

    if (type === "moov" || type === "trak") {
      const child = parseMp4Like(
        buffer.subarray(offset + headerSize, offset + atomSize),
        fallbackContainer,
      );

      if (child.durationSeconds) {
        return normalizeMetadata(
          {
            ...child,
            hasAudioTrack: child.hasAudioTrack ?? hasAudioTrack,
          },
          fallbackContainer,
        );
      }
    }

    offset += atomSize;
  }

  return normalizeMetadata(
    {
      container: fallbackContainer,
      durationSeconds,
      hasAudioTrack,
    },
    fallbackContainer,
  );
}

function parseAvi(buffer: Buffer): ParsedVideoMetadata {
  const avihOffset = buffer.indexOf("avih", 0, "ascii");

  if (avihOffset < 0 || avihOffset + 56 > buffer.length) {
    return normalizeMetadata({ container: "AVI" }, "AVI");
  }

  const dataOffset = avihOffset + 8;
  const microsecondsPerFrame = buffer.readUInt32LE(dataOffset);
  const totalFrames = buffer.readUInt32LE(dataOffset + 16);
  const width = buffer.readUInt32LE(dataOffset + 32);
  const height = buffer.readUInt32LE(dataOffset + 36);
  const frameRate =
    microsecondsPerFrame > 0 ? 1_000_000 / microsecondsPerFrame : null;

  return normalizeMetadata(
    {
      container: "AVI",
      durationSeconds:
        frameRate && totalFrames > 0 ? totalFrames / frameRate : null,
      frameRate,
      height,
      width,
    },
    "AVI",
  );
}

async function parseVideoFallback(
  filePath: string,
  relativePath: string,
): Promise<ParsedVideoMetadata> {
  const extension = path.extname(relativePath).toLowerCase();
  const head = await readRange(filePath, 512 * 1024, 0);

  if (extension === ".avi" && head.toString("ascii", 0, 4) === "RIFF") {
    return parseAvi(head);
  }

  if ([".mp4", ".mov", ".m4v"].includes(extension)) {
    return parseMp4Like(head, extension === ".mov" ? "MOV" : "MP4");
  }

  if (extension === ".webm") {
    return normalizeMetadata({ container: "WEBM" }, "WEBM");
  }

  if (extension === ".mkv") {
    return normalizeMetadata({ container: "MKV" }, "MKV");
  }

  return normalizeMetadata({}, supportedVideoFileTypeForPath(relativePath) ?? "VIDEO");
}

export function videoFingerprintFor(metadata: {
  durationSeconds: number | null;
  frameRate: number | null;
  height: number | null;
  fileType: string;
  sizeBytes: bigint | number | null;
  width: number | null;
}) {
  const durationBucket =
    metadata.durationSeconds === null
      ? "unknown"
      : Math.round(metadata.durationSeconds / 3).toString();
  const sizeBucket =
    metadata.sizeBytes === null
      ? "unknown"
      : Math.round(Number(metadata.sizeBytes) / 250_000).toString();

  return createHash("sha256")
    .update(
      [
        metadata.fileType,
        durationBucket,
        metadata.width ?? "unknown",
        metadata.height ?? "unknown",
        metadata.frameRate ? Math.round(metadata.frameRate) : "unknown",
        sizeBucket,
      ].join("\u001f"),
    )
    .digest("hex");
}

export async function extractVideoMetadata(
  filePath: string,
  relativePath: string,
  fileStats?: Stats,
): Promise<BridgeVideoMetadataDraft> {
  const stats = fileStats ?? (await stat(filePath));
  const fileType = supportedVideoFileTypeForPath(relativePath) ?? "VIDEO";
  const parsed =
    (await ffprobeMetadata(filePath)) ??
    (await parseVideoFallback(filePath, relativePath).catch(() =>
      normalizeMetadata({}, fileType),
    ));

  return {
    ...parsed,
    sourceCreatedAt: stats.birthtime,
    sourceModifiedAt: stats.mtime,
    videoFingerprint: videoFingerprintFor({
      durationSeconds: parsed.durationSeconds,
      fileType,
      frameRate: parsed.frameRate,
      height: parsed.height,
      sizeBytes: BigInt(stats.size),
      width: parsed.width,
    }),
  };
}

export function videoSampleTimestamps(durationSeconds: number | null) {
  if (!durationSeconds || durationSeconds < 4) {
    return [0];
  }

  const ending = Math.max(0, durationSeconds - 1);
  const timestamps = [0, durationSeconds * 0.25, durationSeconds * 0.5, durationSeconds * 0.75, ending];

  return [...new Set(timestamps.map((timestamp) => Math.round(timestamp)))]
    .filter((timestamp) => timestamp >= 0 && timestamp <= durationSeconds)
    .slice(0, 5);
}

export function defaultFrameDescriptions(
  metadata: BridgeVideoMetadataDraft,
): BridgeVideoFrameDescription[] {
  return videoSampleTimestamps(metadata.durationSeconds).map((timestamp, index) => ({
    confidence: 0.38,
    description:
      index === 0
        ? "Opening frame selected for human review."
        : index === 4
          ? "Closing frame selected for human review."
          : "Representative frame selected for human review.",
    label: index === 0 ? "Opening frame" : index === 4 ? "Closing frame" : "Representative frame",
    timestampSeconds: timestamp,
  }));
}

export function jsonStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function jsonVideoHumanLabels(value: unknown): VideoHumanLabel[] {
  return jsonStringArray(value).filter((label): label is VideoHumanLabel =>
    videoHumanLabels.has(label as VideoHumanLabel),
  );
}

function jsonChapterSuggestions(value: unknown): BridgeVideoChapterSuggestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): BridgeVideoChapterSuggestion | null => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return null;
      }

      const record = item as Record<string, unknown>;
      const timestampSeconds = nullablePositiveNumber(record.timestampSeconds) ?? 0;
      const title = typeof record.title === "string" ? record.title : "";
      const confidence = nullablePositiveNumber(record.confidence) ?? 0.4;

      if (!title.trim()) {
        return null;
      }

      return {
        confidence: Math.min(0.95, Math.max(0.2, confidence)),
        timestampSeconds,
        title,
      };
    })
    .filter((item): item is BridgeVideoChapterSuggestion => item !== null);
}

function jsonFrameDescriptions(value: unknown): BridgeVideoFrameDescription[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): BridgeVideoFrameDescription | null => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return null;
      }

      const record = item as Record<string, unknown>;
      const timestampSeconds = nullablePositiveNumber(record.timestampSeconds) ?? 0;
      const label = typeof record.label === "string" ? record.label : "";
      const description =
        typeof record.description === "string" ? record.description : "";
      const confidence = nullablePositiveNumber(record.confidence) ?? 0.35;

      if (!label.trim() || !description.trim()) {
        return null;
      }

      return {
        confidence: Math.min(0.95, Math.max(0.2, confidence)),
        description,
        label,
        timestampSeconds,
      };
    })
    .filter((item): item is BridgeVideoFrameDescription => item !== null);
}

export function normalizeVideoPrivacyState(value: unknown): VideoPrivacyState {
  return typeof value === "string" && videoPrivacyStates.has(value as VideoPrivacyState)
    ? (value as VideoPrivacyState)
    : "REVIEW_REQUIRED";
}

export function normalizeVideoProcessingStatus(
  value: unknown,
): VideoProcessingStatus {
  return typeof value === "string" &&
    videoProcessingStatuses.has(value as VideoProcessingStatus)
    ? (value as VideoProcessingStatus)
    : "NOT_REQUESTED";
}

export function videoMetadataSummary(value: {
  bitrateKbps: number | null;
  chapterSuggestions: unknown;
  codec: string | null;
  container: string | null;
  duplicateConfidence: number | null;
  duplicateKind: string | null;
  duplicateOfScannedFileId: string | null;
  durationSeconds: number | null;
  frameAnalysisErrorCategory: string | null;
  frameAnalysisStatus: string;
  frameRate: number | null;
  hasAudioTrack: boolean | null;
  height: number | null;
  humanLabels: unknown;
  machineLabels: unknown;
  privacyState: string;
  provisionalPeople: unknown;
  provisionalProjects: unknown;
  provisionalQuestions: unknown;
  provisionalTopics: unknown;
  relatedSignals: unknown;
  selectedFrameDescriptions: unknown;
  sourceCreatedAt: Date | null;
  sourceModifiedAt: Date | null;
  summary: string | null;
  transcriptionConfidence: number | null;
  transcriptionErrorCategory: string | null;
  transcriptionStatus: string;
  transcriptSnippet: string | null;
  videoFingerprint: string | null;
  width: number | null;
}): BridgeVideoMetadataSummary {
  return {
    bitrateKbps: value.bitrateKbps,
    chapterSuggestions: jsonChapterSuggestions(value.chapterSuggestions),
    codec: value.codec,
    container: value.container,
    duplicateConfidence: value.duplicateConfidence,
    duplicateKind: value.duplicateKind,
    duplicateOfScannedFileId: value.duplicateOfScannedFileId,
    durationSeconds: value.durationSeconds,
    frameAnalysisErrorCategory: value.frameAnalysisErrorCategory,
    frameAnalysisStatus: normalizeVideoProcessingStatus(value.frameAnalysisStatus),
    frameRate: value.frameRate,
    hasAudioTrack: value.hasAudioTrack,
    height: value.height,
    humanLabels: jsonVideoHumanLabels(value.humanLabels),
    machineLabels: jsonStringArray(value.machineLabels),
    privacyState: normalizeVideoPrivacyState(value.privacyState),
    provisionalPeople: jsonStringArray(value.provisionalPeople),
    provisionalProjects: jsonStringArray(value.provisionalProjects),
    provisionalQuestions: jsonStringArray(value.provisionalQuestions),
    provisionalTopics: jsonStringArray(value.provisionalTopics),
    relatedSignals: jsonStringArray(value.relatedSignals),
    selectedFrameDescriptions: jsonFrameDescriptions(
      value.selectedFrameDescriptions,
    ),
    sourceCreatedAt: value.sourceCreatedAt?.toISOString() ?? null,
    sourceModifiedAt: value.sourceModifiedAt?.toISOString() ?? null,
    summary: value.summary,
    transcriptionConfidence: value.transcriptionConfidence,
    transcriptionErrorCategory: value.transcriptionErrorCategory,
    transcriptionStatus: normalizeVideoProcessingStatus(value.transcriptionStatus),
    transcriptSnippet: value.transcriptSnippet,
    videoFingerprint: value.videoFingerprint,
    width: value.width,
  };
}
