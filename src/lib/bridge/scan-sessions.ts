import path from "node:path";

import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";

import { audioMetadataSummary } from "./audio-metadata";
import { imageMetadataSummary } from "./image-metadata";
import { videoMetadataSummary } from "./video-metadata";
import {
  scanConfiguredBridgeTestFolder,
  scanConnectedLibrary,
} from "./scanner";
import {
  connectDeveloperLibrary,
  ConnectedLibraryError,
  ensureDeveloperFallbackConnectedLibrary,
  requireConnectedLibraryPermission,
} from "./connected-libraries";
import type {
  BridgeAudioMetadataDraft,
  BridgeExtractionStatus,
  BridgeFileReadingStatus,
  BridgeFolderScanResult,
  BridgeScanProcessingProgress,
  BridgeScanSessionDetail,
  BridgeScanSessionSummary,
  BridgeScannedFileDraft,
  BridgeScannedFileSummary,
  BridgeVideoMetadataDraft,
  OrganizationSuggestionCounts,
  OrganizationSuggestionStatus,
  ScannedFileProcessingStage,
  ScannedFileReadStatus,
} from "./types";
import { recordChecksumDuplicateSuggestionsForSession } from "./checksum-duplicates";
import { currentRecommendationGenerationVersion } from "./recommendation-generation";

