import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";

import type {
  AudioHumanLabel,
  AudioPrivacyState,
  AudioTranscriptionStatus,
  BridgeAudioMetadataDraft,
  BridgeAudioMetadataSummary,
} from "./types";

const supportedAudioExtensions = new Map<string, string>([
  [".mp3", "AUDIO_MP3"],
  [".wav", "AUDIO_WAV"],
  [".m4a", "AUDIO_M4A"],
  [".aac", "AUDIO_AAC"],
  [".flac", "AUDIO_FLAC"],
  [".ogg", "AUDIO_OGG"],
]);

const audioTranscriptionStatuses = new Set<AudioTranscriptionStatus>([
  "NOT_REQUESTED",
  "TRANSCRIBING",
  "COMPLETED",
  "UNAVAILABLE",
  "FAILED",
]);

const audioPrivacyStates = new Set<AudioPrivacyState>([
  "PRIVATE",
  "INTERNAL",
  "REVIEW_REQUIRED",
  "WEBSITE_CANDIDATE",
  "APPROVED_FOR_PUBLIC_USE",
]);

const audioHumanLabels = new Set<AudioHumanLabel>([
  "WORKSHOP",
  "CLIENT",
  "PRIVATE",
  "WEBSITE",
  "PODCAST",
  "MEETING",
  "RESEARCH",
  "ARCHIVE",
]);

type ParsedAudioMetadata = Pick<
  BridgeAudioMetadataDraft,
  "bitrateKbps" | "channels" | "codec" | "container" | "durationSeconds" | "sampleRateHz"
>;

export function supportedAudioFileTypeForPath(fileName: string) {
  return supportedAudioExtensions.get(path.extname(fileName).toLowerCase()) ?? null;
}

export function isSupportedAudioExtension(fileName: string) {
  return supportedAudioFileTypeForPath(fileName) !== null;
}

export function isAudioFileType(fileType: string) {
  return fileType.startsWith("AUDIO_");
}

export function audioMimeTypeForExtension(extension: string | null) {
  if (extension === "mp3") {
    return "audio/mpeg";
  }

  if (extension === "wav") {
    return "audio/wav";
  }

  if (extension === "m4a") {
    return "audio/mp4";
  }

  if (extension === "aac") {
    return "audio/aac";
  }

  if (extension === "flac") {
    return "audio/flac";
  }

  if (extension === "ogg") {
    return "audio/ogg";
  }

  return null;
}

function clampSeconds(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value * 10) / 10;
}

