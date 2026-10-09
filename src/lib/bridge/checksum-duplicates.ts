import { currentReadableRootWhere, currentReadableRootSql } from "./current-readable-root";
import { physicalFileClasses, type PhysicalIndexWork } from "./physical-file-index";
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
  connectedRootAliases,
} from "./physical-file-identity";

export type DuplicateCandidate = {
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
  return buildChecksumDuplicateTargets([...group, ...(group.some((candidate) => candidate.id === file.id) ? [] : [file])]).get(file.id);
}

export function buildChecksumDuplicateTargets(group: DuplicateCandidate[], work?: PhysicalIndexWork) {
  const classes = physicalFileClasses(group, work);
  const representatives = new Map<number, DuplicateCandidate>();
  const sorted = [...group].sort((a, b) => a.scanSession.connectedFolder.displayName.localeCompare(b.scanSession.connectedFolder.displayName)
    || a.relativePath.localeCompare(b.relativePath) || a.id.localeCompare(b.id));
  const classById = new Map(group.map((file, index) => [file.id, classes[index]]));
  for (const file of sorted) if (!representatives.has(classById.get(file.id)!)) representatives.set(classById.get(file.id)!, file);
  const presentations = new Map<string, DuplicateCandidate[]>();
  for (const file of representatives.values()) {
    const key = `${file.scanSession.connectedFolder.displayName.trim().toLowerCase()}\u0000${file.relativePath.replace(/\\/g, "/").toLowerCase()}`;
    const files = presentations.get(key) ?? [];
    if (files.length < 2) files.push(file);
    presentations.set(key, files);
  }
  const rank = new Map(sorted.map((file, index) => [file.id, index]));
  const pool = [...presentations.values()].slice(0, 3).flat().sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const targets = new Map<string, DuplicateCandidate>();
  for (const file of group) for (const candidate of pool) {
    if (work) work.targetChecks = (work.targetChecks ?? 0) + 1;
    if (candidate.id !== file.id && classById.get(candidate.id) !== classById.get(file.id) && demonstrablyDistinctPhysicalFiles(file, candidate)) {
      targets.set(file.id, candidate); break;
    }
  }
  return targets;
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

  const latestIds = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT ON (scan."connectedFolderId") scan.id FROM "ScanSession" scan
    JOIN "ConnectedFolder" root ON root.id = scan."connectedFolderId"
    WHERE scan.id <> ${session.id} AND scan.status::text = ANY(${[...reusableSnapshotStatuses]}::text[])
      AND ${currentReadableRootSql}
    ORDER BY scan."connectedFolderId", scan."completedAt" DESC, scan."startedAt" DESC, scan.id ASC
  `);
  const otherSessions: typeof session[] = [];
  for (let offset = 0; offset < latestIds.length; offset += 500) otherSessions.push(...await prisma.scanSession.findMany({
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
    where: { id: { in: latestIds.slice(offset, offset + 500).map((row) => row.id) } },
    orderBy: [{ completedAt: "desc" }, { startedAt: "desc" }, { id: "asc" }],
  }));
  // DISTINCT ON removes deep per-root history before materialization. The
  // cross-root order remains the legacy deterministic alias preference.
  const order = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM "ScanSession"
    WHERE id = ANY(${latestIds.map((row) => row.id)}::text[]) ORDER BY "completedAt" DESC, "startedAt" DESC, id ASC`);
  const rank = new Map(order.map((row, index) => [row.id, index]));
  otherSessions.sort((left, right) => rank.get(left.id)! - rank.get(right.id)!);
  const latestOtherRoots: typeof otherSessions = [];
  const rootAliases = new Set(connectedRootAliases(session.connectedFolder));

  for (const otherSession of otherSessions) {
    const aliases = connectedRootAliases(otherSession.connectedFolder);
    if ([...aliases].some((alias) => rootAliases.has(alias))) {
      continue;
    }

    latestOtherRoots.push(otherSession);
    for (const alias of aliases) rootAliases.add(alias);
  }

  return {
    sessionIds: [session.id, ...latestOtherRoots.map((item) => item.id)],
  };
}

