import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma } from "@prisma/client";
import { verifiedSourceExcerpts } from "@/lib/ai/source-evidence";

import { getPrismaClient } from "@/lib/db/prisma";

import { compareDocumentVersions, documentSignalVersion, extractDocumentSignals } from "./document-signals";
import { normalizePhysicalRelativePath } from "./physical-file-identity";
import { loadScanWorkingKnowledge, observationSourceEvidenceText, type ScanWorkingKnowledgeIndex } from "./scan-working-knowledge";

export const relationshipGenerationVersion = "scan-relationships-v1";
export const humanIdentityCorrectionVersion = "human-identity-correction-v1";
const maxRelationshipsPerFile = 3;
const resolvedSignalKinds = ["CLIENT", "PERSON", "ORGANIZATION", "PROJECT", "WORKSHOP", "DOCUMENT_FAMILY"];

export const usableScanSnapshotWhere = {
  status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] },
} satisfies Prisma.ScanSessionWhereInput;

type EffectiveIdentitySignal = {
  checksum: string;
  connectedLibraryId: string;
  fileKey: string;
  identityHash: string;
  kind: string;
};

type EffectiveIdentityCorrection = {
  id: string;
  relationshipKind: string | null;
  sourceChecksum: string | null;
  sourceEvidence: Prisma.JsonValue | null;
  sourceFileKey: string | null;
  targetChecksum: string | null;
  targetFileKey: string | null;
};

/** Resolve human identity joins as ordered equivalence classes, not one-hop aliases. */
function correctedClientIdentities(
  rows: EffectiveIdentitySignal[],
  corrections: EffectiveIdentityCorrection[],
  separatedPairs: Set<string> = new Set(),
) {
  const clientRows = rows.filter((row) => ["CLIENT", "UNRESOLVED_CLIENT"].includes(row.kind));
  const endpointKey = (row: Pick<EffectiveIdentitySignal, "fileKey" | "checksum">) =>
    `${row.fileKey}\0${row.checksum}`;
  const byEndpoint = new Map(clientRows.map((row) => [endpointKey(row), row]));
  const parent = new Map(clientRows.map((row) => [endpointKey(row), endpointKey(row)]));
  const members = new Map(clientRows.map((row) => [endpointKey(row), new Set([endpointKey(row)])]));
  const canonical = new Map(clientRows.map((row) => [endpointKey(row), row.identityHash]));
  const find = (key: string): string => {
    const next = parent.get(key);
    if (!next || next === key) return key;
    const root = find(next);
    parent.set(key, root);
    return root;
  };

  for (const correction of corrections) {
    if (correction.relationshipKind !== "SAME_CLIENT" || !correction.sourceFileKey || !correction.sourceChecksum ||
        !correction.targetFileKey || !correction.targetChecksum) continue;
    const source = byEndpoint.get(`${correction.sourceFileKey}\0${correction.sourceChecksum}`);
    const target = byEndpoint.get(`${correction.targetFileKey}\0${correction.targetChecksum}`);
    const evidence = correction.sourceEvidence;
    if (!source || !target || source.connectedLibraryId !== target.connectedLibraryId ||
        !evidence || Array.isArray(evidence) || typeof evidence !== "object" ||
        evidence.connectedLibraryId !== source.connectedLibraryId || typeof evidence.identityHash !== "string") continue;
    const sourceRoot = find(endpointKey(source));
    const targetRoot = find(endpointKey(target));
    const targetIdentity = canonical.get(targetRoot) ?? target.identityHash;
    // Older rows stored the target's raw hash; newer rows store its effective canonical hash.
    if (evidence.identityHash !== target.identityHash && evidence.identityHash !== targetIdentity) continue;
    if (sourceRoot === targetRoot) continue;
    const sourceMembers = members.get(sourceRoot) ?? new Set([endpointKey(source)]);
    const targetMembers = members.get(targetRoot) ?? new Set([endpointKey(target)]);
    if ([...sourceMembers].some((sourceKey) => [...targetMembers].some((targetKey) => {
      const sourceRow = byEndpoint.get(sourceKey);
      const targetRow = byEndpoint.get(targetKey);
      return sourceRow && targetRow && separatedPairs.has(knowledgeRelationshipPairKey(sourceRow, targetRow));
    }))) continue;
    for (const key of sourceMembers) {
      parent.set(key, targetRoot);
      targetMembers.add(key);
    }
    members.set(targetRoot, targetMembers);
    members.delete(sourceRoot);
    canonical.set(targetRoot, targetIdentity);
    canonical.delete(sourceRoot);
  }

  const result = new Map<string, string>();
  for (const [root, group] of members) {
    if (group.size < 2) continue;
    const identity = canonical.get(find(root));
    if (identity) for (const endpoint of group) result.set(endpoint, identity);
  }
  return result;
}

