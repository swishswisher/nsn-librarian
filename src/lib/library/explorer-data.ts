import type { Prisma } from "@prisma/client";

import {
  scannedFileSummary,
  type StoredScannedFile,
} from "@/lib/bridge/scan-sessions";
import { getPrismaClient } from "@/lib/db/prisma";

import {
  buildLibraryExplorerData,
  type LibraryExplorerData,
  type LibraryExplorerRootInput,
} from "./explorer";

const scannedFileSummarySelect = {
  audioMetadata: true,
  characterCount: true,
  checksum: true,
  extractedAt: true,
  extractionErrorCategory: true,
  extractionStatus: true,
  fileType: true,
  id: true,
  imageMetadata: true,
  lastModified: true,
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
      suggestionType: true,
    },
  },
  previewText: true,
  processedAt: true,
  processingErrorCategory: true,
  processingStage: true,
  readingStatus: true,
  readStatus: true,
  relativePath: true,
  scanError: true,
  sizeBytes: true,
  sourceCreatedAt: true,
  sourceUnavailableAt: true,
  sourceUnavailableReason: true,
  videoMetadata: true,
} satisfies Prisma.ScannedFileSelect;

export async function getLibraryExplorerData(): Promise<LibraryExplorerData> {
  const prisma = getPrismaClient();
  const connectedLibraries = await prisma.connectedLibrary.findMany({
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    select: {
      displayName: true,
      id: true,
      isEnabled: true,
      lastScanAt: true,
      platform: true,
      scanSessions: {
        orderBy: [{ startedAt: "desc" }],
        select: {
          completedAt: true,
          id: true,
          scannedFiles: {
            orderBy: {
              relativePath: "asc",
            },
            select: scannedFileSummarySelect,
          },
          startedAt: true,
          status: true,
        },
        take: 1,
      },
      status: true,
    },
    where: {
      hiddenFromActiveListAt: null,
      mergedAt: null,
      status: {
        notIn: ["MERGED", "HIDDEN_FROM_ACTIVE_LIST"],
      },
    },
  });

  const roots: LibraryExplorerRootInput[] = connectedLibraries.map(
    (library) => {
      const latestScanSession = library.scanSessions[0] ?? null;

      return {
        displayName: library.displayName,
        files:
          latestScanSession?.scannedFiles.map((file) =>
            scannedFileSummary(file as StoredScannedFile),
          ) ?? [],
        id: library.id,
        isEnabled: library.isEnabled,
        lastScanAt: library.lastScanAt?.toISOString() ?? null,
        latestScanSession: latestScanSession
          ? {
              completedAt: latestScanSession.completedAt?.toISOString() ?? null,
              id: latestScanSession.id,
              startedAt: latestScanSession.startedAt.toISOString(),
              status: latestScanSession.status,
            }
          : null,
        platform: library.platform,
        status: library.status,
      };
    },
  );

  return buildLibraryExplorerData(roots);
}
