import { getPrismaClient } from "@/lib/db/prisma";
import { sanitizeReadingWarning } from "@/lib/reading-room/utils";

import {
  ConnectedLibraryFileResolutionError,
  resolveConnectedLibraryFile,
} from "./connected-library-file-resolver";
import {
  extractImageMetadata,
  imageDimensionsText,
  imageFileNameFromRelativePath,
  ImageMetadataError,
  isImageFileType,
  jsonImageHumanLabels,
  normalizeImagePrivacyState,
} from "./image-metadata";
import {
  imageMimeTypeForExtension,
  supportedImageFileTypeForPath,
} from "./media-kind";
import { scannedFileSummary } from "./scan-sessions";
import type {
  BridgeImageMetadataDraft,
  BridgeReadFileApiSuccess,
  BridgeReadPreview,
  BridgeScannedFileSummary,
  ImageHumanLabel,
  ImagePrivacyState,
  ImageProcessingStatus,
} from "./types";
import { imageHumanLabels, imagePrivacyStates } from "./types";

export class BridgeImageReaderError extends Error {
  statusCode: number;
  category: string;

  constructor(message: string, statusCode = 400, category = "IMAGE_READ_FAILED") {
    super(message);
    this.name = "BridgeImageReaderError";
    this.statusCode = statusCode;
    this.category = category;
  }
}

type ScannedImageFileForRead = {
  id: string;
  relativePath: string;
  fileType: string;
  readStatus: string;
  readingStatus: string;
  extractionStatus: string;
  previewText: string | null;
  checksum: string | null;
  sizeBytes: bigint | null;
  imageMetadata: {
    humanLabels: unknown;
    privacyState: string;
  } | null;
  sessionId: string;
};

type ImageAnalysis = {
  machineLabels: string[];
  provisionalQuestions: string[];
  provisionalTopics: string[];
  relatedSignals: string[];
  summary: string;
  textSnippet: string | null;
  ocrStatus: ImageProcessingStatus;
  ocrErrorCategory: string | null;
  previewStatus: ImageProcessingStatus;
  previewErrorCategory: string | null;
  visualAnalysisStatus: ImageProcessingStatus;
  visualAnalysisErrorCategory: string | null;
};

type ImageDuplicateResult = {
  duplicateConfidence: number | null;
  duplicateKind: string | null;
  duplicateOfScannedFileId: string | null;
};

const previewCharacterLimit = 1_200;

function previewFromText(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, previewCharacterLimit);
}

