import { randomUUID } from "node:crypto";
import path from "node:path";

import { getPrismaClient } from "@/lib/db/prisma";
import {
  BridgeCloudError,
  createBridgeCloudCommand,
} from "@/lib/bridge/cloud-coordinator";
import { requireScanSessionPermission } from "@/lib/bridge/connected-libraries";

import { currentRecommendationGenerationVersion } from "./recommendation-generation";
import {
  getBridgeScanSessionDetail,
  getBridgeScanSessionProgress,
} from "./scan-sessions";
import type {
  BridgeReadFileApiQueued,
  BridgeScannedFileSummary,
} from "./types";

const onlineWindowMs = 90_000;
const readCommandLifetimeMs = 10 * 60 * 1000;
const regenerationReadCommandLifetimeMs = 24 * 60 * 60 * 1000;
const activeReadCommandStatuses = [
  "PENDING",
  "ACKNOWLEDGED",
  "RUNNING",
] as const;
const supportedAudioExtensions = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".wav",
]);
const supportedVideoExtensions = new Set([".m4v", ".mov", ".mp4"]);

type RemoteReadCommandInput = {
  bridgeDeviceId: string;
  bridgeRootId: string;
  connectedLibraryId: string;
  expiresAt?: Date;
  idempotencyKey: string;
  processingPurpose?: "RECOMMENDATION_REGENERATION";
  recommendationGenerationVersion?: string;
  relativePath: string;
  scanSessionId: string;
  scannedFileId: string;
};

