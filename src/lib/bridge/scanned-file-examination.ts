import { getPrismaClient } from "@/lib/db/prisma";
import { getObservationSessionReview } from "@/lib/library/observation-sessions";

import {
  readScannedFileTransient,
  BridgeReaderError,
} from "./reader";
import {
  scannedFileSummary,
  type StoredScannedFile,
} from "./scan-sessions";
import {
  bridgeScanSessionStatuses,
  type BridgeReadPreview,
  type BridgeScanSessionStatus,
  type BridgeScannedFileExaminationData,
} from "./types";
import { summarizeOrganizationSuggestion } from "./organization-suggestions";
import { currentRecommendationGenerationVersion } from "./recommendation-generation";

type ScannedFileForExamination = StoredScannedFile & {
  localPath: string;
  sessionId: string;
  organizationSuggestions: Parameters<
    typeof summarizeOrganizationSuggestion
  >[0][];
  scanSession: {
    connectedFolderId: string;
    id: string;
    startedAt: Date;
    completedAt: Date | null;
    status: string;
    filesScanned: number;
    supportedFiles: number;
    unsupportedFiles: number;
    failedFiles: number;
    connectedFolder: {
      displayName: string;
    };
  };
};

function scanSessionStatus(status: string): BridgeScanSessionStatus {
  return bridgeScanSessionStatuses.includes(status as BridgeScanSessionStatus)
    ? (status as BridgeScanSessionStatus)
    : "FAILED";
}

function approvedMemoryUsedFrom(suggestions: { supportingInformation: string[] }[]) {
  const memory = suggestions.flatMap((suggestion) =>
    suggestion.supportingInformation
      .filter((item) => item.startsWith("Approved Memory used:"))
      .map((item) => item.replace(/^Approved Memory used:\s*/, "").trim()),
  );

  return [...new Set(memory)].filter(Boolean);
}

function safePreviewError(error: unknown) {
  if (error instanceof BridgeReaderError) {
    return error.message;
  }

  return "The Librarian could not reopen the local file for full text right now.";
}

export async function getScannedFileExamination(
  scanSessionId: string,
  scannedFileId: string,
): Promise<BridgeScannedFileExaminationData | null> {
  const prisma = getPrismaClient();
  const file = await prisma.scannedFile.findUnique({
    include: {
      audioMetadata: true,
      imageMetadata: true,
      videoMetadata: true,
      libraryDocument: {
        select: {
          observationSessions: {
            orderBy: {
              createdAt: "desc",
            },
            select: {
              id: true,
              status: true,
            },
          },
        },
      },
      organizationSuggestions: {
        include: {
          revisions: {
            orderBy: {
              createdAt: "desc",
            },
          },
        },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        where: {
          invalidatedAt: null,
          recommendationGenerationVersion: currentRecommendationGenerationVersion,
        },
      },
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

  if (!file || file.sessionId !== scanSessionId) {
    return null;
  }

  const scannedFile = file as ScannedFileForExamination;
  const suggestions = scannedFile.organizationSuggestions.map(
    summarizeOrganizationSuggestion,
  );
  const observationSessionId =
    file.libraryDocument?.observationSessions[0]?.id ?? null;
  const observationReview = observationSessionId
    ? await getObservationSessionReview(observationSessionId)
    : null;
  let preview: BridgeReadPreview | null = null;
  let previewError: string | null = null;

  if (
    scannedFile.readingStatus === "READ" &&
    scannedFile.extractionStatus === "COMPLETED"
  ) {
    try {
      preview = await readScannedFileTransient(scannedFile.id);
    } catch (error) {
      previewError = safePreviewError(error);
    }
  }

  return {
    approvedMemoryUsed: approvedMemoryUsedFrom(suggestions),
    file: scannedFileSummary(scannedFile),
    observationReview,
    preview,
    previewError,
    session: {
      completedAt: scannedFile.scanSession.completedAt?.toISOString() ?? null,
      connectedLibraryId: scannedFile.scanSession.connectedFolderId,
      failedFiles: scannedFile.scanSession.failedFiles,
      folderDisplayName: scannedFile.scanSession.connectedFolder.displayName,
      id: scannedFile.scanSession.id,
      startedAt: scannedFile.scanSession.startedAt.toISOString(),
      status: scanSessionStatus(scannedFile.scanSession.status),
      supportedFiles: scannedFile.scanSession.supportedFiles,
      totalFiles: scannedFile.scanSession.filesScanned,
      unsupportedFiles: scannedFile.scanSession.unsupportedFiles,
    },
    suggestions,
  };
}

export async function getRecommendationExamination(
  scanSessionId: string,
  suggestionId: string,
): Promise<BridgeScannedFileExaminationData | null> {
  const prisma = getPrismaClient();
  const suggestion = await prisma.organizationSuggestion.findUnique({
    select: {
      id: true,
      invalidatedAt: true,
      recommendationGenerationVersion: true,
      scannedFileId: true,
      scanSessionId: true,
    },
    where: {
      id: suggestionId,
    },
  });

  if (
    !suggestion ||
    suggestion.scanSessionId !== scanSessionId ||
    suggestion.invalidatedAt ||
    suggestion.recommendationGenerationVersion !==
      currentRecommendationGenerationVersion
  ) {
    return null;
  }

  const examination = await getScannedFileExamination(
    scanSessionId,
    suggestion.scannedFileId,
  );

  if (!examination) {
    return null;
  }

  return {
    ...examination,
    suggestions: examination.suggestions.filter(
      (item) => item.id === suggestion.id,
    ),
  };
}
