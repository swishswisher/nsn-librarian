import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";

import { PrismaClient } from "@prisma/client";

const schema = `phase_two_${process.pid}_${Date.now()}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalDirectUrl = process.env.DIRECT_URL;
let prisma: PrismaClient;
let persistent: typeof import("../../src/lib/bridge/persistent-knowledge");
let preferences: typeof import("../../src/lib/library/organization-preferences");
let recommendationVersion: string;

function isolatedUrl(value: string | undefined) {
  if (!value) throw new Error("An isolated local test database is required.");
  const url = new URL(value);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/nsn_library_machine_test") {
    throw new Error("Phase 2 tests refuse any non-local or non-test database.");
  }
  url.searchParams.set("schema", schema);
  return url.toString();
}

before(async () => {
  process.env.DATABASE_URL = isolatedUrl(originalDatabaseUrl);
  process.env.DIRECT_URL = isolatedUrl(originalDirectUrl ?? originalDatabaseUrl);
  process.env.OPENAI_API_KEY = "";
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], {
    env: process.env,
    stdio: "pipe",
  });
  prisma = new PrismaClient();
  persistent = await import("../../src/lib/bridge/persistent-knowledge");
  preferences = await import("../../src/lib/library/organization-preferences");
  recommendationVersion = (await import("../../src/lib/bridge/recommendation-generation")).currentRecommendationGenerationVersion;
});

after(async () => {
  if (prisma) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
  }
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalDirectUrl === undefined) delete process.env.DIRECT_URL;
  else process.env.DIRECT_URL = originalDirectUrl;
});

async function createLibrary(name: string) {
  return prisma.connectedLibrary.create({
    data: {
      bridgeRootId: crypto.randomUUID(),
      displayName: name,
      localPath: `bridge://phase-two/${crypto.randomUUID()}`,
      platform: "MACOS",
    },
  });
}

async function createObservedFile(input: {
  checksum: string;
  libraryId: string;
  relativePath: string;
  sessionId: string;
}) {
  const batch = await prisma.libraryBatch.create({ data: { name: "Synthetic Phase 2" } });
  const document = await prisma.libraryDocument.create({
    data: {
      batchId: batch.id,
      normalizedFileName: input.relativePath,
      originalFileName: input.relativePath,
    },
  });
  const observation = await prisma.observationSession.create({
    data: {
      confidence: 0.7,
      explanation: [],
      interpretations: [],
      libraryDocumentId: document.id,
      observations: [],
      observerType: "DETERMINISTIC",
      planSuggestions: [],
      warnings: [],
    },
  });
  const file = await prisma.scannedFile.create({
    data: {
      checksum: input.checksum,
      extractionStatus: "COMPLETED",
      fileType: "TEXT",
      libraryDocumentId: document.id,
      localPath: `bridge://${input.libraryId}/${input.relativePath}`,
      readStatus: "SUPPORTED",
      readingStatus: "READ",
      relativePath: input.relativePath,
      sessionId: input.sessionId,
    },
  });
  return { file, observation };
}

function knowledgeIndex(sessionId: string, libraryId: string, left: { file: { id: string; relativePath: string } }, right: { file: { id: string; relativePath: string } }) {
  const files = [left.file, right.file].map((file) => ({
    approvedMemoryEvidence: [],
    connectedLibraryId: libraryId,
    fileName: file.relativePath.split("/").at(-1) ?? "file.txt",
    fileType: "TEXT",
    id: file.id,
    normalizedIdentity: `${libraryId}/${file.relativePath.toLowerCase()}`,
    provisionalWorkingEvidence: [],
    relativePath: file.relativePath,
    semanticPreview: "invoice payment",
    semanticTerms: ["invoice", "payment"],
    sourceEvidenceText: "",
    supportingTopics: ["finance"],
    trustedObservationEvidence: [],
  }));
  return {
    clusters: [],
    files,
    relationships: [{
      confidence: 0.72,
      evidenceKinds: ["CONTENT" as const],
      leftFileId: left.file.id,
      rightFileId: right.file.id,
      supportingTopicConfidence: { finance: 0.72 },
      supportingTopics: ["finance"],
      sharedTerms: ["invoice", "payment"],
      sharedTopics: ["finance"],
    }],
    scanSessionId: sessionId,
  };
}

test("persistent relationships deduplicate repeated scans and archive changed evidence", async () => {
  const library = await createLibrary("Root A");
  const firstScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const left = await createObservedFile({ checksum: "a".repeat(64), libraryId: library.id, relativePath: "Operations/invoice.txt", sessionId: firstScan.id });
  const right = await createObservedFile({ checksum: "b".repeat(64), libraryId: library.id, relativePath: "Finance/payment.txt", sessionId: firstScan.id });
  const firstIndex = knowledgeIndex(firstScan.id, library.id, left, right);
  firstIndex.files[0].sourceEvidenceText = 'Source characters 12-27: "invoice payment"';
  firstIndex.files[1].sourceEvidenceText = 'Source characters 40-55: "payment invoice"';
  assert.equal(await persistent.persistScanWorkingKnowledge(firstIndex), 1);
  assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKey: { not: null } } }), 1);
  const connection = await prisma.knowledgeConnection.findFirstOrThrow({ where: { relationshipKey: { not: null } } });
  const references = JSON.stringify(connection.sourceEvidence);
  assert.match(references, /"start":12/);
  assert.match(references, /"start":40/);
  assert.equal(references.includes("invoice payment"), false);

  const secondScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const sameLeft = await createObservedFile({ checksum: "a".repeat(64), libraryId: library.id, relativePath: "Operations/invoice.txt", sessionId: secondScan.id });
  const sameRight = await createObservedFile({ checksum: "b".repeat(64), libraryId: library.id, relativePath: "Finance/payment.txt", sessionId: secondScan.id });
  await persistent.persistScanWorkingKnowledge(knowledgeIndex(secondScan.id, library.id, sameLeft, sameRight));
  assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKey: { not: null } } }), 1);
  const earlier = await persistent.earlierRelationshipContext({
    checksum: "a".repeat(64),
    connectedLibraryId: library.id,
    relativePath: "Operations/invoice.txt",
    scanStartedAt: secondScan.startedAt,
  });
  assert.deepEqual(earlier.map((item) => item.relativePath), ["Finance/payment.txt"]);
  await prisma.connectedLibrary.update({ data: { isEnabled: false, status: "DISCONNECTED" }, where: { id: library.id } });
  assert.deepEqual(await persistent.earlierRelationshipContext({
    checksum: "a".repeat(64),
    connectedLibraryId: library.id,
    relativePath: "Operations/invoice.txt",
    scanStartedAt: secondScan.startedAt,
  }), []);
  await prisma.connectedLibrary.update({ data: { isEnabled: true, status: "CONNECTED" }, where: { id: library.id } });

  const thirdScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const changedLeft = await createObservedFile({ checksum: "c".repeat(64), libraryId: library.id, relativePath: "Operations/invoice.txt", sessionId: thirdScan.id });
  const unchangedRight = await createObservedFile({ checksum: "b".repeat(64), libraryId: library.id, relativePath: "Finance/payment.txt", sessionId: thirdScan.id });
  await persistent.persistScanWorkingKnowledge(knowledgeIndex(thirdScan.id, library.id, changedLeft, unchangedRight));
  assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKey: { not: null }, status: "ARCHIVED" } }), 1);
  assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKey: { not: null }, status: "NEW" } }), 1);

  const reconsidered = knowledgeIndex(thirdScan.id, library.id, changedLeft, unchangedRight);
  reconsidered.relationships = [];
  await persistent.persistScanWorkingKnowledge(reconsidered);
  assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKey: { not: null }, status: "NEW" } }), 0);
  assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKey: { not: null }, status: "ARCHIVED" } }), 2);
});

