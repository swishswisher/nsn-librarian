import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";

import type {
  BridgeImageMetadataDraft,
  BridgeImageMetadataSummary,
  ImageHumanLabel,
  ImagePrivacyState,
  ImageProcessingStatus,
} from "./types";
import {
  imageHumanLabels,
  imagePrivacyStates,
  imageProcessingStatuses,
} from "./types";
import {
  isImageFileType,
  supportedImageFileTypeForPath,
} from "./media-kind";

export { isImageFileType, supportedImageFileTypeForPath };

export class ImageMetadataError extends Error {
  category: string;

  constructor(message: string, category: string) {
    super(message);
    this.name = "ImageMetadataError";
    this.category = category;
  }
}

type ParsedImageMetadata = Pick<
  BridgeImageMetadataDraft,
  "colorProfile" | "embeddedDate" | "height" | "orientation" | "width"
>;

const maxHeaderBytes = 512 * 1024;

function formatFromFileType(fileType: string) {
  return fileType.replace(/^IMAGE_/, "").toLowerCase();
}

function positiveDimension(value: number) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parsedDimensions(width: number | null, height: number | null): ParsedImageMetadata {
  return {
    colorProfile: null,
    embeddedDate: null,
    height,
    orientation: null,
    width,
  };
}

function parsePng(buffer: Buffer) {
  const pngSignature = "89504e470d0a1a0a";

  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== pngSignature) {
    return null;
  }

  return {
    ...parsedDimensions(
      positiveDimension(buffer.readUInt32BE(16)),
      positiveDimension(buffer.readUInt32BE(20)),
    ),
    colorProfile: buffer.includes(Buffer.from("iCCP")) ? "embedded" : null,
  };
}

function parseGif(buffer: Buffer) {
  const signature = buffer.subarray(0, 6).toString("ascii");

  if (
    buffer.length < 10 ||
    (signature !== "GIF87a" && signature !== "GIF89a")
  ) {
    return null;
  }

  return {
    ...parsedDimensions(
      positiveDimension(buffer.readUInt16LE(6)),
      positiveDimension(buffer.readUInt16LE(8)),
    ),
  };
}

function parseJpeg(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  const startOfFrameMarkers = new Set([
    0xc0,
    0xc1,
    0xc2,
    0xc3,
    0xc5,
    0xc6,
    0xc7,
    0xc9,
    0xca,
    0xcb,
    0xcd,
    0xce,
    0xcf,
  ]);

  while (offset + 4 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) {
      offset += 1;
    }

    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }

    const marker = buffer[offset];
    offset += 1;

    if (marker === undefined || marker === 0xd9 || marker === 0xda) {
      break;
    }

    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }

    if (offset + 2 > buffer.length) {
      break;
    }

    const segmentLength = buffer.readUInt16BE(offset);

    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      break;
    }

    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      return {
        ...parsedDimensions(
          positiveDimension(buffer.readUInt16BE(offset + 5)),
          positiveDimension(buffer.readUInt16BE(offset + 3)),
        ),
        colorProfile: buffer.includes(Buffer.from("ICC_PROFILE"))
          ? "embedded"
          : null,
      };
    }

    offset += segmentLength;
  }

  return null;
}

function uint24Le(buffer: Buffer, offset: number) {
  return buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16);
}

function parseWebp(buffer: Buffer) {
  if (
    buffer.length < 16 ||
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return null;
  }

  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;

    if (payloadOffset + chunkSize > buffer.length) {
      break;
    }

    if (chunkType === "VP8X" && chunkSize >= 10) {
      return {
        ...parsedDimensions(
          positiveDimension(uint24Le(buffer, payloadOffset + 4) + 1),
          positiveDimension(uint24Le(buffer, payloadOffset + 7) + 1),
        ),
      };
    }

    if (
      chunkType === "VP8 " &&
      chunkSize >= 10 &&
      buffer[payloadOffset + 3] === 0x9d &&
      buffer[payloadOffset + 4] === 0x01 &&
      buffer[payloadOffset + 5] === 0x2a
    ) {
      return {
        ...parsedDimensions(
          positiveDimension(buffer.readUInt16LE(payloadOffset + 6) & 0x3fff),
          positiveDimension(buffer.readUInt16LE(payloadOffset + 8) & 0x3fff),
        ),
      };
    }

    if (chunkType === "VP8L" && chunkSize >= 5 && buffer[payloadOffset] === 0x2f) {
      const b1 = buffer[payloadOffset + 1];
      const b2 = buffer[payloadOffset + 2];
      const b3 = buffer[payloadOffset + 3];
      const b4 = buffer[payloadOffset + 4];

      return {
        ...parsedDimensions(
          positiveDimension((((b2 & 0x3f) << 8) | b1) + 1),
          positiveDimension((((b3 & 0xf0) >> 4) | (b4 << 4)) + 1),
        ),
      };
    }

    offset = payloadOffset + chunkSize + (chunkSize % 2);
  }

  return parsedDimensions(null, null);
}

