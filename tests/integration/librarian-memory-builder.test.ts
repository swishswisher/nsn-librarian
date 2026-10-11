import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@prisma/client";

import type { buildMemoryFromApprovedSession as buildMemoryFromApprovedSessionType } from "../../src/lib/library/memory";
import type { saveHumanDecision as saveHumanDecisionType } from "../../src/lib/library/observation-sessions";

type BuildMemoryFromApprovedSession = typeof buildMemoryFromApprovedSessionType;

let prisma: PrismaClient;
let buildMemoryFromApprovedSession: BuildMemoryFromApprovedSession;
let saveHumanDecision: typeof saveHumanDecisionType;
let testDatabaseUrl: string;
let testDirectDatabaseUrl: string;
const testSchemaName = `memory_builder_test_${process.pid}_${Date.now()}`;

function databaseUrlForSchema(
  schemaName: string,
  databaseUrl = process.env.DATABASE_URL,
) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Memory Builder integration tests.");
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
  await prisma.memoryEntry.deleteMany();
  await prisma.humanDecision.deleteMany();
  await prisma.knowledgeConnection.deleteMany();
  await prisma.observationSession.deleteMany();
  await prisma.libraryDocument.deleteMany();
  await prisma.libraryBatch.deleteMany();
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
  const memoryModule = await import("../../src/lib/library/memory");

  prisma = prismaModule.getPrismaClient();
  buildMemoryFromApprovedSession = memoryModule.buildMemoryFromApprovedSession;
  saveHumanDecision = (await import("../../src/lib/library/observation-sessions")).saveHumanDecision;
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

async function createBatch(prefix: string) {
  return prisma.libraryBatch.create({
    data: {
      name: `${prefix} batch`,
      sourceType: "MANUAL",
      status: "READY",
    },
  });
}

async function createObservationSession(input: {
  batchId: string;
  index: number;
  prefix: string;
  status: "APPROVED" | "MODIFIED" | "REJECTED";
}) {
  const document = await prisma.libraryDocument.create({
    data: {
      batchId: input.batchId,
      originalFileName: `${input.prefix}-${input.index}.txt`,
      normalizedFileName: `${input.prefix}-${input.index}.txt`,
      extension: "txt",
      mimeType: "text/plain",
      rawText: `neutral ${input.prefix} ${input.index}`,
      previewText: `neutral ${input.prefix} ${input.index}`,
      extractionStatus: "COMPLETED",
      classificationStatus: "SKIPPED",
      reviewStatus: "PENDING",
      wordCount: 3,
    },
  });

  return prisma.observationSession.create({
    data: {
      libraryDocumentId: document.id,
      observerType: "TEST_MEMORY_BUILDER",
      status: input.status,
      observations: [],
      interpretations: [],
      explanation: {
        summary: "Test observation",
        evidence: [],
        uncertainty: "Test only",
        confidence: 0.5,
      },
      planSuggestions: [],
      confidence: 0.5,
      warnings: [],
      createdAt: new Date(Date.UTC(2026, 0, input.index)),
    },
  });
}

async function createModifiedDecision(input: {
  sessionId: string;
  index: number;
  editedSuggestion: string;
}) {
  await prisma.humanDecision.create({
    data: {
      observationSessionId: input.sessionId,
      decisionType: "MODIFY",
      editedSuggestion: input.editedSuggestion,
      note: null,
      createdAt: new Date(Date.UTC(2026, 1, input.index)),
    },
  });
}

async function createDecision(input: {
  sessionId: string;
  index: number;
  decisionType: "ACCEPT" | "REJECT" | "NOTE";
  note?: string | null;
}) {
  await prisma.humanDecision.create({
    data: {
      observationSessionId: input.sessionId,
      decisionType: input.decisionType,
      editedSuggestion: null,
      note: input.note ?? null,
      createdAt: new Date(Date.UTC(2026, 1, input.index)),
    },
  });
}

