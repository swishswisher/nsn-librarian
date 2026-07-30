import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getPrismaClient } from "@/lib/db/prisma";
import { createChecksum } from "@/lib/files/checksum";
import { readDocument } from "@/lib/reading-room/read-document";
import type { ReadingResult } from "@/lib/reading-room/types";
import { sanitizeReadingWarning } from "@/lib/reading-room/utils";
import type { KnowledgeItemKind } from "@/types/library";

const uploadRoot = path.join(process.cwd(), "storage", "library-uploads");

type CreateUploadBatchInput = {
  name: string;
  notes?: string;
  files: File[];
};

export type CreatedUploadBatch = {
  batchId: string;
  documentCount: number;
  completedCount: number;
  failedCount: number;
  unsupportedCount: number;
};

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

function getExtension(fileName: string) {
  const extension = path.extname(fileName).replace(".", "").toLowerCase();

  return extension || null;
}

function inferKnowledgeItemKind(
  extension: string | null,
  mimeType?: string,
): KnowledgeItemKind {
  const normalizedMimeType = mimeType?.toLowerCase() ?? "";
  const normalizedExtension = extension ?? "";

  if (
    normalizedMimeType.startsWith("image/") ||
    ["avif", "gif", "heic", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"].includes(
      normalizedExtension,
    )
  ) {
    return "IMAGE";
  }

  if (normalizedMimeType.startsWith("audio/")) {
    return "AUDIO";
  }

  if (normalizedMimeType.startsWith("video/")) {
    return "VIDEO";
  }

  if (["eml", "msg"].includes(normalizedExtension)) {
    return "EMAIL";
  }

  if (["key", "odp", "ppt", "pptx"].includes(normalizedExtension)) {
    return "PRESENTATION";
  }

  if (["csv", "ods", "xls", "xlsx"].includes(normalizedExtension)) {
    return "SPREADSHEET";
  }

  if (["7z", "gz", "rar", "tar", "zip"].includes(normalizedExtension)) {
    return "ARCHIVE";
  }

  if (
    [
      "doc",
      "docx",
      "htm",
      "html",
      "md",
      "pdf",
      "rtf",
      "txt",
    ].includes(normalizedExtension)
  ) {
    return "DOCUMENT";
  }

  return "UNKNOWN";
}

function relativeStoragePath(batchId: string, fileName: string) {
  return path.posix.join("storage", "library-uploads", batchId, fileName);
}

function extractionStatusForResult(result: ReadingResult) {
  if (result.readerType === "unsupported") {
    return "UNSUPPORTED" as const;
  }

  return result.success ? ("COMPLETED" as const) : ("FAILED" as const);
}

function previewFromReadingResult(result: ReadingResult) {
  if (result.extractedText.length > 0) {
    const normalizedPreview = result.extractedText.replace(/\s+/g, " ").trim();

    return normalizedPreview.length > 320
      ? `${normalizedPreview.slice(0, 317)}...`
      : normalizedPreview;
  }

  if (result.warnings.length > 0) {
    return `Reading note: ${result.warnings.join(" ")}`;
  }

  return null;
}

function failurePreview(error: unknown) {
  const message = sanitizeReadingWarning(error);

  return `Reading note: ${message}`;
}

export async function createLibraryUploadBatch({
  name,
  notes,
  files,
}: CreateUploadBatchInput): Promise<CreatedUploadBatch> {
  const prisma = getPrismaClient();

  const batch = await prisma.libraryBatch.create({
    data: {
      name,
      notes: notes || null,
      sourceType: "LOCAL_UPLOAD",
      status: "READY",
    },
    select: {
      id: true,
    },
  });

  const batchStorageDirectory = path.join(uploadRoot, batch.id);
  await mkdir(batchStorageDirectory, { recursive: true });

  const documentResults = await Promise.all(
    files.map(async (file) => {
      const originalFileName = file.name || "untitled";
      const normalizedFileName = normalizeFileName(originalFileName);
      const uniqueFileName = `${randomUUID()}-${normalizedFileName}`;
      const buffer = Buffer.from(await file.arrayBuffer());
      const checksum = createChecksum(buffer);
      const destination = path.join(batchStorageDirectory, uniqueFileName);

      await writeFile(destination, buffer);

      const extension = getExtension(originalFileName);
      const itemKind = inferKnowledgeItemKind(extension, file.type || undefined);
      const storagePath = relativeStoragePath(batch.id, uniqueFileName);
      const document = await prisma.libraryDocument.create({
        data: {
          batchId: batch.id,
          itemKind,
          originalFileName,
          normalizedFileName,
          mimeType: file.type || null,
          extension,
          fileSizeBytes: BigInt(buffer.byteLength),
          checksum,
          storagePath,
          extractionStatus: "PENDING",
          classificationStatus: "PENDING",
          reviewStatus: "PENDING",
        },
        select: {
          id: true,
        },
      });

      try {
        const readingResult = await readDocument({
          filePath: destination,
          fileName: originalFileName,
          mimeType: file.type || undefined,
          extension: extension || undefined,
        });
        const extractionStatus = extractionStatusForResult(readingResult);

        await prisma.libraryDocument.update({
          where: {
            id: document.id,
          },
          data: {
            rawText: readingResult.success ? readingResult.extractedText : null,
            previewText: previewFromReadingResult(readingResult),
            wordCount: readingResult.wordCount,
            extractionStatus,
          },
        });

        return {
          extractionStatus,
        };
      } catch (error) {
        await prisma.libraryDocument.update({
          where: {
            id: document.id,
          },
          data: {
            rawText: null,
            previewText: failurePreview(error),
            wordCount: 0,
            extractionStatus: "FAILED",
          },
        });

        return {
          extractionStatus: "FAILED" as const,
        };
      }
    }),
  );

  const completedCount = documentResults.filter(
    (result) => result.extractionStatus === "COMPLETED",
  ).length;
  const failedCount = documentResults.filter(
    (result) => result.extractionStatus === "FAILED",
  ).length;
  const unsupportedCount = documentResults.filter(
    (result) => result.extractionStatus === "UNSUPPORTED",
  ).length;

  return {
    batchId: batch.id,
    documentCount: documentResults.length,
    completedCount,
    failedCount,
    unsupportedCount,
  };
}