export async function getDocumentVersionSignals(entries: Array<{
  connectedLibraryId: string; fileKey: string; checksum: string; isCurrent: boolean;
}>, includeHistory: boolean) {
  if (!entries.length) return [];
  const prisma = getPrismaClient();
  const signals = await prisma.knowledgeDocumentSignal.findMany({
    take: 240, orderBy: [{ status: "asc" }, { id: "asc" }],
    where: { kind: "DOCUMENT_FAMILY", generationVersion: documentSignalVersion,
      OR: entries.map((entry) => ({
        connectedLibraryId: entry.connectedLibraryId, fileKey: entry.fileKey, checksum: entry.checksum,
        OR: [{ status: "ACTIVE", supersededAt: null },
          ...(includeHistory && !entry.isCurrent ? [{ status: "SUPERSEDED" }] : [])],
      })),
    },
  });
  const observations = await prisma.observationSession.findMany({
    where: { id: { in: signals.map((signal) => signal.observationSessionId) } },
    select: { id: true, status: true, humanDecisions: {
      where: { decisionType: "MODIFY" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1,
      select: { editedSuggestion: true },
    } },
  });
  const byObservation = new Map(observations.map((observation) => [observation.id, observation]));
  return signals.filter((signal) => {
    const observation = byObservation.get(signal.observationSessionId);
    if (!observation || observation.status === "REJECTED") return false;
    if (signal.status === "ACTIVE") return true;
    // Historical revisions are useful; superseded human-corrected claims are not.
    if (signals.some((current) => current.status === "ACTIVE" &&
        current.connectedLibraryId === signal.connectedLibraryId &&
        current.fileKey === signal.fileKey && current.checksum === signal.checksum)) return false;
    return observation.status !== "MODIFIED" || extractDocumentSignals(
      observation.humanDecisions[0]?.editedSuggestion ?? "", signal.connectedLibraryId,
    ).some((corrected) => corrected.kind === "DOCUMENT_FAMILY" && corrected.identityHash === signal.identityHash);
  });
}

export type KnowledgeRelationshipPairEntry = {
  fileKey: string;
  checksum: string;
};

export function knowledgeRelationshipPairKey(
  left: KnowledgeRelationshipPairEntry,
  right: KnowledgeRelationshipPairEntry,
) {
  return [`${left.fileKey}\0${left.checksum}`, `${right.fileKey}\0${right.checksum}`]
    .sort()
    .join("\0");
}

export async function getSeparatedRelationshipPairIdentities(
  entries: KnowledgeRelationshipPairEntry[],
  relationshipKinds: string[],
) {
  const separated = new Map<string, Set<string>>();
  if (!entries.length || !relationshipKinds.length) return separated;

  const prisma = getPrismaClient();
  const endpointKeys = new Set(entries.map((entry) => `${entry.fileKey}\0${entry.checksum}`));
  const fileKeys = [...new Set(entries.map((entry) => entry.fileKey))];
  const rows = await prisma.knowledgeConnection.findMany({
    select: {
      sourceChecksum: true,
      sourceEvidence: true,
      sourceFileKey: true,
      targetChecksum: true,
      targetFileKey: true,
    },
    where: {
      decisions: { some: { action: "SEPARATE", nextStatus: "REJECTED" } },
      generationVersion: documentSignalVersion,
      relationshipKind: { in: relationshipKinds },
      sourceFileKey: { in: fileKeys },
      status: "REJECTED",
      supersededAt: null,
      targetFileKey: { in: fileKeys },
    },
  });

  for (const row of rows) {
    if (!row.sourceFileKey || !row.sourceChecksum || !row.targetFileKey || !row.targetChecksum ||
        !endpointKeys.has(`${row.sourceFileKey}\0${row.sourceChecksum}`) ||
        !endpointKeys.has(`${row.targetFileKey}\0${row.targetChecksum}`)) continue;
    const pairKey = knowledgeRelationshipPairKey(
      { fileKey: row.sourceFileKey, checksum: row.sourceChecksum },
      { fileKey: row.targetFileKey, checksum: row.targetChecksum },
    );
    const evidence = row.sourceEvidence;
    const identityHash = evidence && !Array.isArray(evidence) && typeof evidence === "object" &&
      typeof evidence.identityHash === "string" ? evidence.identityHash : null;
    const identities = separated.get(pairKey) ?? new Set<string>();
    if (identityHash) identities.add(identityHash);
    separated.set(pairKey, identities);
  }

  return separated;
}

export async function reconcileObservationKnowledge(tx: Prisma.TransactionClient, observationSessionId: string) {
  const observation = await tx.observationSession.findUnique({
    select: { status: true, observerType: true, observations: true, humanDecisions: {
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { decisionType: true, editedSuggestion: true },
    } },
    where: { id: observationSessionId },
  });
  if (!observation || !["REJECTED", "MODIFIED", "APPROVED"].includes(observation.status)) return;
  if (observation.status === "APPROVED" && !observation.humanDecisions.some((decision) =>
    decision.decisionType === "REJECT" || decision.decisionType === "MODIFY")) return;
  const rows = await tx.knowledgeDocumentSignal.findMany({ where: { observationSessionId } });
  const evidence = observation.status === "APPROVED"
    ? observationSourceEvidenceText(observation)
    : observation.status === "MODIFIED" ? observation.humanDecisions.find((decision) =>
      decision.decisionType === "MODIFY")?.editedSuggestion ?? "" : "";
  const anchors = rows.filter((row) => row.kind === "FILE_ANCHOR" && row.status === "ACTIVE" && !row.supersededAt);
  const sources = [...new Map((anchors.length ? anchors : rows.filter((row) => row.status === "ACTIVE" && !row.supersededAt))
    .map((row) => [`${row.fileKey}:${row.checksum}`, row])).values()];
  const replacements = sources.flatMap((row) => extractDocumentSignals(evidence, row.connectedLibraryId).map((signal) => ({
    ...signal, sourceRanges: observation.status === "APPROVED" ? signal.sourceRanges : [], connectedLibraryId: row.connectedLibraryId,
    fileKey: row.fileKey, checksum: row.checksum, relativePath: row.relativePath,
    observationSessionId,
    signalKey: digest([documentSignalVersion, row.fileKey, row.checksum, signal.kind, signal.identityHash].join("\0")),
  })));
  await tx.knowledgeDocumentSignal.updateMany({
    data: { status: "SUPERSEDED", supersededAt: new Date() },
    where: { observationSessionId, status: "ACTIVE", kind: { not: "FILE_ANCHOR" },
      signalKey: { notIn: replacements.map((signal) => signal.signalKey) } },
  });
  for (const signal of replacements) {
    await tx.knowledgeDocumentSignal.upsert({
      create: { ...signal, generationVersion: documentSignalVersion },
      update: { status: "ACTIVE", supersededAt: null, sourceRanges: signal.sourceRanges },
      where: { signalKey: signal.signalKey },
    });
  }
  if (observation.status === "APPROVED") return;
  // Retain decisions and confirmed history; retire only claims derived from the reviewed observation.
  const affected = {
    supersededAt: null,
    AND: [
      { OR: [{ sourceObservationSessionId: observationSessionId }, { targetObservationSessionId: observationSessionId }] },
      { OR: [{ generationVersion: null }, { generationVersion: { not: humanIdentityCorrectionVersion } }] },
    ],
  };
  await tx.knowledgeConnection.updateMany({
    data: { status: "ARCHIVED", supersededAt: new Date() }, where: { ...affected, status: "NEW" },
  });
  await tx.knowledgeConnection.updateMany({
    data: { supersededAt: new Date() }, where: { ...affected, status: "CONFIRMED" },
  });
}

export async function refreshApprovedObservationRelationships(observationSessionId: string) {
  const prisma = getPrismaClient();
  const observation = await prisma.observationSession.findUnique({
    select: { libraryDocumentId: true }, where: { id: observationSessionId },
  });
  if (!observation) return;
  const files = await prisma.scannedFile.findMany({
    select: { sessionId: true, scanSession: { select: { connectedFolderId: true } } },
    where: { libraryDocumentId: observation.libraryDocumentId, scanSession: {
      ...usableScanSnapshotWhere,
      connectedFolder: { isEnabled: true, readPermission: true, status: "CONNECTED",
        disconnectedAt: null, hiddenFromActiveListAt: null, mergedAt: null, canonicalConnectedLibraryId: null },
    } },
  });
  const latestByRoot = new Map<string, string>();
  for (const file of files) {
    if (latestByRoot.has(file.scanSession.connectedFolderId)) continue;
    const latest = await prisma.scanSession.findFirst({
      orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { id: true },
      where: { ...usableScanSnapshotWhere, connectedFolderId: file.scanSession.connectedFolderId },
    });
    if (latest && files.some((item) => item.sessionId === latest.id)) {
      latestByRoot.set(file.scanSession.connectedFolderId, latest.id);
    }
  }
  for (const sessionId of latestByRoot.values()) {
    await persistScanWorkingKnowledge(await loadScanWorkingKnowledge(sessionId));
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function persistentFileKey(libraryId: string, relativePath: string) {
  return digest(`${libraryId}\0${normalizePhysicalRelativePath(relativePath)}`);
}

export type ExecutedMoveAlias = {
  checksum: string | null;
  destinationRelativePath: string;
  sourceRelativePath: string;
  undone: boolean;
};

export function fileKeyAfterKnownMoves(
  libraryId: string,
  relativePath: string,
  checksum: string | null,
  moves: ExecutedMoveAlias[],
) {
  let sourcePath = normalizePhysicalRelativePath(relativePath);
  const visited = new Set<string>();
  for (let step = 0; step < 8 && checksum && !visited.has(sourcePath); step += 1) {
    visited.add(sourcePath);
    const move = moves.find((item) =>
      !item.undone && item.checksum === checksum &&
      normalizePhysicalRelativePath(item.destinationRelativePath) === sourcePath,
    );
    if (!move) break;
    sourcePath = normalizePhysicalRelativePath(move.sourceRelativePath);
  }
  return persistentFileKey(libraryId, sourcePath);
}

export async function knownExecutedMoves(connectedLibraryId: string): Promise<ExecutedMoveAlias[]> {
  const actions = await getPrismaClient().executionAction.findMany({
    orderBy: { completedAt: "desc" },
    select: {
      destinationChecksumAfter: true,
      destinationRelativePath: true,
      sourceChecksumBefore: true,
      sourceRelativePath: true,
      undoActions: { select: { status: true } },
    },
    take: 1000,
    where: {
      actionType: { in: ["MOVE_FILE", "RENAME_FILE"] },
      executionRun: { connectedLibraryId },
      status: "COMPLETED",
    },
  });
  return actions.map((action) => ({
    checksum: action.destinationChecksumAfter ?? action.sourceChecksumBefore,
    destinationRelativePath: action.destinationRelativePath,
    sourceRelativePath: action.sourceRelativePath,
    undone: action.undoActions.some((undo) => undo.status === "COMPLETED"),
  }));
}

export function selectPersistentRelationships(index: ScanWorkingKnowledgeIndex) {
  const fileById = new Map(index.files.map((file) => [file.id, file]));
  const perFile = new Map<string, number>();

  return [...index.relationships]
    .filter((relationship) => {
      const left = fileById.get(relationship.leftFileId);
      const right = fileById.get(relationship.rightFileId);
      return Boolean(
        left && right &&
        left.normalizedIdentity !== right.normalizedIdentity &&
        left.connectedLibraryId === right.connectedLibraryId &&
        (left.semanticPreview.trim() || left.sourceEvidenceText.trim() || left.trustedObservationEvidence.length > 0) &&
        (right.semanticPreview.trim() || right.sourceEvidenceText.trim() || right.trustedObservationEvidence.length > 0) &&
        relationship.supportingTopics.length > 0 &&
        relationship.confidence >= 0.45 &&
        relationship.evidenceKinds.some((kind) =>
          kind === "CONTENT" || kind === "TRUSTED_OBSERVATION",
        ),
      );
    })
    .sort((left, right) =>
      right.confidence - left.confidence ||
      left.leftFileId.localeCompare(right.leftFileId) ||
      left.rightFileId.localeCompare(right.rightFileId),
    )
    .filter((relationship) => {
      const leftCount = perFile.get(relationship.leftFileId) ?? 0;
      const rightCount = perFile.get(relationship.rightFileId) ?? 0;
      if (leftCount >= maxRelationshipsPerFile || rightCount >= maxRelationshipsPerFile) {
        return false;
      }
      perFile.set(relationship.leftFileId, leftCount + 1);
      perFile.set(relationship.rightFileId, rightCount + 1);
      return true;
    });
}

function verifiedRanges(sourceEvidenceText: string, sharedTerms: string[]) {
  return verifiedSourceExcerpts(sourceEvidenceText)
    .filter((excerpt) => sharedTerms.some((term) => excerpt.text.toLowerCase().includes(term.toLowerCase())))
    .slice(0, 2)
    .map((excerpt) => ({ start: excerpt.start, end: excerpt.end }));
}

async function upsertCurrentRelationship(data: Prisma.KnowledgeConnectionUncheckedCreateInput & { relationshipKey: string }) {
  const prisma = getPrismaClient();
  return prisma.$transaction(async (tx) => {
    const existing = await tx.knowledgeConnection.findUnique({
      include: { decisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { nextStatus: true }, take: 1 } },
      where: { relationshipKey: data.relationshipKey },
    });
    const generated = [relationshipGenerationVersion, documentSignalVersion]
      .includes(existing?.generationVersion ?? "");
    const reactivateArchived = existing?.status === "ARCHIVED" && generated &&
      existing.decisions[0]?.nextStatus !== "REJECTED" && existing.decisions[0]?.nextStatus !== "CONFIRMED";
    const reactivateConfirmed = existing?.status === "CONFIRMED" && Boolean(existing.supersededAt) && generated &&
      existing.decisions[0]?.nextStatus !== "REJECTED";
    const reactivate = reactivateArchived || reactivateConfirmed;
    let sourceEvidence = data.sourceEvidence;
    const previous = existing?.sourceEvidence;
    if (existing && previous && !Array.isArray(previous) && typeof previous === "object" &&
        sourceEvidence && !Array.isArray(sourceEvidence) && typeof sourceEvidence === "object") {
      const { previousSnapshots, ...previousEvidence } = previous;
      const changed = reactivate || existing.sourceObservationSessionId !== data.sourceObservationSessionId ||
        existing.targetObservationSessionId !== data.targetObservationSessionId ||
        !isDeepStrictEqual(previousEvidence, sourceEvidence);
      sourceEvidence = {
        ...sourceEvidence,
        ...(previousSnapshots || changed ? { previousSnapshots: [
          ...(Array.isArray(previousSnapshots) ? previousSnapshots : []),
          ...(changed ? [{ evidence: previousEvidence, observedAt: (existing.lastSeenAt ?? existing.createdAt).toISOString(),
            ...(reactivate ? { status: existing.status, supersededAt: existing.supersededAt?.toISOString() ?? null } : {}),
            sourceObservationSessionId: existing.sourceObservationSessionId,
            targetObservationSessionId: existing.targetObservationSessionId }] : []),
        ] } : {}),
      } as Prisma.InputJsonValue;
    }
    return tx.knowledgeConnection.upsert({
      create: data,
      update: { lastSeenAt: data.lastSeenAt, sourceEvidence,
        ...(reactivate ? { status: reactivateConfirmed ? "CONFIRMED" : "NEW", supersededAt: null } : {}),
        sourceObservationSessionId: data.sourceObservationSessionId,
        targetObservationSessionId: data.targetObservationSessionId },
      where: { relationshipKey: data.relationshipKey },
    });
  }, { isolationLevel: "Serializable" });
}

export async function persistScanWorkingKnowledge(index: ScanWorkingKnowledgeIndex) {
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findUnique({
    select: {
      connectedFolderId: true,
      status: true,
      connectedFolder: { select: { isEnabled: true, readPermission: true, status: true } },
    },
    where: { id: index.scanSessionId },
  });

  if (!session || !["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(session.status) ||
      !session.connectedFolder.isEnabled || !session.connectedFolder.readPermission || session.connectedFolder.status === "DISCONNECTED") {
    return 0;
  }
  const latestSnapshot = await prisma.scanSession.findFirst({
    orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { id: true },
    where: { ...usableScanSnapshotWhere, connectedFolderId: session.connectedFolderId },
  });
  if (latestSnapshot?.id !== index.scanSessionId) return 0;

  const files = await prisma.scannedFile.findMany({
    select: {
      checksum: true,
      id: true,
      libraryDocument: {
        select: {
          observationSessions: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { id: true, status: true, humanDecisions: {
              where: { decisionType: "MODIFY" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              select: { editedSuggestion: true }, take: 1,
            } },
            take: 1,
          },
        },
      },
      relativePath: true,
    },
    where: { sessionId: index.scanSessionId },
  });
  const byId = new Map(files.map((file) => [file.id, file]));
  // A review can finish after a batch computed its index; do not republish superseded claims.
  const currentIndex = files.some((file) => ["REJECTED", "MODIFIED"].includes(file.libraryDocument?.observationSessions[0]?.status ?? ""))
    ? await loadScanWorkingKnowledge(index.scanSessionId) : index;
  const workingFileById = new Map(currentIndex.files.map((file) => [file.id, file]));
  const moves = await knownExecutedMoves(session.connectedFolderId);
  const keyFor = (file: typeof files[number]) =>
    fileKeyAfterKnownMoves(session.connectedFolderId, file.relativePath, file.checksum, moves);
  const fileKeys = files.map(keyFor);

  // A changed source invalidates provisional evidence, but historical human decisions remain.
  const prior = await prisma.knowledgeConnection.findMany({
    select: {
      generationVersion: true,
      id: true,
      relationshipKey: true,
      relationshipKind: true,
      sourceChecksum: true,
      sourceFileKey: true,
      targetChecksum: true,
      targetFileKey: true,
    },
    where: {
      relationshipKey: { not: null },
      status: { in: ["NEW", "CONFIRMED", "REJECTED"] },
      supersededAt: null,
      OR: [{ sourceFileKey: { in: fileKeys } }, { targetFileKey: { in: fileKeys } }],
    },
  });
  const checksumByKey = new Map(files.map((file) => [
    keyFor(file),
    file.checksum,
  ]));
  const fileByKey = new Map(files.map((file) => [keyFor(file), file]));
  const currentRelationships = await prisma.knowledgeConnection.findMany({ where: {
    generationVersion: { in: [relationshipGenerationVersion, documentSignalVersion, humanIdentityCorrectionVersion] },
    supersededAt: null, status: { in: ["NEW", "CONFIRMED", "REJECTED"] },
    OR: [{ sourceFileKey: { in: fileKeys } }, { targetFileKey: { in: fileKeys } }],
  } });
  for (const connection of currentRelationships) {
    const source = connection.sourceFileKey ? fileByKey.get(connection.sourceFileKey) : null;
    const target = connection.targetFileKey ? fileByKey.get(connection.targetFileKey) : null;
    const evidence = connection.sourceEvidence;
    const sourceObservationId = source?.libraryDocument?.observationSessions[0]?.id;
    const targetObservationId = target?.libraryDocument?.observationSessions[0]?.id;
    if (!connection.relationshipKey || !source || !target || !sourceObservationId || !targetObservationId ||
        source.checksum !== connection.sourceChecksum || target.checksum !== connection.targetChecksum ||
        !evidence || Array.isArray(evidence) || typeof evidence !== "object" ||
        evidence.connectedLibraryId !== session.connectedFolderId) continue;
    const currentEvidence = { ...evidence };
    delete currentEvidence.previousSnapshots;
    await upsertCurrentRelationship({ ...connection, lastSeenAt: new Date(),
      sharedTerms: connection.sharedTerms ?? Prisma.JsonNull,
      sourceObservationSessionId: sourceObservationId, targetObservationSessionId: targetObservationId,
      sourceEvidence: { ...currentEvidence, sourceRelativePath: source.relativePath,
        targetRelativePath: target.relativePath,
        ...("sourceScannedFileId" in currentEvidence ? { sourceScannedFileId: source.id } : {}),
        ...("targetScannedFileId" in currentEvidence ? { targetScannedFileId: target.id } : {}) },
      relationshipKey: connection.relationshipKey });
  }
  const supersededIds = prior.filter((connection) => {
    const sourceCurrent = connection.sourceFileKey
      ? checksumByKey.get(connection.sourceFileKey)
      : undefined;
    const targetCurrent = connection.targetFileKey
      ? checksumByKey.get(connection.targetFileKey)
      : undefined;
    return (sourceCurrent !== undefined && sourceCurrent !== connection.sourceChecksum) ||
      (targetCurrent !== undefined && targetCurrent !== connection.targetChecksum);
  }).map((connection) => connection.id);

  if (supersededIds.length > 0) {
    await prisma.knowledgeConnection.updateMany({
      data: { status: "ARCHIVED", supersededAt: new Date() },
      where: { id: { in: supersededIds }, status: "NEW" },
    });
    await prisma.knowledgeConnection.updateMany({
      data: { supersededAt: new Date() },
      where: { id: { in: supersededIds }, status: { in: ["CONFIRMED", "REJECTED"] } },
    });
  }

  let persisted = 0;
  const currentRelationshipKeys = new Set<string>();
  for (const relationship of selectPersistentRelationships(currentIndex)) {
    const left = byId.get(relationship.leftFileId);
    const right = byId.get(relationship.rightFileId);
    const leftObservationId = left?.libraryDocument?.observationSessions[0]?.id;
    const rightObservationId = right?.libraryDocument?.observationSessions[0]?.id;
    if (!left || !right || !leftObservationId || !rightObservationId ||
        left.libraryDocument?.observationSessions[0]?.status === "REJECTED" ||
        right.libraryDocument?.observationSessions[0]?.status === "REJECTED" ||
        leftObservationId === rightObservationId || !left.checksum || !right.checksum) {
      continue;
    }

    const ordered = [
      { file: left, key: keyFor(left), observationId: leftObservationId },
      { file: right, key: keyFor(right), observationId: rightObservationId },
    ].sort((a, b) => a.key.localeCompare(b.key));
    const [source, target] = ordered;
    const relationshipKey = digest([
      relationshipGenerationVersion,
      source.key, source.file.checksum,
      target.key, target.file.checksum,
      ...relationship.supportingTopics.slice().sort(),
    ].join("\0"));
    currentRelationshipKeys.add(relationshipKey);
    const evidence = {
      connectedLibraryId: session.connectedFolderId,
      evidenceKinds: relationship.evidenceKinds,
      sourceScannedFileId: source.file.id,
      sourceRelativePath: source.file.relativePath,
      sourceRanges: verifiedRanges(
        workingFileById.get(source.file.id)?.sourceEvidenceText ?? "",
        relationship.sharedTerms,
      ),
      targetScannedFileId: target.file.id,
      targetRelativePath: target.file.relativePath,
      targetRanges: verifiedRanges(
        workingFileById.get(target.file.id)?.sourceEvidenceText ?? "",
        relationship.sharedTerms,
      ),
      supportingTopics: relationship.supportingTopics,
    };
    const data = {
      confidence: relationship.confidence,
      generationVersion: relationshipGenerationVersion,
      lastSeenAt: new Date(),
      reasoning: "These files appear related through independently supported subjects. Review the source observations before drawing a conclusion.",
      relationshipKind: "RELATED_SUBJECT",
      sharedTerms: relationship.sharedTerms.slice(0, 5),
      similarityScore: relationship.confidence,
      sourceChecksum: source.file.checksum,
      sourceEvidence: evidence,
      sourceFileKey: source.key,
      targetChecksum: target.file.checksum,
      targetFileKey: target.key,
    };
    await upsertCurrentRelationship({
      ...data,
      relationshipKey,
      sourceObservationSessionId: source.observationId,
      targetObservationSessionId: target.observationId,
    });
    persisted += 1;
  }
  const signalRows = files.flatMap((file) => {
    const observation = file.libraryDocument?.observationSessions[0];
    const observationId = observation?.id;
    const workingFile = workingFileById.get(file.id);
    if (!observationId || !file.checksum || !workingFile) return [];
    const fileKey = keyFor(file);
    const extracted = observation?.status === "REJECTED" ? [] : extractDocumentSignals(
      observation?.status === "MODIFIED" ? observation.humanDecisions[0]?.editedSuggestion ?? "" : workingFile.sourceEvidenceText,
      session.connectedFolderId,
    ).map((signal) => ({ ...signal, sourceRanges: observation?.status === "MODIFIED" ? [] : signal.sourceRanges }));
    return [...extracted, {
      kind: "FILE_ANCHOR",
      identityHash: digest(`${session.connectedFolderId}\0${fileKey}`),
      supportHash: null,
      revisionNumber: null,
      revisionDate: null,
      sourceRanges: [],
    }].map((signal) => ({
      ...signal,
      fileKey,
      observationSessionId: observationId,
      relativePath: file.relativePath,
      checksum: file.checksum!,
    }));
  });
  for (let offset = 0; offset < files.length; offset += 50) {
    const changed = files.slice(offset, offset + 50).filter((file) => Boolean(file.checksum));
    if (changed.length === 0) continue;
    await prisma.knowledgeDocumentSignal.updateMany({
      data: { status: "SUPERSEDED", supersededAt: new Date() },
      where: {
        connectedLibraryId: session.connectedFolderId,
        status: "ACTIVE",
        OR: changed.map((file) => ({ fileKey: keyFor(file), checksum: { not: file.checksum! } })),
      },
    });
  }
  for (const signal of signalRows) {
    const signalKey = digest([documentSignalVersion, signal.fileKey, signal.checksum, signal.kind, signal.identityHash].join("\0"));
    await prisma.knowledgeDocumentSignal.upsert({
      create: { ...signal, signalKey, connectedLibraryId: session.connectedFolderId, generationVersion: documentSignalVersion },
      update: { lastSeenAt: new Date(), relativePath: signal.relativePath, observationSessionId: signal.observationSessionId, status: "ACTIVE", supersededAt: null },
      where: { signalKey },
    });
  }
  const currentResolved = signalRows.filter((signal) => resolvedSignalKinds.includes(signal.kind))
    .sort((left, right) =>
      resolvedSignalKinds.indexOf(left.kind) - resolvedSignalKinds.indexOf(right.kind) ||
      left.identityHash.localeCompare(right.identityHash) ||
      left.fileKey.localeCompare(right.fileKey));
  const activeCorrections = await prisma.knowledgeConnection.findMany({
    select: { relationshipKind: true, sourceChecksum: true, sourceEvidence: true, sourceFileKey: true },
    where: {
      generationVersion: humanIdentityCorrectionVersion,
      sourceFileKey: { in: fileKeys },
      status: "CONFIRMED",
      supersededAt: null,
    },
  });
  const correctedIdentityByFile = new Map<string, string>();
  for (const correction of activeCorrections) {
    const kind = correction.relationshipKind === "SAME_CLIENT" ? "CLIENT" :
      correction.relationshipKind === "BELONGS_TO_PROJECT" ? "PROJECT" : null;
    const evidence = correction.sourceEvidence;
    if (kind && correction.sourceFileKey && correction.sourceChecksum === checksumByKey.get(correction.sourceFileKey) &&
        evidence && !Array.isArray(evidence) && typeof evidence === "object" && typeof evidence.identityHash === "string") {
      correctedIdentityByFile.set(`${correction.sourceFileKey}:${kind}`, evidence.identityHash);
    }
  }
  const candidateKeys = [...new Map(currentResolved.map((signal) => [`${signal.kind}:${signal.identityHash}`, signal])).values()];
  const typedPerFile = new Map<string, number>();
  const seenPairs = new Set<string>();
  for (let offset = 0; offset < candidateKeys.length; offset += 50) {
    const candidates = await prisma.knowledgeDocumentSignal.findMany({
      orderBy: [{ kind: "asc" }, { identityHash: "asc" }, { fileKey: "asc" }],
      take: 1500,
      where: {
        connectedLibraryId: session.connectedFolderId,
        status: "ACTIVE",
        OR: candidateKeys.slice(offset, offset + 50).map((signal) => ({ kind: signal.kind, identityHash: signal.identityHash })),
      },
    });
    const byIdentity = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      if (checksumByKey.get(candidate.fileKey) !== candidate.checksum) continue;
      const key = `${candidate.kind}:${candidate.identityHash}`;
      byIdentity.set(key, [...(byIdentity.get(key) ?? []), candidate]);
    }
    for (const current of currentResolved) {
      const currentCorrection = correctedIdentityByFile.get(`${current.fileKey}:${current.kind}`);
      if (currentCorrection && currentCorrection !== current.identityHash) continue;
      const matches = byIdentity.get(`${current.kind}:${current.identityHash}`) ?? [];
      for (const other of matches) {
        const otherCorrection = correctedIdentityByFile.get(`${other.fileKey}:${other.kind}`);
        if (otherCorrection && otherCorrection !== other.identityHash) continue;
        if ((typedPerFile.get(current.fileKey) ?? 0) >= maxRelationshipsPerFile) break;
        if ((typedPerFile.get(other.fileKey) ?? 0) >= maxRelationshipsPerFile) continue;
        if (current.fileKey === other.fileKey || !other.observationSessionId || current.observationSessionId === other.observationSessionId) continue;
        if (current.kind === "DOCUMENT_FAMILY" && (current.checksum === other.checksum ||
          compareDocumentVersions(current, other) === null)) continue;
        const ordered = [current, other].sort((a, b) => a.fileKey.localeCompare(b.fileKey));
        const [source, target] = ordered;
        const kind = current.kind === "DOCUMENT_FAMILY" ? "PROBABLE_REVISION" : `SAME_${current.kind}`;
        const relationshipKey = digest([documentSignalVersion, kind, current.identityHash,
          source.fileKey, source.checksum, target.fileKey, target.checksum].join("\0"));
        if (seenPairs.has(relationshipKey)) continue;
        seenPairs.add(relationshipKey);
        currentRelationshipKeys.add(relationshipKey);
        const order = current.kind === "DOCUMENT_FAMILY" ? compareDocumentVersions(source, target) : null;
        await upsertCurrentRelationship({
          confidence: 0.75,
          generationVersion: documentSignalVersion,
          lastSeenAt: new Date(),
          reasoning: current.kind === "DOCUMENT_FAMILY"
            ? "These documents carry the same explicit document identity and different revision markers. The lineage remains provisional."
            : "These documents contain matching explicit identity markers. The proposed link remains open to human correction.",
          relationshipKey,
          relationshipKind: kind,
          sharedTerms: [],
          similarityScore: 0.75,
          sourceChecksum: source.checksum,
          sourceEvidence: {
            connectedLibraryId: session.connectedFolderId,
            evidenceKinds: ["CONTENT"],
            identityHash: current.identityHash,
            newerFileKey: order === 1 ? source.fileKey : order === -1 ? target.fileKey : null,
            sourceRanges: source.sourceRanges,
            sourceRelativePath: source.relativePath,
            supportingTopics: [current.kind.toLowerCase().replaceAll("_", " ")],
            targetRanges: target.sourceRanges,
            targetRelativePath: target.relativePath,
          },
          sourceFileKey: source.fileKey,
          sourceObservationSessionId: source.observationSessionId,
          targetChecksum: target.checksum,
          targetFileKey: target.fileKey,
          targetObservationSessionId: target.observationSessionId,
        });
        typedPerFile.set(current.fileKey, (typedPerFile.get(current.fileKey) ?? 0) + 1);
        typedPerFile.set(other.fileKey, (typedPerFile.get(other.fileKey) ?? 0) + 1);
        persisted += 1;
      }
    }
  }
  const processedExplicitFileKinds = new Set(currentResolved.map((signal) => `${signal.fileKey}:${signal.kind}`));
  const isProcessedExplicitConnection = (connection: typeof prior[number]) => {
    if (connection.generationVersion !== documentSignalVersion) return false;
    const kind = connection.relationshipKind === "PROBABLE_REVISION" ? "DOCUMENT_FAMILY"
      : connection.relationshipKind?.startsWith("SAME_") ? connection.relationshipKind.slice(5) : null;
    return Boolean(kind && (processedExplicitFileKinds.has(`${connection.sourceFileKey}:${kind}`) ||
      processedExplicitFileKinds.has(`${connection.targetFileKey}:${kind}`)));
  };
  const noLongerSupported = prior.filter((connection) =>
    (connection.generationVersion === relationshipGenerationVersion || isProcessedExplicitConnection(connection)) &&
    connection.relationshipKey &&
    connection.sourceFileKey && checksumByKey.has(connection.sourceFileKey) &&
    connection.targetFileKey && checksumByKey.has(connection.targetFileKey) &&
    !currentRelationshipKeys.has(connection.relationshipKey),
  ).map((connection) => connection.id);
  if (noLongerSupported.length > 0) {
    await prisma.knowledgeConnection.updateMany({
      data: { status: "ARCHIVED", supersededAt: new Date() },
      where: { id: { in: noLongerSupported }, status: "NEW" },
    });
    await prisma.knowledgeConnection.updateMany({
      data: { supersededAt: new Date() },
      where: { id: { in: noLongerSupported }, status: "CONFIRMED" },
    });
  }
  return persisted;
}

export async function earlierRelationshipContext(input: {
  checksum: string | null;
  connectedLibraryId: string;
  relativePath: string;
  scanStartedAt: Date;
}) {
  if (!input.checksum) return [];
  const prisma = getPrismaClient();
  const library = await prisma.connectedLibrary.findUnique({
    select: { isEnabled: true, status: true },
    where: { id: input.connectedLibraryId },
  });
  if (!library?.isEnabled || library.status === "DISCONNECTED") return [];
  const moveCandidate = await prisma.executionAction.findFirst({
    select: { id: true },
    where: {
      destinationRelativePath: input.relativePath,
      executionRun: { connectedLibraryId: input.connectedLibraryId },
      status: "COMPLETED",
      OR: [
        { destinationChecksumAfter: input.checksum },
        { sourceChecksumBefore: input.checksum },
      ],
    },
  });
  const moves = moveCandidate ? await knownExecutedMoves(input.connectedLibraryId) : [];
  const fileKey = fileKeyAfterKnownMoves(input.connectedLibraryId, input.relativePath, input.checksum, moves);
  const connections = await prisma.knowledgeConnection.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 8,
    where: {
      createdAt: { lt: input.scanStartedAt },
      generationVersion: { in: [relationshipGenerationVersion, documentSignalVersion] },
      status: { in: ["NEW", "CONFIRMED"] },
      supersededAt: null,
      OR: [
        { sourceFileKey: fileKey, sourceChecksum: input.checksum },
        { targetFileKey: fileKey, targetChecksum: input.checksum },
      ],
    },
  });
  return connections.flatMap((connection) => {
    const evidence = connection.sourceEvidence;
    if (!evidence || Array.isArray(evidence) || typeof evidence !== "object") return [];
    const sourceIsCurrent = connection.sourceFileKey === fileKey;
    const otherPath = sourceIsCurrent ? evidence.targetRelativePath : evidence.sourceRelativePath;
    const topics = evidence.supportingTopics;
    if (typeof otherPath !== "string" || !Array.isArray(topics)) return [];
    return [{
      relationshipKind: connection.relationshipKind,
      relativePath: otherPath,
      supportingTopics: topics.filter((topic): topic is string => typeof topic === "string"),
    }];
  }).slice(0, 3);
}