async function createApprovedTrigger(prefix: string, batchId: string) {
  return createObservationSession({
    batchId,
    index: 99,
    prefix: `${prefix}-trigger`,
    status: "APPROVED",
  });
}

async function seedRecoveryToBecomingModifications(prefix: string) {
  const batch = await createBatch(prefix);

  for (let index = 1; index <= 3; index += 1) {
    const session = await createObservationSession({
      batchId: batch.id,
      index,
      prefix,
      status: "MODIFIED",
    });

    await createModifiedDecision({
      sessionId: session.id,
      index,
      editedSuggestion: "Recovery -> Becoming",
    });
  }

  return createApprovedTrigger(prefix, batch.id);
}

async function preferenceEntries() {
  return prisma.memoryEntry.findMany({
    where: { memoryType: "PREFERENCE" },
    orderBy: { memoryKey: "asc" },
  });
}

test("repeated MODIFY decisions create one PREFERENCE MemoryEntry for Recovery -> Becoming", async () => {
  const trigger = await seedRecoveryToBecomingModifications("modify-repeat");

  await buildMemoryFromApprovedSession(trigger.id);

  const entries = await preferenceEntries();

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.memoryType, "PREFERENCE");
  assert.match(entries[0]?.title ?? "", /Becoming/);
  assert.match(entries[0]?.title ?? "", /Recovery/);
});

test("three edits from Recovery to Becoming produce occurrenceCount 3 and increased confidence", async () => {
  const trigger = await seedRecoveryToBecomingModifications("modify-count");

  await buildMemoryFromApprovedSession(trigger.id);

  const [entry] = await preferenceEntries();

  assert.ok(entry, "Expected a preference memory entry.");
  assert.equal(entry.occurrenceCount, 3);
  assert.equal(entry.memoryType, "PREFERENCE");
  assert.ok(
    entry.confidence >= 0.69,
    `Expected confidence to grow for three occurrences, received ${entry.confidence}.`,
  );
  assert.equal(await prisma.memoryEntry.count({ where: { memoryType: "TERM", title: "recovery" } }), 0);
});

test("ACCEPT decisions without edits do not create preferences", async () => {
  const batch = await createBatch("accept-no-edit");

  for (let index = 1; index <= 3; index += 1) {
    const session = await createObservationSession({
      batchId: batch.id,
      index,
      prefix: "accept-no-edit",
      status: "APPROVED",
    });

    await createDecision({
      sessionId: session.id,
      index,
      decisionType: "ACCEPT",
      note: "Recovery -> Becoming",
    });
  }

  const trigger = await createApprovedTrigger("accept-no-edit", batch.id);

  await buildMemoryFromApprovedSession(trigger.id);

  assert.deepEqual(await preferenceEntries(), []);
});

test("REJECT decisions do not create preferences", async () => {
  const batch = await createBatch("reject-no-preference");

  for (let index = 1; index <= 3; index += 1) {
    const session = await createObservationSession({
      batchId: batch.id,
      index,
      prefix: "reject-no-preference",
      status: "REJECTED",
    });

    await createDecision({
      sessionId: session.id,
      index,
      decisionType: "REJECT",
      note: "Recovery -> Becoming",
    });
  }

  const trigger = await createApprovedTrigger("reject-no-preference", batch.id);

  await buildMemoryFromApprovedSession(trigger.id);

  assert.deepEqual(await preferenceEntries(), []);
});

test("repeated notes without modifications do not create terminology preferences", async () => {
  const batch = await createBatch("notes-no-preference");

  for (let index = 1; index <= 3; index += 1) {
    const session = await createObservationSession({
      batchId: batch.id,
      index,
      prefix: "notes-no-preference",
      status: "APPROVED",
    });

    await createDecision({
      sessionId: session.id,
      index,
      decisionType: "NOTE",
      note: "Recovery -> Becoming",
    });
  }

  const trigger = await createApprovedTrigger("notes-no-preference", batch.id);

  await buildMemoryFromApprovedSession(trigger.id);

  assert.deepEqual(await preferenceEntries(), []);
});