test("changed evidence preserves a confirmed relationship as historical", async () => {
  const library = await createLibrary("Confirmed history root");
  const firstScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const left = await createObservedFile({ checksum: "d".repeat(64), libraryId: library.id, relativePath: "Finance/invoice.txt", sessionId: firstScan.id });
  const right = await createObservedFile({ checksum: "e".repeat(64), libraryId: library.id, relativePath: "Finance/payment.txt", sessionId: firstScan.id });
  await persistent.persistScanWorkingKnowledge(knowledgeIndex(firstScan.id, library.id, left, right));
  const original = await prisma.knowledgeConnection.findFirstOrThrow({ where: { sourceFileKey: { not: null }, status: "NEW" } });
  await prisma.knowledgeConnection.update({ data: { status: "CONFIRMED" }, where: { id: original.id } });

  const secondScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const changed = await createObservedFile({ checksum: "f".repeat(64), libraryId: library.id, relativePath: "Finance/invoice.txt", sessionId: secondScan.id });
  const same = await createObservedFile({ checksum: "e".repeat(64), libraryId: library.id, relativePath: "Finance/payment.txt", sessionId: secondScan.id });
  await persistent.persistScanWorkingKnowledge(knowledgeIndex(secondScan.id, library.id, changed, same));

  const historical = await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: original.id } });
  assert.equal(historical.status, "CONFIRMED");
  assert.ok(historical.supersededAt);
  assert.equal(await prisma.knowledgeConnection.count({ where: { sourceFileKey: { not: null }, status: "NEW", supersededAt: null } }), 1);
});

function withVerifiedFields(index: ReturnType<typeof knowledgeIndex>, fileId: string, fields: string) {
  const file = index.files.find((item) => item.id === fileId);
  assert.ok(file);
  file.sourceEvidenceText = `Source characters 40-${40 + fields.length}: "${fields}"`;
  return index;
}

test("explicit client identity connects separate scans without multiplying repeated-file signals", async () => {
  const library = await createLibrary("Entity root");
  const firstScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const first = await createObservedFile({ checksum: "1".repeat(64), libraryId: library.id, relativePath: "Loose/intake.txt", sessionId: firstScan.id });
  const filler = await createObservedFile({ checksum: "2".repeat(64), libraryId: library.id, relativePath: "Other/notes.txt", sessionId: firstScan.id });
  await persistent.persistScanWorkingKnowledge(withVerifiedFields(knowledgeIndex(firstScan.id, library.id, first, filler), first.file.id, "Client: Alex Lee; Client ID: C-101; Project: Intake; Project ID: P-1"));
  assert.equal(await prisma.knowledgeDocumentSignal.count({ where: { connectedLibraryId: library.id, kind: "CLIENT" } }), 1);

  const secondScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const repeated = await createObservedFile({ checksum: "1".repeat(64), libraryId: library.id, relativePath: "Loose/intake.txt", sessionId: secondScan.id });
  const second = await createObservedFile({ checksum: "3".repeat(64), libraryId: library.id, relativePath: "Clients/followup.txt", sessionId: secondScan.id });
  const secondIndex = knowledgeIndex(secondScan.id, library.id, repeated, second);
  withVerifiedFields(secondIndex, repeated.file.id, "Client: Alex Lee; Client ID: C-101; Project: Intake; Project ID: P-1");
  withVerifiedFields(secondIndex, second.file.id, "Client: Alex Lee; Client ID: C-101; Project: Followup; Project ID: P-2");
  await persistent.persistScanWorkingKnowledge(secondIndex);
  assert.equal(await prisma.knowledgeDocumentSignal.count({ where: { connectedLibraryId: library.id, kind: "CLIENT" } }), 2);
  assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKind: "SAME_CLIENT", status: "NEW" } }), 1);
  assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKind: "SAME_PROJECT" } }), 0);
  await persistent.persistScanWorkingKnowledge(secondIndex);
  assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKind: "SAME_CLIENT" } }), 1);
  assert.equal(await prisma.bridgeCommand.count(), 0);
});

test("repeated name-only mentions remain separate unresolved files", async () => {
  const library = await createLibrary("Ambiguous client root");
  const scan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const first = await createObservedFile({ checksum: "a".repeat(64), libraryId: library.id, relativePath: "a.txt", sessionId: scan.id });
  const second = await createObservedFile({ checksum: "b".repeat(64), libraryId: library.id, relativePath: "b.txt", sessionId: scan.id });
  const index = knowledgeIndex(scan.id, library.id, first, second);
  withVerifiedFields(index, first.file.id, "Client: Alex Lee");
  withVerifiedFields(index, second.file.id, "Client: Alex Lee");
  await persistent.persistScanWorkingKnowledge(index);
  const mentions = (await persistent.getPersistentIdentityGroups()).filter((group) => group.kind === "UNRESOLVED_CLIENT" && group.libraryName === library.displayName);
  assert.equal(mentions.length, 2);
  assert.ok(mentions.every((group) => group.members.length === 1));
  const fileKeys = [first, second].map((item) => persistent.persistentFileKey(library.id, item.file.relativePath));
  assert.equal(await prisma.knowledgeConnection.count({ where: {
    relationshipKind: "SAME_CLIENT", sourceFileKey: { in: fileKeys }, targetFileKey: { in: fileKeys },
  } }), 0);
  const signals = await prisma.knowledgeDocumentSignal.findMany({
    orderBy: { relativePath: "asc" },
    where: { connectedLibraryId: library.id, kind: "UNRESOLVED_CLIENT" },
  });
  const reviewed = await persistent.createIdentityCorrection({
    kind: "SAME_CLIENT", note: "These two names refer to the same client.",
    sourceSignalId: signals[0].id, targetSignalId: signals[1].id,
  });
  assert.equal(reviewed.status, "CONFIRMED");
  assert.ok((await persistent.getPersistentIdentityGroups()).some((group) => group.kind === "CLIENT" &&
    group.members.some((member) => member.relativePath === "a.txt") &&
    group.members.some((member) => member.relativePath === "b.txt")));
});