function nullablePositiveInt(value: number | null | undefined) {
  return value && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function normalizeMetadata(
  parsed: Partial<ParsedAudioMetadata>,
  fallbackContainer: string,
): ParsedAudioMetadata {
  return {
    bitrateKbps: nullablePositiveInt(parsed.bitrateKbps),
    channels: nullablePositiveInt(parsed.channels),
    codec: parsed.codec ?? fallbackContainer,
    container: parsed.container ?? fallbackContainer,
    durationSeconds: clampSeconds(parsed.durationSeconds ?? null),
    sampleRateHz: nullablePositiveInt(parsed.sampleRateHz),
  };
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

async function readHead(filePath: string, length = 256 * 1024) {
  return readRange(filePath, length, 0);
}

async function readTail(filePath: string, size: number, length = 128 * 1024) {
  const safeLength = Math.min(length, size);

  return readRange(filePath, safeLength, Math.max(0, size - safeLength));
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

function readUInt64LEAsNumber(buffer: Buffer, offset: number) {
  if (offset + 8 > buffer.length) {
    return null;
  }

  const value =
    BigInt(buffer.readUInt32LE(offset)) |
    (BigInt(buffer.readUInt32LE(offset + 4)) << BigInt(32));

  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

function parseWav(buffer: Buffer, sizeBytes: number): ParsedAudioMetadata {
  let offset = 12;
  let byteRate: number | null = null;
  let dataSize: number | null = null;
  let sampleRateHz: number | null = null;
  let channels: number | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === "fmt " && chunkStart + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRateHz = buffer.readUInt32LE(chunkStart + 4);
      byteRate = buffer.readUInt32LE(chunkStart + 8);
    }

    if (chunkId === "data") {
      dataSize = chunkSize;
      break;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  const durationSeconds =
    byteRate && dataSize ? dataSize / byteRate : byteRate ? sizeBytes / byteRate : null;

  return normalizeMetadata(
    {
      bitrateKbps: byteRate ? (byteRate * 8) / 1000 : null,
      channels,
      codec: "PCM",
      container: "WAV",
      durationSeconds,
      sampleRateHz,
    },
    "WAV",
  );
}

function parseMp3Frame(buffer: Buffer, offset: number) {
  if (offset + 4 > buffer.length || buffer[offset] !== 0xff) {
    return null;
  }

  const second = buffer[offset + 1];

  if ((second & 0xe0) !== 0xe0) {
    return null;
  }

  const versionBits = (second >> 3) & 0x03;
  const layerBits = (second >> 1) & 0x03;
  const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (buffer[offset + 2] >> 2) & 0x03;
  const channelMode = (buffer[offset + 3] >> 6) & 0x03;

  if (
    versionBits === 1 ||
    layerBits !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3
  ) {
    return null;
  }

  const bitrates =
    versionBits === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRates =
    versionBits === 3
      ? [44100, 48000, 32000]
      : versionBits === 2
        ? [22050, 24000, 16000]
        : [11025, 12000, 8000];

  return {
    bitrateKbps: bitrates[bitrateIndex] ?? null,
    channels: channelMode === 3 ? 1 : 2,
    sampleRateHz: sampleRates[sampleRateIndex] ?? null,
  };
}

function parseMp3(buffer: Buffer, sizeBytes: number): ParsedAudioMetadata {
  let offset = 0;

  if (buffer.toString("ascii", 0, 3) === "ID3" && buffer.length >= 10) {
    offset =
      10 +
      ((buffer[6] & 0x7f) << 21) +
      ((buffer[7] & 0x7f) << 14) +
      ((buffer[8] & 0x7f) << 7) +
      (buffer[9] & 0x7f);
  }

  for (let index = offset; index < buffer.length - 4; index += 1) {
    const frame = parseMp3Frame(buffer, index);

    if (!frame?.bitrateKbps) {
      continue;
    }

    return normalizeMetadata(
      {
        ...frame,
        codec: "MP3",
        container: "MP3",
        durationSeconds: (sizeBytes * 8) / (frame.bitrateKbps * 1000),
      },
      "MP3",
    );
  }

  return normalizeMetadata({ codec: "MP3", container: "MP3" }, "MP3");
}

function parseFlac(buffer: Buffer): ParsedAudioMetadata {
  if (buffer.toString("ascii", 0, 4) !== "fLaC" || buffer.length < 42) {
    return normalizeMetadata({ codec: "FLAC", container: "FLAC" }, "FLAC");
  }

  const streamInfoStart = 8;
  const combined =
    (BigInt(buffer.readUInt32BE(streamInfoStart + 10)) << BigInt(32)) |
    BigInt(buffer.readUInt32BE(streamInfoStart + 14));
  const sampleRateHz = Number((combined >> BigInt(44)) & BigInt(0xfffff));
  const channels = Number((combined >> BigInt(41)) & BigInt(0x7)) + 1;
  const totalSamples = Number(combined & BigInt("0xfffffffff"));

  return normalizeMetadata(
    {
      channels,
      codec: "FLAC",
      container: "FLAC",
      durationSeconds:
        sampleRateHz > 0 && totalSamples > 0 ? totalSamples / sampleRateHz : null,
      sampleRateHz,
    },
    "FLAC",
  );
}

function parseAdtsAac(buffer: Buffer, sizeBytes: number): ParsedAudioMetadata {
  const sampleRates = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
    8000, 7350,
  ];

  for (let offset = 0; offset < buffer.length - 7; offset += 1) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xf0) !== 0xf0) {
      continue;
    }

    const sampleRateIndex = (buffer[offset + 2] >> 2) & 0x0f;
    const sampleRateHz = sampleRates[sampleRateIndex] ?? null;
    const channels =
      ((buffer[offset + 2] & 0x01) << 2) | ((buffer[offset + 3] >> 6) & 0x03);
    const frameLength =
      ((buffer[offset + 3] & 0x03) << 11) |
      (buffer[offset + 4] << 3) |
      ((buffer[offset + 5] >> 5) & 0x07);
    const estimatedFrames =
      frameLength > 0 ? Math.max(1, Math.floor(sizeBytes / frameLength)) : null;
    const durationSeconds =
      sampleRateHz && estimatedFrames ? (estimatedFrames * 1024) / sampleRateHz : null;

    return normalizeMetadata(
      {
        bitrateKbps: durationSeconds ? (sizeBytes * 8) / durationSeconds / 1000 : null,
        channels,
        codec: "AAC",
        container: "AAC",
        durationSeconds,
        sampleRateHz,
      },
      "AAC",
    );
  }

  return normalizeMetadata({ codec: "AAC", container: "AAC" }, "AAC");
}

