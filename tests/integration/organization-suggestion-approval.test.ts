import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient;
let previousDatabaseUrl: string | undefined;
let previousDirectDatabaseUrl: string | undefined;
let testDatabaseUrl: string;
let testDirectDatabaseUrl: string;

let currentRecommendationGenerationVersion: typeof import("../../src/lib/bridge/recommendation-generation").currentRecommendationGenerationVersion;
let getOrganizationSuggestionsForScanSession: typeof import("../../src/lib/bridge/organization-suggestions").getOrganizationSuggestionsForScanSession;
let reviewOrganizationSuggestion: typeof import("../../src/lib/bridge/organization-suggestions").reviewOrganizationSuggestion;
let organizationSuggestionCounts: typeof import("../../src/lib/bridge/scan-sessions").organizationSuggestionCounts;

const testSchemaName = `organization_suggestion_approval_${process.pid}_${Date.now()}`;

function databaseUrlForSchema(
  schemaName: string,
  databaseUrl = process.env.DATABASE_URL,
) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for organization suggestion approval tests.");
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
  await prisma.executionAction.deleteMany();
  await prisma.executionRun.deleteMany();
  await prisma.organizationPlan.deleteMany();
  await prisma.organizationSuggestionRevision.deleteMany();
  await prisma.organizationSuggestion.deleteMany();
  await prisma.scannedFile.deleteMany();
  await prisma.scanSession.deleteMany();
  await prisma.connectedLibrary.deleteMany();
}

async function createSuggestionFixture(input: {
  generationVersion?: string;
  invalidated?: boolean;
  status?: "PENDING" | "APPROVED" | "MODIFIED" | "REJECTED" | "LEFT_UNCHANGED";
  suggestionType?:
    | "MOVE_FILE"
    | "POSSIBLE_DUPLICATE"
    | "INSUFFICIENT_EVIDENCE"
    | "KEEP_UNCHANGED";
}) {
  const library = await prisma.connectedLibrary.create({
    data: {
      displayName: "Approval Test Root",
      localPath: `bridge://approval-test/${crypto.randomUUID()}`,
    },
  });
  const session = await prisma.scanSession.create({
    data: {
      connectedFolderId: library.id,
      filesScanned: 1,
      status: "COMPLETED",
      supportedFiles: 1,
    },
  });
  const file = await prisma.scannedFile.create({
    data: {
      checksum: crypto.randomUUID().replaceAll("-", ""),
      extractionStatus: "COMPLETED",
      fileType: "TEXT",
      localPath: `bridge://approval-test/${crypto.randomUUID()}/Loose/source.txt`,
      processingStage: "RECOMMENDATIONS_READY",
      readStatus: "SUPPORTED",
      readingStatus: "READ",
      relativePath: "Loose/source.txt",
      sessionId: session.id,
    },
  });
  const suggestion = await prisma.organizationSuggestion.create({
    data: {
      confidence: 0.86,
      currentRelativePath: file.relativePath,
      explanation:
        "The Librarian found enough reviewed evidence to recommend this organization decision.",
      invalidatedAt: input.invalidated ? new Date() : null,
      invalidatedReason: input.invalidated
        ? "Superseded by a later recommendation generation."
        : null,
      proposedRelativePath: "Reviewed/source.txt",
      recommendationGenerationId: `approval-generation:${crypto.randomUUID()}`,
      recommendationGenerationVersion:
        input.generationVersion ?? currentRecommendationGenerationVersion,
      reviewedAt: input.status && input.status !== "PENDING" ? new Date() : null,
      scanSessionId: session.id,
      scannedFileId: file.id,
      status: input.status ?? "PENDING",
      suggestionKey: `approval-test:${crypto.randomUUID()}`,
      suggestionType: input.suggestionType ?? "MOVE_FILE",
      supportingInformation: [
        "Approved Memory used: organize reviewed files together",
      ],
      title: "Move reviewed source",
      whySuggested: [
        "This recommendation belongs to the current active recommendation generation.",
      ],
    },
  });

  return { file, library, session, suggestion };
}

before(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  previousDirectDatabaseUrl = process.env.DIRECT_URL;
  testDatabaseUrl = databaseUrlForSchema(testSchemaName);
  testDirectDatabaseUrl = databaseUrlForSchema(
    testSchemaName,
    process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  );
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.DIRECT_URL = testDirectDatabaseUrl;
  runPrismaDbPush();
  prisma = new PrismaClient();

  ({
    currentRecommendationGenerationVersion,
  } = await import("../../src/lib/bridge/recommendation-generation"));
  ({
    getOrganizationSuggestionsForScanSession,
    reviewOrganizationSuggestion,
  } = await import("../../src/lib/bridge/organization-suggestions"));
  ({ organizationSuggestionCounts } = await import("../../src/lib/bridge/scan-sessions"));
});

beforeEach(async () => {
  await resetTestData();
});