test("read-revoked roots cannot expose or change current identity relationships", async () => {
  const library = await createLibrary("Permission-limited identity root");
  const scan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const first = await createObservedFile({ checksum: "7".repeat(64), libraryId: library.id,
    relativePath: "first.txt", sessionId: scan.id });
  const second = await createObservedFile({ checksum: "8".repeat(64), libraryId: library.id,
    relativePath: "second.txt", sessionId: scan.id });
  const index = knowledgeIndex(scan.id, library.id, first, second);
  for (const item of index.files) withVerifiedFields(index, item.id, "Client ID: C-77");
  await persistent.persistScanWorkingKnowledge(index);
  const signals = await prisma.knowledgeDocumentSignal.findMany({ where: {
    connectedLibraryId: library.id, kind: "CLIENT", status: "ACTIVE",
  } });
  const link = await prisma.knowledgeConnection.findFirstOrThrow({ where: {
    relationshipKind: "SAME_CLIENT", OR: [
      { sourceFileKey: persistent.persistentFileKey(library.id, first.file.relativePath) },
      { targetFileKey: persistent.persistentFileKey(library.id, first.file.relativePath) },
    ],
  } });
  assert.equal(signals.length, 2);
  await prisma.connectedLibrary.update({ data: { readPermission: false }, where: { id: library.id } });
  assert.equal((await persistent.getIdentityCorrectionCandidates()).some((item) => item.connectedLibraryId === library.id), false);
  assert.equal((await persistent.getRecentPersistentFileRelationships()).some((item) => item.id === link.id), false);
  assert.equal((await persistent.getPersistentIdentityGroups()).some((item) => item.libraryName === library.displayName), false);
  await assert.rejects(persistent.reviewPersistentRelationship(link.id, "CONFIRM"));
  await assert.rejects(persistent.createIdentityCorrection({ sourceSignalId: signals[0].id,
    targetSignalId: signals[1].id, kind: "SAME_CLIENT", note: "Test correction" }));
  assert.equal(await prisma.knowledgeConnectionDecision.count({ where: { knowledgeConnectionId: link.id } }), 0);
  assert.equal(await prisma.bridgeCommand.count(), 0);
  await prisma.connectedLibrary.update({ data: { readPermission: true }, where: { id: library.id } });
  await prisma.knowledgeDocumentSignal.update({ data: { generationVersion: "old-signal-version" },
    where: { id: signals[0].id } });
  await assert.rejects(persistent.createIdentityCorrection({ sourceSignalId: signals[0].id,
    targetSignalId: signals[1].id, kind: "SAME_CLIENT", note: "Stale correction" }));
});

test("changed client identity retires provisional links but preserves a human rejection", async () => {
  const library = await createLibrary("Corrected entity root");
  const firstScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const left = await createObservedFile({ checksum: "4".repeat(64), libraryId: library.id, relativePath: "a.txt", sessionId: firstScan.id });
  const right = await createObservedFile({ checksum: "5".repeat(64), libraryId: library.id, relativePath: "b.txt", sessionId: firstScan.id });
  const firstIndex = knowledgeIndex(firstScan.id, library.id, left, right);
  for (const file of firstIndex.files) withVerifiedFields(firstIndex, file.id, "Client: Alex Lee; Client ID: C-101");
  await persistent.persistScanWorkingKnowledge(firstIndex);
  const link = await prisma.knowledgeConnection.findFirstOrThrow({ where: {
    relationshipKind: "SAME_CLIENT",
    OR: [
      { sourceFileKey: persistent.persistentFileKey(library.id, "a.txt") },
      { targetFileKey: persistent.persistentFileKey(library.id, "a.txt") },
    ],
  } });
  await persistent.reviewPersistentRelationship(link.id, "SEPARATE", "These are different clients.");
  assert.equal(await prisma.knowledgeConnectionDecision.count({ where: { knowledgeConnectionId: link.id } }), 1);
  assert.equal((await persistent.getPersistentIdentityGroups()).some((group) => group.libraryName === library.displayName && group.kind === "CLIENT" &&
    group.members.some((member) => member.relativePath === "a.txt") &&
    group.members.some((member) => member.relativePath === "b.txt")), false);
  await persistent.persistScanWorkingKnowledge(firstIndex);
  assert.equal((await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: link.id } })).status, "REJECTED");

  const changedScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const changed = await createObservedFile({ checksum: "6".repeat(64), libraryId: library.id, relativePath: "a.txt", sessionId: changedScan.id });
  const unchanged = await createObservedFile({ checksum: "5".repeat(64), libraryId: library.id, relativePath: "b.txt", sessionId: changedScan.id });
  const changedIndex = knowledgeIndex(changedScan.id, library.id, changed, unchanged);
  withVerifiedFields(changedIndex, changed.file.id, "Client: Alex Lee; Client ID: C-202");
  withVerifiedFields(changedIndex, unchanged.file.id, "Client: Alex Lee; Client ID: C-101");
  await persistent.persistScanWorkingKnowledge(changedIndex);
  assert.equal(await prisma.knowledgeDocumentSignal.count({ where: { fileKey: persistent.persistentFileKey(library.id, "a.txt"), kind: "CLIENT", status: "SUPERSEDED" } }), 1);
  assert.equal(await prisma.knowledgeConnection.count({ where: {
    relationshipKind: "SAME_CLIENT", status: "NEW",
    OR: [
      { sourceFileKey: persistent.persistentFileKey(library.id, "a.txt") },
      { targetFileKey: persistent.persistentFileKey(library.id, "a.txt") },
    ],
  } }), 0);
  const historicalCorrection = await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: link.id } });
  assert.equal(historicalCorrection.status, "REJECTED");
  assert.ok(historicalCorrection.supersededAt);
});

test("a file absent from the latest scan makes its old identity link historical and unreviewable", async () => {
  const library = await createLibrary("Missing file root");
  const firstScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const first = await createObservedFile({ checksum: "3".repeat(64), libraryId: library.id, relativePath: "one.txt", sessionId: firstScan.id });
  const second = await createObservedFile({ checksum: "4".repeat(64), libraryId: library.id, relativePath: "two.txt", sessionId: firstScan.id });
  const index = knowledgeIndex(firstScan.id, library.id, first, second);
  for (const file of index.files) withVerifiedFields(index, file.id, "Client ID: C-1");
  await persistent.persistScanWorkingKnowledge(index);
  const link = await prisma.knowledgeConnection.findFirstOrThrow({ where: {
    relationshipKind: "SAME_CLIENT",
    sourceFileKey: { in: [persistent.persistentFileKey(library.id, "one.txt"), persistent.persistentFileKey(library.id, "two.txt")] },
    targetFileKey: { in: [persistent.persistentFileKey(library.id, "one.txt"), persistent.persistentFileKey(library.id, "two.txt")] },
  } });
  const latestScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const repeated = await createObservedFile({ checksum: "3".repeat(64), libraryId: library.id, relativePath: "one.txt", sessionId: latestScan.id });
  const filler = await createObservedFile({ checksum: "5".repeat(64), libraryId: library.id, relativePath: "other.txt", sessionId: latestScan.id });
  const latestIndex = knowledgeIndex(latestScan.id, library.id, repeated, filler);
  withVerifiedFields(latestIndex, repeated.file.id, "Client ID: C-1");
  await persistent.persistScanWorkingKnowledge(latestIndex);
  const displayed = (await persistent.getRecentPersistentFileRelationships()).find((item) => item.id === link.id);
  assert.equal(displayed?.status, "ARCHIVED");
  assert.equal(displayed?.reviewable, false);
  await assert.rejects(persistent.reviewPersistentRelationship(link.id, "CONFIRM"));
  assert.equal((await persistent.getPersistentIdentityGroups()).some((group) => group.libraryName === library.displayName &&
    group.members.some((member) => member.relativePath === "two.txt")), false);
});