function parseMp4(buffer: Buffer): ParsedAudioMetadata {
  let offset = 0;
  let durationSeconds: number | null = null;

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
      const child = parseMp4(buffer.subarray(offset + headerSize, offset + atomSize));

      if (child.durationSeconds) {
        return child;
      }
    }

    offset += atomSize;
  }

  return normalizeMetadata(
    {
      codec: "AAC",
      container: "M4A",
      durationSeconds,
    },
    "M4A",
  );
}

async function parseOgg(
  head: Buffer,
  filePath: string,
  sizeBytes: number,
): Promise<ParsedAudioMetadata> {
  const opusOffset = head.indexOf("OpusHead", 0, "ascii");
  const vorbisOffset = head.indexOf("vorbis", 0, "ascii");
  let channels: number | null = null;
  let sampleRateHz: number | null = null;
  let codec = "OGG";

  if (opusOffset >= 0 && opusOffset + 16 <= head.length) {
    codec = "Opus";
    channels = head[opusOffset + 9] ?? null;
    sampleRateHz = head.readUInt32LE(opusOffset + 12) || 48000;
  } else if (vorbisOffset >= 0 && vorbisOffset + 16 <= head.length) {
    codec = "Vorbis";
    channels = head[vorbisOffset + 11] ?? null;
    sampleRateHz = head.readUInt32LE(vorbisOffset + 12);
  }

  let durationSeconds: number | null = null;
  const tail = await readTail(filePath, sizeBytes);
  const lastPage = tail.lastIndexOf("OggS", undefined, "ascii");

  if (lastPage >= 0) {
    const granule = readUInt64LEAsNumber(tail, lastPage + 6);

    if (granule && sampleRateHz) {
      durationSeconds = granule / sampleRateHz;
    }
  }

  return normalizeMetadata(
    {
      channels,
      codec,
      container: "OGG",
      durationSeconds,
      sampleRateHz,
    },
    "OGG",
  );
}

async function parseAudioFile(
  filePath: string,
  relativePath: string,
  sizeBytes: number,
): Promise<ParsedAudioMetadata> {
  const extension = path.extname(relativePath).toLowerCase();
  const head = await readHead(filePath);

  if (extension === ".wav" && head.toString("ascii", 0, 4) === "RIFF") {
    return parseWav(head, sizeBytes);
  }

  if (extension === ".mp3") {
    return parseMp3(head, sizeBytes);
  }

  if (extension === ".flac") {
    return parseFlac(head);
  }

  if (extension === ".aac") {
    return parseAdtsAac(head, sizeBytes);
  }

  if (extension === ".ogg") {
    return parseOgg(head, filePath, sizeBytes);
  }

  if (extension === ".m4a") {
    return parseMp4(head);
  }

  return normalizeMetadata({}, supportedAudioFileTypeForPath(relativePath) ?? "AUDIO");
}

export function audioFingerprintFor(metadata: {
  durationSeconds: number | null;
  sampleRateHz: number | null;
  channels: number | null;
  fileType: string;
  sizeBytes: bigint | number | null;
}) {
  const durationBucket =
    metadata.durationSeconds === null
      ? "unknown"
      : Math.round(metadata.durationSeconds / 2).toString();
  const sizeBucket =
    metadata.sizeBytes === null
      ? "unknown"
      : Math.round(Number(metadata.sizeBytes) / 50_000).toString();

  return createHash("sha256")
    .update(
      [
        metadata.fileType,
        durationBucket,
        metadata.sampleRateHz ?? "unknown",
        metadata.channels ?? "unknown",
        sizeBucket,
      ].join("\u001f"),
    )
    .digest("hex");
}

