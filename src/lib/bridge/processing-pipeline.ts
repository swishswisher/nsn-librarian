import { Prisma } from "@prisma/client";
import { LocalSourceIdentityError } from "./local-read-authority";
import { claimObservationLease, latestObservationOrder, observationLeaseMs, usableObservation, withOwnedObservationLease } from "./observation-authority";
import { getPrismaClient } from "@/lib/db/prisma";
import { ObservationSessionError } from "@/lib/library/observation-sessions";

import { requireScanSessionPermission } from "./connected-libraries";
import { readScannedFile, BridgeReaderError } from "./reader";
import { createObservationSessionForScannedFileReadResult } from "./scanned-file-observations";
import { generateScanRecommendationBatchIfReady } from "./scan-recommendation-batch";
import {
  createBridgeScanSessionFromEnvironment,
  createBridgeScanSessionForConnectedLibrary,
  getActiveBridgeScanSession,
  getBridgeScanSessionProgress,
} from "./scan-sessions";
import type {
  BridgeScanProcessingProgress,
  BridgeScanSessionSummary,
} from "./types";

type ProcessingStartResult = {
  alreadyActive: boolean;
  progress: BridgeScanProcessingProgress;
  session: BridgeScanSessionSummary;
};

type ProcessingOptions = {
  beforeFile?: () => Promise<void>;
  excludeFileIds?: Set<string>;
  includeFailed?: boolean;
  recordNotebook?: boolean;
  retryStartedAt?: Date;
};

type FileProcessingFailure = {
  category: string;
  message: string;
};

const safeFileProcessingFailureMessage =
  "The Librarian could not finish processing this file safely.";
const readingTimeoutMs = 120_000;
const observationTimeoutMs = 35_000;



class FileProcessingTimeoutError extends Error {
  category: string;

  constructor(category: string) {
    super("The Librarian took too long to process this file safely.");
    this.name = "FileProcessingTimeoutError";
    this.category = category;
  }
}

function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  category: string,
) {
  let timeoutId: ReturnType<typeof setTimeout>;

  return new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new FileProcessingTimeoutError(category));
    }, timeoutMs);

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

function fileProcessingFailure(
  error: unknown,
  fallbackCategory: string,
): FileProcessingFailure {
  if (error instanceof LocalSourceIdentityError) return { category: error.category, message: error.message };
  if (error instanceof FileProcessingTimeoutError) {
    return {
      category: error.category,
      message: "This file took too long to process safely.",
    };
  }

  if (error instanceof BridgeReaderError) {
    return {
      category: error.category,
      message: error.message,
    };
  }

  if (error instanceof ObservationSessionError) {
    return {
      category: "OBSERVATION_FAILED",
      message: error.message,
    };
  }

  return {
    category: fallbackCategory,
    message: safeFileProcessingFailureMessage,
  };
}

async function requireAutomaticProcessingPermissions(sessionId: string) {
  await requireScanSessionPermission(
    sessionId,
    "readPermission",
    "process scanned files",
  );
}

async function activeProgressForSession(
  sessionId: string,
): Promise<ProcessingStartResult | null> {
  const progress = await getBridgeScanSessionProgress(sessionId);

  if (!progress) {
    return null;
  }

  return {
    alreadyActive: true,
    progress: progress.progress,
    session: progress.session,
  };
}

async function updateSessionStatus(sessionId: string, status: "READING" | "EXAMINING", fileId: string, owner: Date) {
  await withOwnedObservationLease(fileId, owner, async (tx) => {
    await tx.scanSession.update({ data: { completedAt: null, status }, where: { id: sessionId } });
  });
}

async function markFileFailure(scannedFileId: string, failure: FileProcessingFailure, owner: Date) {
  await withOwnedObservationLease(scannedFileId, owner, async (tx) => {
    await tx.scannedFile.update({ data: { processedAt: new Date(), processingErrorCategory: failure.category,
      processingStage: "FAILED", scanError: failure.message, observationClaimedAt: null }, where: { id: scannedFileId } });
  }).catch(() => undefined); // A superseded worker cannot mark a newer claim failed.
}



export type ProcessingPageCursor = { relativePath: string; id: string };
export type ProcessingPageWork = { pageQueries?: number; candidateRows?: number };

export async function processingFilePage(sessionId: string, options: ProcessingOptions = {}, after?: ProcessingPageCursor,
  limit = 500, work?: ProcessingPageWork) {
  const excluded = [...(options.excludeFileIds ?? [])];
  const size = Math.max(1, Math.min(500, Math.floor(limit)));
  const files = await getPrismaClient().$queryRaw<Array<ProcessingPageCursor>>(Prisma.sql`
    SELECT file.id, file."relativePath" FROM "ScannedFile" file
    WHERE file."sessionId" = ${sessionId} AND file."readStatus" = 'SUPPORTED'
      AND file."sourceUnavailableAt" IS NULL
      AND file."processingStage" NOT IN ('EXAMINED', 'SUGGESTIONS_GENERATED', 'RECOMMENDATIONS_READY', 'UNSUPPORTED')
      AND (file."processingStage" <> 'FAILED' OR (${Boolean(options.includeFailed)}
        ${options.retryStartedAt ? Prisma.sql`AND (file."processedAt" IS NULL OR file."processedAt" < ${options.retryStartedAt})` : Prisma.empty}))
      AND (file."observationClaimedAt" IS NULL OR file."observationClaimedAt" <= ${new Date(Date.now() - observationLeaseMs)})
      ${after ? Prisma.sql`AND (file."relativePath", file.id) > (${after.relativePath}, ${after.id})` : Prisma.empty}
      ${excluded.length ? Prisma.sql`AND file.id NOT IN (${Prisma.join(excluded)})` : Prisma.empty}
    ORDER BY file."relativePath", file.id LIMIT ${size}
  `);
  if (work) { work.pageQueries = (work.pageQueries ?? 0) + 1; work.candidateRows = (work.candidateRows ?? 0) + files.length; }
  return files;
}

