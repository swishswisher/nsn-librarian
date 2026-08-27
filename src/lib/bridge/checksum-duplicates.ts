import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";

import { isImageFileType } from "./media-kind";
import { isAudioFileType } from "./audio-metadata";
import { isVideoFileType } from "./video-metadata";

type DuplicateCandidate = {
  checksum: string | null;
  fileType: string;
  id: string;
  lastModified: Date | null;
  relativePath: string;
  sessionId: string;
  sizeBytes: bigint | null;
  sourceCreatedAt: Date | null;
  scanSession: {
    connectedFolder: {
      bridgeRootId: string | null;
      displayName: string;
      id: string;
    };
  };
};

const exactDuplicateConfidence = 0.98;

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function formatFromFileType(fileType: string) {
  return fileType.replace(/^[A-Z]+_/, "").toLowerCase() || "unknown";
}

function duplicateTitleFor(file: DuplicateCandidate) {
  if (isAudioFileType(file.fileType)) {
    return "Review as a possible duplicate recording";
  }

  if (isVideoFileType(file.fileType)) {
    return "Review as a possible duplicate video";
  }

  if (isImageFileType(file.fileType)) {
    return "Review as a possible duplicate image";
  }

  return "Review as a possible duplicate";
}

function suggestionKeyFor(file: DuplicateCandidate) {
  return createHash("sha256")
    .update(
      [
        file.id,
        "POSSIBLE_DUPLICATE",
        file.relativePath,
        "",
        "",
        duplicateTitleFor(file),
      ].join("\u001f"),
    )
    .digest("hex");
}

function duplicateTargetFor(file: DuplicateCandidate, group: DuplicateCandidate[]) {
  return group
    .filter((candidate) => candidate.id !== file.id)
    .sort(
      (left, right) =>
        left.scanSession.connectedFolder.displayName.localeCompare(
          right.scanSession.connectedFolder.displayName,
        ) ||
        left.relativePath.localeCompare(right.relativePath) ||
        left.id.localeCompare(right.id),
    )[0];
}

async function markAudioDuplicate(
  file: DuplicateCandidate,
  target: DuplicateCandidate,
) {
  const prisma = getPrismaClient();

  await prisma.audioRecordingMetadata.upsert({
    create: {
      audioFingerprint: null,
      bitrateKbps: null,
      channels: null,
      codec: null,
      container: formatFromFileType(file.fileType).toUpperCase(),
      duplicateConfidence: exactDuplicateConfidence,
      duplicateKind: "EXACT_DUPLICATE",
      duplicateOfScannedFileId: target.id,
      durationSeconds: null,
      humanLabels: jsonInput([]),
      machineLabels: jsonInput([]),
      privacyState: "REVIEW_REQUIRED",
      provisionalActionItems: jsonInput([]),
      provisionalPeople: jsonInput([]),
      provisionalProjects: jsonInput([]),
      provisionalQuestions: jsonInput([]),
      provisionalTopics: jsonInput([]),
      sampleRateHz: null,
      scannedFileId: file.id,
      sourceCreatedAt: file.sourceCreatedAt,
      sourceModifiedAt: file.lastModified,
      summary: "This audio file matched another scanned file exactly by checksum.",
      transcriptSnippet: null,
      transcriptionErrorCategory: null,
      transcriptionStatus: "NOT_REQUESTED",
    },
    update: {
      duplicateConfidence: exactDuplicateConfidence,
      duplicateKind: "EXACT_DUPLICATE",
      duplicateOfScannedFileId: target.id,
    },
    where: { scannedFileId: file.id },
  });
}

async function markVideoDuplicate(
  file: DuplicateCandidate,
  target: DuplicateCandidate,
) {
  const prisma = getPrismaClient();

  await prisma.videoRecordingMetadata.upsert({
    create: {
      bitrateKbps: null,
      chapterSuggestions: jsonInput([]),
      codec: null,
      container: formatFromFileType(file.fileType).toUpperCase(),
      duplicateConfidence: exactDuplicateConfidence,
      duplicateKind: "EXACT_DUPLICATE",
      duplicateOfScannedFileId: target.id,
      durationSeconds: null,
      frameAnalysisErrorCategory: null,
      frameAnalysisStatus: "NOT_REQUESTED",
      frameRate: null,
      hasAudioTrack: null,
      height: null,
      humanLabels: jsonInput([]),
      machineLabels: jsonInput([]),
      privacyState: "REVIEW_REQUIRED",
      provisionalPeople: jsonInput([]),
      provisionalProjects: jsonInput([]),
      provisionalQuestions: jsonInput([]),
      provisionalTopics: jsonInput([]),
      relatedSignals: jsonInput([]),
      scannedFileId: file.id,
      selectedFrameDescriptions: jsonInput([]),
      sourceCreatedAt: file.sourceCreatedAt,
      sourceModifiedAt: file.lastModified,
      summary: "This video file matched another scanned file exactly by checksum.",
      transcriptSnippet: null,
      transcriptionErrorCategory: null,
      transcriptionStatus: "NOT_REQUESTED",
      videoFingerprint: null,
      width: null,
    },
    update: {
      duplicateConfidence: exactDuplicateConfidence,
      duplicateKind: "EXACT_DUPLICATE",
      duplicateOfScannedFileId: target.id,
    },
    where: { scannedFileId: file.id },
  });
}