export async function getRecentPersistentFileRelationships() {
  const prisma = getPrismaClient();
  const rows = await prisma.knowledgeConnection.findMany({
    orderBy: { lastSeenAt: "desc" },
    select: {
      id: true,
      generationVersion: true,
      lastSeenAt: true,
      relationshipKind: true,
      sourceChecksum: true,
      sourceEvidence: true,
      targetChecksum: true,
      status: true,
      supersededAt: true,
      decisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { action: true, createdAt: true, note: true }, take: 8 },
    },
    take: 30,
    where: { generationVersion: { in: [relationshipGenerationVersion, documentSignalVersion, humanIdentityCorrectionVersion] } },
  });
  const snapshotCandidates = rows.flatMap((row) => {
    const evidence = row.sourceEvidence;
    if (!evidence || Array.isArray(evidence) || typeof evidence !== "object" ||
        typeof evidence.connectedLibraryId !== "string") return [];
    return [
      ...(typeof evidence.sourceRelativePath === "string" && row.sourceChecksum
        ? [{ connectedLibraryId: evidence.connectedLibraryId, checksum: row.sourceChecksum, relativePath: evidence.sourceRelativePath }]
        : []),
      ...(typeof evidence.targetRelativePath === "string" && row.targetChecksum
        ? [{ connectedLibraryId: evidence.connectedLibraryId, checksum: row.targetChecksum, relativePath: evidence.targetRelativePath }]
        : []),
    ];
  });
  const current = await currentSnapshotSignals(snapshotCandidates);
  const currentFiles = new Set(current.map((item) => `${item.connectedLibraryId}\0${normalizePhysicalRelativePath(item.relativePath)}\0${item.checksum}`));
  const libraryIds = rows.flatMap((row) => {
    const evidence = row.sourceEvidence;
    return evidence && !Array.isArray(evidence) && typeof evidence === "object" && typeof evidence.connectedLibraryId === "string"
      ? [evidence.connectedLibraryId]
      : [];
  });
  const libraries = await prisma.connectedLibrary.findMany({
    select: { displayName: true, id: true },
    where: { id: { in: libraryIds }, isEnabled: true, readPermission: true,
      status: "CONNECTED", disconnectedAt: null, hiddenFromActiveListAt: null,
      mergedAt: null, canonicalConnectedLibraryId: null },
  });
  const byLibraryId = new Map(libraries.map((library) => [library.id, library]));
  return rows.flatMap((row) => {
    const evidence = row.sourceEvidence;
    if (!evidence || Array.isArray(evidence) || typeof evidence !== "object" ||
        typeof evidence.sourceRelativePath !== "string" || typeof evidence.targetRelativePath !== "string") {
      return [];
    }
    const library = typeof evidence.connectedLibraryId === "string"
      ? byLibraryId.get(evidence.connectedLibraryId) : null;
    if (!library) return [];
    const sourceCurrent = typeof evidence.connectedLibraryId === "string" && row.sourceChecksum &&
      currentFiles.has(`${evidence.connectedLibraryId}\0${normalizePhysicalRelativePath(evidence.sourceRelativePath)}\0${row.sourceChecksum}`);
    const targetCurrent = typeof evidence.connectedLibraryId === "string" && row.targetChecksum &&
      currentFiles.has(`${evidence.connectedLibraryId}\0${normalizePhysicalRelativePath(evidence.targetRelativePath)}\0${row.targetChecksum}`);
    return [{
      evidenceKinds: Array.isArray(evidence.evidenceKinds)
        ? evidence.evidenceKinds.filter((item): item is string => typeof item === "string")
        : [],
      id: row.id,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      libraryName: library.displayName,
      relationshipKind: row.relationshipKind,
      reviewable: [documentSignalVersion, humanIdentityCorrectionVersion].includes(row.generationVersion ?? "") && !row.supersededAt && sourceCurrent && targetCurrent &&
        typeof evidence.connectedLibraryId === "string",
      decisions: row.decisions.map((decision) => ({ action: decision.action, createdAt: decision.createdAt.toISOString(), note: decision.note })),
      sourceRelativePath: evidence.sourceRelativePath,
      sourceRanges: Array.isArray(evidence.sourceRanges) ? evidence.sourceRanges.flatMap((range) =>
        range && typeof range === "object" && !Array.isArray(range) && typeof range.start === "number" && typeof range.end === "number"
          ? [{ start: range.start, end: range.end }]
          : [],
      ) : [],
      status: row.supersededAt || !sourceCurrent || !targetCurrent ||
        typeof evidence.connectedLibraryId !== "string"
        ? "ARCHIVED" : row.status,
      supportingTopics: Array.isArray(evidence.supportingTopics)
        ? evidence.supportingTopics.filter((item): item is string => typeof item === "string")
        : [],
      targetRelativePath: evidence.targetRelativePath,
      targetRanges: Array.isArray(evidence.targetRanges) ? evidence.targetRanges.flatMap((range) =>
        range && typeof range === "object" && !Array.isArray(range) && typeof range.start === "number" && typeof range.end === "number"
          ? [{ start: range.start, end: range.end }]
          : [],
      ) : [],
    }];
  });
}

