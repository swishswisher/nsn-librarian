import { getPrismaClient } from "@/lib/db/prisma";
import { recordScanSessionNotebookEntry } from "@/lib/library/notebook";

import { generateOrganizationSuggestionsForScannedFileWithText } from "./organization-suggestions";
import { loadScanWorkingKnowledge } from "./scan-working-knowledge";

type BatchOptions = {
  recordNotebook?: boolean;
};

const settledUnderstandingStages = [
  "EXAMINED",
  "SUGGESTIONS_GENERATED",
  "RECOMMENDATIONS_READY",
  "FAILED",
  "UNSUPPORTED",
] as const;
const claimableSessionStatuses = [
  "PENDING",
  "SCANNING",
  "READING",
  "EXAMINING",
] as const;
const recommendationTimeoutMs = 25_000;

class RecommendationBatchTimeoutError extends Error {}

function withTimeout<T>(task: Promise<T>) {
  let timeoutId: ReturnType<typeof setTimeout>;

  return new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new RecommendationBatchTimeoutError()),
      recommendationTimeoutMs,
    );
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

async function markRecommendationFailure(scannedFileId: string, error: unknown) {
  const category =
    error instanceof RecommendationBatchTimeoutError
      ? "SUGGESTIONS_TIMEOUT"
      : "SUGGESTIONS_FAILED";

  await getPrismaClient().scannedFile.update({
    data: {
      processedAt: new Date(),
      processingErrorCategory: category,
      processingStage: "FAILED",
      scanError:
        category === "SUGGESTIONS_TIMEOUT"
          ? "Recommendation preparation took too long for this file."
          : "The Librarian could not prepare recommendations for this file safely.",
    },
    where: { id: scannedFileId },
  });
}

async function completeSession(sessionId: string, recordNotebook: boolean) {
  const prisma = getPrismaClient();
  const failedFiles = await prisma.scannedFile.count({
    where: {
      OR: [
        { processingStage: "FAILED" },
        { readStatus: "FAILED" },
        { readingStatus: "FAILED" },
        { extractionStatus: "FAILED" },
      ],
      sessionId,
    },
  });

  await prisma.scanSession.update({
    data: {
      completedAt: new Date(),
      failedFiles,
      status: failedFiles > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
    },
    where: { id: sessionId },
  });

  if (recordNotebook) {
    try {
      await recordScanSessionNotebookEntry(sessionId);
    } catch {
      // Notebook reflections must not block scan completion.
    }
  }
}

export async function generateScanRecommendationBatch(
  sessionId: string,
  options: BatchOptions = {},
) {
  const prisma = getPrismaClient();
  const workingKnowledge = await loadScanWorkingKnowledge(sessionId);
  const files = await prisma.scannedFile.findMany({
    orderBy: { relativePath: "asc" },
    select: {
      fileType: true,
      id: true,
      previewText: true,
      relativePath: true,
    },
    where: {
      extractionStatus: "COMPLETED",
      libraryDocument: { observationSessions: { some: {} } },
      readStatus: "SUPPORTED",
      readingStatus: "READ",
      sessionId,
    },
  });
  let createdCount = 0;
  let existingCount = 0;
  let failedCount = 0;

  for (const file of files) {
    try {
      const result = await withTimeout(
        generateOrganizationSuggestionsForScannedFileWithText(
          file.id,
          file.previewText ?? "",
          {
            replaceChecksumBootstrap: true,
            workingKnowledge,
          },
        ),
      );
      createdCount += result.createdCount;
      existingCount += result.existingCount;
    } catch (error) {
      failedCount += 1;
      await markRecommendationFailure(file.id, error);
    }
  }

  await completeSession(sessionId, options.recordNotebook ?? false);

  return {
    createdCount,
    existingCount,
    failedCount,
    processedFileCount: files.length,
    workingKnowledge,
  };
}

export async function generateScanRecommendationBatchIfReady(
  sessionId: string,
  options: BatchOptions = {},
) {
  const prisma = getPrismaClient();
  const remainingUnderstanding = await prisma.scannedFile.count({
    where: {
      processingStage: { notIn: [...settledUnderstandingStages] },
      readStatus: "SUPPORTED",
      sessionId,
    },
  });

  if (remainingUnderstanding > 0) {
    return null;
  }

  const claim = await prisma.scanSession.updateMany({
    data: {
      completedAt: null,
      status: "GENERATING_SUGGESTIONS",
    },
    where: {
      id: sessionId,
      status: { in: [...claimableSessionStatuses] },
    },
  });

  if (claim.count === 0) {
    return null;
  }

  return generateScanRecommendationBatch(sessionId, options);
}
