import path from "node:path";

import { getPrismaClient } from "@/lib/db/prisma";
import { readDocument } from "@/lib/reading-room/read-document";
import { sanitizeReadingWarning } from "@/lib/reading-room/utils";

import {
  ConnectedLibraryFileResolutionError,
  resolveConnectedLibraryFile,
} from "./connected-library-file-resolver";
import { scannedFileSummary, type StoredScannedFile } from "./scan-sessions";
import type {
  BridgeReadFileApiSuccess,
  BridgeReadPreview,
  BridgeScannedFileSummary,
} from "./types";
import { isAudioFileType } from "./audio-metadata";
import {
  BridgeAudioReaderError,
  readScannedAudioFile,
  readScannedAudioFileTransient,
} from "./audio-reader";
import { isVideoFileType } from "./video-metadata";
import {
  BridgeVideoReaderError,
  readScannedVideoFile,
  readScannedVideoFileTransient,
} from "./video-reader";
import { readLocalBridgeFile } from "./local-bridge-client";
import { isImageFileType, supportedImageFileTypeForPath } from "./media-kind";
import {
  BridgeImageReaderError,
  readScannedImageFile,
  readScannedImageFileTransient,
} from "./image-reader";

export class BridgeReaderError extends Error {
  statusCode: number;
  category: string;

  constructor(message: string, statusCode = 400, category = "READ_FAILED") {
    super(message);
    this.name = "BridgeReaderError";
    this.statusCode = statusCode;
    this.category = category;
  }
}

type ScannedFileForRead = StoredScannedFile & {
  localPath: string;
  sessionId: string;
  libraryDocumentId: string | null;
  scanSession: {
    connectedFolder: {
      bridgeRootId: string | null;
      displayName: string;
      localPath: string;
    };
  };
};

const previewCharacterLimit = 1_200;

function safeReadFailureMessage() {
  return "The Librarian could not read this file safely.";
}

function previewFromText(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, previewCharacterLimit);
}

function fileNameFromRelativePath(relativePath: string) {
  return path.basename(relativePath.split(path.posix.sep).join(path.sep));
}

function extensionFromRelativePath(relativePath: string) {
  return path.extname(relativePath).toLowerCase().replace(/^\./, "") || undefined;
}

