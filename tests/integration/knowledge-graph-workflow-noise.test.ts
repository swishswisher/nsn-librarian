import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@prisma/client";

import type { backfillKnowledgeGraph as backfillKnowledgeGraphType } from "../../src/lib/knowledge/graph";
import type { cleanupWorkflowKnowledgeNoise as cleanupWorkflowKnowledgeNoiseType } from "../../src/lib/knowledge/graph";
import type { extractKnowledgeCandidates as extractKnowledgeCandidatesType } from "../../src/lib/knowledge/provenance";
import type { isWorkflowKnowledgeName as isWorkflowKnowledgeNameType } from "../../src/lib/knowledge/provenance";

type BackfillKnowledgeGraph = typeof backfillKnowledgeGraphType;
type CleanupWorkflowKnowledgeNoise = typeof cleanupWorkflowKnowledgeNoiseType;
type ExtractKnowledgeCandidates = typeof extractKnowledgeCandidatesType;
type IsWorkflowKnowledgeName = typeof isWorkflowKnowledgeNameType;

let prisma: PrismaClient;
let backfillKnowledgeGraph: BackfillKnowledgeGraph;
let cleanupWorkflowKnowledgeNoise: CleanupWorkflowKnowledgeNoise;
let extractKnowledgeCandidates: ExtractKnowledgeCandidates;
let isWorkflowKnowledgeName: IsWorkflowKnowledgeName;
let evidenceFromJson: typeof import("../../src/lib/knowledge/provenance").evidenceFromJson;
let knowledgeRelationshipProposalLabel: typeof import("../../src/lib/knowledge/presentation").knowledgeRelationshipProposalLabel;
let organizationHistoryLocationsFromEvidence: typeof import("../../src/lib/knowledge/presentation").organizationHistoryLocationsFromEvidence;
let testDatabaseUrl: string;
let testDirectDatabaseUrl: string;

const testSchemaName = `knowledge_graph_noise_test_${process.pid}_${Date.now()}`;

function databaseUrlForSchema(
  schemaName: string,
  databaseUrl = process.env.DATABASE_URL,
) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Knowledge Graph tests.");
  }

  const url = new URL(databaseUrl);
  url.searchParams.set("schema", schemaName);

  return url.toString();
}

function runPrismaDbPush() {
  execFileSync(process.execPath, [
    "node_modules/prisma/build/index.js",
    "db",
    "push",
    "--skip-generate",
  ], {
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
      DIRECT_URL: testDirectDatabaseUrl,
    },
    stdio: "pipe",
  });
}

async function resetTestData() {
  await prisma.knowledgeRelationshipRevision.deleteMany();
  await prisma.knowledgeObjectRevision.deleteMany();
  await prisma.knowledgeRelationship.deleteMany();
  await prisma.knowledgeObjectMerge.deleteMany();
  await prisma.knowledgeObject.deleteMany();
  await prisma.organizationPlan.deleteMany();
  await prisma.organizationSuggestionRevision.deleteMany();
  await prisma.organizationSuggestion.deleteMany();
  await prisma.notebookEntryRevision.deleteMany();
  await prisma.notebookEntry.deleteMany();
  await prisma.memoryEntry.deleteMany();
  await prisma.scannedFile.deleteMany();
  await prisma.scanSession.deleteMany();
  await prisma.connectedLibrary.deleteMany();
}

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

