import path from "node:path";

import type { Prisma } from "@prisma/client";

import type {
  BridgeCommandReport,
  BridgeJson,
} from "../../../packages/bridge-protocol/src";
import { getPrismaClient } from "@/lib/db/prisma";
import {
  BridgeCloudError,
  createBridgeCloudCommand,
} from "@/lib/bridge/cloud-coordinator";

import { getBridgeScanSessionProgress } from "./scan-sessions";
import { queueRemoteReadCommand } from "./remote-read-commands";
import { ingestBridgeWatchEvents } from "./monitor";
import { recordChecksumDuplicateSuggestionsForSession } from "./checksum-duplicates";
import type {
  BridgeAudioMetadataDraft,
  BridgeFolderScanResult,
  BridgeImageMetadataDraft,
  BridgeScannedFileDraft,
  BridgeVideoMetadataDraft,
  ScannedFileReadStatus,
} from "./types";

const activeScanStatuses = [
  "PENDING",
  "SCANNING",
  "READING",
  "EXAMINING",
  "GENERATING_SUGGESTIONS",
] as const;
const maxScanFiles = 20_000;
const onlineWindowMs = 90_000;

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

function watchEventsFromReport(rawResult: unknown) {
  const outer = objectValue(rawResult);

  return Array.isArray(outer?.events) ? outer.events : [];
}

function initialReadingStatus(file: BridgeScannedFileDraft) {
  if (file.readStatus === "SUPPORTED") {
    return "NOT_READ" as const;
  }

  return file.readStatus === "UNSUPPORTED"
    ? ("UNSUPPORTED" as const)
    : ("FAILED" as const);
}

function initialExtractionStatus(file: BridgeScannedFileDraft) {
  if (file.readStatus === "SUPPORTED") {
    return "PENDING" as const;
  }

  return file.readStatus === "UNSUPPORTED"
    ? ("UNSUPPORTED" as const)
    : ("FAILED" as const);
}

function initialProcessingStage(file: BridgeScannedFileDraft) {
  if (file.readStatus === "SUPPORTED") {
    return "DISCOVERED" as const;
  }

  return file.readStatus === "UNSUPPORTED"
    ? ("UNSUPPORTED" as const)
    : ("FAILED" as const);
}