function objectValue(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function commandTargetsScannedFile(
  command: { payload: unknown },
  input: { scanSessionId: string; scannedFileId: string },
) {
  const payload = objectValue(command.payload);

  return (
    payload?.scanSessionId === input.scanSessionId &&
    payload?.scannedFileId === input.scannedFileId
  );
}

function normalizeCommandCategory(category: string | null | undefined) {
  return category?.trim().toUpperCase() || "READ_COMMAND_FAILED";
}

export function remoteReadFailureCategoryFor(
  category: string | null | undefined,
  relativePath: string,
) {
  const normalized = normalizeCommandCategory(category);
  const extension = path.posix.extname(relativePath).toLowerCase();

  if (normalized === "NO_TEXT_EXTRACTED") {
    return "FILE_EMPTY";
  }

  if (
    normalized === "SOURCE_FILE_MISSING" ||
    normalized === "MISSING_SOURCE" ||
    normalized === "FILE_NOT_FOUND"
  ) {
    return "FILE_NOT_FOUND";
  }

  if (
    normalized === "ROOT_NOT_FOUND" ||
    normalized === "ROOT_DISCONNECTED" ||
    normalized === "ROOT_UNAVAILABLE"
  ) {
    return "ROOT_NOT_CONNECTED";
  }

  if (normalized === "COMMAND_EXPIRED" || normalized === "READ_COMMAND_TIMEOUT") {
    return "READ_COMMAND_TIMEOUT";
  }

  if (normalized === "UNSUPPORTED_FILE_TYPE") {
    if (supportedAudioExtensions.has(extension)) {
      return "AUDIO_READ_FAILED";
    }

    if (supportedVideoExtensions.has(extension)) {
      return "VIDEO_READ_FAILED";
    }

    return "UNSUPPORTED_FILE_TYPE";
  }

  if (
    normalized === "AUDIO_DECODE_FAILED" ||
    normalized === "AUDIO_METADATA_FAILED" ||
    normalized === "AUDIO_TRANSCRIPTION_FAILED" ||
    normalized === "AUDIO_TRANSCRIPTION_UNAVAILABLE" ||
    normalized === "UNSUPPORTED_AUDIO"
  ) {
    return normalized === "UNSUPPORTED_AUDIO"
      ? "AUDIO_READ_FAILED"
      : normalized;
  }

  if (
    normalized === "VIDEO_DECODE_FAILED" ||
    normalized === "VIDEO_METADATA_FAILED" ||
    normalized === "VIDEO_TRANSCRIPTION_FAILED" ||
    normalized === "VIDEO_TRANSCRIPTION_UNAVAILABLE" ||
    normalized === "AI_TRANSCRIPTION_FAILED" ||
    normalized === "AI_TRANSCRIPTION_UNAVAILABLE"
  ) {
    return normalized.startsWith("AI_")
      ? normalized.replace(/^AI_/, "VIDEO_")
      : normalized;
  }

  if (
    normalized === "PDF_PARSE_FAILED" ||
    (normalized === "BRIDGE_COMMAND_FAILED" && extension === ".pdf")
  ) {
    return "PDF_PARSE_FAILED";
  }

  if (normalized === "FILE_EMPTY" || normalized === "FILE_UNREADABLE") {
    return normalized;
  }

  if (normalized === "FILE_CORRUPT") {
    return "FILE_CORRUPT";
  }

  return "READ_COMMAND_FAILED";
}

export function remoteReadFailureMessageFor(
  category: string,
  relativePath: string,
) {
  if (category === "FILE_EMPTY") {
    return "This file is empty.";
  }

  if (category === "PDF_PARSE_FAILED") {
    return "This PDF appears damaged or could not be read safely.";
  }

  if (category === "FILE_CORRUPT") {
    return "This file appears damaged or could not be read safely.";
  }

  if (category === "FILE_NOT_FOUND") {
    return "This file is no longer available at its scanned location.";
  }

  if (category === "UNSUPPORTED_FILE_TYPE") {
    return "Unsupported for reading.";
  }

  if (category === "AUDIO_DECODE_FAILED") {
    return "This audio file appears damaged or could not be read safely.";
  }

  if (category === "VIDEO_DECODE_FAILED") {
    return "This video file appears damaged or could not be read safely.";
  }

  if (
    category === "AUDIO_METADATA_FAILED" ||
    category === "AUDIO_READ_FAILED" ||
    category === "AUDIO_TRANSCRIPTION_FAILED" ||
    category === "AUDIO_TRANSCRIPTION_UNAVAILABLE"
  ) {
    return "The Bridge could not finish reading this audio file safely.";
  }

  if (
    category === "VIDEO_METADATA_FAILED" ||
    category === "VIDEO_READ_FAILED" ||
    category === "VIDEO_TRANSCRIPTION_FAILED" ||
    category === "VIDEO_TRANSCRIPTION_UNAVAILABLE"
  ) {
    return "The Bridge could not finish reading this video file safely.";
  }

  if (category === "READ_COMMAND_TIMEOUT") {
    return "The Bridge did not finish reading this file in time.";
  }

  if (category === "ROOT_NOT_CONNECTED") {
    return "Reconnect this folder before retrying this file.";
  }

  if (category === "BRIDGE_OFFLINE") {
    return "Open NSN Bridge on this Mac before retrying this file.";
  }

  if (category === "FILE_UNREADABLE") {
    return "This file could not be read safely.";
  }

  if (path.posix.extname(relativePath).toLowerCase() === ".pdf") {
    return "This PDF appears damaged or could not be read safely.";
  }

  return "The Bridge could not read this file safely.";
}

export async function markRemoteReadFailure(input: {
  scanSessionId: string;
  scannedFileId: string;
  safeErrorCategory: string | null | undefined;
}) {
  const prisma = getPrismaClient();
  const file = await prisma.scannedFile.findFirst({
    select: {
      relativePath: true,
    },
    where: {
      id: input.scannedFileId,
      sessionId: input.scanSessionId,
    },
  });

  if (!file) {
    return null;
  }

  const category = remoteReadFailureCategoryFor(
    input.safeErrorCategory,
    file.relativePath,
  );
  const unsupported = category === "UNSUPPORTED_FILE_TYPE";
  const sourceMissing = category === "FILE_NOT_FOUND";
  const message = remoteReadFailureMessageFor(category, file.relativePath);
  const updated = await prisma.scannedFile.update({
    data: {
      extractedAt: new Date(),
      extractionErrorCategory: category,
      extractionStatus: unsupported ? "UNSUPPORTED" : "FAILED",
      processedAt: new Date(),
      processingErrorCategory: category,
      processingStage: unsupported ? "UNSUPPORTED" : "FAILED",
      readStatus: unsupported ? "UNSUPPORTED" : undefined,
      readingStatus: unsupported ? "UNSUPPORTED" : "FAILED",
      scanError: message,
      sourceUnavailableAt: sourceMissing ? new Date() : undefined,
      sourceUnavailableReason: sourceMissing ? message : undefined,
    },
    where: {
      id: input.scannedFileId,
    },
  });

  return updated;
}

export async function queueRemoteReadCommand(input: RemoteReadCommandInput) {
  return createBridgeCloudCommand({
    authorizationContext: {
      purpose:
        "Temporarily read a discovered file so the Librarian can prepare reviewable observations and recommendations.",
    },
    bridgeDeviceId: input.bridgeDeviceId,
    bridgeRootId: input.bridgeRootId,
    commandType: "READ_FILE_TEMPORARILY",
    connectedLibraryId: input.connectedLibraryId,
    expiresAt:
      input.expiresAt ?? new Date(Date.now() + readCommandLifetimeMs),
    idempotencyKey: input.idempotencyKey,
    payload: {
      ...(input.processingPurpose
        ? { processingPurpose: input.processingPurpose }
        : {}),
      ...(input.recommendationGenerationVersion
        ? {
            recommendationGenerationVersion:
              input.recommendationGenerationVersion,
          }
        : {}),
      relativePath: input.relativePath,
      scanSessionId: input.scanSessionId,
      scannedFileId: input.scannedFileId,
    },
  });
}

async function activeReadCommandForScannedFile(input: {
  bridgeDeviceId: string;
  bridgeRootId: string;
  connectedLibraryId: string;
  scanSessionId: string;
  scannedFileId: string;
}) {
  const prisma = getPrismaClient();
  const commands = await prisma.bridgeCommand.findMany({
    orderBy: {
      issuedAt: "desc",
    },
    where: {
      bridgeDeviceId: input.bridgeDeviceId,
      bridgeRootId: input.bridgeRootId,
      commandType: "READ_FILE_TEMPORARILY",
      connectedLibraryId: input.connectedLibraryId,
      expiresAt: {
        gt: new Date(),
      },
      status: {
        in: [...activeReadCommandStatuses],
      },
    },
  });

  return (
    commands.find((command) => commandTargetsScannedFile(command, input)) ?? null
  );
}

async function scannedFileSummaryFor(
  sessionId: string,
  scannedFileId: string,
): Promise<BridgeScannedFileSummary> {
  const detail = await getBridgeScanSessionDetail(sessionId);
  const file = detail?.scannedFiles.find((item) => item.id === scannedFileId);

  if (!file) {
    throw new BridgeCloudError(
      "The Librarian could not refresh this scanned file.",
      404,
    );
  }

  return file;
}

async function queuedResult(input: {
  message: string;
  scanSessionId: string;
  scannedFileId: string;
}): Promise<BridgeReadFileApiQueued> {
  const [progress, file] = await Promise.all([
    getBridgeScanSessionProgress(input.scanSessionId),
    scannedFileSummaryFor(input.scanSessionId, input.scannedFileId),
  ]);

  if (!progress) {
    throw new BridgeCloudError(
      "The Librarian could not refresh this scan session.",
      404,
    );
  }

  return {
    file,
    message: input.message,
    ok: true,
    progress: progress.progress,
    queued: true,
    session: progress.session,
  };
}

async function markRetryQueued(scannedFileId: string, scanSessionId: string) {
  const prisma = getPrismaClient();

  await prisma.$transaction([
    prisma.scannedFile.update({
      data: {
        extractedAt: null,
        extractionErrorCategory: null,
        extractionStatus: "EXTRACTING",
        processedAt: null,
        processingErrorCategory: null,
        processingStage: "READING",
        readingStatus: "NOT_READ",
        scanError: null,
        sourceUnavailableAt: null,
        sourceUnavailableReason: null,
      },
      where: {
        id: scannedFileId,
      },
    }),
    prisma.scanSession.update({
      data: {
        completedAt: null,
        status: "READING",
      },
      where: {
        id: scanSessionId,
      },
    }),
  ]);
}

function commandScannedFileId(command: { payload: unknown }, sessionId: string) {
  const payload = objectValue(command.payload);

  return payload?.scanSessionId === sessionId &&
    typeof payload.scannedFileId === "string"
    ? payload.scannedFileId
    : null;
}

export async function queueRemoteRecommendationRegenerationForSession(
  sessionId: string,
) {
  await requireScanSessionPermission(
    sessionId,
    "readPermission",
    "read files for recommendation generation",
  );
  await requireScanSessionPermission(
    sessionId,
    "recommendationPermission",
    "prepare organization recommendations",
  );

  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findUnique({
    include: {
      connectedFolder: {
        include: {
          bridgeDevice: true,
        },
      },
      scannedFiles: {
        orderBy: {
          relativePath: "asc",
        },
        select: {
          id: true,
          organizationSuggestions: {
            orderBy: {
              invalidatedAt: "desc",
            },
            select: {
              id: true,
            },
            take: 1,
            where: {
              invalidatedAt: {
                not: null,
              },
              recommendationGenerationVersion:
                currentRecommendationGenerationVersion,
            },
          },
          relativePath: true,
        },
        where: {
          extractionStatus: {
            not: "FAILED",
          },
          organizationSuggestions: {
            none: {
              invalidatedAt: null,
              recommendationGenerationVersion:
                currentRecommendationGenerationVersion,
            },
          },
          processingStage: {
            notIn: ["FAILED", "UNSUPPORTED"],
          },
          readingStatus: {
            not: "FAILED",
          },
          readStatus: "SUPPORTED",
        },
      },
    },
    where: {
      id: sessionId,
    },
  });

  if (!session) {
    throw new BridgeCloudError(
      "The Librarian could not find that scan session.",
      404,
      "SCAN_SESSION_NOT_FOUND",
    );
  }

  const library = session.connectedFolder;

  if (session.scannedFiles.length === 0) {
    await finalizeRemoteReadSessionIfComplete(sessionId);
    const progress = await getBridgeScanSessionProgress(sessionId);

    if (!progress) {
      throw new BridgeCloudError(
        "The Librarian could not refresh this scan session.",
        404,
        "SCAN_SESSION_NOT_FOUND",
      );
    }

    return {
      alreadyQueuedFiles: 0,
      message:
        "Every supported file in this scan already has a current recommendation.",
      progress: progress.progress,
      queued: false,
      queuedFiles: 0,
      session: progress.session,
    };
  }

  if (!library.bridgeDeviceId || !library.bridgeRootId || !library.bridgeDevice) {
    throw new BridgeCloudError(
      "Pair and reconnect this Mac before generating recommendations.",
      409,
      "ROOT_NOT_CONNECTED",
    );
  }

  const lastSeenAt = library.bridgeDevice.lastSeenAt?.getTime() ?? Number.NaN;
  const bridgeIsOnline =
    library.bridgeDevice.status === "ONLINE" &&
    Number.isFinite(lastSeenAt) &&
    Date.now() - lastSeenAt <= onlineWindowMs;

  if (!bridgeIsOnline) {
    throw new BridgeCloudError(
      "Open NSN Bridge on this Mac before generating recommendations.",
      409,
      "BRIDGE_OFFLINE",
    );
  }

  await expireRemoteReadCommandsForSession(sessionId);

  const readCommands = await prisma.bridgeCommand.findMany({
    orderBy: {
      issuedAt: "desc",
    },
    where: {
      bridgeDeviceId: library.bridgeDeviceId,
      bridgeRootId: library.bridgeRootId,
      commandType: "READ_FILE_TEMPORARILY",
      connectedLibraryId: library.id,
    },
  });
  const latestCommandByFileId = new Map<string, (typeof readCommands)[number]>();
  const activeCommandFileIds = new Set<string>();
  const now = new Date();

  for (const command of readCommands) {
    const scannedFileId = commandScannedFileId(command, sessionId);

    if (!scannedFileId) {
      continue;
    }

    if (!latestCommandByFileId.has(scannedFileId)) {
      latestCommandByFileId.set(scannedFileId, command);
    }

    if (
      activeReadCommandStatuses.includes(
        command.status as (typeof activeReadCommandStatuses)[number],
      ) &&
      command.expiresAt > now
    ) {
      activeCommandFileIds.add(scannedFileId);
    }
  }

  await prisma.$transaction([
    prisma.scannedFile.updateMany({
      data: {
        extractedAt: null,
        extractionErrorCategory: null,
        extractionStatus: "EXTRACTING",
        processedAt: now,
        processingErrorCategory: null,
        processingStage: "READING",
        readingStatus: "NOT_READ",
        scanError: null,
        sourceUnavailableAt: null,
        sourceUnavailableReason: null,
      },
      where: {
        id: {
          in: session.scannedFiles.map((file) => file.id),
        },
        sessionId,
      },
    }),
    prisma.scanSession.update({
      data: {
        completedAt: null,
        status: "READING",
      },
      where: {
        id: sessionId,
      },
    }),
  ]);

  let queuedFiles = 0;
  let alreadyQueuedFiles = 0;

  for (const file of session.scannedFiles) {
    if (activeCommandFileIds.has(file.id)) {
      alreadyQueuedFiles += 1;
      continue;
    }

    const previousCommand = latestCommandByFileId.get(file.id);
    const generationBasis =
      previousCommand?.commandId ??
      file.organizationSuggestions[0]?.id ??
      randomUUID();

    await queueRemoteReadCommand({
      bridgeDeviceId: library.bridgeDeviceId,
      bridgeRootId: library.bridgeRootId,
      connectedLibraryId: library.id,
      expiresAt: new Date(now.getTime() + regenerationReadCommandLifetimeMs),
      idempotencyKey: `recommendation-regeneration:${currentRecommendationGenerationVersion}:${sessionId}:${file.id}:${generationBasis}`,
      processingPurpose: "RECOMMENDATION_REGENERATION",
      recommendationGenerationVersion:
        currentRecommendationGenerationVersion,
      relativePath: file.relativePath,
      scanSessionId: sessionId,
      scannedFileId: file.id,
    });
    queuedFiles += 1;
  }

  const progress = await getBridgeScanSessionProgress(sessionId);

  if (!progress) {
    throw new BridgeCloudError(
      "The Librarian could not refresh this scan session.",
      404,
      "SCAN_SESSION_NOT_FOUND",
    );
  }

  const queued = queuedFiles > 0 || alreadyQueuedFiles > 0;
  const message =
    queuedFiles > 0
      ? `Recommendation generation was queued for ${queuedFiles} ${queuedFiles === 1 ? "file" : "files"}. This page will update as the Mac reports back.`
      : alreadyQueuedFiles > 0
        ? "Recommendation generation is already queued. This page will update as the Mac reports back."
        : "Every supported file in this scan already has a current recommendation.";

  return {
    alreadyQueuedFiles,
    message,
    progress: progress.progress,
    queued,
    queuedFiles,
    session: progress.session,
  };
}

async function finalizeRemoteReadSessionIfComplete(sessionId: string) {
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
    where: {
      id: sessionId,
    },
  });
}