function parseTiff(buffer: Buffer) {
  const littleEndian =
    buffer.length >= 4 &&
    buffer[0] === 0x49 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x2a &&
    buffer[3] === 0x00;
  const bigEndian =
    buffer.length >= 4 &&
    buffer[0] === 0x4d &&
    buffer[1] === 0x4d &&
    buffer[2] === 0x00 &&
    buffer[3] === 0x2a;

  if (!littleEndian && !bigEndian) {
    return null;
  }

  return parsedDimensions(null, null);
}

function parseHeif(buffer: Buffer) {
  if (buffer.length < 12 || buffer.subarray(4, 8).toString("ascii") !== "ftyp") {
    return null;
  }

  const brandText = buffer.subarray(8, Math.min(buffer.length, 64)).toString("ascii");

  if (!/(heic|heif|heix|hevc|mif1|msf1)/i.test(brandText)) {
    return null;
  }

  return parsedDimensions(null, null);
}

function parseImageDimensions(buffer: Buffer, fileType: string) {
  if (fileType === "IMAGE_PNG") {
    return parsePng(buffer);
  }

  if (fileType === "IMAGE_JPG" || fileType === "IMAGE_JPEG") {
    return parseJpeg(buffer);
  }

  if (fileType === "IMAGE_GIF") {
    return parseGif(buffer);
  }

  if (fileType === "IMAGE_WEBP") {
    return parseWebp(buffer);
  }

  if (fileType === "IMAGE_TIF" || fileType === "IMAGE_TIFF") {
    return parseTiff(buffer);
  }

  if (fileType === "IMAGE_HEIC" || fileType === "IMAGE_HEIF") {
    return parseHeif(buffer);
  }

  return null;
}