function toJsonInput(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

function safeImageFailureMessage() {
  return "The Librarian could not inspect this image file safely.";
}

function pathSignals(relativePath: string) {
  const text = relativePath.toLowerCase();
  const signals: string[] = [];

  if (text.includes("private")) {
    signals.push("private");
  }

  if (
    text.includes("website") ||
    text.includes("public") ||
    text.includes("hero") ||
    text.includes("banner")
  ) {
    signals.push("website candidate");
  }

  if (
    text.includes("duplicate") ||
    text.includes("copy") ||
    text.includes("small") ||
    text.includes("resized")
  ) {
    signals.push("possible duplicate");
  }

  if (text.includes("workshop")) {
    signals.push("workshop");
  }

  if (text.includes("slide") || text.includes("presentation")) {
    signals.push("presentation");
  }

  return [...new Set(signals)];
}

function labelWhen(
  text: string,
  label: string,
  terms: string[],
  target: string[],
) {
  if (terms.some((term) => text.includes(term))) {
    target.push(label);
  }
}

function analyzeImageContent(input: {
  fileName: string;
  metadata: BridgeImageMetadataDraft;
  relativePath: string;
}): ImageAnalysis {
  const text = `${input.relativePath} ${input.fileName}`.toLowerCase();
  const machineLabels: string[] = [];
  const topics: string[] = [];
  const relatedSignals = pathSignals(input.relativePath);

  labelWhen(text, "workshop image", ["workshop", "training", "class"], machineLabels);
  labelWhen(text, "presentation slide", ["slide", "presentation", "deck"], machineLabels);
  labelWhen(text, "branding asset", ["brand", "logo", "hero", "banner"], machineLabels);
  labelWhen(text, "website candidate", ["website", "public", "landing", "blog"], machineLabels);
  labelWhen(text, "private image", ["private", "family", "personal"], machineLabels);
  labelWhen(text, "event image", ["event", "conference", "retreat", "gathering"], machineLabels);
  labelWhen(text, "screenshot", ["screenshot", "screen"], machineLabels);
  labelWhen(text, "possible duplicate", ["duplicate", "copy", "small", "resized"], machineLabels);

  if (input.metadata.width !== null && input.metadata.height !== null) {
    if (input.metadata.width >= 1200 && input.metadata.height >= 500) {
      machineLabels.push("large visual asset");
    }

    if (input.metadata.width < 800 || input.metadata.height < 500) {
      machineLabels.push("small or resized image");
    }
  }

  for (const label of machineLabels) {
    for (const part of label.split(/\s+/)) {
      if (!["image", "asset", "possible"].includes(part)) {
        topics.push(part);
      }
    }
  }

  if (machineLabels.length === 0) {
    machineLabels.push("image for review");
  }

  const shouldAttemptOcr = /\b(slide|presentation|screenshot|text)\b/.test(text);
  const summary = `I found an image that appears to fit ${machineLabels
    .slice(0, 3)
    .join(", ")}. This is a provisional review based on image metadata and file path only.`;

  return {
    machineLabels: [...new Set(machineLabels)].slice(0, 10),
    ocrErrorCategory: shouldAttemptOcr ? "IMAGE_OCR_FAILED" : null,
    ocrStatus: shouldAttemptOcr ? "UNAVAILABLE" : "NOT_REQUESTED",
    previewErrorCategory: null,
    previewStatus: "COMPLETED",
    provisionalQuestions: shouldAttemptOcr
      ? ["Does this image contain important text that Deanne wants captured later?"]
      : [],
    provisionalTopics: [...new Set(topics)].slice(0, 8),
    relatedSignals: relatedSignals.map((signal) => `Path signal: ${signal}`),
    summary,
    textSnippet: null,
    visualAnalysisErrorCategory: null,
    visualAnalysisStatus: "COMPLETED",
  };
}

function buildImageReviewText(input: {
  analysis: ImageAnalysis;
  duplicate: ImageDuplicateResult;
  fileName: string;
  metadata: BridgeImageMetadataDraft;
  relativePath: string;
}) {
  const signals = pathSignals(input.relativePath);
  const signalLines =
    signals.length > 0
      ? signals.map((signal) => `Path signal: ${signal}`)
      : ["Path signal: none recorded"];

  return [
    "Image review material. The source image remains in the connected folder.",
    "",
    `File: ${input.fileName}`,
    `Relative path: ${input.relativePath}`,
    `Image type: ${input.metadata.format}`,
    `Dimensions: ${imageDimensionsText(input.metadata)}`,
    `Size: ${input.metadata.sizeBytes.toString()} bytes`,
    `Orientation: ${input.metadata.orientation ?? "not recorded"}`,
    `Color profile: ${input.metadata.colorProfile ?? "not recorded"}`,
    `Embedded date: ${input.metadata.embeddedDate?.toISOString() ?? "not recorded"}`,
    `Camera/device: ${input.metadata.cameraDevice ?? "not recorded"}`,
    ...signalLines,
    input.duplicate.duplicateKind
      ? `Duplicate signal: ${input.duplicate.duplicateKind.replaceAll("_", " ").toLowerCase()}`
      : "Duplicate signal: none recorded",
    "",
    "Summary:",
    input.analysis.summary,
    input.analysis.ocrStatus === "UNAVAILABLE"
      ? "OCR note: Text extraction was useful to try later, but it is unavailable in this local metadata-only pass."
      : "OCR note: Text extraction was not requested for this image.",
    "",
    "Human review note:",
    "This image can be examined and organized, but Deanne decides whether any recommendation is correct.",
  ].join("\n");
}

async function scannedImageFileForRead(scannedFileId: string) {
  const prisma = getPrismaClient();

  return prisma.scannedFile.findUnique({
    select: {
      checksum: true,
      extractionStatus: true,
      fileType: true,
      id: true,
      imageMetadata: {
        select: {
          humanLabels: true,
          privacyState: true,
        },
      },
      previewText: true,
      readingStatus: true,
      readStatus: true,
      relativePath: true,
      sessionId: true,
      sizeBytes: true,
    },
    where: {
      id: scannedFileId,
    },
  });
}

function imagePrivacyFromExisting(
  scannedFile: ScannedImageFileForRead,
): ImagePrivacyState {
  return normalizeImagePrivacyState(scannedFile.imageMetadata?.privacyState);
}

function normalizeImageStem(relativePath: string) {
  return imageFileNameFromRelativePath(relativePath)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/\b(copy|duplicate|small|resized|resize|thumbnail|thumb)\b/g, " ")
    .replace(/\b\d{2,5}x\d{2,5}\b/g, " ")
    .replace(/[-_()[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function imageStemOverlap(left: string, right: string) {
  const leftTerms = new Set(left.split(/\s+/).filter((term) => term.length >= 4));
  const rightTerms = new Set(right.split(/\s+/).filter((term) => term.length >= 4));

  return [...leftTerms].filter((term) => rightTerms.has(term));
}

async function detectImageDuplicate(
  scannedFile: ScannedImageFileForRead,
  metadata: BridgeImageMetadataDraft,
): Promise<ImageDuplicateResult> {
  const prisma = getPrismaClient();

  if (scannedFile.checksum) {
    const exact = await prisma.scannedFile.findFirst({
      select: { id: true },
      where: {
        checksum: scannedFile.checksum,
        id: { not: scannedFile.id },
        sessionId: scannedFile.sessionId,
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

  if (metadata.imageFingerprint) {
    const matchingFingerprint = await prisma.imageAssetMetadata.findFirst({
      select: { scannedFileId: true },
      where: {
        imageFingerprint: metadata.imageFingerprint,
        scannedFile: {
          sessionId: scannedFile.sessionId,
        },
        scannedFileId: { not: scannedFile.id },
      },
    });

    if (matchingFingerprint) {
      return {
        duplicateConfidence: 0.76,
        duplicateKind: "LIKELY_VISUAL_DUPLICATE",
        duplicateOfScannedFileId: matchingFingerprint.scannedFileId,
      };
    }
  }

  const currentStem = normalizeImageStem(scannedFile.relativePath);
  const pathText = scannedFile.relativePath.toLowerCase();
  const siblings = await prisma.scannedFile.findMany({
    select: {
      id: true,
      relativePath: true,
    },
    take: 80,
    where: {
      fileType: {
        startsWith: "IMAGE_",
      },
      id: {
        not: scannedFile.id,
      },
      sessionId: scannedFile.sessionId,
    },
  });
  const likely = siblings.find((sibling) => {
    const candidateStem = normalizeImageStem(sibling.relativePath);
    const overlap = imageStemOverlap(currentStem, candidateStem);

    return (
      candidateStem === currentStem ||
      overlap.length >= 2 ||
      /\b(duplicate|copy|small|resized|thumbnail)\b/.test(pathText)
    );
  });

  if (likely) {
    return {
      duplicateConfidence: /\b(small|resized|thumbnail)\b/.test(pathText)
        ? 0.64
        : 0.68,
      duplicateKind: /\b(small|resized|thumbnail)\b/.test(pathText)
        ? "LIKELY_RESIZED_COPY"
        : "LIKELY_IMAGE_DUPLICATE",
      duplicateOfScannedFileId: likely.id,
    };
  }

  return {
    duplicateConfidence: null,
    duplicateKind: null,
    duplicateOfScannedFileId: null,
  };
}

async function upsertImageMetadata(input: {
  analysis: ImageAnalysis;
  duplicate: ImageDuplicateResult;
  metadata: BridgeImageMetadataDraft;
  scannedFile: ScannedImageFileForRead;
}) {
  const prisma = getPrismaClient();
  const existingLabels = Array.isArray(input.scannedFile.imageMetadata?.humanLabels)
    ? input.scannedFile.imageMetadata.humanLabels.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const privacyState = imagePrivacyFromExisting(input.scannedFile);
  const createData = {
    cameraDevice: input.metadata.cameraDevice,
    colorProfile: input.metadata.colorProfile,
    duplicateConfidence: input.duplicate.duplicateConfidence,
    duplicateKind: input.duplicate.duplicateKind,
    duplicateOfScannedFileId: input.duplicate.duplicateOfScannedFileId,
    embeddedDate: input.metadata.embeddedDate,
    format: input.metadata.format,
    height: input.metadata.height,
    humanLabels: toJsonInput(existingLabels),
    imageFingerprint: input.metadata.imageFingerprint,
    machineLabels: toJsonInput(input.analysis.machineLabels),
    ocrErrorCategory: input.analysis.ocrErrorCategory,
    ocrStatus: input.analysis.ocrStatus,
    orientation: input.metadata.orientation,
    previewErrorCategory: input.analysis.previewErrorCategory,
    previewStatus: input.analysis.previewStatus,
    privacyState,
    provisionalQuestions: toJsonInput(input.analysis.provisionalQuestions),
    provisionalTopics: toJsonInput(input.analysis.provisionalTopics),
    relatedSignals: toJsonInput(input.analysis.relatedSignals),
    sourceCreatedAt: input.metadata.sourceCreatedAt,
    sourceModifiedAt: input.metadata.sourceModifiedAt,
    summary: input.analysis.summary,
    textSnippet: input.analysis.textSnippet,
    visualAnalysisErrorCategory: input.analysis.visualAnalysisErrorCategory,
    visualAnalysisStatus: input.analysis.visualAnalysisStatus,
    width: input.metadata.width,
  };

  await prisma.imageAssetMetadata.upsert({
    create: {
      ...createData,
      scannedFileId: input.scannedFile.id,
    },
    update: createData,
    where: {
      scannedFileId: input.scannedFile.id,
    },
  });
}

async function markImageReadFailure(
  scannedFileId: string,
  category: string,
  message: string,
): Promise<BridgeScannedFileSummary> {
  const prisma = getPrismaClient();
  const unsupported =
    category === "UNSUPPORTED_IMAGE" || category === "UNSUPPORTED_FILE_TYPE";
  const file = await prisma.scannedFile.update({
    include: {
      audioMetadata: true,
      imageMetadata: true,
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
        },
      },
      videoMetadata: true,
    },
    data: {
      extractedAt: new Date(),
      extractionErrorCategory: category,
      extractionStatus: unsupported ? "UNSUPPORTED" : "FAILED",
      processedAt: new Date(),
      processingErrorCategory: category,
      processingStage: unsupported ? "UNSUPPORTED" : "FAILED",
      readingStatus: unsupported ? "UNSUPPORTED" : "FAILED",
      scanError: sanitizeReadingWarning(message),
    },
    where: {
      id: scannedFileId,
    },
  });

  return scannedFileSummary(file);
}

async function extractPreviewFromImageFile(
  scannedFile: ScannedImageFileForRead,
  options: {
    persistMetadata?: boolean;
  } = {},
): Promise<BridgeReadPreview> {
  const prisma = getPrismaClient();
  let resolvedFile;

  try {
    resolvedFile = await resolveConnectedLibraryFile({
      itemLabel: "image file",
      scannedFileId: scannedFile.id,
    });
  } catch (error) {
    if (error instanceof ConnectedLibraryFileResolutionError) {
      throw new BridgeImageReaderError(
        error.message,
        error.statusCode,
        error.category,
      );
    }

    throw error;
  }

  const metadata = await extractImageMetadata(
    resolvedFile.filePath,
    resolvedFile.relativePath,
    resolvedFile.fileStats,
  ).catch((error: unknown) => {
    if (error instanceof ImageMetadataError) {
      throw new BridgeImageReaderError(error.message, 422, error.category);
    }

    throw new BridgeImageReaderError(
      "The Librarian could not read this image's technical information.",
      422,
      "IMAGE_METADATA_FAILED",
    );
  });

  if (options.persistMetadata) {
    await prisma.scannedFile.update({
      data: {
        processingStage: "METADATA_READY",
      },
      where: {
        id: scannedFile.id,
      },
    });
  }

  const fileName = imageFileNameFromRelativePath(resolvedFile.relativePath);
  const duplicate = await detectImageDuplicate(scannedFile, metadata);
  const analysis = analyzeImageContent({
    fileName,
    metadata,
    relativePath: resolvedFile.relativePath,
  });

  if (options.persistMetadata) {
    await prisma.scannedFile.update({
      data: {
        processingStage: "PREPARING_PREVIEW",
      },
      where: {
        id: scannedFile.id,
      },
    });
    await upsertImageMetadata({
      analysis,
      duplicate,
      metadata,
      scannedFile,
    });
    await prisma.scannedFile.update({
      data: {
        processingStage:
          analysis.ocrStatus === "UNAVAILABLE"
            ? "OCR_PROCESSING"
            : "ANALYZING_IMAGE",
      },
      where: {
        id: scannedFile.id,
      },
    });
  }

  const extractedText = buildImageReviewText({
    analysis,
    duplicate,
    fileName,
    metadata,
    relativePath: resolvedFile.relativePath,
  });

  return {
    characterCount: extractedText.length,
    extractedText,
    fileName,
    fileType: scannedFile.fileType,
    relativePath: resolvedFile.relativePath,
    scannedFileId: scannedFile.id,
    warnings: analysis.ocrErrorCategory
      ? [
          "OCR was unavailable for this image. The Librarian kept the image metadata and provisional review available.",
        ]
      : [],
  };
}

export async function readScannedImageFile(
  scannedFileId: string,
): Promise<BridgeReadFileApiSuccess> {
  const prisma = getPrismaClient();
  const scannedFile = await scannedImageFileForRead(scannedFileId);

  if (!scannedFile) {
    throw new BridgeImageReaderError(
      "The Librarian could not find that scanned image file.",
      404,
      "NOT_FOUND",
    );
  }

  const canonicalImageType = supportedImageFileTypeForPath(
    scannedFile.relativePath,
  );

  if (!isImageFileType(scannedFile.fileType) && !canonicalImageType) {
    throw new BridgeImageReaderError(
      "Unsupported for image reading.",
      409,
      "UNSUPPORTED_IMAGE",
    );
  }

  const repairedFileType = isImageFileType(scannedFile.fileType)
    ? scannedFile.fileType
    : canonicalImageType!;

  if (
    scannedFile.fileType !== repairedFileType ||
    scannedFile.readStatus === "UNSUPPORTED" ||
    scannedFile.readStatus === "FAILED"
  ) {
    await prisma.scannedFile.update({
      data: {
        fileType: repairedFileType,
        readStatus: "SUPPORTED",
      },
      where: {
        id: scannedFile.id,
      },
    });
  }

  await prisma.scannedFile.update({
    data: {
      extractionErrorCategory: null,
      extractionStatus: "EXTRACTING",
      processingErrorCategory: null,
      processingStage: "READING_IMAGE_METADATA",
      readingStatus: "NOT_READ",
      scanError: null,
    },
    where: {
      id: scannedFile.id,
    },
  });

  try {
    const preview = await extractPreviewFromImageFile(
      {
        ...scannedFile,
        fileType: repairedFileType,
        readStatus: "SUPPORTED",
      },
      {
        persistMetadata: true,
      },
    );
    const updatedFile = await prisma.scannedFile.update({
      include: {
        audioMetadata: true,
        imageMetadata: true,
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
          },
        },
        videoMetadata: true,
      },
      data: {
        characterCount: preview.characterCount,
        extractedAt: new Date(),
        extractionErrorCategory: null,
        extractionStatus: "COMPLETED",
        previewText: previewFromText(preview.extractedText),
        processedAt: new Date(),
        processingErrorCategory: null,
        processingStage: "READ",
        readingStatus: "READ",
        scanError: null,
      },
      where: {
        id: scannedFile.id,
      },
    });

    return {
      file: scannedFileSummary(updatedFile),
      ok: true,
      preview,
    };
  } catch (error) {
    if (error instanceof BridgeImageReaderError) {
      await markImageReadFailure(scannedFile.id, error.category, error.message);
      throw error;
    }

    await markImageReadFailure(
      scannedFile.id,
      "IMAGE_READ_FAILED",
      safeImageFailureMessage(),
    );
    throw new BridgeImageReaderError(safeImageFailureMessage());
  }
}

export async function readScannedImageFileTransient(scannedFileId: string) {
  const scannedFile = await scannedImageFileForRead(scannedFileId);

  if (!scannedFile) {
    throw new BridgeImageReaderError(
      "The Librarian could not find that scanned image file.",
      404,
      "NOT_FOUND",
    );
  }

  if (
    scannedFile.readingStatus !== "READ" ||
    scannedFile.extractionStatus !== "COMPLETED"
  ) {
    throw new BridgeImageReaderError(
      "The Librarian has not finished reading this image file yet.",
      409,
      "NOT_READ",
    );
  }

  return extractPreviewFromImageFile(scannedFile);
}

function imageExtensionFromPath(relativePath: string) {
  return relativePath.split(/[?#]/)[0]?.split(".").at(-1)?.toLowerCase() ?? null;
}

export async function getScannedImagePreviewSource(scannedFileId: string) {
  const scannedFile = await scannedImageFileForRead(scannedFileId);

  if (!scannedFile) {
    throw new BridgeImageReaderError(
      "The Librarian could not find that scanned image file.",
      404,
      "NOT_FOUND",
    );
  }

  const canonicalImageType = supportedImageFileTypeForPath(
    scannedFile.relativePath,
  );

  if (!isImageFileType(scannedFile.fileType) && !canonicalImageType) {
    throw new BridgeImageReaderError(
      "Unsupported for image preview.",
      409,
      "UNSUPPORTED_IMAGE",
    );
  }

  let resolvedFile;

  try {
    resolvedFile = await resolveConnectedLibraryFile({
      itemLabel: "image file",
      scannedFileId,
    });
  } catch (error) {
    if (error instanceof ConnectedLibraryFileResolutionError) {
      throw new BridgeImageReaderError(
        error.message,
        error.statusCode,
        error.category,
      );
    }

    throw error;
  }

  const contentType =
    imageMimeTypeForExtension(imageExtensionFromPath(resolvedFile.relativePath)) ??
    "application/octet-stream";

  return {
    contentType,
    filePath: resolvedFile.filePath,
    fileSize: Number(resolvedFile.fileStats.size),
    relativePath: resolvedFile.relativePath,
  };
}

export async function updateScannedImageReviewState(input: {
  labels?: ImageHumanLabel[];
  privacyState?: ImagePrivacyState;
  scannedFileId: string;
}): Promise<BridgeScannedFileSummary> {
  const prisma = getPrismaClient();
  const scannedFile = await prisma.scannedFile.findUnique({
    include: {
      audioMetadata: true,
      imageMetadata: true,
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
        },
      },
      videoMetadata: true,
    },
    where: {
      id: input.scannedFileId,
    },
  });

  if (
    !scannedFile ||
    (!isImageFileType(scannedFile.fileType) &&
      supportedImageFileTypeForPath(scannedFile.relativePath) === null)
  ) {
    throw new BridgeImageReaderError(
      "The Librarian could not find that image.",
      404,
      "NOT_FOUND",
    );
  }

  const existingLabels = jsonImageHumanLabels(
    scannedFile.imageMetadata?.humanLabels ?? [],
  );
  const nextLabels = input.labels ?? existingLabels;
  const nextPrivacyState =
    input.privacyState ??
    normalizeImagePrivacyState(scannedFile.imageMetadata?.privacyState);
  const metadataCreateDefaults = {
    format: scannedFile.fileType.startsWith("IMAGE_")
      ? scannedFile.fileType.replace("IMAGE_", "").toLowerCase()
      : supportedImageFileTypeForPath(scannedFile.relativePath)
          ?.replace("IMAGE_", "")
          .toLowerCase() ?? null,
    humanLabels: toJsonInput(nextLabels),
    machineLabels: toJsonInput([]),
    ocrStatus: "NOT_REQUESTED" as const,
    previewStatus: "NOT_REQUESTED" as const,
    privacyState: nextPrivacyState,
    provisionalQuestions: toJsonInput([]),
    provisionalTopics: toJsonInput([]),
    relatedSignals: toJsonInput([]),
    visualAnalysisStatus: "NOT_REQUESTED" as const,
  };

  await prisma.imageAssetMetadata.upsert({
    create: {
      ...metadataCreateDefaults,
      scannedFileId: scannedFile.id,
    },
    update: {
      humanLabels: toJsonInput(nextLabels),
      privacyState: nextPrivacyState,
    },
    where: {
      scannedFileId: scannedFile.id,
    },
  });

  const updated = await prisma.scannedFile.findUniqueOrThrow({
    include: {
      audioMetadata: true,
      imageMetadata: true,
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
        },
      },
      videoMetadata: true,
    },
    where: {
      id: scannedFile.id,
    },
  });

  return scannedFileSummary(updated);
}

export function normalizeImageHumanLabelsInput(value: unknown): ImageHumanLabel[] {
  return [...new Set(jsonImageHumanLabels(value))];
}

export function normalizeImagePrivacyInput(value: unknown): ImagePrivacyState | null {
  return typeof value === "string" &&
    imagePrivacyStates.includes(value as ImagePrivacyState)
    ? (value as ImagePrivacyState)
    : null;
}

export function availableImageHumanLabels() {
  return [...imageHumanLabels];
}

export function availableImagePrivacyStates() {
  return [...imagePrivacyStates];
}