test("human corrections join distinct client labels and assign a document to a project without file actions", async () => {
  const library = await createLibrary("Human correction root");
  const scan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const first = await createObservedFile({ checksum: "b".repeat(64), libraryId: library.id, relativePath: "Clients/one.txt", sessionId: scan.id });
  const second = await createObservedFile({ checksum: "c".repeat(64), libraryId: library.id, relativePath: "Clients/two.txt", sessionId: scan.id });
  const peer = await createObservedFile({ checksum: "0".repeat(64), libraryId: library.id, relativePath: "Clients/peer.txt", sessionId: scan.id });
  const project = await createObservedFile({ checksum: "d".repeat(64), libraryId: library.id, relativePath: "Projects/outreach.txt", sessionId: scan.id });
  const peerIndex = knowledgeIndex(scan.id, library.id, first, peer);
  withVerifiedFields(peerIndex, first.file.id, "Client: Alex Lee; Client ID: C-1");
  withVerifiedFields(peerIndex, peer.file.id, "Client: Alex Lee; Client ID: C-1");
  await persistent.persistScanWorkingKnowledge(peerIndex);
  const provisionalPeerLink = await prisma.knowledgeConnection.findFirstOrThrow({ where: {
    relationshipKind: "SAME_CLIENT", sourceFileKey: { in: [persistent.persistentFileKey(library.id, first.file.relativePath), persistent.persistentFileKey(library.id, peer.file.relativePath)] },
    targetFileKey: { in: [persistent.persistentFileKey(library.id, first.file.relativePath), persistent.persistentFileKey(library.id, peer.file.relativePath)] },
  } });
  const clientIndex = knowledgeIndex(scan.id, library.id, first, second);
  withVerifiedFields(clientIndex, first.file.id, "Client: Alex Lee; Client ID: C-1");
  withVerifiedFields(clientIndex, second.file.id, "Client: A. Lee; Client ID: C-2");
  await persistent.persistScanWorkingKnowledge(clientIndex);
  assert.equal(await prisma.knowledgeConnection.count({ where: {
    relationshipKind: "SAME_CLIENT",
    sourceFileKey: { in: [persistent.persistentFileKey(library.id, first.file.relativePath), persistent.persistentFileKey(library.id, second.file.relativePath)] },
    targetFileKey: { in: [persistent.persistentFileKey(library.id, first.file.relativePath), persistent.persistentFileKey(library.id, second.file.relativePath)] },
  } }), 0);
  const projectIndex = knowledgeIndex(scan.id, library.id, first, project);
  withVerifiedFields(projectIndex, first.file.id, "Client: Alex Lee; Client ID: C-1");
  withVerifiedFields(projectIndex, project.file.id, "Project: Outreach; Project ID: P-1; Client ID: C-2");
  await persistent.persistScanWorkingKnowledge(projectIndex);
  const plain = await createObservedFile({ checksum: "1".repeat(64), libraryId: library.id, relativePath: "Loose/untitled.txt", sessionId: scan.id });
  const plainIndex = knowledgeIndex(scan.id, library.id, plain, project);
  withVerifiedFields(plainIndex, project.file.id, "Project: Outreach; Project ID: P-1; Client ID: C-2");
  await persistent.persistScanWorkingKnowledge(plainIndex);
  const source = await prisma.knowledgeDocumentSignal.findFirstOrThrow({ where: { fileKey: persistent.persistentFileKey(library.id, first.file.relativePath), kind: "CLIENT", status: "ACTIVE" } });
  const target = await prisma.knowledgeDocumentSignal.findFirstOrThrow({ where: { fileKey: persistent.persistentFileKey(library.id, second.file.relativePath), kind: "CLIENT", status: "ACTIVE" } });
  const projectSignal = await prisma.knowledgeDocumentSignal.findFirstOrThrow({ where: { fileKey: persistent.persistentFileKey(library.id, project.file.relativePath), kind: "PROJECT", status: "ACTIVE" } });
  const plainAnchor = await prisma.knowledgeDocumentSignal.findFirstOrThrow({ where: { fileKey: persistent.persistentFileKey(library.id, plain.file.relativePath), kind: "FILE_ANCHOR", status: "ACTIVE" } });
  const sameClient = await persistent.createIdentityCorrection({ sourceSignalId: source.id, targetSignalId: target.id, kind: "SAME_CLIENT", note: "I verified these are the same client." });
  assert.equal(sameClient.status, "CONFIRMED");
  assert.equal((await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: provisionalPeerLink.id } })).status, "REJECTED");
  assert.equal(await prisma.knowledgeConnectionDecision.count({ where: { knowledgeConnectionId: provisionalPeerLink.id, action: "HUMAN_CORRECTION" } }), 1);
  await persistent.createIdentityCorrection({ sourceSignalId: source.id, targetSignalId: target.id, kind: "SAME_CLIENT", note: "Repeated click" });
  assert.equal(await prisma.knowledgeConnectionDecision.count({ where: { knowledgeConnectionId: sameClient.id } }), 1);
  assert.ok((await persistent.getPersistentIdentityGroups()).some((group) => group.kind === "CLIENT" &&
    group.members.some((member) => member.relativePath === first.file.relativePath) &&
    group.members.some((member) => member.relativePath === second.file.relativePath)));
  const belongs = await persistent.createIdentityCorrection({ sourceSignalId: plainAnchor.id, targetSignalId: projectSignal.id, kind: "BELONGS_TO_PROJECT", note: "This is part of Outreach." });
  assert.equal(belongs.status, "CONFIRMED");
  assert.ok((await persistent.getPersistentIdentityGroups()).some((group) => group.kind === "PROJECT" &&
    group.members.some((member) => member.relativePath === plain.file.relativePath) &&
    group.members.some((member) => member.relativePath === project.file.relativePath) &&
    group.contextFiles.includes(second.file.relativePath)));
  await persistent.persistScanWorkingKnowledge(clientIndex);
  assert.equal((await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: sameClient.id } })).status, "CONFIRMED");
  const newPeer = await createObservedFile({ checksum: "2".repeat(64), libraryId: library.id, relativePath: "Clients/new-peer.txt", sessionId: scan.id });
  const laterIndex = knowledgeIndex(scan.id, library.id, first, newPeer);
  withVerifiedFields(laterIndex, first.file.id, "Client: Alex Lee; Client ID: C-1");
  withVerifiedFields(laterIndex, newPeer.file.id, "Client: Alex Lee; Client ID: C-1");
  await persistent.persistScanWorkingKnowledge(laterIndex);
  const oldAndNewKeys = [first, newPeer].map((item) => persistent.persistentFileKey(library.id, item.file.relativePath));
  assert.equal(await prisma.knowledgeConnection.count({ where: {
    relationshipKind: "SAME_CLIENT", status: "NEW", sourceFileKey: { in: oldAndNewKeys }, targetFileKey: { in: oldAndNewKeys },
  } }), 0);
  assert.ok((await persistent.getPersistentIdentityGroups()).some((group) => group.kind === "CLIENT" &&
    group.members.some((member) => member.relativePath === first.file.relativePath) &&
    group.members.some((member) => member.relativePath === second.file.relativePath)));
  const otherLibrary = await createLibrary("Different root");
  const otherScan = await prisma.scanSession.create({ data: { connectedFolderId: otherLibrary.id, status: "COMPLETED" } });
  const other = await createObservedFile({ checksum: "e".repeat(64), libraryId: otherLibrary.id, relativePath: "outside.txt", sessionId: otherScan.id });
  const otherFiller = await createObservedFile({ checksum: "f".repeat(64), libraryId: otherLibrary.id, relativePath: "other.txt", sessionId: otherScan.id });
  const otherIndex = knowledgeIndex(otherScan.id, otherLibrary.id, other, otherFiller);
  withVerifiedFields(otherIndex, other.file.id, "Client ID: C-2");
  await persistent.persistScanWorkingKnowledge(otherIndex);
  const outside = await prisma.knowledgeDocumentSignal.findFirstOrThrow({ where: { connectedLibraryId: otherLibrary.id, kind: "CLIENT" } });
  await assert.rejects(persistent.createIdentityCorrection({ sourceSignalId: source.id, targetSignalId: outside.id, kind: "SAME_CLIENT", note: "Cannot cross roots." }));
  assert.equal(await prisma.bridgeCommand.count(), 0);
  assert.equal(await prisma.executionRun.count(), 0);
});