before(async () => {
  testDatabaseUrl = databaseUrlForSchema(testSchemaName);
  testDirectDatabaseUrl = databaseUrlForSchema(
    testSchemaName,
    process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  );
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.DIRECT_URL = testDirectDatabaseUrl;
  runPrismaDbPush();

  const prismaModule = await import("../../src/lib/db/prisma");
  const graphModule = await import("../../src/lib/knowledge/graph");
  const provenanceModule = await import("../../src/lib/knowledge/provenance");
  const presentationModule = await import("../../src/lib/knowledge/presentation");

  prisma = prismaModule.getPrismaClient();
  backfillKnowledgeGraph = graphModule.backfillKnowledgeGraph;
  cleanupWorkflowKnowledgeNoise = graphModule.cleanupWorkflowKnowledgeNoise;
  extractKnowledgeCandidates = provenanceModule.extractKnowledgeCandidates;
  isWorkflowKnowledgeName = provenanceModule.isWorkflowKnowledgeName;
  evidenceFromJson = provenanceModule.evidenceFromJson;
  knowledgeRelationshipProposalLabel =
    presentationModule.knowledgeRelationshipProposalLabel;
  organizationHistoryLocationsFromEvidence =
    presentationModule.organizationHistoryLocationsFromEvidence;
});

beforeEach(async () => {
  await resetTestData();
});

after(async () => {
  await prisma?.$disconnect();

  const cleanupPrisma = new PrismaClient();

  await cleanupPrisma.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`,
  );
  await cleanupPrisma.$disconnect();
});

async function createScannedFile(relativePath: string) {
  const connectedLibrary = await prisma.connectedLibrary.create({
    data: {
      displayName: "Knowledge Graph Library",
      localPath: `bridge://knowledge-graph/${testSchemaName}/${randomUUID()}`,
    },
  });
  const scanSession = await prisma.scanSession.create({
    data: {
      completedAt: new Date(Date.UTC(2026, 6, 22)),
      connectedFolderId: connectedLibrary.id,
      filesScanned: 1,
      status: "COMPLETED",
      supportedFiles: 1,
    },
  });
  const scannedFile = await prisma.scannedFile.create({
    data: {
      checksum: "knowledge-graph-test-checksum",
      extractionStatus: "COMPLETED",
      fileType: "TEXT",
      localPath: `bridge://${connectedLibrary.id}/${relativePath}`,
      previewText: "Attachment, regulation, and emotional safety workshop notes.",
      readStatus: "SUPPORTED",
      readingStatus: "READ",
      relativePath,
      sessionId: scanSession.id,
    },
  });

  return { connectedLibrary, scanSession, scannedFile };
}

async function createApprovedMemory() {
  await prisma.memoryEntry.createMany({
    data: [
      {
        confidence: 0.88,
        description:
          "Attachment, regulation, and emotional safety recur in approved workshop material.",
        evidence: json(["Approved review decision"]),
        lastSeen: new Date(Date.UTC(2026, 6, 22)),
        memoryKey: "theme:attachment-regulation",
        memoryType: "THEME",
        occurrenceCount: 3,
        status: "ACTIVE",
        title: "Attachment and regulation",
      },
      {
        confidence: 0.74,
        description:
          "Therapeutic movement is a real body-based topic in reviewed material.",
        evidence: json(["Approved review decision"]),
        lastSeen: new Date(Date.UTC(2026, 6, 22)),
        memoryKey: "theme:therapeutic-movement",
        memoryType: "THEME",
        occurrenceCount: 2,
        status: "ACTIVE",
        title: "Therapeutic movement",
      },
    ],
  });
}

test("workflow and fixture words do not become knowledge candidates", () => {
  const names = extractKnowledgeCandidates(
    "Move moved moving rename renamed execute execution executed undo organize organized recommendation plan create folder source destination current location planned location approved rejected modified review scan scanned monitoring bridge CodexExecutionTest move-source smoke test temporary",
  ).map((candidate) => candidate.name);

  assert.deepEqual(names, []);
  assert.equal(isWorkflowKnowledgeName("Move"), true);
  assert.equal(isWorkflowKnowledgeName("Execution"), true);
  assert.equal(isWorkflowKnowledgeName("CodexExecutionTest"), true);
  assert.equal(isWorkflowKnowledgeName("Manual Milestone 11A"), true);
  assert.equal(isWorkflowKnowledgeName("Therapeutic movement"), false);
});