export async function expireRemoteReadCommandsForSession(
  sessionId: string,
  now = new Date(),
) {
  const prisma = getPrismaClient();
  const commands = await prisma.bridgeCommand.findMany({
    where: {
      commandType: "READ_FILE_TEMPORARILY",
      expiresAt: {
        lte: now,
      },
      status: {
        in: [...activeReadCommandStatuses],
      },
    },
  });
  const expiredCommands = commands.filter((command) => {
    const payload = objectValue(command.payload);

    return (
      payload?.scanSessionId === sessionId &&
      typeof payload.scannedFileId === "string"
    );
  });

  for (const command of expiredCommands) {
    const payload = objectValue(command.payload);
    const scannedFileId =
      typeof payload?.scannedFileId === "string" ? payload.scannedFileId : null;

    if (!scannedFileId) {
      continue;
    }

    await prisma.bridgeCommand.update({
      data: {
        completedAt: now,
        safeErrorCategory: "READ_COMMAND_TIMEOUT",
        status: "EXPIRED",
      },
      where: {
        commandId: command.commandId,
      },
    });
    await markRemoteReadFailure({
      safeErrorCategory: "READ_COMMAND_TIMEOUT",
      scanSessionId: sessionId,
      scannedFileId,
    });
  }

  if (expiredCommands.length > 0) {
    await finalizeRemoteReadSessionIfComplete(sessionId);
  }

  return expiredCommands.length;
}