export class RelationshipReviewError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

async function currentSnapshotSignals<T extends { connectedLibraryId: string; checksum: string; relativePath: string }>(signals: T[]) {
  if (signals.length === 0) return signals;
  const prisma = getPrismaClient();
  const libraries = [...new Set(signals.map((signal) => signal.connectedLibraryId))];
  const latestDates = await prisma.scanSession.groupBy({
    by: ["connectedFolderId"],
    _max: { startedAt: true },
    where: { ...usableScanSnapshotWhere, connectedFolderId: { in: libraries } },
  });
  const sessions = await prisma.scanSession.findMany({
    orderBy: { id: "desc" },
    select: { connectedFolderId: true, id: true, startedAt: true },
    where: { ...usableScanSnapshotWhere, OR: latestDates.flatMap((item) => item._max.startedAt ? [{ connectedFolderId: item.connectedFolderId, startedAt: item._max.startedAt }] : []) },
  });
  const latestByLibrary = new Map<string, string>();
  for (const session of sessions) {
    if (!latestByLibrary.has(session.connectedFolderId)) latestByLibrary.set(session.connectedFolderId, session.id);
  }
  const files = await prisma.scannedFile.findMany({
    select: { checksum: true, relativePath: true, sessionId: true },
    where: { sessionId: { in: [...latestByLibrary.values()] }, relativePath: { in: [...new Set(signals.map((signal) => signal.relativePath))] } },
  });
  const libraryBySession = new Map([...latestByLibrary].map(([libraryId, sessionId]) => [sessionId, libraryId]));
  const present = new Set(files.map((file) => `${libraryBySession.get(file.sessionId)}\0${normalizePhysicalRelativePath(file.relativePath)}\0${file.checksum}`));
  return signals.filter((signal) => present.has(`${signal.connectedLibraryId}\0${normalizePhysicalRelativePath(signal.relativePath)}\0${signal.checksum}`));
}

