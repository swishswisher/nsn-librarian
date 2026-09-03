import path from "node:path";

import type {
  AudioTranscriptionStatus,
  BridgeMonitoringState,
  Prisma,
  VideoProcessingStatus,
} from "@prisma/client";

import type {
  BridgeCommandReport,
  BridgeJson,
} from "../../../packages/bridge-protocol/src";
import { getPrismaClient } from "@/lib/db/prisma";
import {
  BridgeCloudError,
  createBridgeCloudCommand,
} from "@/lib/bridge/cloud-coordinator";
import { logBridgePermissionDiagnostic } from "@/lib/bridge/permission-diagnostics";

import { generateOrganizationSuggestionsForScannedFileWithText } from "./organization-suggestions";
import {
  createBridgeScanSessionFromScan,
  getBridgeScanSessionDetail,
} from "./scan-sessions";
import { createObservationSessionForScannedFileReadResult } from "./scanned-file-observations";
import { markRemoteReadFailure } from "./remote-read-commands";
import type {
  BridgeAudioMetadataDraft,
  BridgeFolderScanResult,
  BridgeImageMetadataDraft,
  BridgeReadFileApiSuccess,
  BridgeScannedFileDraft,
  BridgeVideoMetadataDraft,
  ScannedFileReadStatus,
} from "./types";

const maxScanFiles = 20_000;
const readCommandLifetimeMs = 24 * 60 * 60 * 1000;

