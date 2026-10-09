import { deviceKeyFingerprint } from "./observation-authority";
import path from "node:path";
import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

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
import { bridgeDeviceIsOnline } from "./effective-health";
import { currentReadableRootWhere, isCurrentReadableRoot } from "./current-readable-root";
import { queueRemoteReadCommand } from "./remote-read-commands";
import { reuseCompletedObservationsForScan } from "./observation-reuse";
import { generateScanRecommendationBatchIfReady } from "./scan-recommendation-batch";
import { ingestBridgeWatchEvents } from "./monitor";
import { recordChecksumDuplicateSuggestionsForSession } from "./checksum-duplicates";
import { currentRecommendationGenerationVersion } from "./recommendation-generation";
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
// Four sequential reads leave roughly two minutes each within the ten-minute command lifetime.
const remoteReadBatchSize = 4;
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
  if (files.length !== candidate.files.length || new Set(files.map((file) => file.relativePath)).size !== files.length) {
    throw new BridgeCloudError("The scan does not contain a complete, unambiguous file inventory.", 422, "INVALID_SCAN_INVENTORY");
  }
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
    id: `sf_${createHash("sha256").update(`${sessionId}\0${file.relativePath}`).digest("hex")}`,
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
  transaction?: Prisma.TransactionClient,
) {
  const prisma = transaction ?? getPrismaClient();
  const storedFiles = await prisma.scannedFile.findMany({
    select: { id: true, relativePath: true },
    where: { sessionId, relativePath: { in: files.map((file) => file.relativePath) } },
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

async function queueRemoteReadBatch(input: {
  bridgeDeviceId: string;
  bridgeRootId: string;
  connectedLibraryId: string;
  scanSessionId: string;
  regenerationGeneration?: string | null;
}, prisma: Prisma.TransactionClient) {
  const files = await prisma.scannedFile.findMany({
    orderBy: [{ relativePath: "asc" }, { id: "asc" }],
    select: { checksum: true, id: true, relativePath: true },
    take: remoteReadBatchSize,
    where: {
      processingStage: "DISCOVERED",
      readStatus: "SUPPORTED",
      readingStatus: "NOT_READ",
      observationClaimedAt: null,
      sourceUnavailableAt: null,
      sessionId: input.scanSessionId,
    },
  });

  for (const file of files) {
    const previous = await prisma.bridgeCommand.findFirst({
      select: { commandId: true }, orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      where: { bridgeDeviceId: input.bridgeDeviceId, commandType: "READ_FILE_TEMPORARILY",
        AND: [{ payload: { path: ["scannedFileId"], equals: file.id } },
          { payload: { path: ["scanSessionId"], equals: input.scanSessionId } }],
      },
    });
    try {
      await queueRemoteReadCommand({
        bridgeDeviceId: input.bridgeDeviceId,
        bridgeRootId: input.bridgeRootId,
        connectedLibraryId: input.connectedLibraryId,
        idempotencyKey: input.regenerationGeneration
          ? `recommendation-regeneration:${currentRecommendationGenerationVersion}:${input.scanSessionId}:${file.id}:${input.regenerationGeneration}:${previous?.commandId ?? "initial"}`
          : `read-file:${input.scanSessionId}:${file.id}:${file.checksum ?? "no-checksum"}:${previous?.commandId ?? "initial"}`,
        ...(input.regenerationGeneration ? { processingPurpose: "RECOMMENDATION_REGENERATION" as const,
          recommendationGenerationVersion: currentRecommendationGenerationVersion } : {}),
        relativePath: file.relativePath,
        scanSessionId: input.scanSessionId,
        scannedFileId: file.id,
      }, prisma);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
        throw error;
      }
    }
    await prisma.scannedFile.updateMany({
      data: { processingStage: "READING" },
      where: { id: file.id, processingStage: "DISCOVERED" },
    });
  }

  return files.length;
}

export async function queueRemoteReads(input: Parameters<typeof queueRemoteReadBatch>[0]) {
  const prisma = getPrismaClient();
  return prisma.$transaction(async (tx) => {
    // Serialize admission across fetches and roots on the same sequential Bridge worker.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`remote-read-batch:${input.bridgeDeviceId}`}))`;
    // Revocation takes device then root ownership. Keep that order and retain
    // these grants through command creation, rather than trusting selection.
    const device = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${input.bridgeDeviceId}
        AND status <> 'REVOKED' AND "revokedAt" IS NULL FOR SHARE
    `);
    if (!device.length) return 0;
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder"
      WHERE id = ${input.connectedLibraryId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ScanSession" WHERE id = ${input.scanSessionId} FOR UPDATE`);
    const eligible = await tx.scanSession.findFirst({ select: { id: true, recommendationRegenerationGeneration: true }, where: {
      id: input.scanSessionId, connectedFolderId: input.connectedLibraryId, status: "READING",
      connectedFolder: { ...currentReadableRootWhere, bridgeDeviceId: input.bridgeDeviceId,
        bridgeRootId: input.bridgeRootId },
    } });
    if (!eligible) return 0;
    const active = await tx.bridgeCommand.count({ where: {
      bridgeDeviceId: input.bridgeDeviceId, commandType: "READ_FILE_TEMPORARILY",
      expiresAt: { gt: new Date() }, status: { in: ["PENDING", "ACKNOWLEDGED", "RUNNING"] },
    } });
    if (active > 0) return 0;
    return queueRemoteReadBatch({ ...input, regenerationGeneration: eligible.recommendationRegenerationGeneration }, tx);
  }, { timeout: 60_000 });
}

export async function queueNextRemoteReadBatchForDevice(bridgeDeviceId: string) {
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findFirst({
    include: { connectedFolder: true },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    where: {
      connectedFolder: {
        ...currentReadableRootWhere,
        bridgeDeviceId,
        bridgeRootId: { not: null },
      },
      scannedFiles: {
        some: { processingStage: "DISCOVERED", readStatus: "SUPPORTED" },
      },
      status: "READING",
    },
  });
  const library = session?.connectedFolder;

  if (!session || !library?.bridgeRootId) {
    return 0;
  }

  return queueRemoteReads({
    bridgeDeviceId,
    bridgeRootId: library.bridgeRootId,
    connectedLibraryId: library.id,
    scanSessionId: session.id,
  });
}

export async function queueRemoteBridgeScan(connectedLibraryId: string) {
  const prisma = getPrismaClient();
  const admitted = await prisma.$transaction(async (tx) => {
    const binding = await tx.connectedLibrary.findUnique({ where: { id: connectedLibraryId }, select: { bridgeDeviceId: true } });
    if (!binding?.bridgeDeviceId) throw new BridgeCloudError("Pair and reconnect this Mac before starting a scan.", 409);
    await tx.$queryRaw`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${binding.bridgeDeviceId} AND status <> 'REVOKED' AND "revokedAt" IS NULL FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${connectedLibraryId} FOR UPDATE`;
    const prisma = tx;
  const library = await prisma.connectedLibrary.findUnique({
    include: { bridgeDevice: true },
    where: { id: connectedLibraryId },
  });

  if (!library || !isCurrentReadableRoot(library)) {
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

  const online = bridgeDeviceIsOnline(library.bridgeDevice);

  if (!online) {
    throw new BridgeCloudError(
      "Open NSN Bridge on this Mac before starting a scan.",
      409,
    );
  }

  const active = await prisma.scanSession.findFirst({
    orderBy: { startedAt: "desc" },
    where: {
      connectedFolderId: connectedLibraryId, inventoryGeneration: library.physicalInventoryGeneration,
      status: { in: [...activeScanStatuses] },
    },
  });

  if (active) {
    return { alreadyActive: true, sessionId: active.id };
  }

  const session = await prisma.scanSession.create({
    data: {
      connectedFolderId: connectedLibraryId, inventoryGeneration: library.physicalInventoryGeneration,
      status: "SCANNING",
    },
  });

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
    }, tx);
    return { alreadyActive: false, sessionId: session.id };
  });
  const progress = await getBridgeScanSessionProgress(admitted.sessionId);

  if (!progress) {
    throw new BridgeCloudError(
      "The Librarian could not prepare scan progress.",
      500,
    );
  }

  return { alreadyActive: admitted.alreadyActive, ...progress };
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
  expectedRootRevision?: number;
  expectedDeviceKeyFingerprint?: string;
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

  const rootBinding = await prisma.connectedLibrary.findUniqueOrThrow({ include: { bridgeDevice: true }, where: { id: input.connectedLibraryId } });
  const revision = input.expectedRootRevision ?? rootBinding.nativeConnectionRevision;
  const fingerprint = input.expectedDeviceKeyFingerprint ?? (rootBinding.bridgeDevice ? deviceKeyFingerprint(rootBinding.bridgeDevice.publicKey) : null);
  const scan = input.report.status === "COMPLETED" ? scanResultFromReport(input.report.result, input.bridgeRootId) : null;

  const withGrant = async <T,>(run: (tx: Prisma.TransactionClient) => Promise<T>, allowImportedReplay = false): Promise<T> => {
    let supersededInventory = false;
    const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${input.bridgeDeviceId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder" WHERE id = ${input.connectedLibraryId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT "commandId" FROM "BridgeCommand" WHERE "commandId" = ${input.report.commandId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ScanSession" WHERE id = ${scanSessionId} FOR UPDATE`);
    const root = await tx.connectedLibrary.findFirst({ include: { bridgeDevice: true }, where: { id: input.connectedLibraryId,
      ...currentReadableRootWhere, bridgeDeviceId: input.bridgeDeviceId, bridgeRootId: input.bridgeRootId, nativeConnectionRevision: revision } });
    if (!root?.bridgeDevice || root.bridgeDevice.status === "REVOKED" || root.bridgeDevice.revokedAt || deviceKeyFingerprint(root.bridgeDevice.publicKey) !== fingerprint)
      throw new BridgeCloudError("The scan report belongs to older root or device authority.", 409);
    if (scan) {
      try { await (await import("./execution-reconciliation")).assertInventoryAfterPhysicalOutcomes(tx, root.id, session.inventoryGeneration); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes("preceded an authorized filesystem outcome")) throw error;
        await tx.scanSession.update({ where: { id: scanSessionId }, data: { status: "FAILED", completedAt: new Date() } });
        await tx.bridgeCommand.updateMany({ where: { commandId: input.report.commandId, bridgeDeviceId: input.bridgeDeviceId,
          status: { in: ["PENDING", "ACKNOWLEDGED", "RUNNING"] } }, data: { status: "FAILED", safeErrorCategory: "INVENTORY_SUPERSEDED", completedAt: new Date() } });
        supersededInventory = true;
        return null;
      }
    }
    if (!allowImportedReplay && !await tx.scanSession.count({ where: { id: scanSessionId, status: "SCANNING" } }))
      throw new BridgeCloudError("The scan import already settled; retry its completion report.", 409);
    return run(tx);
  }, { timeout: 120_000 });
    if (supersededInventory) throw new BridgeCloudError("This inventory preceded an authorized filesystem outcome. Scan this root again.", 409, "INVENTORY_SUPERSEDED");
    return result as T;
  };

  if (input.report.status !== "COMPLETED") {
    await withGrant((tx) => tx.scanSession.updateMany({
      data: {
        completedAt: new Date(),
        failedFiles: 1,
        status: "FAILED",
      },
      where: { id: scanSessionId, status: "SCANNING" },
    }));

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

  if (!scan) throw new BridgeCloudError("The completed scan inventory is missing.", 400);
  if (session.status !== "SCANNING") {
    return withGrant(async (tx) => {
      const current = await tx.scanSession.findUniqueOrThrow({ where: { id: session.id } });
      if (["FAILED", "CANCELLED"].includes(current.status)) throw new BridgeCloudError("This scan is no longer awaiting inventory.", 409);
      return { cloudScanSessionId: scanSessionId, alreadyImported: true };
    }, true);
  }
  const inventoryHash = createHash("sha256").update(JSON.stringify(
    [...scan.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value,
  )).digest("hex");
  await withGrant((tx) => tx.scanSession.updateMany({ where: { id: scanSessionId, status: "SCANNING", importInventoryHash: null },
    data: { importInventoryHash: inventoryHash } }));
  const owner = await prisma.scanSession.findUniqueOrThrow({ where: { id: scanSessionId } });
  if (owner.importInventoryHash !== inventoryHash) throw new BridgeCloudError("This retry contains a different scan inventory.", 409, "SCAN_INVENTORY_MISMATCH");
  const existingFiles = await prisma.scannedFile.findMany({ select: { relativePath: true, checksum: true }, where: { sessionId: scanSessionId } });
  const existingByPath = new Map(existingFiles.map((file) => [file.relativePath, file]));
  const incomingByPath = new Map(scan.files.map((file) => [file.relativePath, file]));
  if (existingFiles.some((file) => !incomingByPath.has(file.relativePath) || incomingByPath.get(file.relativePath)?.checksum !== file.checksum)) {
    throw new BridgeCloudError("This retry contains a different scan inventory.", 409, "SCAN_INVENTORY_MISMATCH");
  }
  const missingFiles = scan.files.filter((file) => !existingByPath.has(file.relativePath));
    for (let index = 0; index < missingFiles.length; index += 500) {
      await withGrant((tx) => tx.scannedFile.createMany({
        skipDuplicates: true,
        data: missingFiles
          .slice(index, index + 500)
          .map((file) => scannedFileCreateData(scanSessionId, file)),
      }));
    }
    for (let offset = 0; offset < scan.files.length; offset += 500) await withGrant((tx) => storeMediaMetadata(scanSessionId, scan.files.slice(offset, offset + 500), tx));
  await recordChecksumDuplicateSuggestionsForSession(scanSessionId);

  const terminalStatus =
    scan.supportedFiles > 0
      ? "READING"
      : scan.failedFiles > 0
        ? "COMPLETED_WITH_ERRORS"
        : "COMPLETED";
  await withGrant(async (tx) => {
    await tx.scanSession.updateMany({
      data: {
        completedAt: scan.supportedFiles > 0 ? null : scan.completedAt,
        failedFiles: scan.failedFiles,
        filesScanned: scan.totalFiles,
        status: terminalStatus,
        supportedFiles: scan.supportedFiles,
        unsupportedFiles: scan.unsupportedFiles,
      },
      where: { id: scanSessionId, status: "SCANNING" },
    });
    await tx.connectedLibrary.update({
      data: { lastScanAt: new Date() },
      where: { id: input.connectedLibraryId },
    });
  });
  const reusedObservations = await reuseCompletedObservationsForScan({
    bridgeDeviceId: input.bridgeDeviceId,
    bridgeRootId: input.bridgeRootId,
    connectedLibraryId: input.connectedLibraryId,
    scanSessionId,
  });
  const queuedReads = await queueRemoteReads({
    bridgeDeviceId: input.bridgeDeviceId,
    bridgeRootId: input.bridgeRootId,
    connectedLibraryId: input.connectedLibraryId,
    scanSessionId,
  });
  if (queuedReads === 0) {
    await generateScanRecommendationBatchIfReady(scanSessionId);
  }

  return {
    cloudScanSessionId: scanSessionId,
    failedFiles: scan.failedFiles,
    queuedReads,
    reusedObservations,
    supportedFiles: scan.supportedFiles,
    totalFiles: scan.totalFiles,
    unsupportedFiles: scan.unsupportedFiles,
  };
}