after(async () => {
  await resetTestData().catch(() => undefined);
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`);
  await prisma.$disconnect();

  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }

  if (previousDirectDatabaseUrl === undefined) {
    delete process.env.DIRECT_URL;
  } else {
    process.env.DIRECT_URL = previousDirectDatabaseUrl;
  }
});

test("approving a current-generation pending recommendation persists and reloads as approved", async () => {
  const { session, suggestion } = await createSuggestionFixture({});
  const approved = await reviewOrganizationSuggestion(suggestion.id, {
    action: "APPROVE",
    scanSessionId: session.id,
  });

  assert.equal(approved.id, suggestion.id);
  assert.equal(approved.status, "APPROVED");
  assert.equal(approved.recommendationGenerationVersion, currentRecommendationGenerationVersion);

  const stored = await prisma.organizationSuggestion.findUniqueOrThrow({
    where: { id: suggestion.id },
  });
  const pageData = await getOrganizationSuggestionsForScanSession(session.id);

  assert.equal(stored.status, "APPROVED");
  assert.ok(stored.reviewedAt);
  assert.ok(pageData);
  assert.equal(pageData.suggestions[0]?.id, suggestion.id);
  assert.equal(pageData.suggestions[0]?.status, "APPROVED");

  const counts = organizationSuggestionCounts(pageData.suggestions);

  assert.equal(counts.pending, 0);
  assert.equal(counts.approved, 1);
  assert.equal(counts.eligibleForPlanning, 1);
});

test("an older active generation cannot be approved through a stale recommendation id", async () => {
  const { session, suggestion } = await createSuggestionFixture({
    generationVersion: "organization-recommendations-v10",
  });

  await assert.rejects(
    () =>
      reviewOrganizationSuggestion(suggestion.id, {
        action: "APPROVE",
        scanSessionId: session.id,
      }),
    /older recommendation pass/i,
  );

  const stored = await prisma.organizationSuggestion.findUniqueOrThrow({
    where: { id: suggestion.id },
  });

  assert.equal(stored.status, "PENDING");
  assert.equal(stored.reviewedAt, null);
});

test("a current v11 recommendation is not confused with an older row for the same source", async () => {
  const { file, session, suggestion } = await createSuggestionFixture({});
  const older = await prisma.organizationSuggestion.create({
    data: {
      confidence: 0.7,
      currentRelativePath: file.relativePath,
      explanation: "Older recommendation retained for history.",
      proposedRelativePath: "Older/source.txt",
      recommendationGenerationId: `approval-generation:${crypto.randomUUID()}`,
      recommendationGenerationVersion: "organization-recommendations-v10",
      scanSessionId: session.id,
      scannedFileId: file.id,
      status: "PENDING",
      suggestionKey: `approval-test:${crypto.randomUUID()}`,
      suggestionType: "MOVE_FILE",
      supportingInformation: ["Older recommendation support."],
      title: "Older move",
      whySuggested: ["Older logic suggested this."],
    },
  });

  await reviewOrganizationSuggestion(suggestion.id, {
    action: "APPROVE",
    scanSessionId: session.id,
  });

  const [currentStored, olderStored, pageData] = await Promise.all([
    prisma.organizationSuggestion.findUniqueOrThrow({
      where: { id: suggestion.id },
    }),
    prisma.organizationSuggestion.findUniqueOrThrow({
      where: { id: older.id },
    }),
    getOrganizationSuggestionsForScanSession(session.id),
  ]);

  assert.equal(currentStored.status, "APPROVED");
  assert.equal(olderStored.status, "PENDING");
  assert.equal(pageData?.suggestions.length, 1);
  assert.equal(pageData?.suggestions[0]?.id, suggestion.id);
  assert.equal(pageData?.suggestions[0]?.status, "APPROVED");
});

test("duplicate review recommendations keep approval semantics without filesystem mutation", async () => {
  const { session, suggestion } = await createSuggestionFixture({
    suggestionType: "POSSIBLE_DUPLICATE",
  });

  const approved = await reviewOrganizationSuggestion(suggestion.id, {
    action: "APPROVE",
    scanSessionId: session.id,
  });
  const [executionRuns, executionActions, plans] = await Promise.all([
    prisma.executionRun.count(),
    prisma.executionAction.count(),
    prisma.organizationPlan.count(),
  ]);

  assert.equal(approved.status, "APPROVED");
  assert.equal(approved.suggestionType, "POSSIBLE_DUPLICATE");
  assert.equal(executionRuns, 0);
  assert.equal(executionActions, 0);
  assert.equal(plans, 0);
});

test("edited current-generation recommendations persist revisions and become plan-eligible", async () => {
  const { session, suggestion } = await createSuggestionFixture({});
  const edited = await reviewOrganizationSuggestion(suggestion.id, {
    action: "MODIFY",
    context: "Deanne chose the more precise destination.",
    destinationFolder: "Reviewed/Chosen",
    fileName: "source-final.txt",
    scanSessionId: session.id,
  });
  const pageData = await getOrganizationSuggestionsForScanSession(session.id);

  assert.equal(edited.status, "MODIFIED");
  assert.equal(edited.revisions.length, 1);
  assert.equal(edited.revisions[0]?.revisedRelativePath, "Reviewed/Chosen/source-final.txt");

  assert.ok(pageData);

  const counts = organizationSuggestionCounts(pageData.suggestions);

  assert.equal(counts.modified, 1);
  assert.equal(counts.pending, 0);
  assert.equal(counts.eligibleForPlanning, 1);
});

test("invalidated recommendations return a clear stale-review error and remain pending", async () => {
  const { session, suggestion } = await createSuggestionFixture({
    invalidated: true,
  });

  await assert.rejects(
    () =>
      reviewOrganizationSuggestion(suggestion.id, {
        action: "APPROVE",
        scanSessionId: session.id,
      }),
    /replaced by newer review information/i,
  );

  const stored = await prisma.organizationSuggestion.findUniqueOrThrow({
    where: { id: suggestion.id },
  });

  assert.equal(stored.status, "PENDING");
  assert.equal(stored.reviewedAt, null);
});