async function readImageHeader(filePath: string, size: number) {
  const handle = await open(filePath, "r");

  try {
    const bytesToRead = Math.min(size, maxHeaderBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);

    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function extractImageMetadata(
  filePath: string,
  relativePath: string,
  existingStats?: Stats,
): Promise<BridgeImageMetadataDraft> {
  const fileType = supportedImageFileTypeForPath(relativePath);

  if (!fileType) {
    throw new ImageMetadataError("Unsupported image type.", "UNSUPPORTED_IMAGE");
  }

  const fileStats = existingStats ?? (await stat(filePath));
  const buffer = await readImageHeader(filePath, fileStats.size).catch(() => {
    throw new ImageMetadataError(
      "The Librarian could not read this image's technical information.",
      "IMAGE_METADATA_FAILED",
    );
  });
  const parsed = parseImageDimensions(buffer, fileType);

  if (!parsed) {
    throw new ImageMetadataError(
      "The image file was found, but its contents could not be decoded.",
      "IMAGE_DECODE_FAILED",
    );
  }

  return {
    cameraDevice: null,
    colorProfile: parsed.colorProfile,
    embeddedDate: parsed.embeddedDate,
    format: formatFromFileType(fileType),
    height: parsed.height,
    imageFingerprint: imageFingerprintFor({
      fileType,
      height: parsed.height,
      sizeBytes: BigInt(fileStats.size),
      width: parsed.width,
    }),
    orientation: parsed.orientation,
    sizeBytes: BigInt(fileStats.size),
    sourceCreatedAt: fileStats.birthtime ?? null,
    sourceModifiedAt: fileStats.mtime ?? null,
    width: parsed.width,
  };
}

export function imageDimensionsText(
  metadata: Pick<BridgeImageMetadataDraft, "height" | "width">,
) {
  return metadata.width && metadata.height
    ? `${metadata.width} x ${metadata.height} pixels`
    : "Dimensions not recorded";
}

export function imageFileNameFromRelativePath(relativePath: string) {
  return path.posix.basename(relativePath.replace(/\\/g, "/"));
}

export function imageFingerprintFor(metadata: {
  fileType: string;
  height: number | null;
  sizeBytes: bigint | number | null;
  width: number | null;
}) {
  const sizeBucket =
    metadata.sizeBytes === null
      ? "unknown"
      : Math.round(Number(metadata.sizeBytes) / 20_000).toString();
  const widthBucket =
    metadata.width === null
      ? "unknown"
      : Math.round(metadata.width / 80).toString();
  const heightBucket =
    metadata.height === null
      ? "unknown"
      : Math.round(metadata.height / 80).toString();

  return createHash("sha256")
    .update(
      [
        metadata.fileType,
        widthBucket,
        heightBucket,
        sizeBucket,
      ].join("\u001f"),
    )
    .digest("hex");
}

export function jsonStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function jsonImageHumanLabels(value: unknown): ImageHumanLabel[] {
  return jsonStringArray(value).filter((label): label is ImageHumanLabel =>
    imageHumanLabels.includes(label as ImageHumanLabel),
  );
}

export function normalizeImagePrivacyState(value: unknown): ImagePrivacyState {
  return typeof value === "string" &&
    imagePrivacyStates.includes(value as ImagePrivacyState)
    ? (value as ImagePrivacyState)
    : "REVIEW_REQUIRED";
}

export function normalizeImageProcessingStatus(
  value: unknown,
): ImageProcessingStatus {
  return typeof value === "string" &&
    imageProcessingStatuses.includes(value as ImageProcessingStatus)
    ? (value as ImageProcessingStatus)
    : "NOT_REQUESTED";
}

export function imageMetadataSummary(value: {
  cameraDevice: string | null;
  colorProfile: string | null;
  duplicateConfidence: number | null;
  duplicateKind: string | null;
  duplicateOfScannedFileId: string | null;
  embeddedDate: Date | null;
  format: string | null;
  height: number | null;
  humanLabels: unknown;
  imageFingerprint: string | null;
  machineLabels: unknown;
  ocrErrorCategory: string | null;
  ocrStatus: string;
  orientation: string | null;
  previewErrorCategory: string | null;
  previewStatus: string;
  privacyState: string;
  provisionalQuestions: unknown;
  provisionalTopics: unknown;
  relatedSignals: unknown;
  sourceCreatedAt: Date | null;
  sourceModifiedAt: Date | null;
  summary: string | null;
  textSnippet: string | null;
  visualAnalysisErrorCategory: string | null;
  visualAnalysisStatus: string;
  width: number | null;
}): BridgeImageMetadataSummary {
  return {
    cameraDevice: value.cameraDevice,
    colorProfile: value.colorProfile,
    duplicateConfidence: value.duplicateConfidence,
    duplicateKind: value.duplicateKind,
    duplicateOfScannedFileId: value.duplicateOfScannedFileId,
    embeddedDate: value.embeddedDate?.toISOString() ?? null,
    format: value.format,
    height: value.height,
    humanLabels: jsonImageHumanLabels(value.humanLabels),
    imageFingerprint: value.imageFingerprint,
    machineLabels: jsonStringArray(value.machineLabels),
    ocrErrorCategory: value.ocrErrorCategory,
    ocrStatus: normalizeImageProcessingStatus(value.ocrStatus),
    orientation: value.orientation,
    previewErrorCategory: value.previewErrorCategory,
    previewStatus: normalizeImageProcessingStatus(value.previewStatus),
    privacyState: normalizeImagePrivacyState(value.privacyState),
    provisionalQuestions: jsonStringArray(value.provisionalQuestions),
    provisionalTopics: jsonStringArray(value.provisionalTopics),
    relatedSignals: jsonStringArray(value.relatedSignals),
    sourceCreatedAt: value.sourceCreatedAt?.toISOString() ?? null,
    sourceModifiedAt: value.sourceModifiedAt?.toISOString() ?? null,
    summary: value.summary,
    textSnippet: value.textSnippet,
    visualAnalysisErrorCategory: value.visualAnalysisErrorCategory,
    visualAnalysisStatus: normalizeImageProcessingStatus(
      value.visualAnalysisStatus,
    ),
    width: value.width,
  };
}