export async function queueRemoteReadRetryForScannedFile(scannedFileId: string) {
  const prisma = getPrismaClient();
  const scannedFile = await prisma.scannedFile.findUnique({
    include: {
      scanSession: {
        include: {
          connectedFolder: {
            include: {
              bridgeDevice: true,
            },
          },
        },
      },
    },
    where: {
      id: scannedFileId,
    },
  });

  if (!scannedFile) {
    throw new BridgeCloudError(
      "The Librarian could not find that scanned file.",
      404,
      "NOT_FOUND",
    );
  }

  const library = scannedFile.scanSession.connectedFolder;

  if (!library.bridgeDeviceId) {
    return null;
  }

  await expireRemoteReadCommandsForSession(scannedFile.sessionId);

  if (scannedFile.readStatus === "UNSUPPORTED") {
    await markRemoteReadFailure({
      safeErrorCategory: "UNSUPPORTED_FILE_TYPE",
      scanSessionId: scannedFile.sessionId,
      scannedFileId,
    });
    throw new BridgeCloudError(
      "Unsupported for reading.",
      409,
      "UNSUPPORTED_FILE_TYPE",
    );
  }

  if (!library.isEnabled || library.status === "DISCONNECTED") {
    throw new BridgeCloudError(
      "Reconnect this folder before retrying this file.",
      409,
      "ROOT_NOT_CONNECTED",
    );
  }

  if (!library.readPermission) {
    throw new BridgeCloudError(
      "The Librarian does not currently have permission to read this folder.",
      403,
      "READ_PERMISSION_REQUIRED",
    );
  }

  if (!library.bridgeRootId) {
    throw new BridgeCloudError(
      "Reconnect this folder before retrying this file.",
      409,
      "ROOT_NOT_CONNECTED",
    );
  }

  const device = library.bridgeDevice;
  const lastSeenAt = device?.lastSeenAt?.getTime() ?? Number.NaN;
  const deviceOnline =
    device?.status === "ONLINE" &&
    Number.isFinite(lastSeenAt) &&
    Date.now() - lastSeenAt <= onlineWindowMs;

  if (!deviceOnline) {
    throw new BridgeCloudError(
      "Open NSN Bridge on this Mac before retrying this file.",
      409,
      "BRIDGE_OFFLINE",
    );
  }

  const activeCommand = await activeReadCommandForScannedFile({
    bridgeDeviceId: library.bridgeDeviceId,
    bridgeRootId: library.bridgeRootId,
    connectedLibraryId: library.id,
    scanSessionId: scannedFile.sessionId,
    scannedFileId,
  });

  if (activeCommand) {
    await markRetryQueued(scannedFileId, scannedFile.sessionId);
    return queuedResult({
      message: "The Bridge is already reading this file again.",
      scanSessionId: scannedFile.sessionId,
      scannedFileId,
    });
  }

  const retryRequestedAt = new Date();

  await markRetryQueued(scannedFileId, scannedFile.sessionId);
  await queueRemoteReadCommand({
    bridgeDeviceId: library.bridgeDeviceId,
    bridgeRootId: library.bridgeRootId,
    connectedLibraryId: library.id,
    idempotencyKey: `read-file-retry:${scannedFile.sessionId}:${scannedFile.id}:${retryRequestedAt.getTime()}`,
    relativePath: scannedFile.relativePath,
    scanSessionId: scannedFile.sessionId,
    scannedFileId: scannedFile.id,
  });

  return queuedResult({
    message:
      "The Librarian asked the Bridge to read this file again. This page will update when the Mac reports back.",
    scanSessionId: scannedFile.sessionId,
    scannedFileId,
  });
}