async function markImageDuplicate(
  file: DuplicateCandidate,
  target: DuplicateCandidate,
) {
  const prisma = getPrismaClient();

  await prisma.imageAssetMetadata.upsert({
    create: {
      cameraDevice: null,
      colorProfile: null,
      duplicateConfidence: exactDuplicateConfidence,
      duplicateKind: "EXACT_DUPLICATE",
      duplicateOfScannedFileId: target.id,
      embeddedDate: null,
      format: formatFromFileType(file.fileType),
      height: null,
      humanLabels: jsonInput([]),
      imageFingerprint: null,
      machineLabels: jsonInput([]),
      ocrErrorCategory: null,
      ocrStatus: "NOT_REQUESTED",
      orientation: null,
      previewErrorCategory: null,
      previewStatus: "NOT_REQUESTED",
      privacyState: "REVIEW_REQUIRED",
      provisionalQuestions: jsonInput([]),
      provisionalTopics: jsonInput([]),
      relatedSignals: jsonInput([]),
      scannedFileId: file.id,
      sourceCreatedAt: file.sourceCreatedAt,
      sourceModifiedAt: file.lastModified,
      summary: "This image file matched another scanned file exactly by checksum.",
      textSnippet: null,
      visualAnalysisErrorCategory: null,
      visualAnalysisStatus: "NOT_REQUESTED",
      width: null,
    },
    update: {
      duplicateConfidence: exactDuplicateConfidence,
      duplicateKind: "EXACT_DUPLICATE",
      duplicateOfScannedFileId: target.id,
    },
    where: { scannedFileId: file.id },
  });
}

async function markMediaDuplicate(
  file: DuplicateCandidate,
  target: DuplicateCandidate,
) {
  if (isAudioFileType(file.fileType)) {
    await markAudioDuplicate(file, target);
    return;
  }

  if (isVideoFileType(file.fileType)) {
    await markVideoDuplicate(file, target);
    return;
  }

  if (isImageFileType(file.fileType)) {
    await markImageDuplicate(file, target);
  }
}

function duplicateSuggestionCopy(
  file: DuplicateCandidate,
  target: DuplicateCandidate,
) {
  const sameRoot =
    file.scanSession.connectedFolder.id === target.scanSession.connectedFolder.id;

  return {
    explanation:
      "The Librarian found another scanned file with matching contents. This is a review prompt only; nothing should be deleted automatically.",
    supportingInformation: [
      `Current file: ${file.relativePath}`,
      `Similar file: ${target.relativePath}`,
      sameRoot
        ? `Connected folder: ${file.scanSession.connectedFolder.displayName}`
        : `Connected folders: ${file.scanSession.connectedFolder.displayName} and ${target.scanSession.connectedFolder.displayName}`,
      "The matching signal came from scan metadata, not from an assumption about the file name.",
    ],
    title: duplicateTitleFor(file),
    whySuggested: [
      "The scanned files have the same checksum.",
      "The Bridge keeps each connected folder separate; this suggestion does not merge, move, or delete either file.",
    ],
  };
}

async function upsertDuplicateSuggestion(
  file: DuplicateCandidate,
  target: DuplicateCandidate,
) {
  const prisma = getPrismaClient();
  const copy = duplicateSuggestionCopy(file, target);

  await prisma.organizationSuggestion.upsert({
    create: {
      confidence: exactDuplicateConfidence,
      currentRelativePath: file.relativePath,
      explanation: copy.explanation,
      proposedFileName: null,
      proposedRelativePath: null,
      scanSessionId: file.sessionId,
      scannedFileId: file.id,
      status: "PENDING",
      suggestionKey: suggestionKeyFor(file),
      suggestionType: "POSSIBLE_DUPLICATE",
      supportingInformation: jsonInput(copy.supportingInformation),
      title: copy.title,
      whySuggested: jsonInput(copy.whySuggested),
    },
    update: {
      confidence: exactDuplicateConfidence,
      explanation: copy.explanation,
      supportingInformation: jsonInput(copy.supportingInformation),
      title: copy.title,
      whySuggested: jsonInput(copy.whySuggested),
    },
    where: {
      suggestionKey: suggestionKeyFor(file),
    },
  });
}

export async function recordChecksumDuplicateSuggestionsForSession(
  scanSessionId: string,
) {
  const prisma = getPrismaClient();
  const sessionFiles = await prisma.scannedFile.findMany({
    select: {
      checksum: true,
    },
    where: {
      checksum: {
        not: null,
      },
      sessionId: scanSessionId,
    },
  });
  const checksums = [
    ...new Set(
      sessionFiles
        .map((file) => file.checksum)
        .filter((checksum): checksum is string => Boolean(checksum)),
    ),
  ];

  if (checksums.length === 0) {
    return { duplicateFiles: 0, duplicateGroups: 0 };
  }

  const candidates = await prisma.scannedFile.findMany({
    orderBy: [{ checksum: "asc" }, { relativePath: "asc" }],
    select: {
      checksum: true,
      fileType: true,
      id: true,
      lastModified: true,
      relativePath: true,
      scanSession: {
        select: {
          connectedFolder: {
            select: {
              bridgeRootId: true,
              displayName: true,
              id: true,
            },
          },
        },
      },
      sessionId: true,
      sizeBytes: true,
      sourceCreatedAt: true,
    },
    where: {
      checksum: {
        in: checksums,
      },
      readStatus: {
        not: "FAILED",
      },
    },
  });
  const groups = new Map<string, DuplicateCandidate[]>();

  for (const candidate of candidates) {
    if (!candidate.checksum) {
      continue;
    }

    const group = groups.get(candidate.checksum) ?? [];

    group.push(candidate);
    groups.set(candidate.checksum, group);
  }

  let duplicateFiles = 0;
  let duplicateGroups = 0;

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }

    duplicateGroups += 1;

    for (const file of group) {
      const target = duplicateTargetFor(file, group);

      if (!target) {
        continue;
      }

      duplicateFiles += 1;
      await markMediaDuplicate(file, target);
      await upsertDuplicateSuggestion(file, target);
    }
  }

  return { duplicateFiles, duplicateGroups };
}