function objectValue(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown, maxLength = 10_000) {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function bridgeRootWatcherState(value: unknown) {
  return value === "WATCHING" ||
    value === "PAUSED" ||
    value === "STOPPED" ||
    value === "NEEDS_ATTENTION"
    ? value
    : "STOPPED";
}

function connectedLibraryStatus(value: unknown) {
  return value === "CONNECTED" ||
    value === "PAUSED" ||
    value === "NEEDS_ATTENTION" ||
    value === "DISCONNECTED"
    ? value
    : "CONNECTED";
}

function monitoringDataFromNativeRoot(
  existing: {
    lastMonitoringAt: Date | null;
    monitoringPausedAt: Date | null;
    monitoringStartedAt: Date | null;
    monitoringState: BridgeMonitoringState;
    monitoringStoppedAt: Date | null;
  },
  watcherState: ReturnType<typeof bridgeRootWatcherState>,
  now: Date,
) {
  const nativeWatching = watcherState === "WATCHING";
  const previousState = existing.monitoringState;

  return {
    lastMonitoringAt: nativeWatching ? now : existing.lastMonitoringAt,
    monitoringErrorCategory:
      watcherState === "NEEDS_ATTENTION" ? "WATCHER_NEEDS_ATTENTION" : null,
    monitoringHeartbeatAt: nativeWatching ? now : null,
    monitoringLastCheckAt: now,
    monitoringLastSuccessfulCheckAt: now,
    monitoringPausedAt:
      watcherState === "PAUSED"
        ? previousState === "PAUSED"
          ? existing.monitoringPausedAt ?? now
          : now
        : nativeWatching
          ? null
          : existing.monitoringPausedAt,
    monitoringStartedAt: nativeWatching
      ? previousState === "WATCHING"
        ? existing.monitoringStartedAt ?? now
        : now
      : existing.monitoringStartedAt,
    monitoringState: watcherState as BridgeMonitoringState,
    monitoringStoppedAt:
      watcherState === "STOPPED"
        ? previousState === "STOPPED"
          ? existing.monitoringStoppedAt ?? now
          : now
        : nativeWatching || watcherState === "PAUSED"
          ? null
          : existing.monitoringStoppedAt,
  };
}

function dateValue(value: unknown) {
  if (typeof value !== "string" && !(value instanceof Date)) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function bigintValue(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  try {
    const parsed = BigInt(value);
    return parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function safeRelativePath(value: unknown) {
  const raw = stringValue(value, 2_000)?.replace(/\\/gu, "/").trim();

  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw)) {
    return null;
  }

  const normalized = path.posix.normalize(raw).replace(/^\.\//u, "");

  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return null;
  }

  return normalized;
}

function readStatus(value: unknown): ScannedFileReadStatus {
  return value === "SUPPORTED" || value === "UNSUPPORTED" || value === "FAILED"
    ? value
    : "FAILED";
}

function audioMetadata(value: unknown): BridgeAudioMetadataDraft | null {
  const metadata = objectValue(value);

  if (!metadata) {
    return null;
  }

  return {
    audioFingerprint: stringValue(metadata.audioFingerprint, 500),
    bitrateKbps: numberValue(metadata.bitrateKbps),
    channels: numberValue(metadata.channels),
    codec: stringValue(metadata.codec, 100),
    container: stringValue(metadata.container, 100),
    durationSeconds: numberValue(metadata.durationSeconds),
    sampleRateHz: numberValue(metadata.sampleRateHz),
    sourceCreatedAt: dateValue(metadata.sourceCreatedAt),
    sourceModifiedAt: dateValue(metadata.sourceModifiedAt),
  };
}

function videoMetadata(value: unknown): BridgeVideoMetadataDraft | null {
  const metadata = objectValue(value);

  if (!metadata) {
    return null;
  }

  return {
    bitrateKbps: numberValue(metadata.bitrateKbps),
    codec: stringValue(metadata.codec, 100),
    container: stringValue(metadata.container, 100),
    durationSeconds: numberValue(metadata.durationSeconds),
    frameRate: numberValue(metadata.frameRate),
    hasAudioTrack: booleanValue(metadata.hasAudioTrack),
    height: numberValue(metadata.height),
    sourceCreatedAt: dateValue(metadata.sourceCreatedAt),
    sourceModifiedAt: dateValue(metadata.sourceModifiedAt),
    videoFingerprint: stringValue(metadata.videoFingerprint, 500),
    width: numberValue(metadata.width),
  };
}

type RemoteAudioReadMetadata = BridgeAudioMetadataDraft & {
  transcriptSnippet: string | null;
  summary: string | null;
  transcriptionConfidence: number | null;
  transcriptionStatus: ReturnType<typeof audioTranscriptionStatus>;
  transcriptionErrorCategory: string | null;
  machineLabels: string[];
  provisionalTopics: string[];
  provisionalPeople: string[];
  provisionalProjects: string[];
  provisionalActionItems: string[];
  provisionalQuestions: string[];
};

type RemoteVideoReadMetadata = BridgeVideoMetadataDraft & {
  transcriptSnippet: string | null;
  summary: string | null;
  transcriptionConfidence: number | null;
  transcriptionStatus: ReturnType<typeof videoProcessingStatus>;
  transcriptionErrorCategory: string | null;
  frameAnalysisStatus: ReturnType<typeof videoProcessingStatus>;
  frameAnalysisErrorCategory: string | null;
  machineLabels: string[];
  provisionalTopics: string[];
  provisionalPeople: string[];
  provisionalProjects: string[];
  provisionalQuestions: string[];
  selectedFrameDescriptions: unknown[];
  chapterSuggestions: unknown[];
  relatedSignals: string[];
};

function remoteAudioReadMetadata(value: unknown): RemoteAudioReadMetadata | null {
  const metadata = objectValue(value);
  const baseMetadata = audioMetadata(value);

  if (!metadata || !baseMetadata) {
    return null;
  }

  return {
    ...baseMetadata,
    machineLabels: stringArrayValue(metadata.machineLabels),
    provisionalActionItems: stringArrayValue(metadata.provisionalActionItems),
    provisionalPeople: stringArrayValue(metadata.provisionalPeople),
    provisionalProjects: stringArrayValue(metadata.provisionalProjects),
    provisionalQuestions: stringArrayValue(metadata.provisionalQuestions),
    provisionalTopics: stringArrayValue(metadata.provisionalTopics),
    summary: stringValue(metadata.summary, 2_000),
    transcriptSnippet: stringValue(metadata.transcriptSnippet, 2_000),
    transcriptionConfidence: numberValue(metadata.transcriptionConfidence),
    transcriptionErrorCategory: stringValue(
      metadata.transcriptionErrorCategory,
      200,
    ),
    transcriptionStatus: audioTranscriptionStatus(
      metadata.transcriptionStatus,
    ),
  };
}

function remoteVideoReadMetadata(value: unknown): RemoteVideoReadMetadata | null {
  const metadata = objectValue(value);
  const baseMetadata = videoMetadata(value);

  if (!metadata || !baseMetadata) {
    return null;
  }

  return {
    ...baseMetadata,
    chapterSuggestions: Array.isArray(metadata.chapterSuggestions)
      ? metadata.chapterSuggestions.slice(0, 20)
      : [],
    frameAnalysisErrorCategory: stringValue(
      metadata.frameAnalysisErrorCategory,
      200,
    ),
    frameAnalysisStatus: videoProcessingStatus(metadata.frameAnalysisStatus),
    machineLabels: stringArrayValue(metadata.machineLabels),
    provisionalPeople: stringArrayValue(metadata.provisionalPeople),
    provisionalProjects: stringArrayValue(metadata.provisionalProjects),
    provisionalQuestions: stringArrayValue(metadata.provisionalQuestions),
    provisionalTopics: stringArrayValue(metadata.provisionalTopics),
    relatedSignals: stringArrayValue(metadata.relatedSignals),
    selectedFrameDescriptions: Array.isArray(metadata.selectedFrameDescriptions)
      ? metadata.selectedFrameDescriptions.slice(0, 20)
      : [],
    summary: stringValue(metadata.summary, 2_000),
    transcriptSnippet: stringValue(metadata.transcriptSnippet, 2_000),
    transcriptionConfidence: numberValue(metadata.transcriptionConfidence),
    transcriptionErrorCategory: stringValue(
      metadata.transcriptionErrorCategory,
      200,
    ),
    transcriptionStatus: videoProcessingStatus(metadata.transcriptionStatus),
  };
}

function imageMetadata(value: unknown): BridgeImageMetadataDraft | null {
  const metadata = objectValue(value);

  if (!metadata) {
    return null;
  }

  return {
    cameraDevice: stringValue(metadata.cameraDevice, 200),
    colorProfile: stringValue(metadata.colorProfile, 200),
    embeddedDate: dateValue(metadata.embeddedDate),
    format: stringValue(metadata.format, 100) ?? "UNKNOWN",
    height: numberValue(metadata.height),
    imageFingerprint: stringValue(metadata.imageFingerprint, 500),
    orientation: stringValue(metadata.orientation, 100),
    sizeBytes: bigintValue(metadata.sizeBytes) ?? BigInt(0),
    sourceCreatedAt: dateValue(metadata.sourceCreatedAt),
    sourceModifiedAt: dateValue(metadata.sourceModifiedAt),
    width: numberValue(metadata.width),
  };
}

function scannedFileDraft(
  value: unknown,
  bridgeRootId: string,
): BridgeScannedFileDraft | null {
  const file = objectValue(value);
  const relativePath = safeRelativePath(file?.relativePath);

  if (!file || !relativePath) {
    return null;
  }

  return {
    audioMetadata: audioMetadata(file.audioMetadata),
    checksum: stringValue(file.checksum, 256),
    fileType: stringValue(file.fileType, 100) ?? "UNSUPPORTED",
    imageMetadata: imageMetadata(file.imageMetadata),
    lastModified: dateValue(file.lastModified),
    localPath: `bridge://${bridgeRootId}/${relativePath}`,
    readStatus: readStatus(file.readStatus),
    relativePath,
    scanError: stringValue(file.scanError, 500),
    sizeBytes: bigintValue(file.sizeBytes),
    sourceCreatedAt: dateValue(file.sourceCreatedAt),
    videoMetadata: videoMetadata(file.videoMetadata),
  };
}

function scanResultFromReport(
  rawResult: unknown,
  bridgeRootId: string,
): BridgeFolderScanResult {
  const outer = objectValue(rawResult);
  const candidate = objectValue(outer?.scan) ?? outer;

  if (!candidate || !Array.isArray(candidate.files)) {
    throw new BridgeCloudError(
      "The Bridge returned an invalid scan result.",
      422,
    );
  }

  if (candidate.files.length > maxScanFiles) {
    throw new BridgeCloudError(
      "This scan is too large to import in one result.",
      413,
    );
  }

  const files = candidate.files
    .map((file) => scannedFileDraft(file, bridgeRootId))
    .filter((file): file is BridgeScannedFileDraft => Boolean(file));
  const supportedFiles = files.filter(
    (file) => file.readStatus === "SUPPORTED",
  ).length;
  const unsupportedFiles = files.filter(
    (file) => file.readStatus === "UNSUPPORTED",
  ).length;
  const failedFiles = files.filter((file) => file.readStatus === "FAILED").length;

  return {
    bridgeRootId,
    completedAt: dateValue(candidate.completedAt) ?? new Date(),
    failedFiles,
    files,
    folderDisplayName:
      stringValue(candidate.folderDisplayName, 200) ?? "Connected folder",
    rootPath: `bridge://${bridgeRootId}`,
    safeLocation:
      stringValue(candidate.safeLocation, 500) ?? "A folder selected on this Mac",
    startedAt: dateValue(candidate.startedAt) ?? new Date(),
    supportedFiles,
    totalFiles: files.length,
    unsupportedFiles,
  };
}

async function existingImportedScanSession(
  connectedLibraryId: string,
  scan: BridgeFolderScanResult,
) {
  const prisma = getPrismaClient();

  return prisma.scanSession.findFirst({
    where: {
      connectedFolderId: connectedLibraryId,
      filesScanned: scan.totalFiles,
      startedAt: scan.startedAt,
      supportedFiles: scan.supportedFiles,
      unsupportedFiles: scan.unsupportedFiles,
    },
  });
}

async function queueReadCommands(input: {
  bridgeDeviceId: string;
  bridgeRootId: string;
  connectedLibraryId: string;
  scanSessionId: string;
}) {
  const prisma = getPrismaClient();
  const files = await prisma.scannedFile.findMany({
    select: {
      checksum: true,
      id: true,
      relativePath: true,
    },
    where: {
      readStatus: "SUPPORTED",
      readingStatus: "NOT_READ",
      sessionId: input.scanSessionId,
    },
  });

  for (const file of files) {
    await createBridgeCloudCommand({
      authorizationContext: {
        purpose: "Temporarily read a discovered file so the Librarian can prepare reviewable observations and recommendations.",
      },
      bridgeDeviceId: input.bridgeDeviceId,
      bridgeRootId: input.bridgeRootId,
      commandType: "READ_FILE_TEMPORARILY",
      connectedLibraryId: input.connectedLibraryId,
      expiresAt: new Date(Date.now() + readCommandLifetimeMs),
      idempotencyKey: `read-file:${input.scanSessionId}:${file.id}:${file.checksum ?? "no-checksum"}`,
      payload: {
        relativePath: file.relativePath,
        scanSessionId: input.scanSessionId,
        scannedFileId: file.id,
      },
    });
  }

  return files.length;
}

async function applyCompletedScan(input: {
  bridgeDeviceId: string;
  bridgeRootId: string;
  connectedLibraryId: string;
  result: unknown;
}) {
  const scan = scanResultFromReport(input.result, input.bridgeRootId);
  const existing = await existingImportedScanSession(
    input.connectedLibraryId,
    scan,
  );
  const session = existing
    ? {
        id: existing.id,
      }
    : await createBridgeScanSessionFromScan(scan, {
        allowReusableSession: false,
        connectedLibraryId: input.connectedLibraryId,
      });
  const queuedReads = await queueReadCommands({
    ...input,
    scanSessionId: session.id,
  });

  return {
    cloudScanSessionId: session.id,
    failedFiles: scan.failedFiles,
    queuedReads,
    supportedFiles: scan.supportedFiles,
    totalFiles: scan.totalFiles,
    unsupportedFiles: scan.unsupportedFiles,
  } satisfies BridgeJson;
}

function remoteReadResult(value: unknown) {
  const result = objectValue(value);
  const extractedText = stringValue(result?.extractedText, 2_000_000);
  const relativePath = safeRelativePath(result?.relativePath);

  if (!result || !extractedText || !relativePath) {
    throw new BridgeCloudError(
      "The Bridge returned an invalid temporary read result.",
      422,
    );
  }

  return {
    audioMetadata: remoteAudioReadMetadata(result.audioMetadata),
    characterCount: extractedText.length,
    extractedText,
    fileName: stringValue(result.fileName, 500) ?? path.posix.basename(relativePath),
    fileType: stringValue(result.fileType, 100) ?? "DOCUMENT",
    relativePath,
    videoMetadata: remoteVideoReadMetadata(result.videoMetadata),
    warnings: Array.isArray(result.warnings)
      ? result.warnings
          .filter((warning): warning is string => typeof warning === "string")
          .slice(0, 20)
      : [],
  };
}

async function finalizeScanSessionIfComplete(sessionId: string) {
  const prisma = getPrismaClient();
  const remaining = await prisma.scannedFile.count({
    where: {
      readStatus: "SUPPORTED",
      sessionId,
      processingStage: {
        notIn: [
          "SUGGESTIONS_GENERATED",
          "RECOMMENDATIONS_READY",
          "FAILED",
          "UNSUPPORTED",
        ],
      },
    },
  });

  if (remaining > 0) {
    return;
  }

  const failedFiles = await prisma.scannedFile.count({
    where: {
      OR: [
        { processingStage: "FAILED" },
        { readStatus: "FAILED" },
        { readingStatus: "FAILED" },
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
}

async function storeRemoteReadAudioMetadata(
  scannedFileId: string,
  metadata: RemoteAudioReadMetadata,
) {
  const prisma = getPrismaClient();
  const data = {
    audioFingerprint: metadata.audioFingerprint,
    bitrateKbps: metadata.bitrateKbps,
    channels: metadata.channels,
    codec: metadata.codec,
    container: metadata.container,
    durationSeconds: metadata.durationSeconds,
    machineLabels: jsonInput(metadata.machineLabels),
    provisionalActionItems: jsonInput(metadata.provisionalActionItems),
    provisionalPeople: jsonInput(metadata.provisionalPeople),
    provisionalProjects: jsonInput(metadata.provisionalProjects),
    provisionalQuestions: jsonInput(metadata.provisionalQuestions),
    provisionalTopics: jsonInput(metadata.provisionalTopics),
    sampleRateHz: metadata.sampleRateHz,
    sourceCreatedAt: metadata.sourceCreatedAt,
    sourceModifiedAt: metadata.sourceModifiedAt,
    summary: metadata.summary,
    transcriptSnippet: metadata.transcriptSnippet,
    transcriptionConfidence: metadata.transcriptionConfidence,
    transcriptionErrorCategory: metadata.transcriptionErrorCategory,
    transcriptionStatus: metadata.transcriptionStatus,
  };

  await prisma.audioRecordingMetadata.upsert({
    create: {
      ...data,
      humanLabels: jsonInput([]),
      privacyState: "REVIEW_REQUIRED",
      scannedFileId,
    },
    update: data,
    where: { scannedFileId },
  });
}

async function storeRemoteReadVideoMetadata(
  scannedFileId: string,
  metadata: RemoteVideoReadMetadata,
) {
  const prisma = getPrismaClient();
  const data = {
    bitrateKbps: metadata.bitrateKbps,
    chapterSuggestions: jsonInput(metadata.chapterSuggestions),
    codec: metadata.codec,
    container: metadata.container,
    durationSeconds: metadata.durationSeconds,
    frameAnalysisErrorCategory: metadata.frameAnalysisErrorCategory,
    frameAnalysisStatus: metadata.frameAnalysisStatus,
    frameRate: metadata.frameRate,
    hasAudioTrack: metadata.hasAudioTrack,
    height: metadata.height,
    machineLabels: jsonInput(metadata.machineLabels),
    provisionalPeople: jsonInput(metadata.provisionalPeople),
    provisionalProjects: jsonInput(metadata.provisionalProjects),
    provisionalQuestions: jsonInput(metadata.provisionalQuestions),
    provisionalTopics: jsonInput(metadata.provisionalTopics),
    relatedSignals: jsonInput(metadata.relatedSignals),
    selectedFrameDescriptions: jsonInput(metadata.selectedFrameDescriptions),
    sourceCreatedAt: metadata.sourceCreatedAt,
    sourceModifiedAt: metadata.sourceModifiedAt,
    summary: metadata.summary,
    transcriptSnippet: metadata.transcriptSnippet,
    transcriptionConfidence: metadata.transcriptionConfidence,
    transcriptionErrorCategory: metadata.transcriptionErrorCategory,
    transcriptionStatus: metadata.transcriptionStatus,
    videoFingerprint: metadata.videoFingerprint,
    width: metadata.width,
  };

  await prisma.videoRecordingMetadata.upsert({
    create: {
      ...data,
      humanLabels: jsonInput([]),
      privacyState: "REVIEW_REQUIRED",
      scannedFileId,
    },
    update: data,
    where: { scannedFileId },
  });
}

async function storeRemoteReadMediaMetadata(
  scannedFileId: string,
  result: ReturnType<typeof remoteReadResult>,
) {
  if (result.audioMetadata) {
    await storeRemoteReadAudioMetadata(scannedFileId, result.audioMetadata);
  }

  if (result.videoMetadata) {
    await storeRemoteReadVideoMetadata(scannedFileId, result.videoMetadata);
  }
}

async function applyCompletedRead(commandPayload: unknown, rawResult: unknown) {
  const payload = objectValue(commandPayload);
  const scannedFileId = stringValue(payload?.scannedFileId, 100);
  const scanSessionId = stringValue(payload?.scanSessionId, 100);

  if (!scannedFileId || !scanSessionId) {
    throw new BridgeCloudError(
      "The temporary read command is missing its cloud file reference.",
      422,
    );
  }

  const result = remoteReadResult(rawResult);
  const prisma = getPrismaClient();
  const stored = await prisma.scannedFile.findFirst({
    where: {
      id: scannedFileId,
      sessionId: scanSessionId,
    },
  });

  if (!stored || stored.relativePath !== result.relativePath) {
    throw new BridgeCloudError(
      "The temporary read result does not match the scanned file.",
      409,
    );
  }

  await prisma.scannedFile.update({
    data: {
      characterCount: result.characterCount,
      extractedAt: new Date(),
      extractionErrorCategory: null,
      extractionStatus: "COMPLETED",
      previewText: result.extractedText.slice(0, 2_000),
      processingErrorCategory: null,
      processingStage: "READ",
      readingStatus: "READ",
    },
    where: { id: scannedFileId },
  });
  await storeRemoteReadMediaMetadata(scannedFileId, result);
  const detail = await getBridgeScanSessionDetail(scanSessionId);
  const file = detail?.scannedFiles.find((item) => item.id === scannedFileId);

  if (!file) {
    throw new BridgeCloudError(
      "The Librarian could not refresh the scanned file.",
      404,
    );
  }

  const readResult: BridgeReadFileApiSuccess = {
    file,
    ok: true,
    preview: {
      characterCount: result.characterCount,
      extractedText: result.extractedText,
      fileName: result.fileName,
      fileType: result.fileType,
      relativePath: result.relativePath,
      scannedFileId,
      warnings: result.warnings,
    },
  };
  const observationReused = file.hasObservation;

  if (observationReused) {
    await prisma.scannedFile.update({
      data: {
        processedAt: new Date(),
        processingErrorCategory: null,
        processingStage: "EXAMINED",
      },
      where: {
        id: scannedFileId,
      },
    });
  } else {
    await createObservationSessionForScannedFileReadResult(
      scannedFileId,
      readResult,
    );
  }

  await prisma.scanSession.update({
    data: {
      status: "GENERATING_SUGGESTIONS",
    },
    where: {
      id: scanSessionId,
    },
  });
  const suggestions = await generateOrganizationSuggestionsForScannedFileWithText(
    scannedFileId,
    result.extractedText,
  );
  await finalizeScanSessionIfComplete(scanSessionId);

  return {
    characterCount: result.characterCount,
    observationPrepared: true,
    observationReused,
    scannedFileId,
    suggestionsCreated: suggestions.createdCount,
    suggestionsReused: suggestions.existingCount,
  } satisfies BridgeJson;
}

async function applyFailedRead(commandPayload: unknown, safeErrorCategory: string | null) {
  const payload = objectValue(commandPayload);
  const scannedFileId = stringValue(payload?.scannedFileId, 100);
  const scanSessionId = stringValue(payload?.scanSessionId, 100);

  if (!scannedFileId || !scanSessionId) {
    return;
  }

  await markRemoteReadFailure({
    safeErrorCategory,
    scanSessionId,
    scannedFileId,
  });
  await finalizeScanSessionIfComplete(scanSessionId);
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function stringArrayValue(value: unknown, maxItems = 40) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, maxItems)
    : [];
}

function audioTranscriptionStatus(value: unknown): AudioTranscriptionStatus {
  return value === "NOT_REQUESTED" ||
    value === "TRANSCRIBING" ||
    value === "COMPLETED" ||
    value === "UNAVAILABLE" ||
    value === "FAILED"
    ? value
    : "NOT_REQUESTED";
}

function videoProcessingStatus(value: unknown): VideoProcessingStatus {
  return value === "NOT_REQUESTED" ||
    value === "PROCESSING" ||
    value === "COMPLETED" ||
    value === "UNAVAILABLE" ||
    value === "FAILED"
    ? value
    : "NOT_REQUESTED";
}

async function applyCompletedPermissionUpdate(input: {
  bridgeRootId: string;
  commandId: string;
  commandPayload: unknown;
  connectedLibraryId: string;
  result: unknown;
}) {
  const prisma = getPrismaClient();
  const payload = objectValue(input.commandPayload);
  const root = objectValue(input.result);
  const rootId = stringValue(root?.id, 100);

  if (!root || rootId !== input.bridgeRootId) {
    throw new BridgeCloudError(
      "The Bridge returned a result for a different connected folder.",
      422,
      "ROOT_RESULT_MISMATCH",
    );
  }

  const existing = await prisma.connectedLibrary.findUnique({
    where: {
      id: input.connectedLibraryId,
    },
  });

  if (!existing) {
    throw new BridgeCloudError(
      "The Librarian could not find that connected folder.",
      404,
      "CONNECTED_LIBRARY_NOT_FOUND",
    );
  }

  const readPermission =
    booleanValue(root.readPermission) ??
    booleanValue(payload?.readPermission) ??
    existing.readPermission;
  const watchPermission = readPermission
    ? (booleanValue(root.watchPermission) ??
      booleanValue(payload?.watchPermission) ??
      existing.watchPermission)
    : false;
  const watcherState = bridgeRootWatcherState(root.watcherState);
  const status = connectedLibraryStatus(root.status);
  const rootUpdatedAt = stringValue(root.updatedAt, 100);
  const now = new Date();
  const permissions = {
    createFolderPermission:
      booleanValue(root.createFolderPermission) ??
      booleanValue(payload?.createFolderPermission) ??
      existing.createFolderPermission,
    moveFilePermission:
      booleanValue(root.moveFilePermission) ??
      booleanValue(payload?.moveFilePermission) ??
      existing.moveFilePermission,
    organizationPlanPermission:
      booleanValue(root.organizationPlanPermission) ??
      booleanValue(payload?.organizationPlanPermission) ??
      existing.organizationPlanPermission,
    readPermission,
    recommendationPermission:
      booleanValue(root.recommendationPermission) ??
      booleanValue(payload?.recommendationPermission) ??
      existing.recommendationPermission,
    renameFilePermission:
      booleanValue(root.renameFilePermission) ??
      booleanValue(payload?.renameFilePermission) ??
      existing.renameFilePermission,
    watchPermission,
  };
  const monitoringData = monitoringDataFromNativeRoot(
    existing,
    watcherState,
    now,
  );

  await prisma.connectedLibrary.update({
    data: {
      bridgeRootId: input.bridgeRootId,
      createFolderPermission: permissions.createFolderPermission,
      disconnectedAt: status === "DISCONNECTED" ? now : null,
      isEnabled: status !== "DISCONNECTED",
      lastBridgeCheckAt: now,
      ...monitoringData,
      monitoringErrorCategory: readPermission
        ? monitoringData.monitoringErrorCategory
        : "READ_PERMISSION_REQUIRED",
      moveFilePermission: permissions.moveFilePermission,
      organizationPlanPermission: permissions.organizationPlanPermission,
      readPermission: permissions.readPermission,
      recommendationPermission: permissions.recommendationPermission,
      renameFilePermission: permissions.renameFilePermission,
      safeLocalLocation: stringValue(root.safeLocation, 500) ?? undefined,
      status,
      watchPermission: permissions.watchPermission,
    },
    where: {
      id: input.connectedLibraryId,
    },
  });

  logBridgePermissionDiagnostic({
    bridgeRootId: input.bridgeRootId,
    commandId: input.commandId,
    commandType: "UPDATE_ROOT_PERMISSIONS",
    event: "completed-persisted",
    permissions,
    rootUpdatedAt,
  });

  return {
    bridgeRootId: input.bridgeRootId,
    permissions,
    rootUpdatedAt,
    status,
    watcherState,
  } satisfies BridgeJson;
}

async function applyCompletedMonitoringCommand(input: {
  bridgeRootId: string;
  connectedLibraryId: string;
  result: unknown;
}) {
  const prisma = getPrismaClient();
  const root = objectValue(input.result);
  const rootId = stringValue(root?.id, 100);

  if (!root || rootId !== input.bridgeRootId) {
    throw new BridgeCloudError(
      "The Bridge returned a result for a different connected folder.",
      422,
      "ROOT_RESULT_MISMATCH",
    );
  }

  const existing = await prisma.connectedLibrary.findUnique({
    where: {
      id: input.connectedLibraryId,
    },
  });

  if (!existing) {
    throw new BridgeCloudError(
      "The Librarian could not find that connected folder.",
      404,
      "CONNECTED_LIBRARY_NOT_FOUND",
    );
  }

  const watcherState = bridgeRootWatcherState(root.watcherState);
  const status = connectedLibraryStatus(root.status);
  const now = new Date();
  const monitoringData = monitoringDataFromNativeRoot(
    existing,
    watcherState,
    now,
  );

  await prisma.connectedLibrary.update({
    data: {
      bridgeRootId: input.bridgeRootId,
      createFolderPermission:
        booleanValue(root.createFolderPermission) ??
        existing.createFolderPermission,
      disconnectedAt: status === "DISCONNECTED" ? now : null,
      isEnabled: status !== "DISCONNECTED",
      lastBridgeCheckAt: now,
      ...monitoringData,
      moveFilePermission:
        booleanValue(root.moveFilePermission) ?? existing.moveFilePermission,
      organizationPlanPermission:
        booleanValue(root.organizationPlanPermission) ??
        existing.organizationPlanPermission,
      readPermission: booleanValue(root.readPermission) ?? existing.readPermission,
      recommendationPermission:
        booleanValue(root.recommendationPermission) ??
        existing.recommendationPermission,
      renameFilePermission:
        booleanValue(root.renameFilePermission) ??
        existing.renameFilePermission,
      safeLocalLocation: stringValue(root.safeLocation, 500) ?? undefined,
      status,
      watchPermission:
        booleanValue(root.watchPermission) ?? existing.watchPermission,
    },
    where: {
      id: input.connectedLibraryId,
    },
  });

  return {
    bridgeRootId: input.bridgeRootId,
    status,
    watcherState,
  } satisfies BridgeJson;
}

export async function prepareBridgeCommandReportForPersistence(
  bridgeDeviceId: string,
  report: BridgeCommandReport,
): Promise<BridgeCommandReport> {
  const prisma = getPrismaClient();
  const command = await prisma.bridgeCommand.findUnique({
    where: { commandId: report.commandId },
  });

  if (!command || command.bridgeDeviceId !== bridgeDeviceId) {
    throw new BridgeCloudError("That Bridge command could not be found.", 404);
  }

  if (command.commandType === "READ_FILE_TEMPORARILY") {
    if (report.status === "COMPLETED") {
      return {
        ...report,
        result: await applyCompletedRead(command.payload, report.result),
      };
    }

    await applyFailedRead(command.payload, report.safeErrorCategory ?? null);
    return {
      ...report,
      result: null,
    };
  }

  if (
    report.status === "COMPLETED" &&
    (command.commandType === "SCAN_LIBRARY" ||
      command.commandType === "RECONCILE_LIBRARY")
  ) {
    if (
      !command.connectedLibraryId ||
      !command.bridgeRootId
    ) {
      throw new BridgeCloudError(
        "The scan command is missing its connected folder.",
        422,
      );
    }

    return {
      ...report,
      result: await applyCompletedScan({
        bridgeDeviceId,
        bridgeRootId: command.bridgeRootId,
        connectedLibraryId: command.connectedLibraryId,
        result: report.result,
      }),
    };
  }

  if (command.commandType === "UPDATE_ROOT_PERMISSIONS") {
    if (report.status === "COMPLETED") {
      if (!command.connectedLibraryId || !command.bridgeRootId) {
        throw new BridgeCloudError(
          "The permission command is missing its connected folder.",
          422,
        );
      }

      return {
        ...report,
        result: await applyCompletedPermissionUpdate({
          bridgeRootId: command.bridgeRootId,
          commandId: command.commandId,
          commandPayload: command.payload,
          connectedLibraryId: command.connectedLibraryId,
          result: report.result,
        }),
      };
    }

    return {
      ...report,
      result: null,
    };
  }

  if (
    command.commandType === "START_WATCHING" ||
    command.commandType === "PAUSE_WATCHING" ||
    command.commandType === "RESUME_WATCHING" ||
    command.commandType === "STOP_WATCHING"
  ) {
    if (report.status === "COMPLETED") {
      if (!command.connectedLibraryId || !command.bridgeRootId) {
        throw new BridgeCloudError(
          "The monitoring command is missing its connected folder.",
          422,
        );
      }

      return {
        ...report,
        result: await applyCompletedMonitoringCommand({
          bridgeRootId: command.bridgeRootId,
          connectedLibraryId: command.connectedLibraryId,
          result: report.result,
        }),
      };
    }

    return {
      ...report,
      result: null,
    };
  }

  return report;
}
