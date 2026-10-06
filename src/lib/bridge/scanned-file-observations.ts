import path from "node:path";
import type { Prisma } from "@prisma/client";
import { latestObservationOrder, usableObservation, withOwnedObservationLease } from "./observation-authority";

import { observationFingerprint, observationProcessingVersion } from "@/lib/ai/observation-processing";
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

async function bridgeBatchFor(displayName: string, prisma: Prisma.TransactionClient = getPrismaClient()) {
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

async function scannedFileWithFolder(scannedFileId: string, prisma: Prisma.TransactionClient = getPrismaClient()) {

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
  prisma: Prisma.TransactionClient = getPrismaClient(),
) {
  const scannedFile = await scannedFileWithFolder(scannedFileId, prisma);

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

    if (existingDocument && await prisma.scannedFile.count({
      where: { libraryDocumentId: existingDocument.id },
    }) <= 1) {
      return prisma.libraryDocument.update({
        data: documentData,
        where: {
          id: existingDocument.id,
        },
      });
    }
  }

  const batch = await bridgeBatchFor(
    scannedFile.scanSession.connectedFolder.displayName, prisma,
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

async function completeScannedObservation(prisma: Prisma.TransactionClient, scannedFileId: string,
  readResult: BridgeReadFileApiSuccess,
  observation: Pick<Awaited<ReturnType<typeof createObservationSessionFromReadableDocument>>, "observerType" | "aiUsage" | "result">) {
  const scannedFile = await prisma.scannedFile.findUnique({
    select: {
      checksum: true,
      fileType: true,
      relativePath: true,
      scanSession: {
        select: {
          connectedFolder: {
            select: {
              bridgeDeviceId: true,
              bridgeRootId: true,
              bridgeDevice: { select: { appVersion: true } },
              id: true,
            },
          },
        },
      },
      sessionId: true,
    },
    where: {
      id: scannedFileId,
    },
  });

  if (scannedFile) {
    const library = scannedFile.scanSession.connectedFolder;
    const canReuse = observation.observerType === "OPENAI" &&
      observation.aiUsage?.sourceComplete === true &&
      observation.result.observations.length > 0 &&
      readResult.preview.characterCount === readResult.preview.extractedText.length &&
      readResult.preview.sourceChecksum?.toLowerCase() === scannedFile.checksum?.toLowerCase() &&
      library.bridgeDeviceId && library.bridgeRootId && library.bridgeDevice;
    const fingerprint = canReuse
      ? observationFingerprint({
          bridgeDeviceId: library.bridgeDeviceId!,
          bridgeRootId: library.bridgeRootId!,
          bridgeVersion: library.bridgeDevice!.appVersion,
          checksum: scannedFile.checksum,
          connectedLibraryId: library.id,
          fileType: scannedFile.fileType,
          relativePath: scannedFile.relativePath,
        })
      : null;
    await prisma.scannedFile.update({
        data: {
          aiHttpAttempts: observation.aiUsage?.httpAttempts ?? 0,
          aiInputTokens: observation.aiUsage?.inputTokens ?? null,
          aiModel: observation.aiUsage?.model ?? null,
          aiOutputTokens: observation.aiUsage?.outputTokens ?? null,
          aiRequestCount: observation.aiUsage?.requestCount ?? 0,
          observationClaimedAt: null,
          observationFingerprint: fingerprint,
          observationVersion: observation.observerType === "OPENAI" ? observationProcessingVersion : null,
          observationOrigin: observation.observerType === "OPENAI" ? "NEW_AI" : "BASIC",
          processedAt: new Date(),
          processingErrorCategory: null,
          processingStage: "EXAMINED",
          readingStatus: "READ", extractionStatus: "COMPLETED",
        },
        where: {
          id: scannedFileId,
        },
      });
    await prisma.scanSession.update({
        data: {
          observationsCreated: {
            increment: 1,
          },
        },
        where: {
          id: scannedFile.sessionId,
        },
      });
  }

}

export async function createObservationSessionForScannedFileReadResult(
  scannedFileId: string,
  readResult: BridgeReadFileApiSuccess,
  claimedAt?: Date,
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

  const stage = {
      processingErrorCategory: null,
      processingStage:
        fileForStage && isImageFileType(fileForStage.fileType)
          ? "OBSERVING"
          : "EXAMINING",
  } as const;
  if (claimedAt) await withOwnedObservationLease(scannedFileId, claimedAt, async (tx) => {
    await tx.scannedFile.update({ data: stage, where: { id: scannedFileId } });
  });
  else await prisma.scannedFile.update({ data: stage, where: { id: scannedFileId } });

  const wordCount = countWords(readResult.preview.extractedText);
  const document = claimedAt
    ? await withOwnedObservationLease(scannedFileId, claimedAt, (tx) =>
      metadataDocumentForScannedFile(scannedFileId, readResult.file.previewText, wordCount, tx))
    : await metadataDocumentForScannedFile(scannedFileId, readResult.file.previewText, wordCount);
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
    readResult.preview.warnings,
    claimedAt ? (data, observed) => withOwnedObservationLease(scannedFileId, claimedAt, async (tx) => {
      const current = await tx.scannedFile.findUniqueOrThrow({
        select: { checksum: true, libraryDocument: { select: { observationSessions: {
          orderBy: [...latestObservationOrder], take: 1, select: { status: true },
        } } } }, where: { id: scannedFileId },
      });
      if (current.checksum?.toLowerCase() !== readResult.preview.sourceChecksum?.toLowerCase() ||
          usableObservation(current.libraryDocument?.observationSessions[0])) {
        throw new Error("Observation source or completion changed; retry the report.");
      }
      const session = await tx.observationSession.create({ data, select: { id: true } });
      await completeScannedObservation(tx, scannedFileId, readResult, {
        ...observed, aiUsage: "aiUsage" in observed ? observed.aiUsage : null,
      });
      return session;
    }) : undefined,
  );
  if (!claimedAt) await prisma.$transaction((tx) => completeScannedObservation(tx, scannedFileId, readResult, observation));

  return observation;
}