type StoredScanSession = {
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

export type StoredScannedFile = {
  id: string;
  relativePath: string;
  fileType: string;
  checksum: string | null;
  sizeBytes: bigint | null;
  lastModified: Date | null;
  readStatus: string;
  readingStatus: string;
  extractionStatus: string;
  characterCount: number | null;
  extractedAt: Date | null;
  extractionErrorCategory: string | null;
  previewText: string | null;
  processingStage: string;
  processingErrorCategory: string | null;
  processedAt: Date | null;
  sourceUnavailableAt: Date | null;
  sourceUnavailableReason: string | null;
  scanError: string | null;
  sourceCreatedAt: Date | null;
  audioMetadata?: StoredAudioRecordingMetadata | null;
  imageMetadata?: StoredImageAssetMetadata | null;
  videoMetadata?: StoredVideoRecordingMetadata | null;
  libraryDocument?: {
    observationSessions: {
      status: string;
    }[];
  } | null;
  organizationSuggestions?: {
    status: string;
    suggestionType?: string | null;
  }[];
};

type StoredImageAssetMetadata = {
  cameraDevice: string | null;
  colorProfile: string | null;
  duplicateConfidence: number | null;
  duplicateKind: string | null;
  duplicateOfScannedFileId: string | null;
  embeddedDate: Date | null;
  format: string | null;
  height: number | null;
  humanLabels: Prisma.JsonValue;
  imageFingerprint: string | null;
  machineLabels: Prisma.JsonValue;
  ocrErrorCategory: string | null;
  ocrStatus: string;
  orientation: string | null;
  previewErrorCategory: string | null;
  previewStatus: string;
  privacyState: string;
  provisionalQuestions: Prisma.JsonValue;
  provisionalTopics: Prisma.JsonValue;
  relatedSignals: Prisma.JsonValue;
  sourceCreatedAt: Date | null;
  sourceModifiedAt: Date | null;
  summary: string | null;
  textSnippet: string | null;
  visualAnalysisErrorCategory: string | null;
  visualAnalysisStatus: string;
  width: number | null;
};

type StoredVideoRecordingMetadata = {
  bitrateKbps: number | null;
  chapterSuggestions: Prisma.JsonValue;
  codec: string | null;
  container: string | null;
  duplicateConfidence: number | null;
  duplicateKind: string | null;
  duplicateOfScannedFileId: string | null;
  durationSeconds: number | null;
  frameAnalysisErrorCategory: string | null;
  frameAnalysisStatus: string;
  frameRate: number | null;
  hasAudioTrack: boolean | null;
  height: number | null;
  humanLabels: Prisma.JsonValue;
  machineLabels: Prisma.JsonValue;
  privacyState: string;
  provisionalPeople: Prisma.JsonValue;
  provisionalProjects: Prisma.JsonValue;
  provisionalQuestions: Prisma.JsonValue;
  provisionalTopics: Prisma.JsonValue;
  relatedSignals: Prisma.JsonValue;
  selectedFrameDescriptions: Prisma.JsonValue;
  sourceCreatedAt: Date | null;
  sourceModifiedAt: Date | null;
  summary: string | null;
  transcriptionConfidence: number | null;
  transcriptionErrorCategory: string | null;
  transcriptionStatus: string;
  transcriptSnippet: string | null;
  videoFingerprint: string | null;
  width: number | null;
};

type StoredAudioRecordingMetadata = {
  audioFingerprint: string | null;
  bitrateKbps: number | null;
  channels: number | null;
  codec: string | null;
  container: string | null;
  duplicateConfidence: number | null;
  duplicateKind: string | null;
  duplicateOfScannedFileId: string | null;
  durationSeconds: number | null;
  humanLabels: Prisma.JsonValue;
  machineLabels: Prisma.JsonValue;
  privacyState: string;
  provisionalActionItems: Prisma.JsonValue;
  provisionalPeople: Prisma.JsonValue;
  provisionalProjects: Prisma.JsonValue;
  provisionalQuestions: Prisma.JsonValue;
  provisionalTopics: Prisma.JsonValue;
  sampleRateHz: number | null;
  sourceCreatedAt: Date | null;
  sourceModifiedAt: Date | null;
  summary: string | null;
  transcriptionConfidence: number | null;
  transcriptionErrorCategory: string | null;
  transcriptionStatus: string;
  transcriptSnippet: string | null;
};

const scanCreateChunkSize = 250;
const scannedFileReadStatusValues = new Set<ScannedFileReadStatus>([
  "PENDING",
  "SUPPORTED",
  "UNSUPPORTED",
  "FAILED",
]);
const bridgeFileReadingStatusValues = new Set<BridgeFileReadingStatus>([
  "NOT_READ",
  "READ",
  "FAILED",
  "UNSUPPORTED",
]);
const bridgeScanSessionStatusValues = new Set<BridgeScanSessionSummary["status"]>([
  "PENDING",
  "SCANNING",
  "READING",
  "EXAMINING",
  "GENERATING_SUGGESTIONS",
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
]);
const bridgeExtractionStatusValues = new Set<BridgeExtractionStatus>([
  "PENDING",
  "EXTRACTING",
  "COMPLETED",
  "FAILED",
  "UNSUPPORTED",
]);
const scannedFileProcessingStageValues = new Set<ScannedFileProcessingStage>([
  "DISCOVERED",
  "READING_IMAGE_METADATA",
  "METADATA_READY",
  "PREPARING_PREVIEW",
  "ANALYZING_IMAGE",
  "OCR_PROCESSING",
  "OBSERVING",
  "RECOMMENDATIONS_READY",
  "READING",
  "READ",
  "EXAMINING",
  "EXAMINED",
  "SUGGESTIONS_GENERATED",
  "UNSUPPORTED",
  "FAILED",
]);
const organizationSuggestionStatusValues = new Set<OrganizationSuggestionStatus>(
  ["PENDING", "APPROVED", "MODIFIED", "REJECTED", "LEFT_UNCHANGED"],
);
const activeBridgeScanStatuses: BridgeScanSessionSummary["status"][] = [
  "PENDING",
  "SCANNING",
  "READING",
  "EXAMINING",
  "GENERATING_SUGGESTIONS",
];
const reusableBridgeScanStatuses: BridgeScanSessionSummary["status"][] = [
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
];
const staleScanSessionThresholdMs = 2 * 60 * 1000;

function isRecommendationTerminalStage(stage: string) {
  return stage === "SUGGESTIONS_GENERATED" || stage === "RECOMMENDATIONS_READY";
}

function pathKey(value: string) {
  const normalized = path.normalize(value);

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function emptyOrganizationSuggestionCounts(): OrganizationSuggestionCounts {
  return {
    approved: 0,
    eligibleForPlanning: 0,
    leftUnchanged: 0,
    modified: 0,
    pending: 0,
    rejected: 0,
    total: 0,
  };
}

function organizationSuggestionStatus(
  status: string,
): OrganizationSuggestionStatus {
  return organizationSuggestionStatusValues.has(
    status as OrganizationSuggestionStatus,
  )
    ? (status as OrganizationSuggestionStatus)
    : "PENDING";
}

export function organizationSuggestionCounts(
  suggestions: { status: string }[] = [],
): OrganizationSuggestionCounts {
  const counts = emptyOrganizationSuggestionCounts();

  for (const suggestion of suggestions) {
    counts.total += 1;

    const status = organizationSuggestionStatus(suggestion.status);

    if (status === "APPROVED") {
      counts.approved += 1;
      counts.eligibleForPlanning += 1;
    } else if (status === "MODIFIED") {
      counts.modified += 1;
      counts.eligibleForPlanning += 1;
    } else if (status === "REJECTED") {
      counts.rejected += 1;
    } else if (status === "LEFT_UNCHANGED") {
      counts.leftUnchanged += 1;
    } else {
      counts.pending += 1;
    }
  }

  return counts;
}

function reviewedObservationStatus(status: string) {
  return status === "APPROVED" || status === "MODIFIED";
}

function scanSessionStatus(status: string): BridgeScanSessionSummary["status"] {
  return bridgeScanSessionStatusValues.has(
    status as BridgeScanSessionSummary["status"],
  )
    ? (status as BridgeScanSessionSummary["status"])
    : "FAILED";
}

function scanSessionSummary(
  session: StoredScanSession,
): BridgeScanSessionSummary {
  return {
    completedAt: session.completedAt?.toISOString() ?? null,
    connectedLibraryId: session.connectedFolderId,
    failedFiles: session.failedFiles,
    folderDisplayName: session.connectedFolder.displayName,
    id: session.id,
    startedAt: session.startedAt.toISOString(),
    status: scanSessionStatus(session.status),
    supportedFiles: session.supportedFiles,
    totalFiles: session.filesScanned,
    unsupportedFiles: session.unsupportedFiles,
  };
}

export function scannedFileSummary(
  file: StoredScannedFile,
): BridgeScannedFileSummary {
  const readStatus = scannedFileReadStatusValues.has(
    file.readStatus as ScannedFileReadStatus,
  )
    ? (file.readStatus as ScannedFileReadStatus)
    : "FAILED";
  const readingStatus = bridgeFileReadingStatusValues.has(
    file.readingStatus as BridgeFileReadingStatus,
  )
    ? (file.readingStatus as BridgeFileReadingStatus)
    : "FAILED";
  const extractionStatus = bridgeExtractionStatusValues.has(
    file.extractionStatus as BridgeExtractionStatus,
  )
    ? (file.extractionStatus as BridgeExtractionStatus)
    : "FAILED";
  const processingStage = scannedFileProcessingStageValues.has(
    file.processingStage as ScannedFileProcessingStage,
  )
    ? (file.processingStage as ScannedFileProcessingStage)
    : "FAILED";

  return {
    characterCount: file.characterCount,
    checksum: file.checksum,
    extractedAt: file.extractedAt?.toISOString() ?? null,
    extractionErrorCategory: file.extractionErrorCategory,
    extractionStatus,
    fileType: file.fileType,
    id: file.id,
    lastModified: file.lastModified?.toISOString() ?? null,
    sourceCreatedAt: file.sourceCreatedAt?.toISOString() ?? null,
    previewText: file.previewText,
    processedAt: file.processedAt?.toISOString() ?? null,
    processingErrorCategory: file.processingErrorCategory,
    processingStage,
    readingStatus,
    readStatus,
    relativePath: file.relativePath,
    scanError: file.scanError,
    sizeBytes: file.sizeBytes?.toString() ?? null,
    sourceUnavailableAt: file.sourceUnavailableAt?.toISOString() ?? null,
    sourceUnavailableReason: file.sourceUnavailableReason,
    hasObservation:
      (file.libraryDocument?.observationSessions.length ?? 0) > 0,
    hasReviewedObservation:
      file.libraryDocument?.observationSessions.some((session) =>
        reviewedObservationStatus(session.status),
      ) ?? false,
    hasPossibleDuplicateSuggestion:
      file.organizationSuggestions?.some(
        (suggestion) => suggestion.suggestionType === "POSSIBLE_DUPLICATE",
      ) ?? false,
    organizationSuggestionCounts: organizationSuggestionCounts(
      file.organizationSuggestions,
    ),
    audioMetadata: file.audioMetadata
      ? audioMetadataSummary(file.audioMetadata)
      : null,
    imageMetadata: file.imageMetadata
      ? imageMetadataSummary(file.imageMetadata)
      : null,
    videoMetadata: file.videoMetadata
      ? videoMetadataSummary(file.videoMetadata)
      : null,
  };
}

function initialReadingStatusFor(
  file: BridgeScannedFileDraft,
): Prisma.ScannedFileCreateManyInput["readingStatus"] {
  if (file.readStatus === "SUPPORTED") {
    return "NOT_READ" as const;
  }

  return file.readStatus === "UNSUPPORTED" ? "UNSUPPORTED" : "FAILED";
}

function initialExtractionStatusFor(
  file: BridgeScannedFileDraft,
): Prisma.ScannedFileCreateManyInput["extractionStatus"] {
  if (file.readStatus === "SUPPORTED") {
    return "PENDING" as const;
  }

  return file.readStatus === "UNSUPPORTED" ? "UNSUPPORTED" : "FAILED";
}

function initialProcessingStageFor(
  file: BridgeScannedFileDraft,
): Prisma.ScannedFileCreateManyInput["processingStage"] {
  if (file.readStatus === "SUPPORTED") {
    return "DISCOVERED" as const;
  }

  return file.readStatus === "UNSUPPORTED" ? "UNSUPPORTED" : "FAILED";
}

function scannedFileCreateData(
  sessionId: string,
  file: BridgeScannedFileDraft,
): Prisma.ScannedFileCreateManyInput {
  return {
    checksum: file.checksum,
    extractionStatus: initialExtractionStatusFor(file),
    fileType: file.fileType,
    lastModified: file.lastModified,
    localPath: file.localPath,
    processedAt: file.readStatus === "SUPPORTED" ? null : new Date(),
    processingErrorCategory:
      file.readStatus === "FAILED"
        ? "SCAN_FAILED"
        : file.readStatus === "UNSUPPORTED"
          ? "UNSUPPORTED_FILE_TYPE"
          : null,
    processingStage: initialProcessingStageFor(file),
    readingStatus: initialReadingStatusFor(file),
    readStatus: file.readStatus,
    relativePath: file.relativePath,
    scanError: file.scanError ?? null,
    sessionId,
    sizeBytes: file.sizeBytes,
    sourceCreatedAt: file.sourceCreatedAt ?? null,
  };
}

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function audioMetadataWriteData(
  metadata: BridgeAudioMetadataDraft,
): Prisma.AudioRecordingMetadataUncheckedCreateWithoutScannedFileInput {
  return {
    audioFingerprint: metadata.audioFingerprint,
    bitrateKbps: metadata.bitrateKbps,
    channels: metadata.channels,
    codec: metadata.codec,
    container: metadata.container,
    durationSeconds: metadata.durationSeconds,
    humanLabels: toJsonInput([]),
    machineLabels: toJsonInput([]),
    privacyState: "REVIEW_REQUIRED",
    provisionalActionItems: toJsonInput([]),
    provisionalPeople: toJsonInput([]),
    provisionalProjects: toJsonInput([]),
    provisionalQuestions: toJsonInput([]),
    provisionalTopics: toJsonInput([]),
    sampleRateHz: metadata.sampleRateHz,
    sourceCreatedAt: metadata.sourceCreatedAt,
    sourceModifiedAt: metadata.sourceModifiedAt,
    transcriptionStatus: "NOT_REQUESTED",
  };
}

function videoMetadataWriteData(
  metadata: BridgeVideoMetadataDraft,
): Prisma.VideoRecordingMetadataUncheckedCreateWithoutScannedFileInput {
  return {
    bitrateKbps: metadata.bitrateKbps,
    chapterSuggestions: toJsonInput([]),
    codec: metadata.codec,
    container: metadata.container,
    durationSeconds: metadata.durationSeconds,
    frameAnalysisStatus: "NOT_REQUESTED",
    frameRate: metadata.frameRate,
    hasAudioTrack: metadata.hasAudioTrack,
    height: metadata.height,
    humanLabels: toJsonInput([]),
    machineLabels: toJsonInput([]),
    privacyState: "REVIEW_REQUIRED",
    provisionalPeople: toJsonInput([]),
    provisionalProjects: toJsonInput([]),
    provisionalQuestions: toJsonInput([]),
    provisionalTopics: toJsonInput([]),
    relatedSignals: toJsonInput([]),
    selectedFrameDescriptions: toJsonInput([]),
    sourceCreatedAt: metadata.sourceCreatedAt,
    sourceModifiedAt: metadata.sourceModifiedAt,
    transcriptionStatus: "NOT_REQUESTED",
    videoFingerprint: metadata.videoFingerprint,
    width: metadata.width,
  };
}

async function storeAudioMetadata(
  sessionId: string,
  files: BridgeScannedFileDraft[],
) {
  const prisma = getPrismaClient();
  const audioDrafts = files.filter((file) => file.audioMetadata);

  if (audioDrafts.length === 0) {
    return;
  }

  for (let index = 0; index < audioDrafts.length; index += scanCreateChunkSize) {
    const chunk = audioDrafts.slice(index, index + scanCreateChunkSize);
    const draftsByPath = new Map(
      chunk.map((file) => [file.relativePath, file.audioMetadata]),
    );
    const storedFiles = await prisma.scannedFile.findMany({
      select: {
        id: true,
        relativePath: true,
      },
      where: {
        relativePath: {
          in: chunk.map((file) => file.relativePath),
        },
        sessionId,
      },
    });

    for (const storedFile of storedFiles) {
      const metadata = draftsByPath.get(storedFile.relativePath);

      if (!metadata) {
        continue;
      }

      const data = audioMetadataWriteData(metadata);

      await prisma.audioRecordingMetadata.upsert({
        create: {
          ...data,
          scannedFileId: storedFile.id,
        },
        update: data,
        where: {
          scannedFileId: storedFile.id,
        },
      });
    }
  }
}

async function storeVideoMetadata(
  sessionId: string,
  files: BridgeScannedFileDraft[],
) {
  const prisma = getPrismaClient();
  const videoDrafts = files.filter((file) => file.videoMetadata);

  if (videoDrafts.length === 0) {
    return;
  }

  for (let index = 0; index < videoDrafts.length; index += scanCreateChunkSize) {
    const chunk = videoDrafts.slice(index, index + scanCreateChunkSize);
    const draftsByPath = new Map(
      chunk.map((file) => [file.relativePath, file.videoMetadata]),
    );
    const storedFiles = await prisma.scannedFile.findMany({
      select: {
        id: true,
        relativePath: true,
      },
      where: {
        relativePath: {
          in: chunk.map((file) => file.relativePath),
        },
        sessionId,
      },
    });

    for (const storedFile of storedFiles) {
      const metadata = draftsByPath.get(storedFile.relativePath);

      if (!metadata) {
        continue;
      }

      const data = videoMetadataWriteData(metadata);

      await prisma.videoRecordingMetadata.upsert({
        create: {
          ...data,
          scannedFileId: storedFile.id,
        },
        update: data,
        where: {
          scannedFileId: storedFile.id,
        },
      });
    }
  }
}

async function storeScannedFiles(
  sessionId: string,
  files: BridgeScannedFileDraft[],
) {
  const prisma = getPrismaClient();

  for (let index = 0; index < files.length; index += scanCreateChunkSize) {
    const chunk = files.slice(index, index + scanCreateChunkSize);

    await prisma.scannedFile.createMany({
      data: chunk.map((file) => scannedFileCreateData(sessionId, file)),
    });
  }

  await storeAudioMetadata(sessionId, files);
  await storeVideoMetadata(sessionId, files);
}

export async function createBridgeScanSessionFromScan(
  scan: BridgeFolderScanResult,
  options: {
    allowReusableSession?: boolean;
    connectedLibraryId?: string;
  } = {},
) {
  const prisma = getPrismaClient();
  const connectedFolder = await connectedFolderFor(
    scan,
    options.connectedLibraryId,
  );
  const allowReusableSession = options.allowReusableSession ?? true;
  const reusableSession = allowReusableSession
    ? await reusableScanSessionFor(connectedFolder.id, scan)
    : null;

  if (reusableSession) {
    await prisma.connectedLibrary.update({
      data: {
        lastScanAt: new Date(),
      },
      where: {
        id: connectedFolder.id,
      },
    });
    await recordChecksumDuplicateSuggestionsForSession(reusableSession.id);

    return scanSessionSummary(reusableSession);
  }

  const session = await prisma.scanSession.create({
    data: {
      connectedFolderId: connectedFolder.id,
      startedAt: scan.startedAt,
      status: "SCANNING",
    },
  });

  try {
    await storeScannedFiles(session.id, scan.files);
    await recordChecksumDuplicateSuggestionsForSession(session.id);

    const terminalStatus =
      scan.supportedFiles > 0
        ? "READING"
        : scan.failedFiles > 0
          ? "COMPLETED_WITH_ERRORS"
          : "COMPLETED";
    const [updatedSession] = await prisma.$transaction([
      prisma.scanSession.update({
        data: {
          completedAt: scan.supportedFiles > 0 ? null : scan.completedAt,
          failedFiles: scan.failedFiles,
          filesScanned: scan.totalFiles,
          observationsCreated: 0,
          status: terminalStatus,
          supportedFiles: scan.supportedFiles,
          unsupportedFiles: scan.unsupportedFiles,
        },
        include: {
          connectedFolder: {
            select: {
              displayName: true,
            },
          },
        },
        where: {
          id: session.id,
        },
      }),
      prisma.connectedLibrary.update({
        data: {
          lastScanAt: new Date(),
        },
        where: {
          id: connectedFolder.id,
        },
      }),
    ]);

    return scanSessionSummary(updatedSession);
  } catch (error) {
    await prisma.scanSession.update({
      data: {
        completedAt: new Date(),
        failedFiles: scan.failedFiles,
        filesScanned: scan.totalFiles,
        status: "FAILED",
        supportedFiles: scan.supportedFiles,
        unsupportedFiles: scan.unsupportedFiles,
      },
      where: {
        id: session.id,
      },
    });

    throw error;
  }
}

async function connectedFolderFor(
  scan: BridgeFolderScanResult,
  connectedLibraryId?: string,
) {
  const prisma = getPrismaClient();

  if (connectedLibraryId) {
    const library = await requireConnectedLibraryPermission(
      connectedLibraryId,
      "readPermission",
      "scan files",
    );
    const expectedRoot = library.bridgeRootId
      ? `bridge://${library.bridgeRootId}`
      : library.localPath;

    if (pathKey(expectedRoot) !== pathKey(scan.rootPath)) {
      throw new ConnectedLibraryError(
        "The scan result does not match the selected connected library.",
        409,
      );
    }

    return prisma.connectedLibrary.update({
      data: {
        displayName: library.displayName,
        isEnabled: true,
        lastScanAt: new Date(),
        status: "CONNECTED",
      },
      where: {
        id: library.id,
      },
    });
  }

  const developerLibrary = await connectDeveloperLibrary({
    displayName: scan.folderDisplayName,
    localPath: scan.rootPath,
  });

  return prisma.connectedLibrary.findUniqueOrThrow({
    where: {
      id: developerLibrary.id,
    },
  });
}

function lastModifiedFingerprint(value: Date | null) {
  return value ? value.getTime().toString() : "";
}

function sizeFingerprint(value: bigint | null) {
  return value === null ? "" : value.toString();
}

function draftFileFingerprint(file: BridgeScannedFileDraft) {
  return [
    file.relativePath,
    file.fileType,
    file.readStatus,
    file.checksum ?? "",
    sizeFingerprint(file.sizeBytes),
    lastModifiedFingerprint(file.lastModified),
  ].join("\u001f");
}

function storedFileFingerprint(
  file: Pick<
    StoredScannedFile,
    | "checksum"
    | "fileType"
    | "lastModified"
    | "processingStage"
    | "readStatus"
    | "relativePath"
    | "sizeBytes"
  >,
) {
  return [
    file.relativePath,
    file.fileType,
    file.readStatus,
    file.checksum ?? "",
    sizeFingerprint(file.sizeBytes),
    lastModifiedFingerprint(file.lastModified),
  ].join("\u001f");
}

function scanMatchesStoredSession(
  scan: BridgeFolderScanResult,
  session: StoredScanSession & {
    scannedFiles: Pick<
      StoredScannedFile,
      | "checksum"
      | "fileType"
      | "lastModified"
      | "processingStage"
      | "readStatus"
      | "relativePath"
      | "sizeBytes"
    >[];
  },
) {
  if (
    session.filesScanned !== scan.totalFiles ||
    session.supportedFiles !== scan.supportedFiles ||
    session.unsupportedFiles !== scan.unsupportedFiles ||
    session.scannedFiles.length !== scan.files.length
  ) {
    return false;
  }

  const hasUnfinishedSupportedFiles = session.scannedFiles.some(
    (file) =>
      file.readStatus === "SUPPORTED" &&
      !isRecommendationTerminalStage(file.processingStage) &&
      file.processingStage !== "FAILED",
  );

  if (hasUnfinishedSupportedFiles) {
    return false;
  }

  const draftFingerprints = scan.files
    .map(draftFileFingerprint)
    .sort((left, right) => left.localeCompare(right));
  const storedFingerprints = session.scannedFiles
    .map(storedFileFingerprint)
    .sort((left, right) => left.localeCompare(right));

  return draftFingerprints.every(
    (fingerprint, index) => fingerprint === storedFingerprints[index],
  );
}

async function reusableScanSessionFor(
  connectedFolderId: string,
  scan: BridgeFolderScanResult,
) {
  const prisma = getPrismaClient();
  const candidates = await prisma.scanSession.findMany({
    include: {
      connectedFolder: {
        select: {
          displayName: true,
        },
      },
      scannedFiles: {
        orderBy: {
          relativePath: "asc",
        },
        select: {
          checksum: true,
          fileType: true,
          lastModified: true,
          processingStage: true,
          readStatus: true,
          relativePath: true,
          sourceCreatedAt: true,
          sizeBytes: true,
        },
      },
    },
    orderBy: {
      startedAt: "desc",
    },
    take: 5,
    where: {
      connectedFolderId,
      status: {
        in: reusableBridgeScanStatuses,
      },
    },
  });

  return candidates.find((candidate) =>
    scanMatchesStoredSession(scan, candidate),
  );
}

export async function createBridgeScanSessionFromEnvironment() {
  const developerLibrary = await ensureDeveloperFallbackConnectedLibrary();

  if (developerLibrary) {
    return createBridgeScanSessionForConnectedLibrary(developerLibrary.id);
  }

  const scan = await scanConfiguredBridgeTestFolder();
  return createBridgeScanSessionFromScan(scan);
}

export async function createBridgeScanSessionForConnectedLibrary(
  connectedLibraryId: string,
) {
  const scan = await scanConnectedLibrary(connectedLibraryId);

  return createBridgeScanSessionFromScan(scan, {
    connectedLibraryId,
  });
}

export async function getBridgeScanSessions(
  take = 20,
): Promise<BridgeScanSessionSummary[]> {
  const prisma = getPrismaClient();
  const sessions = await prisma.scanSession.findMany({
    include: {
      connectedFolder: {
        select: {
          displayName: true,
        },
      },
    },
    orderBy: {
      startedAt: "desc",
    },
    take,
  });

  return sessions.map(scanSessionSummary);
}

export async function getActiveBridgeScanSession(connectedLibraryId?: string) {
  const prisma = getPrismaClient();

  return prisma.scanSession.findFirst({
    include: {
      connectedFolder: {
        select: {
          displayName: true,
        },
      },
    },
    orderBy: {
      startedAt: "desc",
    },
    where: {
      ...(connectedLibraryId ? { connectedFolderId: connectedLibraryId } : {}),
      status: {
        in: activeBridgeScanStatuses,
      },
    },
  });
}

export function isActiveBridgeScanStatus(status: BridgeScanSessionSummary["status"]) {
  return activeBridgeScanStatuses.includes(status);
}

function latestDate(left: Date, right: Date | null) {
  if (!right) {
    return left;
  }

  return right > left ? right : left;
}

function scanProgressForSession(
  session: StoredScanSession & {
    scannedFiles: StoredScannedFile[];
  },
): BridgeScanProcessingProgress {
  const fileSummaries = session.scannedFiles.map(scannedFileSummary);
  const filesRead = fileSummaries.filter(
    (file) => file.readingStatus === "READ",
  ).length;
  const filesExamined = fileSummaries.filter(
    (file) => file.hasObservation,
  ).length;
  const filesWithSuggestions = fileSummaries.filter(
    (file) => file.organizationSuggestionCounts.total > 0,
  ).length;
  const filesProcessed = fileSummaries.filter(
    (file) =>
      isRecommendationTerminalStage(file.processingStage) ||
      file.processingStage === "FAILED" ||
      file.processingStage === "UNSUPPORTED" ||
      file.readStatus === "UNSUPPORTED" ||
      file.readStatus === "FAILED",
  ).length;
  const suggestionsGenerated = fileSummaries.reduce(
    (total, file) => total + file.organizationSuggestionCounts.total,
    0,
  );
  const pendingSuggestions = fileSummaries.reduce(
    (total, file) => total + file.organizationSuggestionCounts.pending,
    0,
  );
  const failedFiles = fileSummaries.filter(
    (file) =>
      file.processingStage === "FAILED" ||
      file.readStatus === "FAILED" ||
      file.readingStatus === "FAILED" ||
      file.extractionStatus === "FAILED",
  ).length;
  const summary = scanSessionSummary({
    ...session,
    failedFiles,
  });
  const lastActivityAt = session.scannedFiles.reduce(
    (latest, file) =>
      latestDate(
        latestDate(latest, file.processedAt),
        file.extractedAt,
      ),
    session.startedAt,
  );
  const isActive = isActiveBridgeScanStatus(summary.status);
  const isStale =
    isActive && Date.now() - lastActivityAt.getTime() > staleScanSessionThresholdMs;

  return {
    completedAt: summary.completedAt,
    currentStage: summary.status,
    failedFiles,
    filesDiscovered: summary.totalFiles,
    filesExamined,
    filesProcessed,
    filesRead,
    filesWithSuggestions,
    folderDisplayName: summary.folderDisplayName,
    isActive,
    isStale,
    lastActivityAt: lastActivityAt.toISOString(),
    pendingSuggestions,
    remainingFiles: Math.max(0, summary.totalFiles - filesProcessed),
    sessionId: summary.id,
    startedAt: summary.startedAt,
    suggestionsGenerated,
    supportedFiles: summary.supportedFiles,
    unsupportedFiles: summary.unsupportedFiles,
  };
}

export async function getBridgeScanSessionProgress(sessionId: string) {
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findUnique({
    include: {
      connectedFolder: {
        select: {
          displayName: true,
        },
      },
      scannedFiles: {
        include: {
          audioMetadata: true,
          imageMetadata: true,
          videoMetadata: true,
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
            where: {
              invalidatedAt: null,
              recommendationGenerationVersion: currentRecommendationGenerationVersion,
            },
          },
        },
      },
    },
    where: {
      id: sessionId,
    },
  });

  if (!session) {
    return null;
  }

  return {
    progress: scanProgressForSession(session),
    session: scanSessionSummary(session),
  };
}

export async function getActiveBridgeScanSessionProgress() {
  const activeSession = await getActiveBridgeScanSession();

  if (!activeSession) {
    return null;
  }

  return getBridgeScanSessionProgress(activeSession.id);
}

export async function markBridgeScanSessionFailed(sessionId: string) {
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.update({
    data: {
      completedAt: new Date(),
      status: "FAILED",
    },
    include: {
      connectedFolder: {
        select: {
          displayName: true,
        },
      },
    },
    where: {
      id: sessionId,
    },
  });

  return scanSessionSummary(session);
}

export async function getBridgeScanSessionDetail(
  sessionId: string,
): Promise<BridgeScanSessionDetail | null> {
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findUnique({
    include: {
      connectedFolder: {
        select: {
          displayName: true,
        },
      },
      scannedFiles: {
        include: {
          audioMetadata: true,
          imageMetadata: true,
          videoMetadata: true,
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
            where: {
              invalidatedAt: null,
              recommendationGenerationVersion: currentRecommendationGenerationVersion,
            },
          },
        },
        orderBy: {
          relativePath: "asc",
        },
      },
    },
    where: {
      id: sessionId,
    },
  });

  if (!session) {
    return null;
  }

  const scannedFiles = session.scannedFiles.map(scannedFileSummary);
  const organizationSummary = scannedFiles.reduce(
    (summary, file) => {
      if (file.hasObservation) {
        summary.filesExamined += 1;
      }

      summary.approved += file.organizationSuggestionCounts.approved;
      summary.leftUnchanged +=
        file.organizationSuggestionCounts.leftUnchanged;
      summary.eligibleForPlanning +=
        file.organizationSuggestionCounts.eligibleForPlanning;
      summary.modified += file.organizationSuggestionCounts.modified;
      summary.pending += file.organizationSuggestionCounts.pending;
      summary.rejected += file.organizationSuggestionCounts.rejected;
      summary.total += file.organizationSuggestionCounts.total;

      return summary;
    },
    {
      ...emptyOrganizationSuggestionCounts(),
      filesExamined: 0,
    },
  );

  return {
    ...scanSessionSummary(session),
    organizationSummary,
    scannedFiles,
  };
}