function scannedFileCreateData(
  sessionId: string,
  file: BridgeScannedFileDraft,
): Prisma.ScannedFileCreateManyInput {
  return {
    checksum: file.checksum,
    extractionStatus: initialExtractionStatus(file),
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
    processingStage: initialProcessingStage(file),
    readingStatus: initialReadingStatus(file),
    readStatus: file.readStatus,
    relativePath: file.relativePath,
    scanError: file.scanError ?? null,
    sessionId,
    sizeBytes: file.sizeBytes,
    sourceCreatedAt: file.sourceCreatedAt ?? null,
  };
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function storeMediaMetadata(
  sessionId: string,
  files: BridgeScannedFileDraft[],
) {
  const prisma = getPrismaClient();
  const storedFiles = await prisma.scannedFile.findMany({
    select: { id: true, relativePath: true },
    where: { sessionId },
  });
  const storedByPath = new Map(
    storedFiles.map((file) => [file.relativePath, file.id]),
  );

  for (const file of files) {
    const scannedFileId = storedByPath.get(file.relativePath);

    if (!scannedFileId) {
      continue;
    }

    if (file.audioMetadata) {
      const metadata = file.audioMetadata;
      await prisma.audioRecordingMetadata.upsert({
        create: {
          audioFingerprint: metadata.audioFingerprint,
          bitrateKbps: metadata.bitrateKbps,
          channels: metadata.channels,
          codec: metadata.codec,
          container: metadata.container,
          durationSeconds: metadata.durationSeconds,
          humanLabels: jsonInput([]),
          machineLabels: jsonInput([]),
          privacyState: "REVIEW_REQUIRED",
          provisionalActionItems: jsonInput([]),
          provisionalPeople: jsonInput([]),
          provisionalProjects: jsonInput([]),
          provisionalQuestions: jsonInput([]),
          provisionalTopics: jsonInput([]),
          sampleRateHz: metadata.sampleRateHz,
          scannedFileId,
          sourceCreatedAt: metadata.sourceCreatedAt,
          sourceModifiedAt: metadata.sourceModifiedAt,
          transcriptionStatus: "NOT_REQUESTED",
        },
        update: {
          audioFingerprint: metadata.audioFingerprint,
          bitrateKbps: metadata.bitrateKbps,
          channels: metadata.channels,
          codec: metadata.codec,
          container: metadata.container,
          durationSeconds: metadata.durationSeconds,
          sampleRateHz: metadata.sampleRateHz,
          sourceCreatedAt: metadata.sourceCreatedAt,
          sourceModifiedAt: metadata.sourceModifiedAt,
        },
        where: { scannedFileId },
      });
    }

    if (file.videoMetadata) {
      const metadata = file.videoMetadata;
      await prisma.videoRecordingMetadata.upsert({
        create: {
          bitrateKbps: metadata.bitrateKbps,
          chapterSuggestions: jsonInput([]),
          codec: metadata.codec,
          container: metadata.container,
          durationSeconds: metadata.durationSeconds,
          frameAnalysisStatus: "NOT_REQUESTED",
          frameRate: metadata.frameRate,
          hasAudioTrack: metadata.hasAudioTrack,
          height: metadata.height,
          humanLabels: jsonInput([]),
          machineLabels: jsonInput([]),
          privacyState: "REVIEW_REQUIRED",
          provisionalPeople: jsonInput([]),
          provisionalProjects: jsonInput([]),
          provisionalQuestions: jsonInput([]),
          provisionalTopics: jsonInput([]),
          relatedSignals: jsonInput([]),
          scannedFileId,
          selectedFrameDescriptions: jsonInput([]),
          sourceCreatedAt: metadata.sourceCreatedAt,
          sourceModifiedAt: metadata.sourceModifiedAt,
          transcriptionStatus: "NOT_REQUESTED",
          videoFingerprint: metadata.videoFingerprint,
          width: metadata.width,
        },
        update: {
          bitrateKbps: metadata.bitrateKbps,
          codec: metadata.codec,
          container: metadata.container,
          durationSeconds: metadata.durationSeconds,
          frameRate: metadata.frameRate,
          hasAudioTrack: metadata.hasAudioTrack,
          height: metadata.height,
          sourceCreatedAt: metadata.sourceCreatedAt,
          sourceModifiedAt: metadata.sourceModifiedAt,
          videoFingerprint: metadata.videoFingerprint,
          width: metadata.width,
        },
        where: { scannedFileId },
      });
    }

    if (file.imageMetadata) {
      const metadata = file.imageMetadata;
      await prisma.imageAssetMetadata.upsert({
        create: {
          cameraDevice: metadata.cameraDevice,
          colorProfile: metadata.colorProfile,
          embeddedDate: metadata.embeddedDate,
          format: metadata.format,
          height: metadata.height,
          humanLabels: jsonInput([]),
          imageFingerprint: metadata.imageFingerprint,
          machineLabels: jsonInput([]),
          ocrStatus: "NOT_REQUESTED",
          orientation: metadata.orientation,
          previewStatus: "NOT_REQUESTED",
          privacyState: "REVIEW_REQUIRED",
          provisionalQuestions: jsonInput([]),
          provisionalTopics: jsonInput([]),
          relatedSignals: jsonInput([]),
          scannedFileId,
          sourceCreatedAt: metadata.sourceCreatedAt,
          sourceModifiedAt: metadata.sourceModifiedAt,
          visualAnalysisStatus: "NOT_REQUESTED",
          width: metadata.width,
        },
        update: {
          cameraDevice: metadata.cameraDevice,
          colorProfile: metadata.colorProfile,
          embeddedDate: metadata.embeddedDate,
          format: metadata.format,
          height: metadata.height,
          imageFingerprint: metadata.imageFingerprint,
          orientation: metadata.orientation,
          sourceCreatedAt: metadata.sourceCreatedAt,
          sourceModifiedAt: metadata.sourceModifiedAt,
          width: metadata.width,
        },
        where: { scannedFileId },
      });
    }
  }
}

async function queueRemoteReads(input: {
  bridgeDeviceId: string;
  bridgeRootId: string;
  connectedLibraryId: string;
  scanSessionId: string;
}) {
  const prisma = getPrismaClient();
  const files = await prisma.scannedFile.findMany({
    select: { checksum: true, id: true, relativePath: true },
    where: {
      readStatus: "SUPPORTED",
      readingStatus: "NOT_READ",
      sessionId: input.scanSessionId,
    },
  });

  for (const file of files) {
    await queueRemoteReadCommand({
      bridgeDeviceId: input.bridgeDeviceId,
      bridgeRootId: input.bridgeRootId,
      connectedLibraryId: input.connectedLibraryId,
      idempotencyKey: `read-file:${input.scanSessionId}:${file.id}:${file.checksum ?? "no-checksum"}`,
      relativePath: file.relativePath,
      scanSessionId: input.scanSessionId,
      scannedFileId: file.id,
    });
  }

  return files.length;
}

export async function queueRemoteBridgeScan(connectedLibraryId: string) {
  const prisma = getPrismaClient();
  const library = await prisma.connectedLibrary.findUnique({
    include: { bridgeDevice: true },
    where: { id: connectedLibraryId },
  });

  if (!library || !library.isEnabled || library.status === "DISCONNECTED") {
    throw new BridgeCloudError(
      "Reconnect this folder before starting a scan.",
      409,
    );
  }

  if (!library.readPermission) {
    throw new BridgeCloudError(
      "Reading permission is required before this folder can be scanned.",
      403,
    );
  }

  if (!library.bridgeDeviceId || !library.bridgeRootId || !library.bridgeDevice) {
    throw new BridgeCloudError(
      "Pair and reconnect this Mac before starting a scan.",
      409,
    );
  }

  const lastSeenAt = library.bridgeDevice.lastSeenAt?.getTime() ?? Number.NaN;
  const online =
    library.bridgeDevice.status === "ONLINE" &&
    Number.isFinite(lastSeenAt) &&
    Date.now() - lastSeenAt <= onlineWindowMs;

  if (!online) {
    throw new BridgeCloudError(
      "Open NSN Bridge on this Mac before starting a scan.",
      409,
    );
  }

  const active = await prisma.scanSession.findFirst({
    orderBy: { startedAt: "desc" },
    where: {
      connectedFolderId: connectedLibraryId,
      status: { in: [...activeScanStatuses] },
    },
  });

  if (active) {
    const progress = await getBridgeScanSessionProgress(active.id);

    if (!progress) {
      throw new BridgeCloudError(
        "The Librarian could not load the active scan.",
        500,
      );
    }

    return { alreadyActive: true, ...progress };
  }

  const session = await prisma.scanSession.create({
    data: {
      connectedFolderId: connectedLibraryId,
      status: "SCANNING",
    },
  });

  try {
    await createBridgeCloudCommand({
      authorizationContext: {
        initiatedBy: "Deanne",
        purpose:
          "Scan the selected connected folder without uploading the folder itself.",
      },
      bridgeDeviceId: library.bridgeDeviceId,
      bridgeRootId: library.bridgeRootId,
      commandType: "SCAN_LIBRARY",
      connectedLibraryId,
      idempotencyKey: `scan-library:${session.id}`,
      payload: { scanSessionId: session.id },
    });
  } catch (error) {
    await prisma.scanSession.update({
      data: { completedAt: new Date(), status: "FAILED" },
      where: { id: session.id },
    });
    throw error;
  }

  const progress = await getBridgeScanSessionProgress(session.id);

  if (!progress) {
    throw new BridgeCloudError(
      "The Librarian could not prepare scan progress.",
      500,
    );
  }

  return { alreadyActive: false, ...progress };
}

export async function remoteSessionIsCloudManaged(sessionId: string) {
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findUnique({
    select: {
      connectedFolder: { select: { bridgeDeviceId: true } },
    },
    where: { id: sessionId },
  });

  return Boolean(session?.connectedFolder.bridgeDeviceId);
}

export async function importRemoteBridgeScanReport(input: {
  bridgeDeviceId: string;
  commandPayload: unknown;
  connectedLibraryId: string;
  bridgeRootId: string;
  report: BridgeCommandReport;
}): Promise<BridgeJson | null> {
  const payload = objectValue(input.commandPayload);
  const scanSessionId = stringValue(payload?.scanSessionId, 100);

  if (!scanSessionId) {
    return null;
  }

  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findFirst({
    where: {
      connectedFolderId: input.connectedLibraryId,
      id: scanSessionId,
    },
  });

  if (!session) {
    throw new BridgeCloudError(
      "The queued cloud scan session could not be found.",
      404,
    );
  }

  if (input.report.status !== "COMPLETED") {
    await prisma.scanSession.update({
      data: {
        completedAt: new Date(),
        failedFiles: 1,
        status: "FAILED",
      },
      where: { id: scanSessionId },
    });

    return {
      cloudScanSessionId: scanSessionId,
      safeErrorCategory:
        input.report.safeErrorCategory ?? "BRIDGE_SCAN_FAILED",
    };
  }

  const watchEvents = watchEventsFromReport(input.report.result);

  if (watchEvents.length > 0) {
    await ingestBridgeWatchEvents(input.bridgeDeviceId, watchEvents);
  }

  const scan = scanResultFromReport(input.report.result, input.bridgeRootId);
  const existingFileCount = await prisma.scannedFile.count({
    where: { sessionId: scanSessionId },
  });

  if (existingFileCount === 0) {
    for (let index = 0; index < scan.files.length; index += 500) {
      await prisma.scannedFile.createMany({
        data: scan.files
          .slice(index, index + 500)
          .map((file) => scannedFileCreateData(scanSessionId, file)),
      });
    }
    await storeMediaMetadata(scanSessionId, scan.files);
  }
  await recordChecksumDuplicateSuggestionsForSession(scanSessionId);

  const terminalStatus =
    scan.supportedFiles > 0
      ? "READING"
      : scan.failedFiles > 0
        ? "COMPLETED_WITH_ERRORS"
        : "COMPLETED";
  await prisma.$transaction([
    prisma.scanSession.update({
      data: {
        completedAt: scan.supportedFiles > 0 ? null : scan.completedAt,
        failedFiles: scan.failedFiles,
        filesScanned: scan.totalFiles,
        status: terminalStatus,
        supportedFiles: scan.supportedFiles,
        unsupportedFiles: scan.unsupportedFiles,
      },
      where: { id: scanSessionId },
    }),
    prisma.connectedLibrary.update({
      data: { lastScanAt: new Date(), status: "CONNECTED" },
      where: { id: input.connectedLibraryId },
    }),
  ]);
  const queuedReads = await queueRemoteReads({
    bridgeDeviceId: input.bridgeDeviceId,
    bridgeRootId: input.bridgeRootId,
    connectedLibraryId: input.connectedLibraryId,
    scanSessionId,
  });

  return {
    cloudScanSessionId: scanSessionId,
    failedFiles: scan.failedFiles,
    queuedReads,
    supportedFiles: scan.supportedFiles,
    totalFiles: scan.totalFiles,
    unsupportedFiles: scan.unsupportedFiles,
  };
}