async function supersedeCompetingCorrections(tx: Prisma.TransactionClient, selected: {
  id?: string; relationshipKind: string | null; sourceFileKey: string | null; sourceChecksum: string | null;
}) {
  const previous = await tx.knowledgeConnection.findMany({ where: {
    generationVersion: humanIdentityCorrectionVersion, relationshipKind: selected.relationshipKind,
    sourceFileKey: selected.sourceFileKey, sourceChecksum: selected.sourceChecksum,
    status: "CONFIRMED", supersededAt: null,
    ...(selected.id ? { id: { not: selected.id } } : {}),
  } });
  for (const connection of previous) {
    await tx.knowledgeConnection.update({ data: { status: "REJECTED" }, where: { id: connection.id } });
    await tx.knowledgeConnectionDecision.create({ data: {
      action: "SUPERSEDE", knowledgeConnectionId: connection.id,
      previousStatus: "CONFIRMED", nextStatus: "REJECTED",
      note: "Replaced by another human-confirmed correction.",
    } });
  }
}

export async function reviewPersistentRelationship(id: string, action: "CONFIRM" | "SEPARATE" | "RECONSIDER", note?: string) {
  if (!["CONFIRM", "SEPARATE", "RECONSIDER"].includes(action)) {
    throw new RelationshipReviewError("Choose a review decision.");
  }
  const prisma = getPrismaClient();
  return prisma.$transaction(async (tx) => {
    const connection = await tx.knowledgeConnection.findUnique({ where: { id } });
    if (!connection || ![documentSignalVersion, humanIdentityCorrectionVersion].includes(connection.generationVersion ?? "") || connection.supersededAt) {
      throw new RelationshipReviewError("This relationship is no longer available for review.", 409);
    }
    const evidence = connection.sourceEvidence;
    const libraryId = evidence && !Array.isArray(evidence) && typeof evidence === "object" ? evidence.connectedLibraryId : null;
    if (!evidence || Array.isArray(evidence) || typeof evidence !== "object" || typeof libraryId !== "string") {
      throw new RelationshipReviewError("The source library could not be verified.", 409);
    }
    const library = await tx.connectedLibrary.findFirst({ select: { id: true }, where: {
      id: libraryId, isEnabled: true, readPermission: true, status: "CONNECTED",
      disconnectedAt: null, hiddenFromActiveListAt: null, mergedAt: null,
      canonicalConnectedLibraryId: null,
    } });
    if (!library) throw new RelationshipReviewError("This library is not available for relationship review.", 409);
    const sourcePath = typeof evidence.sourceRelativePath === "string" ? evidence.sourceRelativePath : null;
    const targetPath = typeof evidence.targetRelativePath === "string" ? evidence.targetRelativePath : null;
    const latestScan = await tx.scanSession.findFirst({ orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { id: true }, where: { ...usableScanSnapshotWhere, connectedFolderId: libraryId } });
    const files = latestScan && sourcePath && targetPath ? await tx.scannedFile.findMany({
      select: { checksum: true, relativePath: true },
      where: { sessionId: latestScan.id, relativePath: { in: [sourcePath, targetPath] } },
    }) : [];
    if (!sourcePath || !targetPath || !connection.sourceChecksum || !connection.targetChecksum ||
        ![ { path: sourcePath, checksum: connection.sourceChecksum }, { path: targetPath, checksum: connection.targetChecksum } ].every((item) =>
          files.some((file) => file.checksum === item.checksum && normalizePhysicalRelativePath(file.relativePath) === normalizePhysicalRelativePath(item.path)),
        )) {
      throw new RelationshipReviewError("The supporting files are no longer in the latest scan. This relationship is now historical.", 409);
    }
    const status = action === "CONFIRM" ? "CONFIRMED" : action === "SEPARATE" ? "REJECTED" : "NEW";
    if (action === "CONFIRM" && connection.generationVersion === humanIdentityCorrectionVersion) {
      await supersedeCompetingCorrections(tx, connection);
      const separatedKind = connection.relationshipKind === "SAME_CLIENT" ? "SAME_CLIENT" :
        connection.relationshipKind === "BELONGS_TO_PROJECT" ? "SAME_PROJECT" : null;
      if (separatedKind && connection.sourceFileKey && connection.sourceChecksum &&
          connection.targetFileKey && connection.targetChecksum) {
        await tx.knowledgeConnection.updateMany({ data: { supersededAt: new Date() }, where: {
          generationVersion: documentSignalVersion, relationshipKind: separatedKind,
          status: "REJECTED", supersededAt: null,
          decisions: { some: { action: "SEPARATE", nextStatus: "REJECTED" } },
          OR: [
            { sourceFileKey: connection.sourceFileKey, sourceChecksum: connection.sourceChecksum,
              targetFileKey: connection.targetFileKey, targetChecksum: connection.targetChecksum },
            { sourceFileKey: connection.targetFileKey, sourceChecksum: connection.targetChecksum,
              targetFileKey: connection.sourceFileKey, targetChecksum: connection.sourceChecksum },
          ],
        } });
      }
    }
    if (connection.status === status) return connection;
    const changed = await tx.knowledgeConnection.updateMany({
      data: { status },
      where: { id, status: connection.status, supersededAt: null },
    });
    if (changed.count !== 1) throw new RelationshipReviewError("This relationship changed during review. Refresh and try again.", 409);
    await tx.knowledgeConnectionDecision.create({
      data: {
        action,
        knowledgeConnectionId: id,
        nextStatus: status,
        note: note?.trim().slice(0, 500) || null,
        previousStatus: connection.status,
      },
    });
    return tx.knowledgeConnection.findUniqueOrThrow({ where: { id } });
  }, { isolationLevel: "Serializable" }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2034") {
      throw new RelationshipReviewError("This relationship changed during review. Refresh and try again.", 409);
    }
    throw error;
  });
}

