import { latestObservationOrder, usableObservation } from "./observation-authority";
import { getPrismaClient } from "@/lib/db/prisma";
import { Prisma } from "@prisma/client";
import { currentReadableRootWhere } from "./current-readable-root";
import { lockRecommendationBatch, recommendationLeaseMs, type RecommendationBatchOwner } from "./recommendation-batch-authority";
import { currentRecommendationGenerationVersion } from "./recommendation-generation";
import { recordScanSessionNotebookEntry } from "@/lib/library/notebook";
import { publishScanDerivedKnowledge } from "./scan-publication";
import { assertInventoryAfterPhysicalOutcomes } from "./execution-reconciliation";

import { generateOrganizationSuggestionsForScannedFileWithText, loadRecommendationContextIndex } from "./organization-suggestions";
import { loadScanWorkingKnowledge } from "./scan-working-knowledge";

type BatchOptions = {
  recordNotebook?: boolean;
  beforeFilePersist?: () => Promise<void>;
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

function withTimeout<T>(task: Promise<T>, controller: AbortController) {
  let timeoutId: ReturnType<typeof setTimeout>;

  return new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(
      () => { controller.abort(); reject(new RecommendationBatchTimeoutError()); },
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

async function markRecommendationFailure(scannedFileId: string, error: unknown, owner: RecommendationBatchOwner) {
  const category =
    error instanceof RecommendationBatchTimeoutError
      ? "SUGGESTIONS_TIMEOUT"
      : "SUGGESTIONS_FAILED";

  await getPrismaClient().$transaction(async (tx) => {
    await lockRecommendationBatch(tx, owner);
    await tx.scannedFile.update({
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
  });
}

async function completeSession(owner: RecommendationBatchOwner, recordNotebook: boolean) {
  const prisma = getPrismaClient();
  const sessionId = owner.sessionId;
  const publicationGeneration = `NOT_ATTEMPTED@${crypto.randomUUID()}`;
  await prisma.$transaction(async (tx) => {
    await lockRecommendationBatch(tx, owner, undefined, true);
    const remaining = await tx.scannedFile.count({ where: {
      sessionId, readStatus: "SUPPORTED", OR: [
        { observationClaimedAt: { not: null } },
        { processingStage: { notIn: [...settledUnderstandingStages] } },
      ],
    } });
    if (remaining) throw new Error("Scan understanding is still in progress.");
    const failedFiles = await tx.scannedFile.count({
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

  await tx.scanSession.update({
    data: {
      completedAt: new Date(),
      failedFiles,
      status: failedFiles > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
      // Completion of a fresh primary cycle also durably records its derived
      // work. Reprocessing this same session cannot reuse an older success.
      knowledgePersistenceStatus: publicationGeneration,
      searchIndexStatus: publicationGeneration,
      recommendationGeneration: null,
      recommendationLeaseUntil: null,
      recommendationRegenerationGeneration: null,
    },
    where: { id: sessionId },
  });
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
  const owner = await claimBatch(sessionId, true);
  if (!owner) throw new Error("Recommendation preparation is already active or understanding is incomplete.");
  return runBatch(owner, options);
}

async function runBatch(owner: RecommendationBatchOwner, options: BatchOptions) {
  const sessionId = owner.sessionId;
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findUniqueOrThrow({ include: { connectedFolder: true }, where: { id: sessionId } });
  if (!session.connectedFolder.recommendationPermission) {
    await completeSession(owner, options.recordNotebook ?? false);
    await publishScanDerivedKnowledge(sessionId);
    return { createdCount: 0, existingCount: 0, failedCount: 0, processedFileCount: 0, workingKnowledge: null };
  }
  const workingKnowledge = await loadScanWorkingKnowledge(sessionId);
  const contextIndex = await loadRecommendationContextIndex(sessionId, workingKnowledge);
  const candidates = await prisma.scannedFile.findMany({
    orderBy: { relativePath: "asc" },
    select: {
      fileType: true,
      libraryDocument: { select: { observationSessions: {
        orderBy: [...latestObservationOrder], take: 1, select: { status: true },
      } } },
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
  const files = candidates.filter((file) => usableObservation(file.libraryDocument?.observationSessions[0]));
  const evidenceById = new Map(workingKnowledge.files.map((file) => [file.id, file.sourceEvidenceText]));
  let createdCount = 0;
  let existingCount = 0;
  let failedCount = 0;

  for (const file of files) {
    await prisma.$transaction(async (tx) => {
      await lockRecommendationBatch(tx, owner);
      await tx.scanSession.update({ data: { recommendationLeaseUntil: new Date(Date.now() + recommendationLeaseMs) },
        where: { id: sessionId } });
    });
    const controller = new AbortController();
    try {
      const sourceEvidence = evidenceById.get(file.id) ?? "";
      const result = await withTimeout(
        generateOrganizationSuggestionsForScannedFileWithText(
          file.id,
          [file.previewText, sourceEvidence].filter(Boolean).join("\n"),
          {
            replaceChecksumBootstrap: true,
            workingKnowledge,
            contextIndex,
            batchOwner: owner,
            signal: controller.signal,
            beforePersist: options.beforeFilePersist,
          },
        ), controller,
      );
      createdCount += result.createdCount;
      existingCount += result.existingCount;
    } catch (error) {
      failedCount += 1;
      controller.abort();
      await markRecommendationFailure(file.id, error, owner);
    }
  }

  await completeSession(owner, options.recordNotebook ?? false);

  await publishScanDerivedKnowledge(sessionId);

  return {
    createdCount,
    existingCount,
    failedCount,
    processedFileCount: files.length,
    workingKnowledge,
  };
}

async function claimBatch(sessionId: string, explicit: boolean): Promise<RecommendationBatchOwner | null> {
  const prisma = getPrismaClient();
  return prisma.$transaction(async (tx) => {
    const session = await tx.scanSession.findUnique({ select: { connectedFolderId: true, inventoryGeneration: true }, where: { id: sessionId } });
    if (!session) return null;
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder" WHERE id = ${session.connectedFolderId} FOR SHARE`);
    await assertInventoryAfterPhysicalOutcomes(tx, session.connectedFolderId, session.inventoryGeneration);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ScanSession" WHERE id = ${sessionId} FOR UPDATE`);
    const remainingUnderstanding = await tx.scannedFile.count({
    where: {
      OR: [ { processingStage: { notIn: [...settledUnderstandingStages] } }, { observationClaimedAt: { not: null } } ],
      readStatus: "SUPPORTED",
      sessionId,
    },
  });

  if (remainingUnderstanding > 0) {
    return null;
  }

  const generation = crypto.randomUUID();
  const now = new Date();
  const claim = await tx.scanSession.updateMany({
    data: {
      completedAt: null,
      status: "GENERATING_SUGGESTIONS",
      recommendationGeneration: generation,
      recommendationLeaseUntil: new Date(now.getTime() + recommendationLeaseMs),
    },
    where: {
      id: sessionId,
      connectedFolder: currentReadableRootWhere,
      OR: [
        { status: { in: [...claimableSessionStatuses, ...(explicit ? ["COMPLETED", "COMPLETED_WITH_ERRORS"] as const : [])] } },
        { status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] }, connectedFolder: { recommendationPermission: true },
          scannedFiles: { some: { readStatus: "SUPPORTED", readingStatus: "READ", extractionStatus: "COMPLETED", sourceUnavailableAt: null,
            organizationSuggestions: { none: { invalidatedAt: null, recommendationGenerationVersion: currentRecommendationGenerationVersion } } } } },
        { status: "GENERATING_SUGGESTIONS", OR: [ { recommendationLeaseUntil: null }, { recommendationLeaseUntil: { lte: now } } ] },
      ],
    },
  });

  if (claim.count === 0) {
    return null;
  }

  return { sessionId, generation };
  });
}

export async function generateScanRecommendationBatchIfReady(sessionId: string, options: BatchOptions = {}) {
  const owner = await claimBatch(sessionId, false);
  return owner ? runBatch(owner, options) : null;
}

export async function recoverRecommendationBatchesForDevice(bridgeDeviceId: string, now = new Date()) {
  const rows = await getPrismaClient().scanSession.findMany({ select: { id: true }, take: 2,
    orderBy: [{ recommendationLeaseUntil: "asc" }, { id: "asc" }], where: {
      status: "GENERATING_SUGGESTIONS", connectedFolder: { ...currentReadableRootWhere, bridgeDeviceId },
      OR: [ { recommendationLeaseUntil: null }, { recommendationLeaseUntil: { lte: now } } ],
    } });
  for (const row of rows) await generateScanRecommendationBatchIfReady(row.id).catch(async () => {
    // A crashed/retryable batch stays discoverable; rotate failures behind peers.
    await getPrismaClient().scanSession.updateMany({ data: { recommendationLeaseUntil: new Date(Date.now() + 60_000) },
      where: { id: row.id, status: "GENERATING_SUGGESTIONS", recommendationLeaseUntil: { lte: new Date() } } });
  });
}