async function nextSupportedFileForProcessing(sessionId: string, options: ProcessingOptions) {
  return (await processingFilePage(sessionId, options, undefined, 1))[0] ?? null;
}

async function markFileExamined(scannedFileId: string, owner: Date) {
  await withOwnedObservationLease(scannedFileId, owner, async (tx) => {
    await tx.scannedFile.update({ data: { processedAt: new Date(), processingErrorCategory: null,
      processingStage: "EXAMINED", scanError: null, observationClaimedAt: null }, where: { id: scannedFileId } });
  });
}

async function fileAlreadyExamined(scannedFileId: string) {
  const prisma = getPrismaClient();
  const file = await prisma.scannedFile.findUnique({
    select: {
      libraryDocument: {
        select: {
          observationSessions: {
            orderBy: [...latestObservationOrder],
            select: {
              id: true, status: true,
            },
            take: 1,
          },
        },
      },
    },
    where: {
      id: scannedFileId,
    },
  });

  return usableObservation(file?.libraryDocument?.observationSessions[0]);
}

async function processOneScannedFile(sessionId: string, scannedFileId: string) {
  let owner: Date;
  try { owner = await claimObservationLease(scannedFileId); } catch { return; }
  let readResult;

  try {
    await updateSessionStatus(sessionId, "READING", scannedFileId, owner);
    readResult = await withTimeout(
      readScannedFile(scannedFileId, owner),
      readingTimeoutMs,
      "READ_TIMEOUT",
    );
  } catch (error) {
    await markFileFailure(
      scannedFileId,
      fileProcessingFailure(error, "READ_FAILED"), owner,
    );
    return;
  }

  try {
    await updateSessionStatus(sessionId, "EXAMINING", scannedFileId, owner);

    if (await fileAlreadyExamined(scannedFileId)) {
      await markFileExamined(scannedFileId, owner);
    } else {
      await withTimeout(
        createObservationSessionForScannedFileReadResult(
          scannedFileId,
          readResult, owner,
        ),
        observationTimeoutMs,
        "OBSERVATION_TIMEOUT",
      );
    }
  } catch (error) {
    await markFileFailure(
      scannedFileId,
      fileProcessingFailure(error, "OBSERVATION_FAILED"), owner,
    );
    return;
  }


}

async function progressResult(
  sessionId: string,
  alreadyActive = false,
): Promise<ProcessingStartResult> {
  const progress = await getBridgeScanSessionProgress(sessionId);

  if (!progress) {
    throw new Error("The Librarian could not find that scan session.");
  }

  return {
    alreadyActive,
    progress: progress.progress,
    session: progress.session,
  };
}

export async function processNextBridgeScanSessionFile(
  sessionId: string,
  options: ProcessingOptions = {},
): Promise<ProcessingStartResult> {
  await requireAutomaticProcessingPermissions(sessionId);

  const nextFile = await nextSupportedFileForProcessing(sessionId, options);

  if (!nextFile) {
    await generateScanRecommendationBatchIfReady(sessionId, {
      recordNotebook: options.recordNotebook ?? true,
    });
    return progressResult(sessionId);
  }

  await options.beforeFile?.();
  await processOneScannedFile(sessionId, nextFile.id);

  const remainingFile = await nextSupportedFileForProcessing(sessionId, {
    includeFailed: false,
  });

  if (!remainingFile) {
    await generateScanRecommendationBatchIfReady(sessionId, {
      recordNotebook: options.recordNotebook ?? true,
    });
  }

  return progressResult(sessionId);
}

export async function processBridgeScanSession(
  sessionId: string,
  options: ProcessingOptions = {},
) {
  await requireAutomaticProcessingPermissions(sessionId);

  const retryStartedAt = options.retryStartedAt ?? new Date();
  let cursor: ProcessingPageCursor | undefined;
  while (true) {
    const page = await processingFilePage(sessionId, { ...options, retryStartedAt }, cursor);
    if (!page.length) break;
    for (const file of page) { await options.beforeFile?.(); await processOneScannedFile(sessionId, file.id); }
    cursor = page.at(-1);
  }

  await generateScanRecommendationBatchIfReady(sessionId, {
    recordNotebook: options.recordNotebook ?? true,
  });
}

export async function startBridgeScanSessionFromEnvironment(): Promise<ProcessingStartResult> {
  const activeSession = await getActiveBridgeScanSession();

  if (activeSession) {
    const activeProgress = await activeProgressForSession(activeSession.id);

    if (activeProgress) {
      return activeProgress;
    }
  }

  const session = await createBridgeScanSessionFromEnvironment();

  return progressResult(session.id, false);
}

export async function startBridgeScanSessionForConnectedLibrary(
  connectedLibraryId: string,
): Promise<ProcessingStartResult> {
  const activeSession = await getActiveBridgeScanSession(connectedLibraryId);

  if (activeSession) {
    const activeProgress = await activeProgressForSession(activeSession.id);

    if (activeProgress) {
      return activeProgress;
    }
  }

  const session = await createBridgeScanSessionForConnectedLibrary(
    connectedLibraryId,
  );

  return progressResult(session.id, false);
}

export async function startAutomaticBridgeScanProcessingFromEnvironment(): Promise<ProcessingStartResult> {
  return startBridgeScanSessionFromEnvironment();
}

export async function retryBridgeScanSessionProcessing(
  sessionId: string,
): Promise<ProcessingStartResult> {
  await processBridgeScanSession(sessionId, {
    includeFailed: true,
  });

  return progressResult(sessionId);
}