async function scannedFileForRead(scannedFileId: string) {
  const prisma = getPrismaClient();

  return prisma.scannedFile.findUnique({
    include: {
      scanSession: {
        select: {
          connectedFolder: {
            select: {
              bridgeRootId: true,
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

async function markReadFailure(
  scannedFileId: string,
  category: string,
  message: string,
): Promise<BridgeScannedFileSummary | null> {
  const prisma = getPrismaClient();
  const file = await prisma.scannedFile.update({
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
    where: {
      id: scannedFileId,
    },
  });

  return scannedFileSummary(file);
}

function safeWarnings(warnings: string[]) {
  return warnings.map(sanitizeReadingWarning);
}

function audioReaderError(error: BridgeAudioReaderError) {
  return new BridgeReaderError(error.message, error.statusCode, error.category);
}

function videoReaderError(error: BridgeVideoReaderError) {
  return new BridgeReaderError(error.message, error.statusCode, error.category);
}

function imageReaderError(error: BridgeImageReaderError) {
  return new BridgeReaderError(error.message, error.statusCode, error.category);
}

function fileResolutionError(error: ConnectedLibraryFileResolutionError) {
  return new BridgeReaderError(error.message, error.statusCode, error.category);
}

function shouldUseImageReader(scannedFile: { fileType: string; relativePath: string }) {
  return (
    isImageFileType(scannedFile.fileType) ||
    supportedImageFileTypeForPath(scannedFile.relativePath) !== null
  );
}

async function extractPreviewFromScannedFile(
  scannedFile: ScannedFileForRead,
): Promise<BridgeReadPreview> {
  let resolvedFile;

  try {
    resolvedFile = await resolveConnectedLibraryFile({
      itemLabel: "file",
      scannedFileId: scannedFile.id,
    });
  } catch (error) {
    if (error instanceof ConnectedLibraryFileResolutionError) {
      throw fileResolutionError(error);
    }

    throw error;
  }

  const bridgeRootId = resolvedFile.bridgeRootId;

  if (bridgeRootId) {
    try {
      const bridgePreview = await readLocalBridgeFile(
        bridgeRootId,
        resolvedFile.relativePath,
      );

      return {
        ...bridgePreview,
        scannedFileId: scannedFile.id,
      };
    } catch (error) {
      throw new BridgeReaderError(
        error instanceof Error
          ? error.message
          : "The NSN Bridge could not read this file safely.",
        503,
        "LOCAL_BRIDGE_READ_FAILED",
      );
    }
  }

  const fileName = fileNameFromRelativePath(resolvedFile.relativePath);
  const readingResult = await readDocument({
    extension: extensionFromRelativePath(resolvedFile.relativePath),
    fileName,
    filePath: resolvedFile.filePath,
  });

  if (!readingResult.success) {
    const warning = readingResult.warnings[0] ?? safeReadFailureMessage();

    throw new BridgeReaderError(sanitizeReadingWarning(warning), 422);
  }

  const extractedText = readingResult.extractedText;

  return {
    characterCount: extractedText.length,
    extractedText,
    fileName,
    fileType: scannedFile.fileType,
    relativePath: resolvedFile.relativePath,
    scannedFileId: scannedFile.id,
    warnings: safeWarnings(readingResult.warnings),
  };
}

export async function readScannedFileTransient(scannedFileId: string) {
  const scannedFile = await scannedFileForRead(scannedFileId);

  if (!scannedFile) {
    throw new BridgeReaderError(
      "The Librarian could not find that scanned file.",
      404,
      "NOT_FOUND",
    );
  }

  if (isAudioFileType(scannedFile.fileType)) {
    try {
      return await readScannedAudioFileTransient(scannedFile.id);
    } catch (error) {
      if (error instanceof BridgeAudioReaderError) {
        throw audioReaderError(error);
      }

      throw error;
    }
  }

  if (isVideoFileType(scannedFile.fileType)) {
    try {
      return await readScannedVideoFileTransient(scannedFile.id);
    } catch (error) {
      if (error instanceof BridgeVideoReaderError) {
        throw videoReaderError(error);
      }

      throw error;
    }
  }

  if (shouldUseImageReader(scannedFile)) {
    try {
      return await readScannedImageFileTransient(scannedFile.id);
    } catch (error) {
      if (error instanceof BridgeImageReaderError) {
        throw imageReaderError(error);
      }

      throw error;
    }
  }

  if (scannedFile.readStatus === "UNSUPPORTED") {
    throw new BridgeReaderError(
      "Unsupported for reading.",
      409,
      "UNSUPPORTED_FILE_TYPE",
    );
  }

  if (scannedFile.readStatus === "FAILED") {
    throw new BridgeReaderError(
      scannedFile.scanError ?? safeReadFailureMessage(),
      409,
      "SCAN_FAILED",
    );
  }

  if (
    scannedFile.readingStatus !== "READ" ||
    scannedFile.extractionStatus !== "COMPLETED"
  ) {
    throw new BridgeReaderError(
      "The Librarian has not finished reading this file yet.",
      409,
      "NOT_READ",
    );
  }

  return extractPreviewFromScannedFile(scannedFile);
}

export async function readScannedFile(
  scannedFileId: string,
): Promise<BridgeReadFileApiSuccess> {
  const prisma = getPrismaClient();
  const scannedFile = await scannedFileForRead(scannedFileId);

  if (!scannedFile) {
    throw new BridgeReaderError(
      "The Librarian could not find that scanned file.",
      404,
      "NOT_FOUND",
    );
  }

  if (isAudioFileType(scannedFile.fileType)) {
    try {
      return await readScannedAudioFile(scannedFile.id);
    } catch (error) {
      if (error instanceof BridgeAudioReaderError) {
        throw audioReaderError(error);
      }

      throw error;
    }
  }

  if (isVideoFileType(scannedFile.fileType)) {
    try {
      return await readScannedVideoFile(scannedFile.id);
    } catch (error) {
      if (error instanceof BridgeVideoReaderError) {
        throw videoReaderError(error);
      }

      throw error;
    }
  }

  if (shouldUseImageReader(scannedFile)) {
    try {
      return await readScannedImageFile(scannedFile.id);
    } catch (error) {
      if (error instanceof BridgeImageReaderError) {
        throw imageReaderError(error);
      }

      throw error;
    }
  }

  if (scannedFile.readStatus === "UNSUPPORTED") {
    await markReadFailure(
      scannedFile.id,
      "UNSUPPORTED_FILE_TYPE",
      "Unsupported for reading.",
    );
    throw new BridgeReaderError(
      "Unsupported for reading.",
      409,
      "UNSUPPORTED_FILE_TYPE",
    );
  }

  if (scannedFile.readStatus === "FAILED") {
    await markReadFailure(
      scannedFile.id,
      "SCAN_FAILED",
      scannedFile.scanError ?? safeReadFailureMessage(),
    );
    throw new BridgeReaderError(
      scannedFile.scanError ?? safeReadFailureMessage(),
      409,
      "SCAN_FAILED",
    );
  }

  const extractedAt = new Date();

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
    const preview = await extractPreviewFromScannedFile(scannedFile);
    const characterCount = preview.characterCount;
    const updatedFile = await prisma.scannedFile.update({
      data: {
        characterCount,
        extractedAt,
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
    if (error instanceof BridgeReaderError) {
      await markReadFailure(scannedFile.id, error.category, error.message);
      throw error;
    }

    await markReadFailure(
      scannedFile.id,
      "READ_FAILED",
      safeReadFailureMessage(),
    );
    throw new BridgeReaderError(safeReadFailureMessage());
  }
}