export async function getIdentityCorrectionCandidates() {
  const prisma = getPrismaClient();
  const select = { checksum: true, connectedLibraryId: true, id: true, kind: true, relativePath: true } as const;
  const [identities, anchors] = await Promise.all([
    prisma.knowledgeDocumentSignal.findMany({
      orderBy: { lastSeenAt: "desc" },
      select,
      take: 200,
      where: { status: "ACTIVE", supersededAt: null, generationVersion: documentSignalVersion,
        kind: { in: ["CLIENT", "UNRESOLVED_CLIENT", "PROJECT", "UNRESOLVED_PROJECT", "PERSON", "ORGANIZATION", "WORKSHOP", "DOCUMENT_FAMILY"] } },
    }),
    prisma.knowledgeDocumentSignal.findMany({
      orderBy: { lastSeenAt: "desc" },
      select,
      take: 200,
      where: { status: "ACTIVE", supersededAt: null, generationVersion: documentSignalVersion,
        kind: "FILE_ANCHOR" },
    }),
  ]);
  const signals = [...identities, ...anchors];
  const currentSignals = await currentSnapshotSignals(signals);
  const libraries = await prisma.connectedLibrary.findMany({
    select: { displayName: true, id: true },
    where: { id: { in: [...new Set(currentSignals.map((signal) => signal.connectedLibraryId))] },
      isEnabled: true, readPermission: true, status: "CONNECTED", disconnectedAt: null,
      hiddenFromActiveListAt: null, mergedAt: null, canonicalConnectedLibraryId: null },
  });
  const names = new Map(libraries.map((library) => [library.id, library.displayName]));
  return currentSignals.flatMap((signal) => {
    const libraryName = names.get(signal.connectedLibraryId);
    return libraryName ? [{ connectedLibraryId: signal.connectedLibraryId, id: signal.id, kind: signal.kind, libraryName, relativePath: signal.relativePath }] : [];
  });
}