test("Memory Builder remains deterministic when run repeatedly over unchanged data", async () => {
  const trigger = await seedRecoveryToBecomingModifications("deterministic");

  await buildMemoryFromApprovedSession(trigger.id);
  const firstSnapshot = await preferenceEntries();
  const secondUpdateCount = await buildMemoryFromApprovedSession(trigger.id);
  const secondSnapshot = await preferenceEntries();

  assert.equal(secondUpdateCount, 0);
  assert.deepEqual(
    secondSnapshot.map((entry) => ({
      confidence: entry.confidence,
      memoryKey: entry.memoryKey,
      occurrenceCount: entry.occurrenceCount,
      title: entry.title,
    })),
    firstSnapshot.map((entry) => ({
      confidence: entry.confidence,
      memoryKey: entry.memoryKey,
      occurrenceCount: entry.occurrenceCount,
      title: entry.title,
    })),
  );
});

test("a completed human revision contributes corrected content, not the superseded proposal", async () => {
  const batch = await createBatch("corrected-only");
  const session = await createObservationSession({
    batchId: batch.id,
    index: 1,
    prefix: "corrected-only",
    status: "MODIFIED",
  });
  await prisma.libraryDocument.update({
    data: { rawText: "attachment regulation clinical therapy" },
    where: { id: session.libraryDocumentId },
  });
  await createModifiedDecision({
    sessionId: session.id,
    index: 1,
    editedSuggestion: "Workshop facilitation guide",
  });

  await buildMemoryFromApprovedSession(session.id);
  const themes = await prisma.memoryEntry.findMany({ where: { memoryType: "THEME" } });

  assert.ok(themes.some((entry) => entry.title === "Teaching material"));
  assert.ok(!themes.some((entry) => entry.title === "Attachment and regulation"));
  assert.ok(!themes.some((entry) => entry.title === "Clinical practice"));
  const before = themes.length;
  assert.equal(await buildMemoryFromApprovedSession(session.id), 0);
  assert.equal(await prisma.memoryEntry.count({ where: { memoryType: "THEME" } }), before);
});

test("a revision without a final correction and a rejected session cannot enter Memory", async () => {
  const batch = await createBatch("unapproved-correction");
  const modified = await createObservationSession({
    batchId: batch.id,
    index: 1,
    prefix: "unapproved-correction",
    status: "MODIFIED",
  });
  const rejected = await createObservationSession({
    batchId: batch.id,
    index: 2,
    prefix: "unapproved-correction",
    status: "REJECTED",
  });
  await createModifiedDecision({
    sessionId: rejected.id,
    index: 2,
    editedSuggestion: "Workshop facilitation guide",
  });

  assert.equal(await buildMemoryFromApprovedSession(modified.id), 0);
  assert.equal(await buildMemoryFromApprovedSession(rejected.id), 0);
  assert.equal(await prisma.memoryEntry.count(), 0);
});

test("identical human correction retries do not add decisions or duplicate Memory", async () => {
  const batch = await createBatch("correction-retry");
  const session = await createObservationSession({
    batchId: batch.id,
    index: 1,
    prefix: "correction-retry",
    status: "APPROVED",
  });
  const first = await saveHumanDecision(session.id, {
    decisionType: "MODIFY",
    editedSuggestion: "Workshop facilitation guide",
  });
  const second = await saveHumanDecision(session.id, {
    decisionType: "MODIFY",
    editedSuggestion: "Workshop facilitation guide",
  });

  assert.equal(first.decisionId, second.decisionId);
  assert.equal(await prisma.humanDecision.count({ where: { observationSessionId: session.id } }), 1);
  await buildMemoryFromApprovedSession(session.id);
  assert.equal(await buildMemoryFromApprovedSession(session.id), 0);
});