export function collapseHistoricalPhysicalFiles(
  candidates: DuplicateCandidate[],
  currentScanSessionId: string,
  work?: PhysicalIndexWork,
) {
  const classes = physicalFileClasses(candidates, work);
  const collapsed = new Map<number, DuplicateCandidate>();
  for (const [index, candidate] of candidates.entries()) {
    const key = classes[index];
    if (!collapsed.has(key) || candidate.sessionId === currentScanSessionId) collapsed.set(key, candidate);
  }

  return [...collapsed.values()];
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

  const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM "ScannedFile" WHERE checksum = ANY(${checksums}::text[])
      AND "sessionId" = ANY(${sessionIds}::text[]) AND "readStatus" <> 'FAILED' AND "sourceUnavailableAt" IS NULL
    ORDER BY checksum, "sessionId", "relativePath", id
  `);
  const candidates: DuplicateCandidate[] = [];
  for (let offset = 0; offset < ids.length; offset += 500) candidates.push(...await prisma.scannedFile.findMany({
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
    where: { id: { in: ids.slice(offset, offset + 500).map((row) => row.id) } },
  }));

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

export async function loadExactChecksumDuplicateIndex(scanSessionId: string) {
  const files = await getPrismaClient().scannedFile.findMany({ select: { checksum: true, sizeBytes: true }, where: { sessionId: scanSessionId, sourceUnavailableAt: null } });
  const checksums = [...new Set(files.filter(hasUsefulChecksum).map((file) => file.checksum!).filter(Boolean))];
  const candidates = await duplicateCandidatesForChecksums(scanSessionId, checksums);
  const families = new Map<string, DuplicateCandidate[]>();
  for (const file of candidates) { const family = families.get(file.checksum!) ?? []; family.push(file); families.set(file.checksum!, family); }
  const targets = new Map<string, DuplicateCandidate>();
  for (const family of families.values()) for (const [id, target] of buildChecksumDuplicateTargets(family)) targets.set(id, target);
  return targets;
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

export type DuplicatePersistenceWork = { transactions: number; files: number; maximumFilesPerTransaction: number };
const duplicatePersistencePageSize = 100;

export async function recordChecksumDuplicateSuggestionsForSession(scanSessionId: string, work?: DuplicatePersistenceWork) {
  const db = getPrismaClient();
  const root = await db.connectedLibrary.findFirst({ where: { ...currentReadableRootWhere, recommendationPermission: true, scanSessions: { some: { id: scanSessionId } } } });
  if (!root) return { duplicateFiles: 0, duplicateGroups: 0 };
  const sessionFiles = await db.scannedFile.findMany({ select: { checksum: true, sizeBytes: true }, where: { sessionId: scanSessionId, checksum: { not: null } } });
  const checksums = [...new Set(sessionFiles.filter(hasUsefulChecksum).map((file) => file.checksum!))];
  const candidates = await duplicateCandidatesForChecksums(scanSessionId, checksums);
  const groups = new Map<string, DuplicateCandidate[]>();
  for (const file of candidates) { const group = groups.get(file.checksum!) ?? []; group.push(file); groups.set(file.checksum!, group); }
  const planned: Array<{ file: DuplicateCandidate; target: DuplicateCandidate }> = [];
  for (const group of groups.values()) {
    const targets = buildChecksumDuplicateTargets(group);
    for (const file of group) { const target = targets.get(file.id); if (target) planned.push({ file, target }); }
  }
  const duplicateFileIds = new Set<string>(), duplicateChecksums = new Set<string>();
  // A library-wide transaction can always expire before committing at large N.
  // Each bounded page is independently durable; replay rechecks exact source
  // identities and preserves human decisions before filling remaining pages.
  for (let offset = 0; offset < planned.length; offset += duplicatePersistencePageSize) {
    const page = planned.slice(offset, offset + duplicatePersistencePageSize);
    const persisted = await db.$transaction(async (tx) => {
      const rootIds = [...new Set([root.id, ...page.flatMap(({ file, target }) => [file.scanSession.connectedFolder.id, target.scanSession.connectedFolder.id])])].sort();
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder" WHERE id = ANY(${rootIds}::text[]) ORDER BY id FOR SHARE`);
      if (!await tx.connectedLibrary.count({ where: { id: root.id, ...currentReadableRootWhere, recommendationPermission: true, nativeConnectionRevision: root.nativeConnectionRevision } }))
        throw new Error("Duplicate persistence root authority changed.");
      const fileIds = [...new Set(page.flatMap(({ file, target }) => [file.id, target.id]))].sort();
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "ScannedFile" WHERE id = ANY(${fileIds}::text[]) ORDER BY id FOR UPDATE`);
      const live = new Map((await tx.scannedFile.findMany({ select: { id: true, checksum: true, relativePath: true, localPath: true },
        where: { id: { in: fileIds }, sourceUnavailableAt: null, readStatus: { not: "FAILED" }, scanSession: { connectedFolder: currentReadableRootWhere } } })).map((file) => [file.id, file]));
      const same = (file: DuplicateCandidate) => { const current = live.get(file.id); return current && current.checksum === file.checksum && current.relativePath === file.relativePath && current.localPath === file.localPath; };
      const done: DuplicateCandidate[] = [];
      const proposingRoots = new Set((await tx.connectedLibrary.findMany({ select: { id: true }, where: { id: { in: rootIds }, ...currentReadableRootWhere, recommendationPermission: true } })).map((row) => row.id));
      for (const { file, target } of page) {
        if (!same(file) || !same(target)) throw new Error("Duplicate persistence file identity changed; rebuild its bounded pages.");
        if (!proposingRoots.has(file.scanSession.connectedFolder.id)) continue;
        if (await upsertDuplicateSuggestion(file, target, tx)) done.push(file);
      }
      return done;
    }, { isolationLevel: "Serializable", timeout: 120_000 });
    if (work) { work.transactions++; work.files += page.length; work.maximumFilesPerTransaction = Math.max(work.maximumFilesPerTransaction, page.length); }
    for (const file of persisted) { duplicateFileIds.add(file.id); duplicateChecksums.add(file.checksum!); }
  }
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${root.id} FOR SHARE`;
    if (!await tx.connectedLibrary.count({ where: { id: root.id, ...currentReadableRootWhere, nativeConnectionRevision: root.nativeConnectionRevision } }))
      throw new Error("Duplicate reconciliation root authority changed.");
    await reconcileStaleExactDuplicates(scanSessionId, duplicateFileIds, tx);
  }, { isolationLevel: "Serializable", timeout: 120_000 });
  return { duplicateFiles: duplicateFileIds.size, duplicateGroups: duplicateChecksums.size };
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

  const stale = (await prisma.organizationSuggestion.findMany({ select: { id: true, scannedFileId: true }, where: staleSuggestionWhere }))
    .filter((row) => !duplicateFileIds.has(row.scannedFileId));
  for (let offset = 0; offset < stale.length; offset += 500) await prisma.organizationSuggestion.updateMany({ data: {
    invalidatedAt: new Date(), invalidatedReason: "The current scan snapshot no longer supports this exact duplicate recommendation.",
  }, where: { id: { in: stale.slice(offset, offset + 500).map((row) => row.id) }, invalidatedAt: null } });
  // Pending bootstrap diagnostics retain the existing recheck presentation.
  // Reviewed decisions and full generation history are never rewritten.
  for (let offset = 0; offset < stale.length; offset += 500) await prisma.organizationSuggestion.updateMany({ data: {
    confidence: 0.35,
    suggestionType: "KEEP_UNCHANGED",
    title: "No exact duplicate after recheck",
    explanation: "The Librarian rechecked this item against the current scan snapshot and no longer found a useful exact duplicate. Same physical files seen in older scans are not treated as duplicates.",
    supportingInformation: jsonInput(recommendationSupportForStorage({ alternatives: [], duplicateEvidence: [], requiredFolderPaths: [],
      supportingInformation: ["Exact duplicate metadata was rechecked using connected-library identity and relative path.", "No physical files were changed."] })),
    whySuggested: jsonInput(["The earlier checksum match appears to have represented the same physical file from an older scan, or a zero-byte file without useful duplicate value."]),
  }, where: { id: { in: stale.slice(offset, offset + 500).map((item) => item.id) }, status: "PENDING", recommendationGenerationId: { startsWith: "checksum-duplicates-" } } });
  await disputePreferencesFromDecisions(stale.map((item) => item.id), prisma);

  const staleFiles = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM "ScannedFile"
    WHERE "sessionId" = ${scanSessionId} AND NOT (id = ANY(${[...duplicateFileIds]}::text[])) ORDER BY id`);
  for (let offset = 0; offset < staleFiles.length; offset += 500) {
    const staleScannedFileWhere: Prisma.ScannedFileWhereInput = { id: { in: staleFiles.slice(offset, offset + 500).map((row) => row.id) } };
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
}