test("explicit v1/v2 forms a revision link while identical copies and filenames do not", async () => {
  const library = await createLibrary("Version root");
  const scan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const first = await createObservedFile({ checksum: "7".repeat(64), libraryId: library.id, relativePath: "final.txt", sessionId: scan.id });
  const second = await createObservedFile({ checksum: "8".repeat(64), libraryId: library.id, relativePath: "final2.txt", sessionId: scan.id });
  const index = knowledgeIndex(scan.id, library.id, first, second);
  withVerifiedFields(index, first.file.id, "Client ID: C-1; Document ID: D-42; Document Title: Annual Plan; Version: v1");
  withVerifiedFields(index, second.file.id, "Client ID: C-1; Document ID: D-42; Document Title: Annual Plan; Version: v2");
  await persistent.persistScanWorkingKnowledge(index);
  const revision = await prisma.knowledgeConnection.findFirstOrThrow({ where: { relationshipKind: "PROBABLE_REVISION" } });
  assert.equal(JSON.stringify(revision.sourceEvidence).includes("Alex Lee"), false);
  assert.ok(JSON.stringify(revision.sourceEvidence).includes("newerFileKey"));
  const initialFamily = (await persistent.getPersistentIdentityGroups()).find((group) =>
    group.kind === "DOCUMENT_FAMILY" && group.members.some((member) => member.relativePath === "final.txt"),
  );
  assert.equal(initialFamily?.latestKey, persistent.persistentFileKey(library.id, "final2.txt"));
  await persistent.persistScanWorkingKnowledge(index);
  assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKind: "PROBABLE_REVISION" } }), 1);

  const sameScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const copy = await createObservedFile({ checksum: "7".repeat(64), libraryId: library.id, relativePath: "copy.txt", sessionId: sameScan.id });
  const other = await createObservedFile({ checksum: "9".repeat(64), libraryId: library.id, relativePath: "unrelated-final2.txt", sessionId: sameScan.id });
  await createObservedFile({ checksum: "8".repeat(64), libraryId: library.id, relativePath: "final2.txt", sessionId: sameScan.id });
  const copyIndex = knowledgeIndex(sameScan.id, library.id, copy, other);
  withVerifiedFields(copyIndex, copy.file.id, "Client ID: C-1; Document ID: D-42; Document Title: Annual Plan; Version: v1");
  await persistent.persistScanWorkingKnowledge(copyIndex);
  assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKind: "PROBABLE_REVISION" } }), 2);
  assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKind: "PROBABLE_REVISION", OR: [
    { sourceFileKey: persistent.persistentFileKey(library.id, "final.txt"), targetFileKey: persistent.persistentFileKey(library.id, "copy.txt") },
    { sourceFileKey: persistent.persistentFileKey(library.id, "copy.txt"), targetFileKey: persistent.persistentFileKey(library.id, "final.txt") },
  ] } }), 0);

  const changedScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const revised = await createObservedFile({ checksum: "a".repeat(64), libraryId: library.id, relativePath: "final.txt", sessionId: changedScan.id });
  const stillV2 = await createObservedFile({ checksum: "8".repeat(64), libraryId: library.id, relativePath: "final2.txt", sessionId: changedScan.id });
  const revisedIndex = knowledgeIndex(changedScan.id, library.id, revised, stillV2);
  withVerifiedFields(revisedIndex, revised.file.id, "Client ID: C-1; Document ID: D-42; Document Title: Annual Plan; Version: v3");
  withVerifiedFields(revisedIndex, stillV2.file.id, "Client ID: C-1; Document ID: D-42; Document Title: Annual Plan; Version: v2");
  await persistent.persistScanWorkingKnowledge(revisedIndex);
  assert.ok((await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: revision.id } })).supersededAt);
  const updatedFamily = (await persistent.getPersistentIdentityGroups()).find((group) =>
    group.kind === "DOCUMENT_FAMILY" && group.members.some((member) => member.relativePath === "final.txt"),
  );
  assert.equal(updatedFamily?.latestKey, persistent.persistentFileKey(library.id, "final.txt"));
});

test("distinct paths stay distinct and generic-only relationships do not persist", async () => {
  assert.notEqual(
    persistent.persistentFileKey("root-a", "Loose/Copy-1.txt"),
    persistent.persistentFileKey("root-a", "Loose/Copy-2.txt"),
  );
  assert.equal(
    persistent.persistentFileKey("root-a", "Loose\\COPY-1.txt"),
    persistent.persistentFileKey("root-a", "loose/copy-1.txt"),
  );
  const index = knowledgeIndex("synthetic", "root-a", { file: { id: "a", relativePath: "a.txt" } }, { file: { id: "b", relativePath: "b.txt" } });
  index.relationships[0].supportingTopics = [];
  assert.equal(persistent.selectPersistentRelationships(index).length, 0);
});