export async function extractAudioMetadata(
  filePath: string,
  relativePath: string,
  fileStats?: Stats,
): Promise<BridgeAudioMetadataDraft> {
  const stats = fileStats ?? (await stat(filePath));
  const fileType = supportedAudioFileTypeForPath(relativePath) ?? "AUDIO";
  const parsed = await parseAudioFile(filePath, relativePath, stats.size).catch(() =>
    normalizeMetadata({}, fileType),
  );

  return {
    ...parsed,
    audioFingerprint: audioFingerprintFor({
      channels: parsed.channels,
      durationSeconds: parsed.durationSeconds,
      fileType,
      sampleRateHz: parsed.sampleRateHz,
      sizeBytes: BigInt(stats.size),
    }),
    sourceCreatedAt: stats.birthtime,
    sourceModifiedAt: stats.mtime,
  };
}

export function jsonStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function jsonAudioHumanLabels(value: unknown): AudioHumanLabel[] {
  return jsonStringArray(value).filter((label): label is AudioHumanLabel =>
    audioHumanLabels.has(label as AudioHumanLabel),
  );
}

export function normalizeAudioPrivacyState(value: unknown): AudioPrivacyState {
  return typeof value === "string" && audioPrivacyStates.has(value as AudioPrivacyState)
    ? (value as AudioPrivacyState)
    : "REVIEW_REQUIRED";
}

export function normalizeAudioTranscriptionStatus(
  value: unknown,
): AudioTranscriptionStatus {
  return typeof value === "string" &&
    audioTranscriptionStatuses.has(value as AudioTranscriptionStatus)
    ? (value as AudioTranscriptionStatus)
    : "NOT_REQUESTED";
}

export function audioMetadataSummary(value: {
  audioFingerprint: string | null;
  bitrateKbps: number | null;
  channels: number | null;
  codec: string | null;
  container: string | null;
  duplicateConfidence: number | null;
  duplicateKind: string | null;
  duplicateOfScannedFileId: string | null;
  durationSeconds: number | null;
  humanLabels: unknown;
  machineLabels: unknown;
  privacyState: string;
  provisionalActionItems: unknown;
  provisionalPeople: unknown;
  provisionalProjects: unknown;
  provisionalQuestions: unknown;
  provisionalTopics: unknown;
  sampleRateHz: number | null;
  sourceCreatedAt: Date | null;
  sourceModifiedAt: Date | null;
  summary: string | null;
  transcriptionConfidence: number | null;
  transcriptionErrorCategory: string | null;
  transcriptionStatus: string;
  transcriptSnippet: string | null;
}): BridgeAudioMetadataSummary {
  return {
    audioFingerprint: value.audioFingerprint,
    bitrateKbps: value.bitrateKbps,
    channels: value.channels,
    codec: value.codec,
    container: value.container,
    duplicateConfidence: value.duplicateConfidence,
    duplicateKind: value.duplicateKind,
    duplicateOfScannedFileId: value.duplicateOfScannedFileId,
    durationSeconds: value.durationSeconds,
    humanLabels: jsonAudioHumanLabels(value.humanLabels),
    machineLabels: jsonStringArray(value.machineLabels),
    privacyState: normalizeAudioPrivacyState(value.privacyState),
    provisionalActionItems: jsonStringArray(value.provisionalActionItems),
    provisionalPeople: jsonStringArray(value.provisionalPeople),
    provisionalProjects: jsonStringArray(value.provisionalProjects),
    provisionalQuestions: jsonStringArray(value.provisionalQuestions),
    provisionalTopics: jsonStringArray(value.provisionalTopics),
    sampleRateHz: value.sampleRateHz,
    sourceCreatedAt: value.sourceCreatedAt?.toISOString() ?? null,
    sourceModifiedAt: value.sourceModifiedAt?.toISOString() ?? null,
    summary: value.summary,
    transcriptionConfidence: value.transcriptionConfidence,
    transcriptionErrorCategory: value.transcriptionErrorCategory,
    transcriptionStatus: normalizeAudioTranscriptionStatus(
      value.transcriptionStatus,
    ),
    transcriptSnippet: value.transcriptSnippet,
  };
}