export async function createIdentityCorrection(input: {
  sourceSignalId: string;
  targetSignalId: string;
  kind: "SAME_CLIENT" | "BELONGS_TO_PROJECT";
  note: string;
}) {
  if (!["SAME_CLIENT", "BELONGS_TO_PROJECT"].includes(input.kind) ||
      !input.sourceSignalId || !input.targetSignalId ||
      !input.note?.trim() || input.note.length > 500) {
    throw new RelationshipReviewError("Choose both files and add a brief reason for the correction.");
  }
  const prisma = getPrismaClient();
  return prisma.$transaction(async (tx) => {
    const [source, target] = await Promise.all([
      tx.knowledgeDocumentSignal.findUnique({ where: { id: input.sourceSignalId } }),
      tx.knowledgeDocumentSignal.findUnique({ where: { id: input.targetSignalId } }),
    ]);
    if (!source || !target || source.status !== "ACTIVE" || target.status !== "ACTIVE" ||
        source.supersededAt || target.supersededAt ||
        source.generationVersion !== documentSignalVersion || target.generationVersion !== documentSignalVersion ||
        source.connectedLibraryId !== target.connectedLibraryId || source.fileKey === target.fileKey ||
        source.observationSessionId === target.observationSessionId ||
        (input.kind === "SAME_CLIENT" && (!["CLIENT", "UNRESOLVED_CLIENT"].includes(source.kind) || !["CLIENT", "UNRESOLVED_CLIENT"].includes(target.kind))) ||
        (input.kind === "BELONGS_TO_PROJECT" && target.kind !== "PROJECT")) {
      throw new RelationshipReviewError("Choose distinct, current files in the same connected library.", 409);
    }
    const library = await tx.connectedLibrary.findFirst({ select: { id: true }, where: {
      id: source.connectedLibraryId, isEnabled: true, readPermission: true, status: "CONNECTED",
      disconnectedAt: null, hiddenFromActiveListAt: null, mergedAt: null,
      canonicalConnectedLibraryId: null,
    } });
    if (!library) {
      throw new RelationshipReviewError("This library is not available for relationship correction.", 409);
    }
    const latestScan = await tx.scanSession.findFirst({
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: { id: true },
      where: { ...usableScanSnapshotWhere, connectedFolderId: source.connectedLibraryId },
    });
    const currentFiles = latestScan ? await tx.scannedFile.findMany({
      select: { checksum: true, relativePath: true },
      where: { sessionId: latestScan.id, checksum: { in: [source.checksum, target.checksum] } },
    }) : [];
    if (![source, target].every((signal) => currentFiles.some((file) =>
      file.checksum === signal.checksum && normalizePhysicalRelativePath(file.relativePath) === normalizePhysicalRelativePath(signal.relativePath),
    ))) {
      throw new RelationshipReviewError("One of these files is no longer in the latest scan. Scan again before correcting it.", 409);
    }
    // Submitting an exact human correction is an intentional later rejoin.
    // Retire an older generated SEPARATE boundary before resolving the target's
    // canonical class. A separation saved later remains active and wins.
    if (input.kind === "SAME_CLIENT" || input.kind === "BELONGS_TO_PROJECT") {
      await tx.knowledgeConnection.updateMany({
        data: { supersededAt: new Date() },
        where: {
          generationVersion: documentSignalVersion,
          relationshipKind: input.kind === "SAME_CLIENT" ? "SAME_CLIENT" : "SAME_PROJECT",
          status: "REJECTED",
          supersededAt: null,
          decisions: { some: { action: "SEPARATE", nextStatus: "REJECTED" } },
          OR: [
            { sourceFileKey: source.fileKey, sourceChecksum: source.checksum,
              targetFileKey: target.fileKey, targetChecksum: target.checksum },
            { sourceFileKey: target.fileKey, sourceChecksum: target.checksum,
              targetFileKey: source.fileKey, targetChecksum: source.checksum },
          ],
        },
      });
    }
    let targetIdentityHash = target.identityHash;
    if (input.kind === "SAME_CLIENT") {
      const [clientSignals, activeCorrections, separated] = await Promise.all([
        tx.knowledgeDocumentSignal.findMany({
          select: { checksum: true, connectedLibraryId: true, fileKey: true, identityHash: true, kind: true },
          where: { connectedLibraryId: source.connectedLibraryId, generationVersion: documentSignalVersion,
            kind: { in: ["CLIENT", "UNRESOLVED_CLIENT"] }, status: "ACTIVE", supersededAt: null },
        }),
        tx.knowledgeConnection.findMany({
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, relationshipKind: true, sourceChecksum: true, sourceEvidence: true,
            sourceFileKey: true, targetChecksum: true, targetFileKey: true },
          where: { generationVersion: humanIdentityCorrectionVersion, relationshipKind: "SAME_CLIENT",
            status: "CONFIRMED", supersededAt: null },
        }),
        tx.knowledgeConnection.findMany({
          select: { sourceChecksum: true, sourceFileKey: true, targetChecksum: true, targetFileKey: true },
          where: { decisions: { some: { action: "SEPARATE", nextStatus: "REJECTED" } },
            generationVersion: documentSignalVersion, relationshipKind: "SAME_CLIENT",
            status: "REJECTED", supersededAt: null },
        }),
      ]);
      const separatedPairs = new Set(separated.flatMap((row) => row.sourceFileKey && row.sourceChecksum &&
        row.targetFileKey && row.targetChecksum ? [knowledgeRelationshipPairKey(
          { fileKey: row.sourceFileKey, checksum: row.sourceChecksum },
          { fileKey: row.targetFileKey, checksum: row.targetChecksum },
        )] : []));
      targetIdentityHash = correctedClientIdentities(clientSignals, activeCorrections, separatedPairs)
        .get(`${target.fileKey}\0${target.checksum}`) ?? target.identityHash;
    }
    const relationshipKey = digest([humanIdentityCorrectionVersion, input.kind, source.fileKey, source.checksum,
      target.fileKey, target.checksum, targetIdentityHash].join("\0"));
    const existing = await tx.knowledgeConnection.findUnique({
      select: { id: true, status: true, supersededAt: true },
      where: { relationshipKey },
    });
    await supersedeCompetingCorrections(tx, { id: existing?.id, relationshipKind: input.kind,
      sourceFileKey: source.fileKey, sourceChecksum: source.checksum });
    const evidence = {
      connectedLibraryId: source.connectedLibraryId,
      evidenceKinds: ["HUMAN_REVIEW"],
      identityHash: targetIdentityHash,
      sourceRanges: source.sourceRanges,
      sourceRelativePath: source.relativePath,
      supportingTopics: [input.kind === "SAME_CLIENT" ? "client identity" : "project membership"],
      targetRanges: target.sourceRanges,
      targetRelativePath: target.relativePath,
    };
    if (existing?.status === "CONFIRMED") {
      if (!existing.supersededAt) {
        return tx.knowledgeConnection.findUniqueOrThrow({ where: { id: existing.id } });
      }
      return tx.knowledgeConnection.update({ where: { id: existing.id }, data: {
        lastSeenAt: new Date(), sourceEvidence: evidence,
        sourceObservationSession: { connect: { id: source.observationSessionId } },
        targetObservationSession: { connect: { id: target.observationSessionId } },
        supersededAt: null,
      } });
    }
    const conflictingProposals = await tx.knowledgeConnection.findMany({
      select: { id: true, sourceEvidence: true },
      where: {
        generationVersion: documentSignalVersion,
        relationshipKind: input.kind === "SAME_CLIENT" ? "SAME_CLIENT" : "SAME_PROJECT",
        status: "NEW",
        supersededAt: null,
        OR: [
          { sourceFileKey: source.fileKey, sourceChecksum: source.checksum },
          { targetFileKey: source.fileKey, targetChecksum: source.checksum },
        ],
      },
    });
    for (const proposal of conflictingProposals) {
      const proposalEvidence = proposal.sourceEvidence;
      if (!proposalEvidence || Array.isArray(proposalEvidence) || typeof proposalEvidence !== "object" ||
          proposalEvidence.identityHash === targetIdentityHash) continue;
      const changed = await tx.knowledgeConnection.updateMany({ data: { status: "REJECTED" }, where: { id: proposal.id, status: "NEW" } });
      if (changed.count === 1) await tx.knowledgeConnectionDecision.create({
        data: {
          action: "HUMAN_CORRECTION",
          knowledgeConnectionId: proposal.id,
          previousStatus: "NEW",
          nextStatus: "REJECTED",
          note: "A later human correction superseded this provisional link.",
        },
      });
    }
    const connection = await tx.knowledgeConnection.upsert({
      create: {
        confidence: 0,
        generationVersion: humanIdentityCorrectionVersion,
        lastSeenAt: new Date(),
        reasoning: "Deanne corrected this relationship after reviewing both files.",
        relationshipKey,
        relationshipKind: input.kind,
        sharedTerms: [],
        similarityScore: 0,
        sourceChecksum: source.checksum,
        sourceEvidence: evidence,
        sourceFileKey: source.fileKey,
        sourceObservationSessionId: source.observationSessionId,
        status: "CONFIRMED",
        targetChecksum: target.checksum,
        targetFileKey: target.fileKey,
        targetObservationSessionId: target.observationSessionId,
      },
      update: {
        lastSeenAt: new Date(), status: "CONFIRMED", supersededAt: null,
        sourceEvidence: evidence,
        sourceObservationSession: { connect: { id: source.observationSessionId } },
        targetObservationSession: { connect: { id: target.observationSessionId } },
      },
      where: { relationshipKey },
    });
    await tx.knowledgeConnectionDecision.create({
      data: {
        action: "CONFIRM",
        knowledgeConnectionId: connection.id,
        nextStatus: "CONFIRMED",
        note: input.note.trim(),
        previousStatus: existing?.status ?? "NEW",
      },
    });
    return connection;
  }, { isolationLevel: "Serializable" }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2034") {
      throw new RelationshipReviewError("The relationship changed during review. Refresh and try again.", 409);
    }
    throw error;
  });
}

export type HistoricalDocumentSignalEntry = {
  checksum: string;
  connectedLibraryId: string;
  fileKey: string;
  isCurrent: boolean;
};

