import { getPrismaClient } from "@/lib/db/prisma";
import { ObservationSessionError } from "@/lib/library/observation-sessions";

import { requireScanSessionPermission } from "./connected-libraries";
import { readScannedFile, BridgeReaderError } from "./reader";
import { createObservationSessionForScannedFileReadResult } from "./scanned-file-observations";
import { currentRecommendationGenerationVersion } from "./recommendation-generation";
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

function isRecommendationTerminalStage(stage: string) {
  return stage === "SUGGESTIONS_GENERATED" || stage === "RECOMMENDATIONS_READY";
}

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
  await requireScanSessionPermission(
    sessionId,
    "recommendationPermission",
    "prepare organization recommendations",
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

async function updateSessionStatus(
  sessionId: string,
  status: "READING" | "EXAMINING" | "GENERATING_SUGGESTIONS",
) {
  const prisma = getPrismaClient();

  await prisma.scanSession.update({
    data: {
      completedAt: null,
      status,
    },
    where: {
      id: sessionId,
    },
  });
}

async function markFileFailure(
  scannedFileId: string,
  failure: FileProcessingFailure,
) {
  const prisma = getPrismaClient();

  await prisma.scannedFile.update({
    data: {
      processedAt: new Date(),
      processingErrorCategory: failure.category,
      processingStage: "FAILED",
      scanError: failure.message,
    },
    where: {
      id: scannedFileId,
    },
  });
}

function fileNeedsProcessing(
  file: {
    extractionStatus: string;
    libraryDocument: {
      observationSessions: { id: string }[];
    } | null;
    organizationSuggestions: { id: string; suggestionType: string }[];
    processedAt: Date | null;
    processingStage: string;
    readingStatus: string;
  },
  options: ProcessingOptions,
) {
  const hasObservation =
    (file.libraryDocument?.observationSessions.length ?? 0) > 0;
  const hasCurrentRecommendations = file.organizationSuggestions.length > 0;

  if (file.processingStage === "FAILED") {
    if (!options.includeFailed) {
      return false;
    }

    if (!options.retryStartedAt) {
      return true;
    }

    return !file.processedAt || file.processedAt < options.retryStartedAt;
  }

  if (file.readingStatus !== "READ" || file.extractionStatus !== "COMPLETED") {
    return true;
  }

  if (!hasObservation) {
    return true;
  }

  if (file.processingStage === "EXAMINED") {
    return false;
  }

  if (!hasCurrentRecommendations) {
    return true;
  }

  return !isRecommendationTerminalStage(file.processingStage);
}

async function nextSupportedFileForProcessing(
  sessionId: string,
  options: ProcessingOptions,
) {
  const prisma = getPrismaClient();
  const files = await prisma.scannedFile.findMany({
    orderBy: {
      relativePath: "asc",
    },
    select: {
      extractionStatus: true,
      id: true,
      libraryDocument: {
        select: {
          observationSessions: {
            select: {
              id: true,
            },
            take: 1,
          },
        },
      },
      organizationSuggestions: {
        select: {
          id: true,
          suggestionType: true,
        },
        where: {
          invalidatedAt: null,
          recommendationGenerationVersion: currentRecommendationGenerationVersion,
        },
      },
      processedAt: true,
      processingStage: true,
      readingStatus: true,
    },
    where: {
      readStatus: "SUPPORTED",
      sessionId,
    },
  });

  return (
    files.find(
      (file) =>
        !options.excludeFileIds?.has(file.id) &&
        fileNeedsProcessing(file, options),
    ) ?? null
  );
}

async function markFileExamined(scannedFileId: string) {
  const prisma = getPrismaClient();

  await prisma.scannedFile.update({
    data: {
      processedAt: new Date(),
      processingErrorCategory: null,
      processingStage: "EXAMINED",
      scanError: null,
    },
    where: {
      id: scannedFileId,
    },
  });
}

async function fileAlreadyExamined(scannedFileId: string) {
  const prisma = getPrismaClient();
  const file = await prisma.scannedFile.findUnique({
    select: {
      libraryDocument: {
        select: {
          observationSessions: {
            select: {
              id: true,
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

  return (file?.libraryDocument?.observationSessions.length ?? 0) > 0;
}

async function processOneScannedFile(sessionId: string, scannedFileId: string) {
  let readResult;

  try {
    await updateSessionStatus(sessionId, "READING");
    readResult = await withTimeout(
      readScannedFile(scannedFileId),
      readingTimeoutMs,
      "READ_TIMEOUT",
    );
  } catch (error) {
    await markFileFailure(
      scannedFileId,
      fileProcessingFailure(error, "READ_FAILED"),
    );
    return;
  }

  try {
    await updateSessionStatus(sessionId, "EXAMINING");

    if (await fileAlreadyExamined(scannedFileId)) {
      await markFileExamined(scannedFileId);
    } else {
      await withTimeout(
        createObservationSessionForScannedFileReadResult(
          scannedFileId,
          readResult,
        ),
        observationTimeoutMs,
        "OBSERVATION_TIMEOUT",
      );
    }
  } catch (error) {
    await markFileFailure(
      scannedFileId,
      fileProcessingFailure(error, "OBSERVATION_FAILED"),
    );
    return;
  }

  await markFileExamined(scannedFileId);
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

  const processedFileIds = new Set<string>();

  while (true) {
    const nextFile = await nextSupportedFileForProcessing(sessionId, {
      ...options,
      excludeFileIds: processedFileIds,
    });

    if (!nextFile || processedFileIds.has(nextFile.id)) {
      break;
    }

    processedFileIds.add(nextFile.id);
    await processOneScannedFile(sessionId, nextFile.id);
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