test("cleanup archives existing provisional workflow topics once and leaves approved knowledge alone", async () => {
  const move = await prisma.knowledgeObject.create({
    data: {
      confidence: 0.45,
      description: "A workflow action label.",
      evidence: json({ appearedIn: ["Manual Milestone 11A"], whyProposed: [] }),
      firstSeen: new Date(Date.UTC(2026, 6, 22)),
      lastSeen: new Date(Date.UTC(2026, 6, 22)),
      name: "Move",
      normalizedName: "move",
      objectType: "TOPIC",
      provenanceSummary: "Created from workflow wording.",
      sourceKeys: json(["notebook:workflow-noise"]),
      status: "PROVISIONAL",
      trustLevel: "PROVISIONAL",
    },
  });
  const attachment = await prisma.knowledgeObject.create({
    data: {
      approvedAt: new Date(Date.UTC(2026, 6, 22)),
      approvedBy: "Deanne",
      confidence: 0.86,
      description: "Approved human knowledge.",
      evidence: json({ appearedIn: ["Memory: Attachment"], whyProposed: [] }),
      firstSeen: new Date(Date.UTC(2026, 6, 22)),
      lastSeen: new Date(Date.UTC(2026, 6, 22)),
      name: "Attachment",
      normalizedName: "attachment",
      objectType: "TOPIC",
      provenanceSummary: "Created from approved Memory.",
      sourceKeys: json(["memory:attachment"]),
      status: "APPROVED",
      trustLevel: "HUMAN_APPROVED",
    },
  });

  await prisma.knowledgeRelationship.create({
    data: {
      confidence: 0.4,
      evidence: json({ appearedIn: ["Manual Milestone 11A"], whyProposed: [] }),
      explanation: "Workflow wording appeared next to a real topic.",
      provenanceSummary: "Created from workflow wording.",
      relationshipKey: `RELATED_TO:${move.id}:${attachment.id}`,
      relationshipType: "RELATED_TO",
      sourceObjectId: move.id,
      status: "PROVISIONAL",
      targetObjectId: attachment.id,
      trustLevel: "PROVISIONAL",
    },
  });

  await cleanupWorkflowKnowledgeNoise();
  await cleanupWorkflowKnowledgeNoise();

  const archivedMove = await prisma.knowledgeObject.findUniqueOrThrow({
    where: { id: move.id },
  });
  const approvedAttachment = await prisma.knowledgeObject.findUniqueOrThrow({
    where: { id: attachment.id },
  });
  const moveRevisions = await prisma.knowledgeObjectRevision.count({
    where: { actionType: "REJECTED_SYSTEM_NOISE", objectId: move.id },
  });
  const archivedRelationships = await prisma.knowledgeRelationship.findMany();
  const relationshipRevisions = await prisma.knowledgeRelationshipRevision.count({
    where: { actionType: "ARCHIVE_SYSTEM_NOISE_RELATIONSHIP" },
  });

  assert.equal(archivedMove.status, "ARCHIVED");
  assert.equal(archivedMove.trustLevel, "EXCLUDED");
  assert.equal(moveRevisions, 1);
  assert.equal(approvedAttachment.status, "APPROVED");
  assert.equal(approvedAttachment.trustLevel, "HUMAN_APPROVED");
  assert.equal(archivedRelationships[0]?.status, "ARCHIVED");
  assert.equal(relationshipRevisions, 1);
});