test("a checksum-verified Bridge move preserves identity, but an undone move does not", () => {
  const move = {
    checksum: "a".repeat(64),
    destinationRelativePath: "Finance/invoice.txt",
    sourceRelativePath: "Loose/invoice.txt",
    undone: false,
  };
  assert.equal(
    persistent.fileKeyAfterKnownMoves("root-a", "Finance/invoice.txt", move.checksum, [move]),
    persistent.persistentFileKey("root-a", "Loose/invoice.txt"),
  );
  assert.equal(
    persistent.fileKeyAfterKnownMoves("root-a", "Finance/invoice.txt", "b".repeat(64), [move]),
    persistent.persistentFileKey("root-a", "Finance/invoice.txt"),
  );
  assert.equal(
    persistent.fileKeyAfterKnownMoves("root-a", "Finance/invoice.txt", move.checksum, [{ ...move, undone: true }]),
    persistent.persistentFileKey("root-a", "Finance/invoice.txt"),
  );
});

test("large scans keep rare grounded subjects connected without unbounded pairs", async () => {
  const { buildScanWorkingKnowledge } = await import("../../src/lib/bridge/scan-working-knowledge");
  const files = Array.from({ length: 260 }, (_, index) => ({
    connectedLibraryId: "large-root",
    fileType: "TEXT",
    id: `ordinary-${index}`,
    observationSessions: [],
    previewText: "General unrelated document material.",
    relativePath: `Other/${index}.txt`,
  }));
  files.push({ ...files[0], id: "workshop-a", previewText: "Workshop facilitation training curriculum.", relativePath: "Events/a.txt" });
  files.push({ ...files[0], id: "workshop-b", previewText: "Workshop facilitation training materials.", relativePath: "Events/b.txt" });
  const index = buildScanWorkingKnowledge({ files, scanSessionId: "large-scan" });
  assert.ok(index.relationships.some((relationship) =>
    [relationship.leftFileId, relationship.rightFileId].sort().join(":") === "workshop-a:workshop-b",
  ));
  assert.ok(index.relationships.length <= 20_000);
});

test("disconnected roots provide no new persistent relationships", async () => {
  const library = await createLibrary("Disconnected Root");
  const scan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const left = await createObservedFile({ checksum: "1".repeat(64), libraryId: library.id, relativePath: "a.txt", sessionId: scan.id });
  const right = await createObservedFile({ checksum: "2".repeat(64), libraryId: library.id, relativePath: "b.txt", sessionId: scan.id });
  await prisma.connectedLibrary.update({ data: { isEnabled: false, status: "DISCONNECTED" }, where: { id: library.id } });
  assert.equal(await persistent.persistScanWorkingKnowledge(knowledgeIndex(scan.id, library.id, left, right)), 0);
});

async function createReviewedMove(libraryId: string, source: string) {
  const scan = await prisma.scanSession.create({ data: { connectedFolderId: libraryId, status: "COMPLETED" } });
  const file = await prisma.scannedFile.create({
    data: {
      checksum: crypto.randomUUID().replaceAll("-", ""),
      fileType: "TEXT",
      localPath: `bridge://${libraryId}/${source}`,
      relativePath: source,
      sessionId: scan.id,
    },
  });
  return prisma.organizationSuggestion.create({
    data: {
      confidence: 0.78,
      currentRelativePath: source,
      explanation: "Current document evidence supports Finance.",
      proposedRelativePath: `Finance/${source.split("/").at(-1)}`,
      recommendationGenerationId: crypto.randomUUID(),
      recommendationGenerationVersion: recommendationVersion,
      scanSessionId: scan.id,
      scannedFileId: file.id,
      status: "APPROVED",
      suggestionKey: crypto.randomUUID(),
      suggestionType: "MOVE_FILE",
      supportingInformation: ["Source location: characters 0-50 of extracted text."],
      title: "Move to Finance",
      whySuggested: ["Content concepts: invoice, payment"],
    },
  });
}

test("two reviewed moves propose a local rule, but only explicit approval activates it", async () => {
  const library = await createLibrary("Preference Root");
  const otherLibrary = await createLibrary("Unrelated Root");
  await createReviewedMove(library.id, "Loose/invoice-one.txt");
  assert.equal(await preferences.proposeOrganizationPreferences(library.id), 0);
  await createReviewedMove(library.id, "Loose/invoice-two.txt");
  assert.equal(await preferences.proposeOrganizationPreferences(library.id), 1);
  assert.equal(await preferences.proposeOrganizationPreferences(library.id), 0);
  const proposal = await prisma.organizationPreference.findFirstOrThrow({ where: { connectedLibraryId: library.id } });
  assert.equal(proposal.status, "PROPOSED");
  assert.equal(proposal.destinationRelativePath, "Finance");
  assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: library.id, contentText: "invoice payment", destination: "finance" })).length, 0);
  await preferences.reviewOrganizationPreference(proposal.id, { action: "APPROVE" });
  assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: library.id, contentText: "invoice payment", destination: "finance" })).length, 1);
  await prisma.connectedLibrary.update({ data: { isEnabled: false, status: "DISCONNECTED" }, where: { id: library.id } });
  assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: library.id, contentText: "invoice payment", destination: "finance" })).length, 0);
  await prisma.connectedLibrary.update({ data: { isEnabled: true, status: "CONNECTED" }, where: { id: library.id } });
  const futureScan = await prisma.scanSession.create({ data: { connectedFolderId: library.id, status: "COMPLETED" } });
  const future = await createObservedFile({
    checksum: "f".repeat(64),
    libraryId: library.id,
    relativePath: "Loose/invoice-future.txt",
    sessionId: futureScan.id,
  });
  const { generateOrganizationSuggestionsForScannedFileWithText } = await import("../../src/lib/bridge/organization-suggestions");
  await generateOrganizationSuggestionsForScannedFileWithText(
    future.file.id,
    "Invoice payment expenses accounting records for the current office.",
  );
  const moved = await prisma.organizationSuggestion.findFirst({
    where: { scannedFileId: future.file.id, suggestionType: "MOVE_FILE" },
  });
  assert.ok(moved);
  assert.equal(JSON.stringify(moved.supportingInformation).includes("separately approved organization preference"), true);
  assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: library.id, contentText: "invoice payment", destination: "workshops" })).length, 0);
  assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: library.id, contentText: "unrelated personal notes", destination: "finance" })).length, 0);
  assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: otherLibrary.id, contentText: "invoice payment", destination: "finance" })).length, 0);
  await preferences.reviewOrganizationPreference(proposal.id, { action: "ARCHIVE" });
  assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: library.id, contentText: "invoice payment", destination: "finance" })).length, 0);
  assert.equal(await prisma.organizationPreferenceRevision.count({ where: { preferenceId: proposal.id } }), 2);
});

test("reset or regeneration disputes supporting decisions without filesystem commands", async () => {
  const library = await createLibrary("Dispute Root");
  const first = await createReviewedMove(library.id, "Loose/invoice-a.txt");
  await createReviewedMove(library.id, "Loose/invoice-b.txt");
  await preferences.proposeOrganizationPreferences(library.id);
  const proposal = await prisma.organizationPreference.findFirstOrThrow({ where: { connectedLibraryId: library.id } });
  await preferences.reviewOrganizationPreference(proposal.id, { action: "APPROVE" });
  await preferences.disputePreferencesFromDecisions([first.id]);
  assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: library.id, contentText: "invoice payment", destination: "finance" })).length, 0);
  assert.equal(await prisma.bridgeCommand.count(), 0);
  assert.equal(await prisma.executionRun.count(), 0);
});

