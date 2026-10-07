import { currentReadableRootWhere, currentReadableRootSql } from "./current-readable-root";
import { disputePreferencesFromDecisions } from "@/lib/library/organization-preferences";
import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";

import { currentRecommendationGenerationVersion } from "./recommendation-generation";
import { recommendationSupportForStorage } from "./recommendation-reconciliation";
import { isImageFileType } from "./media-kind";
import { isAudioFileType } from "./audio-metadata";
import { isVideoFileType } from "./video-metadata";
import {
  demonstrablyDistinctPhysicalFiles,
  samePhysicalFile,
  samePhysicalRoot,
} from "./physical-file-identity";

type DuplicateCandidate = {
  checksum: string | null;
  fileType: string;
  id: string;
  lastModified: Date | null;
  localPath: string;
  relativePath: string;
  sessionId: string;
  sizeBytes: bigint | null;
  sourceCreatedAt: Date | null;
  scanSession: {
    connectedFolder: {
      bridgeRootId: string | null;
      canonicalConnectedLibraryId: string | null;
      displayName: string;
      folderFingerprint: string | null;
      id: string;
      localPath: string;
      platform: string;
    };
  };
};

const exactDuplicateConfidence = 0.98;
const reusableSnapshotStatuses = [
  "READING",
  "EXAMINING",
  "GENERATING_SUGGESTIONS",
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
] as const;

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function hasUsefulChecksum(file: Pick<DuplicateCandidate, "checksum" | "sizeBytes">) {
  return Boolean(file.checksum?.trim()) && file.sizeBytes !== BigInt(0);
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
    .filter(
      (candidate) =>
        candidate.id !== file.id &&
        demonstrablyDistinctPhysicalFiles(candidate, file),
    )
    .sort(
      (left, right) =>
        left.scanSession.connectedFolder.displayName.localeCompare(
          right.scanSession.connectedFolder.displayName,
        ) ||
        left.relativePath.localeCompare(right.relativePath) ||
        left.id.localeCompare(right.id),
    )[0];
}

async function comparableSessionIdsFor(scanSessionId: string, tx?: Prisma.TransactionClient) {
  const prisma = tx ?? getPrismaClient();
  const session = await prisma.scanSession.findFirst({
    select: {
      connectedFolder: {
        select: {
          bridgeRootId: true,
          canonicalConnectedLibraryId: true,
          displayName: true,
          folderFingerprint: true,
          id: true,
          localPath: true,
          platform: true,
        },
      },
      id: true,
    },
    where: {
      id: scanSessionId, connectedFolder: currentReadableRootWhere,
    },
  });

  if (!session) {
    return {
      sessionIds: [] as string[],
    };
  }

  const otherSessions = await prisma.scanSession.findMany({
    orderBy: [
      { completedAt: "desc" },
      { startedAt: "desc" },
      { id: "asc" },
    ],
    select: {
      connectedFolder: {
        select: {
          bridgeRootId: true,
          canonicalConnectedLibraryId: true,
          displayName: true,
          folderFingerprint: true,
          id: true,
          localPath: true,
          platform: true,
        },
      },
      id: true,
    },
    where: {
      connectedFolder: currentReadableRootWhere,
      id: {
        not: session.id,
      },
      status: {
        in: [...reusableSnapshotStatuses],
      },
    },
  });
  const latestOtherRoots: typeof otherSessions = [];

  for (const otherSession of otherSessions) {
    if (
      samePhysicalRoot(
        session.connectedFolder,
        otherSession.connectedFolder,
      ) ||
      latestOtherRoots.some((latest) =>
        samePhysicalRoot(
          latest.connectedFolder,
          otherSession.connectedFolder,
        ),
      )
    ) {
      continue;
    }

    latestOtherRoots.push(otherSession);
  }

  return {
    sessionIds: [session.id, ...latestOtherRoots.map((item) => item.id)],
  };
}

function collapseHistoricalPhysicalFiles(
  candidates: DuplicateCandidate[],
  currentScanSessionId: string,
) {
  const collapsed: DuplicateCandidate[] = [];

  for (const candidate of candidates) {
    const existingIndex = collapsed.findIndex((existing) =>
      samePhysicalFile(existing, candidate),
    );

    if (existingIndex === -1) {
      collapsed.push(candidate);
    } else if (candidate.sessionId === currentScanSessionId) {
      collapsed[existingIndex] = candidate;
    }
  }

  return collapsed;
}