test("reviewed organization actions become history relationships without Move or Execution topics", async () => {
  await createApprovedMemory();

  const { scanSession, scannedFile } = await createScannedFile(
    "Workshops/attachment-outline.md",
  );
  const suggestion = await prisma.organizationSuggestion.create({
    data: {
      confidence: 0.78,
      currentRelativePath: scannedFile.relativePath,
      explanation:
        "The attachment workshop outline appears related to emotional safety and Becoming workshop material.",
      proposedRelativePath: "Workshops/Becoming/attachment-outline.md",
      scanSessionId: scanSession.id,
      scannedFileId: scannedFile.id,
      status: "APPROVED",
      suggestionKey: `move:${scannedFile.id}`,
      suggestionType: "MOVE_FILE",
      supportingInformation: json([
        "Approved Memory used: Attachment and regulation",
      ]),
      title: "Move workshop outline with Becoming material",
      reviewedAt: new Date(Date.UTC(2026, 6, 22)),
      whySuggested: json([
        "The Librarian noticed shared workshop and attachment language.",
      ]),
    },
  });

  await prisma.organizationPlan.create({
    data: {
      actions: json([
        {
          actionType: "MOVE_FILE",
          confidence: 0.78,
          id: "action-attachment-outline",
          plannedRelativePath: "Workshops/Becoming/attachment-outline.md",
          sourceRelativePath: scannedFile.relativePath,
          suggestionId: suggestion.id,
          suggestionType: "MOVE_FILE",
        },
      ]),
      approvedActions: 1,
      connectedLibrary: {
        connect: {
          id: scanSession.connectedFolderId,
        },
      },
      createdBy: "Deanne",
      history: json([{ label: "Generated", detail: "Organization plan ready." }]),
      scanSession: {
        connect: {
          id: scanSession.id,
        },
      },
      skippedItems: json([]),
      status: "READY_FOR_EXECUTION",
      totalActions: 1,
      warnings: json([]),
    },
  });

  await prisma.notebookEntry.create({
    data: {
      body: "CodexExecutionTest move-source Organized Execution Move Scan Recommendation Undo",
      entryType: "ORGANIZATION_RESULT",
      history: json([]),
      provenanceSummary: "Smoke test execution record.",
      relatedEntryKeys: json([]),
      sourceId: "execution-test",
      sourceKey: "notebook:execution-test-noise",
      sourceType: "execution",
      status: "CURRENT",
      summary: "Manual Milestone 11A Execution smoke test.",
      title: "Manual Milestone 11A Execution",
    },
  });

  await backfillKnowledgeGraph();

  const badActiveTopics = await prisma.knowledgeObject.findMany({
    where: {
      normalizedName: {
        in: [
          "move",
          "execution",
          "organize",
          "organized",
          "undo",
          "test",
          "scan",
          "recommendation",
          "codex execution test",
          "manual milestone",
          "move source",
        ],
      },
      objectType: { in: ["TOPIC", "CONCEPT", "FRAMEWORK"] },
      status: { not: "ARCHIVED" },
    },
  });
  const validTopics = await prisma.knowledgeObject.findMany({
    where: {
      normalizedName: { in: ["attachment and regulation", "therapeutic movement"] },
      status: { not: "ARCHIVED" },
    },
  });
  const historyRelationship =
    await prisma.knowledgeRelationship.findFirstOrThrow({
      where: {
        relationshipType: "FILE_MOVED_TO",
        status: { not: "ARCHIVED" },
      },
    });
  const historyEvidence = evidenceFromJson(historyRelationship.evidence);
  const locations = organizationHistoryLocationsFromEvidence(historyEvidence);

  assert.deepEqual(
    badActiveTopics.map((object) => object.normalizedName),
    [],
  );
  assert.ok(
    validTopics.some((object) => object.normalizedName === "attachment and regulation"),
  );
  assert.ok(
    validTopics.some((object) => object.normalizedName === "therapeutic movement"),
  );
  assert.equal(
    knowledgeRelationshipProposalLabel({
      relationshipType: "FILE_MOVED_TO",
    }),
    "Organization history",
  );
  assert.equal(locations.current, "Workshops/attachment-outline.md");
  assert.equal(
    locations.plannedOrCompleted,
    "Workshops/Becoming/attachment-outline.md",
  );
  assert.match(
    historyRelationship.explanation,
    /Observed in organization history/,
  );
});