test("editing an approved preference pauses it until reapproval and preserves revisions", async () => {
  const library = await createLibrary("Edited Preference Root");
  await createReviewedMove(library.id, "Loose/invoice-c.txt");
  await createReviewedMove(library.id, "Loose/invoice-d.txt");
  await preferences.proposeOrganizationPreferences(library.id);
  const proposal = await prisma.organizationPreference.findFirstOrThrow({ where: { connectedLibraryId: library.id } });
  await preferences.reviewOrganizationPreference(proposal.id, { action: "APPROVE" });
  const edited = await preferences.reviewOrganizationPreference(proposal.id, {
    action: "EDIT",
    destination: "Accounting",
    note: "Keep this category together under Accounting.",
    scopeTerms: ["invoice", "payment"],
  });
  assert.equal(edited.status, "PROPOSED");
  await assert.rejects(
    preferences.reviewOrganizationPreference(proposal.id, { action: "EDIT", destination: "." }),
    /Choose a folder inside the connected library/,
  );
  assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: library.id, contentText: "invoice payment", destination: "Finance" })).length, 0);
  await preferences.reviewOrganizationPreference(proposal.id, { action: "APPROVE" });
  assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: library.id, contentText: "invoice payment", destination: "Accounting" })).length, 1);
  assert.equal(await prisma.organizationPreferenceRevision.count({ where: { preferenceId: proposal.id } }), 3);

  const conflict = await prisma.organizationPreference.create({
    data: {
      connectedLibraryId: library.id,
      destinationRelativePath: "Other Finance",
      evidence: [],
      proposalKey: crypto.randomUUID(),
      scopeTerms: ["invoice", "payment"],
      sourceDecisionIds: (proposal.sourceDecisionIds as string[]),
    },
  });
  await assert.rejects(
    preferences.reviewOrganizationPreference(conflict.id, { action: "APPROVE" }),
    /same scope but a different destination/,
  );
});

test("simultaneous conflicting preference approvals leave at most one active destination", async () => {
  const library = await createLibrary("Concurrent Preference Root");
  const first = await createReviewedMove(library.id, "Loose/concurrent-one.txt");
  const second = await createReviewedMove(library.id, "Loose/concurrent-two.txt");
  const base = {
    connectedLibraryId: library.id,
    evidence: [],
    scopeTerms: ["invoice", "payment"],
    sourceDecisionIds: [first.id, second.id],
  };
  const a = await prisma.organizationPreference.create({
    data: { ...base, destinationRelativePath: "Finance", proposalKey: crypto.randomUUID() },
  });
  const b = await prisma.organizationPreference.create({
    data: { ...base, destinationRelativePath: "Accounting", proposalKey: crypto.randomUUID() },
  });
  const results = await Promise.allSettled([
    preferences.reviewOrganizationPreference(a.id, { action: "APPROVE" }),
    preferences.reviewOrganizationPreference(b.id, { action: "APPROVE" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(await prisma.organizationPreference.count({
    where: { connectedLibraryId: library.id, status: "APPROVED", disputedAt: null },
  }), 1);
});

async function reviewedIdentityFixture(name: string) {
  const library = await createLibrary(name);
  const scan = await prisma.scanSession.create({ data: { connectedFolderId: library.id,
    status: "COMPLETED", searchIndexStatus: "COMPLETED", startedAt: new Date("2026-09-01T00:00:00Z") } });
  const left = await createObservedFile({ checksum: "a".repeat(64), libraryId: library.id,
    relativePath: "Clients/intake.txt", sessionId: scan.id });
  const right = await createObservedFile({ checksum: "b".repeat(64), libraryId: library.id,
    relativePath: "Clients/followup.txt", sessionId: scan.id });
  const index = knowledgeIndex(scan.id, library.id, left, right);
  for (const item of [left, right]) {
    withVerifiedFields(index, item.file.id, "Client ID: C-101; Project ID: P-101");
    await prisma.observationSession.update({ data: { observerType: "OPENAI",
      observations: [{ evidence: [index.files.find((file) => file.id === item.file.id)!.sourceEvidenceText] }] },
      where: { id: item.observation.id } });
  }
  await persistent.persistScanWorkingKnowledge(index);
  const indexer = await import("../../src/lib/library/search-index");
  await indexer.indexScanKnowledge(index);
  return { library, scan, left, right, index, indexer };
}

test("rejecting an observation retires its identities and links before search refresh, retaining reviewed history", async () => {
  const fixture = await reviewedIdentityFixture("Rejected identity lifecycle");
  const { library, left, right, indexer } = fixture;
  const approvedHistory = await prisma.observationSession.create({ data: {
    libraryDocumentId: left.observation.libraryDocumentId, observerType: "OPENAI", status: "APPROVED",
    createdAt: new Date("2025-01-01T00:00:00Z"), confidence: 0.7,
    observations: [{ evidence: ['Source characters 0-16: "Client ID: C-055"'] }],
    explanation: [], interpretations: [], planSuggestions: [], warnings: [],
  } });
  const link = await prisma.knowledgeConnection.findFirstOrThrow({ where: {
    relationshipKind: "SAME_CLIENT", sourceObservationSessionId: { in: [left.observation.id, right.observation.id] },
  } });
  await persistent.reviewPersistentRelationship(link.id, "CONFIRM", "Earlier human review.");
  const { saveHumanDecision } = await import("../../src/lib/library/observation-sessions");
  const decision = await saveHumanDecision(left.observation.id, { decisionType: "REJECT" });
  const retired = await prisma.knowledgeDocumentSignal.findFirstOrThrow({ where: {
    observationSessionId: left.observation.id, kind: "CLIENT", status: "SUPERSEDED",
  } });
  const retry = await saveHumanDecision(left.observation.id, { decisionType: "REJECT" });
  assert.equal(retry.decisionId, decision.decisionId);
  assert.equal(await prisma.humanDecision.count({ where: { observationSessionId: left.observation.id } }), 1);
  assert.equal((await prisma.knowledgeDocumentSignal.findUniqueOrThrow({ where: { id: retired.id } })).supersededAt?.getTime(), retired.supersededAt?.getTime());
  const historical = await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: link.id } });
  assert.equal(historical.status, "CONFIRMED");
  assert.ok(historical.supersededAt);
  assert.equal(await prisma.knowledgeConnectionDecision.count({ where: { knowledgeConnectionId: link.id } }), 1);
  assert.equal(await prisma.knowledgeConnection.count({ where: { supersededAt: null, status: "NEW",
    OR: [{ sourceObservationSessionId: left.observation.id }, { targetObservationSessionId: left.observation.id }] } }), 0);
  assert.ok(await prisma.knowledgeDocumentSignal.count({ where: { observationSessionId: right.observation.id, kind: "CLIENT", status: "ACTIVE" } }));
  await indexer.refreshSearchForObservation(left.observation.id);
  assert.deepEqual((await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: left.file.id } })).entityHashes, []);
  assert.equal((await prisma.observationSession.findUniqueOrThrow({ where: { id: approvedHistory.id } })).status, "APPROVED");
  const { loadScanWorkingKnowledge } = await import("../../src/lib/bridge/scan-working-knowledge");
  const rejectedWorking = (await loadScanWorkingKnowledge(fixture.scan.id)).files.find((file) => file.id === left.file.id)!;
  assert.equal(rejectedWorking.sourceEvidenceText, "");
  assert.deepEqual(rejectedWorking.trustedObservationEvidence, []);
  assert.equal((await persistent.getPersistentIdentityGroups()).some((group) => group.libraryName === library.displayName &&
    group.kind === "CLIENT" && group.members.some((file) => file.relativePath === left.file.relativePath)), false);
  const { retrieveQuestionContext } = await import("../../src/lib/library/qa/retrieve");
  assert.deepEqual((await retrieveQuestionContext("Client C-101", [library.id])).relationships, []);
  await persistent.persistScanWorkingKnowledge(fixture.index);
  assert.equal(await prisma.knowledgeDocumentSignal.count({ where: {
    observationSessionId: left.observation.id, kind: "CLIENT", status: "ACTIVE",
  } }), 0);
  assert.equal(await prisma.bridgeCommand.count(), 0);
});