/** Load original signals eligible for the current or explicitly retained snapshots. */
export async function getEligibleDocumentSignals(permittedRootIds?: string[], options?: {
  historicalEntries: HistoricalDocumentSignalEntry[];
}) {
  const prisma = getPrismaClient();
  const libraries = await prisma.connectedLibrary.findMany({
    select: { id: true },
    where: { ...(permittedRootIds ? { id: { in: permittedRootIds } } : {}),
      isEnabled: true, readPermission: true, status: "CONNECTED", disconnectedAt: null,
      hiddenFromActiveListAt: null, mergedAt: null, canonicalConnectedLibraryId: null },
  });
  const libraryIds = libraries.map((library) => library.id);
  const historicalEntries = options?.historicalEntries.filter((entry) => !entry.isCurrent) ?? [];
  const candidateSignalFilters: Prisma.KnowledgeDocumentSignalWhereInput[] = [
    { status: "ACTIVE", supersededAt: null },
    ...historicalEntries.map((entry): Prisma.KnowledgeDocumentSignalWhereInput => ({
      connectedLibraryId: entry.connectedLibraryId,
      fileKey: entry.fileKey,
      checksum: entry.checksum,
      status: { in: ["ACTIVE", "SUPERSEDED"] },
    })),
  ];
  const candidateRows = await prisma.knowledgeDocumentSignal.findMany({
    orderBy: { lastSeenAt: "desc" },
    where: { generationVersion: documentSignalVersion, connectedLibraryId: { in: libraryIds },
      OR: candidateSignalFilters },
  });
  const currentRows = await currentSnapshotSignals(candidateRows);
  const currentKeys = new Set(currentRows.map((row) => `${row.connectedLibraryId}\0${row.fileKey}\0${row.checksum}\0${row.id}`));
  const historicalKeys = new Set(historicalEntries.map((entry) =>
    `${entry.connectedLibraryId}\0${entry.fileKey}\0${entry.checksum}`));
  const historicalCandidates = candidateRows.filter((row) => !currentKeys.has(
    `${row.connectedLibraryId}\0${row.fileKey}\0${row.checksum}\0${row.id}`) && historicalKeys.has(
    `${row.connectedLibraryId}\0${row.fileKey}\0${row.checksum}`));
  const historicalObservations = historicalCandidates.length ? await prisma.observationSession.findMany({
    where: { id: { in: historicalCandidates.map((row) => row.observationSessionId) },
      status: { in: ["NEW", "AWAITING_REVIEW", "IN_REVIEW", "APPROVED", "MODIFIED"] } },
    select: { id: true, status: true, humanDecisions: { where: { decisionType: "MODIFY" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { editedSuggestion: true } } },
  }) : [];
  const historicalObservationById = new Map(historicalObservations.map((item) => [item.id, item]));
  const historicalRows = historicalCandidates.filter((row) => {
    const observation = historicalObservationById.get(row.observationSessionId);
    if (!observation) return false;
    if (observation.status !== "MODIFIED") return true;
    return extractDocumentSignals(observation.humanDecisions[0]?.editedSuggestion ?? "", row.connectedLibraryId)
      .some((signal) => signal.kind === row.kind && signal.identityHash === row.identityHash);
  });
  return [...currentRows, ...historicalRows];
}

export async function getEffectiveDocumentSignals(permittedRootIds?: string[], options?: {
  historicalEntries: HistoricalDocumentSignalEntry[];
}) {
  const prisma = getPrismaClient();
  const rows = await getEligibleDocumentSignals(permittedRootIds, options);
  const humanCorrections = await prisma.knowledgeConnection.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, relationshipKind: true, sourceChecksum: true, sourceEvidence: true, sourceFileKey: true, targetChecksum: true, targetFileKey: true },
    where: { generationVersion: humanIdentityCorrectionVersion, status: "CONFIRMED", supersededAt: null,
      sourceFileKey: { in: rows.map((row) => row.fileKey) } },
  });
  const separatedIdentityRows = await prisma.knowledgeConnection.findMany({
    select: { relationshipKind: true, sourceChecksum: true, sourceFileKey: true, targetChecksum: true, targetFileKey: true },
    where: { decisions: { some: { action: "SEPARATE", nextStatus: "REJECTED" } },
      generationVersion: documentSignalVersion, relationshipKind: { in: ["SAME_CLIENT", "SAME_PROJECT"] },
      status: "REJECTED", supersededAt: null,
      sourceFileKey: { in: rows.map((row) => row.fileKey) },
      targetFileKey: { in: rows.map((row) => row.fileKey) } },
  });
  const effectiveRows = [...rows];
  const correctedIdentities = new Map<string, string>();
  const correctionKey = (row: Pick<EffectiveIdentitySignal, "fileKey" | "checksum" | "kind">) =>
    `${row.fileKey}\0${row.checksum}\0${row.kind}`;
  const separatedClientPairs = new Set(separatedIdentityRows.flatMap((row) => row.relationshipKind === "SAME_CLIENT" && row.sourceFileKey && row.sourceChecksum &&
    row.targetFileKey && row.targetChecksum ? [knowledgeRelationshipPairKey(
      { fileKey: row.sourceFileKey, checksum: row.sourceChecksum },
      { fileKey: row.targetFileKey, checksum: row.targetChecksum },
    )] : []));
  const correctedClients = correctedClientIdentities(rows, humanCorrections, separatedClientPairs);
  for (const row of rows) {
    const identityHash = correctedClients.get(`${row.fileKey}\0${row.checksum}`);
    if (!identityHash || !["CLIENT", "UNRESOLVED_CLIENT"].includes(row.kind)) continue;
    correctedIdentities.set(correctionKey({ ...row, kind: "CLIENT" }), identityHash);
    effectiveRows.push({ ...row, kind: "CLIENT", identityHash, sourceRanges: [],
      generationVersion: humanIdentityCorrectionVersion });
  }
  for (const correction of humanCorrections) {
    const kind = correction.relationshipKind === "BELONGS_TO_PROJECT" ? "PROJECT" : null;
    const evidence = correction.sourceEvidence;
    if (!kind || !correction.sourceFileKey || !correction.targetFileKey ||
        !evidence || Array.isArray(evidence) || typeof evidence !== "object" ||
        typeof evidence.identityHash !== "string") continue;
    const source = rows.find((row) => row.fileKey === correction.sourceFileKey && row.checksum === correction.sourceChecksum);
    const target = rows.find((row) => row.fileKey === correction.targetFileKey && row.checksum === correction.targetChecksum &&
      (row.kind === kind || row.kind === "UNRESOLVED_PROJECT") &&
      row.identityHash === evidence.identityHash && row.connectedLibraryId === source?.connectedLibraryId);
    if (!source || !target || evidence.connectedLibraryId !== source.connectedLibraryId) continue;
    const separatedProjectPair = separatedIdentityRows.some((row) => row.relationshipKind === "SAME_PROJECT" &&
      row.sourceFileKey && row.sourceChecksum && row.targetFileKey && row.targetChecksum &&
      knowledgeRelationshipPairKey(source, target) === knowledgeRelationshipPairKey(
        { fileKey: row.sourceFileKey, checksum: row.sourceChecksum },
        { fileKey: row.targetFileKey, checksum: row.targetChecksum }));
    if (separatedProjectPair) continue;
    const key = correctionKey({ ...source, kind });
    if (correctedIdentities.has(key)) continue;
    correctedIdentities.set(key, target.identityHash);
    effectiveRows.push({ ...source, kind, identityHash: target.identityHash, sourceRanges: [], generationVersion: humanIdentityCorrectionVersion });
    if (target.kind !== kind) {
      correctedIdentities.set(correctionKey({ ...target, kind }), target.identityHash);
      effectiveRows.push({ ...target, kind, generationVersion: humanIdentityCorrectionVersion });
    }
  }
  return effectiveRows.filter((row) => {
    const correction = correctedIdentities.get(correctionKey(row));
    return (!correction || correction === row.identityHash) &&
      !(row.kind === "UNRESOLVED_CLIENT" && correctedIdentities.has(correctionKey({ ...row, kind: "CLIENT" }))) &&
      !(row.kind === "UNRESOLVED_PROJECT" && correctedIdentities.has(correctionKey({ ...row, kind: "PROJECT" })));
  });
}

export async function getPersistentIdentityGroups() {
  const prisma = getPrismaClient();
  const rows = await getEffectiveDocumentSignals();
  const effectiveRows = rows;
  const libraryIds = [...new Set(rows.map((row) => row.connectedLibraryId))];
  const libraries = await prisma.connectedLibrary.findMany({
    select: { displayName: true, id: true },
    where: { id: { in: libraryIds }, isEnabled: true, readPermission: true,
      status: "CONNECTED", disconnectedAt: null, hiddenFromActiveListAt: null,
      mergedAt: null, canonicalConnectedLibraryId: null },
  });
  const byLibrary = new Map(libraries.map((library) => [library.id, library]));
  const rejected = await prisma.knowledgeConnection.findMany({
    select: { sourceEvidence: true, sourceFileKey: true, targetFileKey: true },
    take: 1000,
    where: { generationVersion: documentSignalVersion, status: "REJECTED", supersededAt: null },
  });
  const groups = new Map<string, typeof rows>();
  for (const row of effectiveRows) {
    if (![...resolvedSignalKinds, "UNRESOLVED_CLIENT", "UNRESOLVED_PROJECT"].includes(row.kind)) continue;
    const library = byLibrary.get(row.connectedLibraryId);
    if (!library) continue;
    const key = `${row.connectedLibraryId}:${row.kind}:${row.identityHash}${row.kind.startsWith("UNRESOLVED_") ? `:${row.fileKey}` : ""}`;
    const existing = groups.get(key) ?? [];
    if (!existing.some((member) => member.fileKey === row.fileKey)) existing.push(row);
    groups.set(key, existing);
  }
  return [...groups.values()].flatMap((members) => {
    const keys = new Set(members.map((member) => member.fileKey));
    const disputed = rejected.some((connection) => {
      const evidence = connection.sourceEvidence;
      return connection.sourceFileKey && connection.targetFileKey &&
        keys.has(connection.sourceFileKey) && keys.has(connection.targetFileKey) &&
        evidence && !Array.isArray(evidence) && typeof evidence === "object" &&
        evidence.identityHash === members[0].identityHash;
    });
    return disputed ? members[0].kind === "DOCUMENT_FAMILY" ? [] : members.map((member) => [member]) : [members];
  }).filter((members) => {
    if (members[0].kind !== "DOCUMENT_FAMILY") return true;
    return members.length > 1 && new Set(members.map((member) => member.checksum)).size > 1 &&
      members.some((member) => members.some((other) =>
        member.fileKey !== other.fileKey &&
        (member.revisionNumber !== other.revisionNumber || member.revisionDate !== other.revisionDate),
      ));
  }).sort((left, right) => {
    const priority = (members: typeof rows) => members[0].kind === "DOCUMENT_FAMILY" ? 0 :
      members[0].kind.startsWith("UNRESOLVED_") ? 3 : members.length > 1 ? 1 : 2;
    return priority(left) - priority(right) || right[0].lastSeenAt.getTime() - left[0].lastSeenAt.getTime();
  }).slice(0, 40).map((members) => {
    const kind = members[0].kind;
    const isVersionFamily = kind === "DOCUMENT_FAMILY";
    const distinctChecksums = new Set(members.map((member) => member.checksum));
    const contextHashes = new Set(members.flatMap((member) => member.supportHash ? [member.supportHash] : []));
    const contextFiles = kind === "PROJECT" || kind === "WORKSHOP"
      ? [...new Set(effectiveRows.filter((row) =>
        row.connectedLibraryId === members[0].connectedLibraryId &&
        contextHashes.has(row.identityHash) &&
        (row.kind === "CLIENT" || row.kind === "PROJECT"),
      ).map((row) => row.relativePath))].slice(0, 3)
      : [];
    let latestKey: string | null = null;
    if (isVersionFamily && distinctChecksums.size > 1) {
      const candidate = members.find((member) => members.every((other) =>
        member.fileKey === other.fileKey || compareDocumentVersions(member, other) === 1,
      ));
      latestKey = candidate?.fileKey ?? null;
    }
    return {
      id: `${members[0].identityHash}:${members.length === 1 ? members[0].fileKey : ""}`,
      kind,
      latestKey,
      contextFiles,
      humanConfirmed: members.some((member) => member.generationVersion === humanIdentityCorrectionVersion),
      libraryName: byLibrary.get(members[0].connectedLibraryId)?.displayName ?? "Connected library",
      members: members.map((member) => ({
        fileKey: member.fileKey,
        lastSeenAt: member.lastSeenAt.toISOString(),
        relativePath: member.relativePath,
        revisionDate: member.revisionDate,
        revisionNumber: member.revisionNumber,
        sourceRanges: Array.isArray(member.sourceRanges) ? member.sourceRanges.flatMap((range) =>
          range && typeof range === "object" && !Array.isArray(range) && typeof range.start === "number" && typeof range.end === "number"
            ? [{ start: range.start, end: range.end }]
            : [],
        ) : [],
      })),
    };
  });
}
