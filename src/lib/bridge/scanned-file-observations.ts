import path from "node:path";

import { getPrismaClient } from "@/lib/db/prisma";
import {
  createObservationSessionFromReadableDocument,
  ObservationSessionError,
} from "@/lib/library/observation-sessions";
import { countWords } from "@/lib/reading-room/utils";
import type { KnowledgeItemKind } from "@/types/library";

import { audioMimeTypeForExtension } from "./audio-metadata";
import { imageMimeTypeForExtension } from "./media-kind";
import { isImageFileType } from "./media-kind";
import { readScannedFile } from "./reader";
import type { BridgeReadFileApiSuccess } from "./types";
import { videoMimeTypeForExtension } from "./video-metadata";

function normalizeFileName(fileName: string) {
  const parsed = path.parse(fileName);
  const safeName = parsed.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const safeExtension = parsed.ext.toLowerCase().replace(/[^a-z0-9.]/g, "");

  return `${safeName || "document"}${safeExtension}`;
}

function extensionFromRelativePath(relativePath: string) {
  return path.extname(relativePath).replace(".", "").toLowerCase() || null;
}

function mimeTypeForExtension(extension: string | null) {
  if (extension === "txt" || extension === "md" || extension === "markdown") {
    return "text/plain";
  }

  if (extension === "html" || extension === "htm") {
    return "text/html";
  }

  if (extension === "pdf") {
    return "application/pdf";
  }

  if (extension === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  const audioMimeType = audioMimeTypeForExtension(extension);

  if (audioMimeType) {
    return audioMimeType;
  }

  const imageMimeType = imageMimeTypeForExtension(extension);

  if (imageMimeType) {
    return imageMimeType;
  }

  const videoMimeType = videoMimeTypeForExtension(extension);

  if (videoMimeType) {
    return videoMimeType;
  }

  return null;
}

function itemKindForExtension(extension: string | null): KnowledgeItemKind {
  return ["docx", "htm", "html", "markdown", "md", "pdf", "txt"].includes(
    extension ?? "",
  )
    ? "DOCUMENT"
    : audioMimeTypeForExtension(extension)
      ? "AUDIO"
      : imageMimeTypeForExtension(extension)
        ? "IMAGE"
        : videoMimeTypeForExtension(extension)
          ? "VIDEO"
          : "UNKNOWN";
}

async function bridgeBatchFor(displayName: string) {
  const prisma = getPrismaClient();
  const batchName = `Bridge scan: ${displayName}`;
  const existingBatch = await prisma.libraryBatch.findFirst({
    orderBy: {
      createdAt: "desc",
    },
    where: {
      name: batchName,
      sourceType: "MAC_BRIDGE",
    },
  });

  if (existingBatch) {
    return existingBatch;
  }

  return prisma.libraryBatch.create({
    data: {
      name: batchName,
      notes:
        "Metadata-only Bridge records for scanned files. Source files stay on the local computer.",
      sourceType: "MAC_BRIDGE",
      status: "READY",
    },
  });
}

async function scannedFileWithFolder(scannedFileId: string) {
  const prisma = getPrismaClient();

  return prisma.scannedFile.findUnique({
    include: {
      scanSession: {
        include: {
          connectedFolder: {
            select: {
              displayName: true,
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

async function metadataDocumentForScannedFile(
  scannedFileId: string,
  previewText: string | null,
  wordCount: number,
) {
  const prisma = getPrismaClient();
  const scannedFile = await scannedFileWithFolder(scannedFileId);

  if (!scannedFile) {
    throw new ObservationSessionError(
      "The Librarian could not find that scanned file.",
      404,
    );
  }

  const extension = extensionFromRelativePath(scannedFile.relativePath);
  const documentData = {
    checksum: scannedFile.checksum,
    extension,
    extractionStatus: "COMPLETED" as const,
    fileSizeBytes: scannedFile.sizeBytes,
    itemKind: itemKindForExtension(extension),
    mimeType: mimeTypeForExtension(extension),
    normalizedFileName: normalizeFileName(scannedFile.relativePath),
    originalFileName: scannedFile.relativePath,
    previewText,
    rawText: null,
    storagePath: null,
    wordCount,
  };

  if (scannedFile.libraryDocumentId) {
    const existingDocument = await prisma.libraryDocument.findUnique({
      where: {
        id: scannedFile.libraryDocumentId,
      },
    });

    if (existingDocument) {
      return prisma.libraryDocument.update({
        data: documentData,
        where: {
          id: existingDocument.id,
        },
      });
    }
  }

  const batch = await bridgeBatchFor(
    scannedFile.scanSession.connectedFolder.displayName,
  );
  const document = await prisma.libraryDocument.create({
    data: {
      ...documentData,
      batchId: batch.id,
      classificationStatus: "PENDING",
      reviewStatus: "PENDING",
    },
  });

  await prisma.scannedFile.update({
    data: {
      libraryDocumentId: document.id,
    },
    where: {
      id: scannedFile.id,
    },
  });

  return document;
}

export async function createObservationSessionForScannedFile(
  scannedFileId: string,
) {
  const readResult = await readScannedFile(scannedFileId);

  return createObservationSessionForScannedFileReadResult(
    scannedFileId,
    readResult,
  );
}

export async function createObservationSessionForScannedFileReadResult(
  scannedFileId: string,
  readResult: BridgeReadFileApiSuccess,
) {
  const prisma = getPrismaClient();
  const fileForStage = await prisma.scannedFile.findUnique({
    select: {
      fileType: true,
    },
    where: {
      id: scannedFileId,
    },
  });

  await prisma.scannedFile.update({
    data: {
      processingErrorCategory: null,
      processingStage:
        fileForStage && isImageFileType(fileForStage.fileType)
          ? "OBSERVING"
          : "EXAMINING",
    },
    where: {
      id: scannedFileId,
    },
  });

  const wordCount = countWords(readResult.preview.extractedText);
  const document = await metadataDocumentForScannedFile(
    scannedFileId,
    readResult.file.previewText,
    wordCount,
  );
  const observation = await createObservationSessionFromReadableDocument(
    {
      extension: document.extension,
      id: document.id,
      itemKind: document.itemKind,
      mimeType: document.mimeType,
      originalFileName: document.originalFileName,
      previewText: document.previewText,
      rawText: readResult.preview.extractedText,
      wordCount,
    },
    "BRIDGE",
  );
  const scannedFile = await prisma.scannedFile.findUnique({
    select: {
      sessionId: true,
    },
    where: {
      id: scannedFileId,
    },
  });

  if (scannedFile) {
    await prisma.$transaction([
      prisma.scannedFile.update({
        data: {
          processedAt: new Date(),
          processingErrorCategory: null,
          processingStage: "EXAMINED",
        },
        where: {
          id: scannedFileId,
        },
      }),
      prisma.scanSession.update({
        data: {
          observationsCreated: {
            increment: 1,
          },
        },
        where: {
          id: scannedFile.sessionId,
        },
      }),
    ]);
  }

  return observation;
}