async function duplicateCandidatesForChecksums(
  scanSessionId: string,
  checksums: string[],
  tx?: Prisma.TransactionClient,
) {
  const prisma = tx ?? getPrismaClient();
  const { sessionIds } = await comparableSessionIdsFor(scanSessionId, tx);

  if (sessionIds.length === 0 || checksums.length === 0) {
    return [];
  }

  const candidates = await prisma.scannedFile.findMany({
    orderBy: [
      { checksum: "asc" },
      { sessionId: "asc" },
      { relativePath: "asc" },
    ],
    select: {
      checksum: true,
      fileType: true,
      id: true,
      lastModified: true,
      localPath: true,
      relativePath: true,
      scanSession: {
        select: {
          connectedFolder: {
            select: {
              bridgeRootId: true,
              canonicalConnectedLibraryId: true,
              displayName: true,
              folderFingerprint: true,
              id: true,
              localPath: true,
              platform: true,
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
      sessionId: {
        in: sessionIds,
      },
    },
  });

  return collapseHistoricalPhysicalFiles(
    candidates.filter(hasUsefulChecksum),
    scanSessionId,
  );
}

export async function distinctPhysicalScannedFileIds(
  scannedFileId: string,
  candidateIds: string[],
) {
  const uniqueCandidateIds = [
    ...new Set(candidateIds.filter((id) => id && id !== scannedFileId)),
  ];

  if (uniqueCandidateIds.length === 0) {
    return new Set<string>();
  }

  const prisma = getPrismaClient();
  const files = await prisma.scannedFile.findMany({
    select: {
      id: true,
      localPath: true,
      relativePath: true,
      scanSession: {
        select: {
          connectedFolder: {
            select: {
              bridgeRootId: true,
              canonicalConnectedLibraryId: true,
              displayName: true,
              folderFingerprint: true,
              id: true,
              localPath: true,
              platform: true,
            },
          },
        },
      },
    },
    where: {
      id: { in: [scannedFileId, ...uniqueCandidateIds] },
    },
  });
  const source = files.find((file) => file.id === scannedFileId);

  if (!source) {
    return new Set<string>();
  }

  return new Set(
    files
      .filter(
        (candidate) =>
          candidate.id !== source.id &&
          demonstrablyDistinctPhysicalFiles(source, candidate),
      )
      .map((candidate) => candidate.id),
  );
}

export async function findExactChecksumDuplicateForScannedFile(
  scannedFileId: string,
) {
  const prisma = getPrismaClient();
  const file = await prisma.scannedFile.findUnique({
    select: {
      checksum: true,
      fileType: true,
      id: true,
      lastModified: true,
      localPath: true,
      relativePath: true,
      scanSession: {
        select: {
          connectedFolder: {
            select: {
              bridgeRootId: true,
              canonicalConnectedLibraryId: true,
              displayName: true,
              folderFingerprint: true,
              id: true,
              localPath: true,
              platform: true,
            },
          },
        },
      },
      sessionId: true,
      sizeBytes: true,
      sourceCreatedAt: true,
    },
    where: {
      id: scannedFileId,
    },
  });

  if (!file || !hasUsefulChecksum(file)) {
    return null;
  }

  const candidates = await duplicateCandidatesForChecksums(file.sessionId, [
    file.checksum as string,
  ]);
  const group = candidates.filter(
    (candidate) => candidate.checksum === file.checksum,
  );

  return duplicateTargetFor(file, group) ?? null;
}

async function markAudioDuplicate(
  file: DuplicateCandidate,
  target: DuplicateCandidate,
  prisma: Prisma.TransactionClient,
) {

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
  prisma: Prisma.TransactionClient,
) {

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
  prisma: Prisma.TransactionClient,
) {

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
  prisma: Prisma.TransactionClient,
) {
  if (!demonstrablyDistinctPhysicalFiles(file, target)) {
    return;
  }

  if (isAudioFileType(file.fileType)) {
    await markAudioDuplicate(file, target, prisma);
    return;
  }

  if (isVideoFileType(file.fileType)) {
    await markVideoDuplicate(file, target, prisma);
    return;
  }

  if (isImageFileType(file.fileType)) {
    await markImageDuplicate(file, target, prisma);
  }
}

function duplicateSuggestionCopy(
  file: DuplicateCandidate,
  target: DuplicateCandidate,
) {
  const sameRoot =
    file.scanSession.connectedFolder.id === target.scanSession.connectedFolder.id;

  return {
    duplicateEvidence: [
      {
        connectedLibraryName: target.scanSession.connectedFolder.displayName,
        relativePath: target.relativePath,
        signals: [
          "Exact content match: the non-empty files have the same checksum.",
          ...(file.sizeBytes !== null && file.sizeBytes === target.sizeBytes
            ? [`Matching file size: ${file.sizeBytes.toString()} bytes.`]
            : []),
        ],
      },
    ],
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
  prisma: Prisma.TransactionClient,
) {
  if (!demonstrablyDistinctPhysicalFiles(file, target)) {
    return false;
  }

  // The no-op parent write is a durable per-file serialization fence shared
  // with normal generation. A Serializable stale snapshot fails on a changed
  // row rather than creating a second current batch after another writer.
  await prisma.$executeRaw(Prisma.sql`UPDATE "ScannedFile" SET id = id WHERE id = ${file.id}`);
  const active = await prisma.organizationSuggestion.findMany({ where: {
    scannedFileId: file.id, invalidatedAt: null, recommendationGenerationVersion: currentRecommendationGenerationVersion,
  } });
  if (active.some((item) => !item.recommendationGenerationId.startsWith("checksum-duplicates-") || item.status !== "PENDING")) return true;
  const history = await prisma.organizationSuggestion.findFirst({ select: { id: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], where: { scannedFileId: file.id, invalidatedAt: { not: null },
      recommendationGenerationId: { startsWith: "checksum-duplicates-" } } });
  const key = active[0]?.suggestionKey ?? (history ? `${suggestionKeyFor(file)}:${history.id}` : suggestionKeyFor(file));
  await markMediaDuplicate(file, target, prisma);
  const copy = duplicateSuggestionCopy(file, target);
  const recommendationGenerationId = `checksum-duplicates-${file.sessionId}`;

  await prisma.organizationSuggestion.upsert({
    create: {
      confidence: exactDuplicateConfidence,
      currentRelativePath: file.relativePath,
      explanation: copy.explanation,
      invalidatedAt: null,
      invalidatedReason: null,
      proposedFileName: null,
      proposedRelativePath: null,
      recommendationGenerationId,
      recommendationGenerationVersion: currentRecommendationGenerationVersion,
      scanSessionId: file.sessionId,
      scannedFileId: file.id,
      status: "PENDING",
      suggestionKey: key,
      suggestionType: "POSSIBLE_DUPLICATE",
      supportingInformation: jsonInput(
        recommendationSupportForStorage({
          alternatives: [],
          duplicateEvidence: copy.duplicateEvidence,
          requiredFolderPaths: [],
          supportingInformation: copy.supportingInformation,
        }),
      ),
      title: copy.title,
      whySuggested: jsonInput(copy.whySuggested),
    },
    update: {
      confidence: exactDuplicateConfidence,
      explanation: copy.explanation,
      recommendationGenerationId,
      recommendationGenerationVersion: currentRecommendationGenerationVersion,
      supportingInformation: jsonInput(
        recommendationSupportForStorage({
          alternatives: [],
          duplicateEvidence: copy.duplicateEvidence,
          requiredFolderPaths: [],
          supportingInformation: copy.supportingInformation,
        }),
      ),
      title: copy.title,
      whySuggested: jsonInput(copy.whySuggested),
    },
    where: {
      suggestionKey: key,
    },
  });

  return true;
}

export async function recordChecksumDuplicateSuggestionsForSession(
  scanSessionId: string,
) {
  return getPrismaClient().$transaction(async (prisma) => {
  const [root] = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT root.id FROM "ConnectedFolder" root JOIN "ScanSession" scan ON scan."connectedFolderId" = root.id
    WHERE scan.id = ${scanSessionId} AND ${currentReadableRootSql} FOR SHARE OF root
  `);
  if (!root) return { duplicateFiles: 0, duplicateGroups: 0 };
  const sessionFiles = await prisma.scannedFile.findMany({
    select: {
      checksum: true,
      sizeBytes: true,
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
        .filter(hasUsefulChecksum)
        .map((file) => file.checksum)
        .filter((checksum): checksum is string => Boolean(checksum)),
    ),
  ];

  if (checksums.length === 0) {
    await reconcileStaleExactDuplicates(scanSessionId, new Set(), prisma);
    return { duplicateFiles: 0, duplicateGroups: 0 };
  }

  const candidates = await duplicateCandidatesForChecksums(scanSessionId, checksums, prisma);
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
  const duplicateFileIds = new Set<string>();

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }

    let groupHasDistinctFiles = false;

    for (const file of group) {
      const target = duplicateTargetFor(file, group);

      if (!target) {
        continue;
      }

      const persisted = await upsertDuplicateSuggestion(file, target, prisma);

      if (!persisted) {
        continue;
      }

      duplicateFiles += 1;
      duplicateFileIds.add(file.id);
      groupHasDistinctFiles = true;
    }

    if (groupHasDistinctFiles) {
      duplicateGroups += 1;
    }
  }

  await reconcileStaleExactDuplicates(scanSessionId, duplicateFileIds, prisma);

  return { duplicateFiles, duplicateGroups };
  }, { isolationLevel: "Serializable", timeout: 120_000 });
}

async function reconcileStaleExactDuplicates(
  scanSessionId: string,
  duplicateFileIds: Set<string>,
  prisma: Prisma.TransactionClient,
) {
  const staleSuggestionWhere: Prisma.OrganizationSuggestionWhereInput = {
    scanSessionId,
    suggestionType: "POSSIBLE_DUPLICATE",
    invalidatedAt: null,
    confidence: {
      gte: exactDuplicateConfidence,
    },
  };

  if (duplicateFileIds.size > 0) {
    staleSuggestionWhere.scannedFileId = {
      notIn: [...duplicateFileIds],
    };
  }

  const stale = await prisma.organizationSuggestion.findMany({ select: { id: true }, where: staleSuggestionWhere });
  await prisma.organizationSuggestion.updateMany({ data: {
    invalidatedAt: new Date(), invalidatedReason: "The current scan snapshot no longer supports this exact duplicate recommendation.",
  }, where: staleSuggestionWhere });
  // Pending bootstrap diagnostics retain the existing recheck presentation.
  // Reviewed decisions and full generation history are never rewritten.
  await prisma.organizationSuggestion.updateMany({ data: {
    confidence: 0.35,
    suggestionType: "KEEP_UNCHANGED",
    title: "No exact duplicate after recheck",
    explanation: "The Librarian rechecked this item against the current scan snapshot and no longer found a useful exact duplicate. Same physical files seen in older scans are not treated as duplicates.",
    supportingInformation: jsonInput(recommendationSupportForStorage({ alternatives: [], duplicateEvidence: [], requiredFolderPaths: [],
      supportingInformation: ["Exact duplicate metadata was rechecked using connected-library identity and relative path.", "No physical files were changed."] })),
    whySuggested: jsonInput(["The earlier checksum match appears to have represented the same physical file from an older scan, or a zero-byte file without useful duplicate value."]),
  }, where: { id: { in: stale.map((item) => item.id) }, status: "PENDING", recommendationGenerationId: { startsWith: "checksum-duplicates-" } } });
  await disputePreferencesFromDecisions(stale.map((item) => item.id), prisma);

  const staleScannedFileWhere: Prisma.ScannedFileWhereInput = {
    sessionId: scanSessionId,
  };

  if (duplicateFileIds.size > 0) {
    staleScannedFileWhere.id = {
      notIn: [...duplicateFileIds],
    };
  }

  await prisma.audioRecordingMetadata.updateMany({
    data: {
      duplicateConfidence: null,
      duplicateKind: null,
      duplicateOfScannedFileId: null,
    },
    where: {
      duplicateKind: "EXACT_DUPLICATE",
      scannedFile: staleScannedFileWhere,
    },
  });
  await prisma.imageAssetMetadata.updateMany({
    data: {
      duplicateConfidence: null,
      duplicateKind: null,
      duplicateOfScannedFileId: null,
    },
    where: {
      duplicateKind: "EXACT_DUPLICATE",
      scannedFile: staleScannedFileWhere,
    },
  });
  await prisma.videoRecordingMetadata.updateMany({
    data: {
      duplicateConfidence: null,
      duplicateKind: null,
      duplicateOfScannedFileId: null,
    },
    where: {
      duplicateKind: "EXACT_DUPLICATE",
      scannedFile: staleScannedFileWhere,
    },
  });
}