test("human observation corrections supersede provisional identity hashes and remain idempotent after a note or regeneration", async () => {
  const { left, library, index, indexer, scan } = await reviewedIdentityFixture("Corrected identity lifecycle");
  const { saveHumanDecision } = await import("../../src/lib/library/observation-sessions");
  const correction = { decisionType: "MODIFY" as const, editedSuggestion: "Client ID: C-202; Project ID: P-202" };
  const first = await saveHumanDecision(left.observation.id, correction);
  const retry = await saveHumanDecision(left.observation.id, correction);
  assert.equal(first.decisionId, retry.decisionId);
  const signals = await prisma.knowledgeDocumentSignal.findMany({ where: {
    observationSessionId: left.observation.id, status: "ACTIVE", kind: { not: "FILE_ANCHOR" },
  } });
  const { extractDocumentSignals } = await import("../../src/lib/bridge/document-signals");
  assert.deepEqual(signals.map((signal) => signal.identityHash).sort(),
    extractDocumentSignals(correction.editedSuggestion, library.id).map((signal) => signal.identityHash).sort());
  assert.ok(signals.every((signal) => JSON.stringify(signal.sourceRanges) === "[]"));
  assert.equal(await prisma.knowledgeDocumentSignal.count({ where: {
    observationSessionId: left.observation.id, status: "SUPERSEDED", kind: { in: ["CLIENT", "PROJECT"] },
  } }), 2);
  await saveHumanDecision(left.observation.id, { decisionType: "NOTE", note: "Correction remains authoritative." });
  await indexer.refreshSearchForObservation(left.observation.id);
  const entry = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: left.file.id } });
  assert.deepEqual(entry.entityHashes.sort(), signals.map((signal) => signal.identityHash).sort());
  assert.equal(entry.knowledgeState, "APPROVED");
  await persistent.persistScanWorkingKnowledge(index);
  const { loadScanWorkingKnowledge } = await import("../../src/lib/bridge/scan-working-knowledge");
  const working = (await loadScanWorkingKnowledge(scan.id)).files.find((file) => file.id === left.file.id)!;
  assert.deepEqual(working.provisionalWorkingEvidence, []);
  assert.deepEqual(working.trustedObservationEvidence, [correction.editedSuggestion]);
  assert.equal(await prisma.knowledgeConnection.count({ where: { status: "NEW", supersededAt: null,
    OR: [{ sourceObservationSessionId: left.observation.id }, { targetObservationSessionId: left.observation.id }],
  } }), 0);
  assert.equal(await prisma.bridgeCommand.count(), 0);
});

test("incomplete and failed snapshots cannot replace completed identities, search or QA; a completed snapshot can", async () => {
  const { library, left, right, scan, indexer } = await reviewedIdentityFixture("Stable completed snapshot");
  const link = await prisma.knowledgeConnection.findFirstOrThrow({ where: {
    relationshipKind: "SAME_CLIENT", sourceObservationSessionId: { in: [left.observation.id, right.observation.id] },
  } });
  const next = await prisma.scanSession.create({ data: { connectedFolderId: library.id,
    startedAt: new Date("2026-09-02T00:00:00Z"), status: "PENDING" } });
  const replacement = await createObservedFile({ checksum: "c".repeat(64), libraryId: library.id,
    relativePath: left.file.relativePath, sessionId: next.id });
  const nextIndex = withVerifiedFields(knowledgeIndex(next.id, library.id, replacement, replacement), replacement.file.id, "Client ID: C-202");
  const { searchLibrary } = await import("../../src/lib/library/search");
  const { retrieveQuestionContext } = await import("../../src/lib/library/qa/retrieve");
  for (const status of ["PENDING", "SCANNING", "READING", "EXAMINING", "GENERATING_SUGGESTIONS", "FAILED"] as const) {
    await prisma.scanSession.update({ data: { status }, where: { id: next.id } });
    assert.equal(await persistent.persistScanWorkingKnowledge(nextIndex), 0);
    assert.equal(await indexer.indexScanKnowledge(nextIndex), 0);
    await indexer.refreshSearchForObservation(left.observation.id);
    assert.ok((await persistent.getPersistentIdentityGroups()).some((group) => group.libraryName === library.displayName && group.members.length === 2));
    const displayed = (await persistent.getRecentPersistentFileRelationships()).find((item) => item.id === link.id);
    assert.equal(displayed?.status, "NEW");
    assert.equal(displayed?.reviewable, true);
    assert.ok((await searchLibrary("intake.txt", [library.id])).some((result) => result.href.includes(scan.id)));
    const context = await retrieveQuestionContext("Client C-101", [library.id]);
    assert.ok(context.sources.length > 0);
    assert.ok(context.sources.every((source) => source.href.includes(scan.id)));
    assert.equal(context.indexIncomplete, true);
  }
  await persistent.reviewPersistentRelationship(link.id, "CONFIRM", "The completed sources remain current.");
  await prisma.scanSession.update({ data: { status: "COMPLETED_WITH_ERRORS" }, where: { id: next.id } });
  await persistent.persistScanWorkingKnowledge(nextIndex);
  await indexer.indexScanKnowledge(nextIndex);
  assert.equal((await persistent.getRecentPersistentFileRelationships()).find((item) => item.id === link.id)?.status, "ARCHIVED");
  assert.equal((await persistent.getPersistentIdentityGroups()).some((group) => group.libraryName === library.displayName &&
    group.members.some((file) => file.relativePath === right.file.relativePath)), false);
  assert.equal((await searchLibrary("followup.txt", [library.id])).length, 0);
  assert.equal(await prisma.bridgeCommand.count(), 0);
});
