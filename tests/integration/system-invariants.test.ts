import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import { knowledgeScaleFixture } from "./knowledge-scale-fixtures";
import { createBridgeDeviceId, createBridgeKeyPair, createBridgeDeviceRequestHeaders } from "../../packages/bridge-protocol/src";

const schema = `system_invariants_${process.pid}_${Date.now()}`;
let prisma: PrismaClient;
let reviews: typeof import("../../src/lib/library/observation-sessions");
let memory: typeof import("../../src/lib/library/memory");
let reads: typeof import("../../src/lib/bridge/remote-scan-queue");

before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "5432");
  assert.equal(url.pathname, "/nsn_library_machine_test");
  assert.equal(process.env.OPENAI_API_KEY, undefined, "Invariant tests require unset provider key");
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = process.env.DIRECT_URL = url.toString();
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { stdio: "pipe" });
  prisma = (await import("../../src/lib/db/prisma")).getPrismaClient();
  reviews = await import("../../src/lib/library/observation-sessions");
  memory = await import("../../src/lib/library/memory");
  reads = await import("../../src/lib/bridge/remote-scan-queue");
});
beforeEach(async () => {
  await prisma.memoryEntry.deleteMany(); await prisma.notebookEntry.deleteMany();
  await prisma.knowledgeRelationship.deleteMany(); await prisma.knowledgeObjectMerge.deleteMany(); await prisma.knowledgeObject.deleteMany();
});
after(async () => {
  await prisma?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await prisma?.$disconnect();
});

async function standaloneMemory(title: string) {
  return prisma.memoryEntry.create({ data: { memoryType: "THEME", title, description: "Attachment and recovery are useful clinical ideas.",
    memoryKey: randomUUID(), evidence: [], confidence: 0.8, status: "ACTIVE" } });
}

test("AUTH-1 machine graph backfill cannot revive rejection or replace human meaning", async () => {
  const graph = await import("../../src/lib/knowledge/graph");
  const source = await standaloneMemory("Synthetic orchid curation");
  await graph.backfillKnowledgeGraph();
  const object = await prisma.knowledgeObject.findFirstOrThrow({ where: { name: source.title, objectType: "TOPIC" } });
  await graph.rejectKnowledgeObject(object.id);
  await graph.reviseKnowledgeObject({ objectId: object.id, description: "The person's exact corrected meaning." });
  await prisma.memoryEntry.update({ where: { id: source.id }, data: { description: "Machine attachment recovery material. ".repeat(30) } });
  await graph.backfillKnowledgeGraph();
  const current = await prisma.knowledgeObject.findUniqueOrThrow({ where: { id: object.id } });
  assert.equal(current.status, "REJECTED"); assert.equal(current.trustLevel, "EXCLUDED");
  assert.equal(current.description, "The person's exact corrected meaning.");
  await graph.keepKnowledgeObjectProvisional(object.id);
  await graph.backfillKnowledgeGraph();
  assert.equal((await prisma.knowledgeObject.findUniqueOrThrow({ where: { id: object.id } })).status, "PROVISIONAL");
});

test("AUTH-2 graph concurrent approve/reject status follows serialized authority", async (t) => {
  const graph = await import("../../src/lib/knowledge/graph");
  const object = await prisma.knowledgeObject.create({ data: { name: "Synthetic graph owner", normalizedName: "synthetic graph owner",
    objectType: "TOPIC", description: "Synthetic", evidence: {}, sourceKeys: [], provenanceSummary: "Synthetic" } });
  const held = barrier(), release = barrier(); t.after(release.resolve);
  const lock = prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM "KnowledgeObject" WHERE id = ${object.id} FOR UPDATE`; held.resolve(); await release.promise; }, { timeout: 30_000 });
  await held.promise;
  const approve = graph.approveKnowledgeObject(object.id); await waitForReviewWaiters(1, "KnowledgeObject");
  const reject = graph.rejectKnowledgeObject(object.id); await waitForReviewWaiters(2, "KnowledgeObject");
  release.resolve(); await lock; await Promise.all([approve, reject]);
  const current = await prisma.knowledgeObject.findUniqueOrThrow({ where: { id: object.id }, include: { revisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] } } });
  assert.equal(current.status, "REJECTED"); assert.equal(current.revisions[0].actionType, "REJECT");
  assert.ok(current.revisions[0].createdAt > current.revisions[1].createdAt, "Graph human authority times follow owner serialization");
});

test("AUTH-1 graph merge refuses cycles and preserves stronger human relationship authority", async () => {
  const graph = await import("../../src/lib/knowledge/graph");
  const { relationshipKeyFor } = await import("../../src/lib/knowledge/provenance");
  const make = (name: string) => prisma.knowledgeObject.create({ data: { name, normalizedName: name, objectType: "TOPIC", description: "Synthetic", evidence: {}, sourceKeys: [], provenanceSummary: "Synthetic" } });
  const [a, b, c] = await Promise.all([make("synthetic a"), make("synthetic b"), make("synthetic c")]);
  const relation = (source: string, target: string) => prisma.knowledgeRelationship.create({ data: { sourceObjectId: source, targetObjectId: target,
    relationshipType: "RELATED_TO", relationshipKey: relationshipKeyFor(source, target, "RELATED_TO"), explanation: "Synthetic", evidence: {}, provenanceSummary: "Synthetic" } });
  const [confirmed, provisional] = await Promise.all([relation(a.id, c.id), relation(b.id, c.id)]);
  await graph.approveKnowledgeRelationship(confirmed.id);
  await graph.mergeKnowledgeObject({ canonicalObjectId: b.id, mergedObjectId: a.id });
  const moved = await prisma.knowledgeRelationship.findUniqueOrThrow({ where: { id: confirmed.id } });
  assert.equal(moved.status, "APPROVED"); assert.equal(moved.sourceObjectId, b.id);
  assert.equal((await prisma.knowledgeRelationship.findUniqueOrThrow({ where: { id: provisional.id } })).status, "ARCHIVED");
  await assert.rejects(graph.mergeKnowledgeObject({ canonicalObjectId: a.id, mergedObjectId: b.id }), /live canonical/);
  await graph.mergeKnowledgeObject({ canonicalObjectId: b.id, mergedObjectId: a.id });
  assert.equal((await prisma.knowledgeObject.findUniqueOrThrow({ where: { id: b.id } })).canonicalObjectId, null);
});

test("AUTH-1 Notebook rejects Memory approval and preserves revised words through machine backfill", async () => {
  const notebook = await import("../../src/lib/library/notebook");
  const source = await standaloneMemory("Synthetic Notebook source");
  const entry = await notebook.recordMemoryNotebookEntry(source.id); assert.ok(entry, "Real source creates a Notebook entry");
  await notebook.saveNotebookEntryResponse(entry.id, { actionType: "APPROVE_FOR_MEMORY" });
  await notebook.saveNotebookEntryResponse(entry.id, { actionType: "REVISE_WORDING", revisedBody: "The person's words.", revisedTitle: "Human title" });
  await notebook.recordMemoryNotebookEntry(source.id);
  let current = await prisma.notebookEntry.findUniqueOrThrow({ where: { id: entry.id } });
  assert.equal(current.body, "The person's words."); assert.equal(current.title, "Human title"); assert.equal(current.approvedForMemory, true);
  await notebook.saveNotebookEntryResponse(entry.id, { actionType: "KEEP_NOTEBOOK_ONLY" });
  await notebook.recordMemoryNotebookEntry(source.id);
  current = await prisma.notebookEntry.findUniqueOrThrow({ where: { id: entry.id } });
  assert.equal(current.approvedForMemory, false); assert.equal(current.status, "NOTEBOOK_ONLY");
  await notebook.saveNotebookEntryResponse(entry.id, { actionType: "REJECT_REFLECTION" });
  await notebook.recordMemoryNotebookEntry(source.id);
  current = await prisma.notebookEntry.findUniqueOrThrow({ where: { id: entry.id } });
  assert.equal(current.approvedForMemory, false); assert.equal(current.status, "REJECTED");
  await notebook.saveNotebookEntryResponse(entry.id, { actionType: "APPROVE_FOR_MEMORY" });
  await notebook.saveNotebookEntryResponse(entry.id, { actionType: "ARCHIVE" });
  await notebook.recordMemoryNotebookEntry(source.id);
  current = await prisma.notebookEntry.findUniqueOrThrow({ where: { id: entry.id } });
  assert.equal(current.status, "ARCHIVED"); assert.equal(current.requiresAttention, false);
  assert.equal(current.approvedForMemory, false);
  await notebook.saveNotebookEntryResponse(entry.id, { actionType: "APPROVE_FOR_MEMORY" });
  await notebook.archiveNotebookEntry(entry.id);
  current = await prisma.notebookEntry.findUniqueOrThrow({ where: { id: entry.id } });
  assert.equal(current.status, "ARCHIVED"); assert.equal(current.approvedForMemory, false);
});

test("AUTH-2 Notebook conflicting Memory approval/rejection materializes the latest event", async (t) => {
  const notebook = await import("../../src/lib/library/notebook");
  const source = await standaloneMemory("Synthetic concurrent Notebook source");
  const entry = await notebook.recordMemoryNotebookEntry(source.id); assert.ok(entry, "Source creates Notebook owner");
  const held = barrier(), release = barrier(); t.after(release.resolve);
  const lock = prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM "NotebookEntry" WHERE id = ${entry.id} FOR UPDATE`; held.resolve(); await release.promise; }, { timeout: 30_000 });
  await held.promise;
  const approve = notebook.saveNotebookEntryResponse(entry.id, { actionType: "APPROVE_FOR_MEMORY" }); await waitForReviewWaiters(1, "NotebookEntry");
  const reject = notebook.saveNotebookEntryResponse(entry.id, { actionType: "REJECT_REFLECTION" }); await waitForReviewWaiters(2, "NotebookEntry");
  release.resolve(); await lock; await Promise.all([approve, reject]);
  const current = await prisma.notebookEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { revisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] } } });
  assert.equal(current.status, "REJECTED"); assert.equal(current.approvedForMemory, false);
  assert.equal(current.revisions[0].actionType, "REJECT_REFLECTION");
  assert.ok(current.revisions[0].createdAt > current.revisions[1].createdAt, "Notebook authority times follow owner serialization");
});

test("SCALE-1 Notebook categories remain visible behind one thousand archived attention rows", async () => {
  const notebook = await import("../../src/lib/library/notebook");
  const common = { body: "Synthetic", summary: "Synthetic", provenanceSummary: "Synthetic", sourceType: "SYNTHETIC", history: [], relatedEntryKeys: [] };
  await prisma.notebookEntry.createMany({ data: Array.from({ length: 1000 }, (_, index) => ({ ...common,
    entryType: "REFLECTION" as const, title: `Archived ${index}`, sourceKey: `archived-${index}`, sourceId: String(index),
    status: "ARCHIVED" as const, requiresAttention: true })) });
  const controls = await Promise.all(["REFLECTION", "QUESTION", "MEMORY_LEARNING"].map((entryType) => prisma.notebookEntry.create({ data: {
    ...common, entryType: entryType as "REFLECTION" | "QUESTION" | "MEMORY_LEARNING", title: `Eligible ${entryType}`, sourceId: entryType,
    sourceKey: `eligible-${entryType}`, updatedAt: new Date("2000-01-01T00:00:00Z"), status: "CURRENT" } })));
  const page = await notebook.getNotebookPageData();
  assert.ok(page.currentReflections.some((entry) => entry.id === controls[0].id), "Eligible reflection survives archive pressure");
  assert.ok(page.needsAttention.some((entry) => entry.id === controls[1].id), "Eligible question survives archive pressure");
  assert.ok(page.recentLearning.some((entry) => entry.id === controls[2].id), "Eligible learning survives archive pressure");
  assert.equal((await notebook.getNotebookArchivePageData()).length, 1003, "Full history remains available");
});

test("SCALE-1 graph Memory eligibility precedes cap and invalid modern provenance cannot create trusted objects", async () => {
  const graph = await import("../../src/lib/knowledge/graph");
  const eligible = await standaloneMemory("Older eligible curation");
  await prisma.memoryEntry.update({ where: { id: eligible.id }, data: { updatedAt: new Date("2000-01-01T00:00:00Z") } });
  await prisma.memoryEntry.createMany({ data: Array.from({ length: 100 }, (_, index) => ({ memoryType: "THEME" as const,
    title: `Invalid modern source ${index}`, description: "Attachment", memoryKey: `invalid-${index}`, status: "ACTIVE" as const,
    searchSourceCount: 1, searchProvenanceComplete: true, evidence: [{ kind: "MEMORY_PROVENANCE_REQUIRED", sourceSessionIds: [`missing-${index}`] }] })) });
  await graph.backfillKnowledgeGraph();
  assert.equal(await prisma.knowledgeObject.count({ where: { name: eligible.title, status: "APPROVED" } }), 1);
  assert.equal(await prisma.knowledgeObject.count({ where: { name: { startsWith: "Invalid modern source" } } }), 0);
});

test("SCALE-1 graph reviewed observations use latest per owner and MODIFY excludes replaced meaning", async (t) => {
  const graph = await import("../../src/lib/knowledge/graph");
  const data = await observationFixture(t, "graph-latest-owner");
  const id = data.rows[0].observationId;
  await prisma.observationSession.update({ where: { id }, data: { observations: [{ description: "Trauma and discardedmachineclaim" }] } });
  const modified = await reviews.saveHumanDecision(id, { decisionType: "MODIFY", editedSuggestion: "Recovery through attachment." });
  await prisma.humanDecision.createMany({ data: Array.from({ length: 100 }, (_, index) => ({ observationSessionId: data.rows[1].observationId,
    decisionType: "ACCEPT" as const, createdAt: new Date(Date.now() + index + 1000) })) });
  await graph.backfillKnowledgeGraph();
  const sourceKey = `observation:${id}:${modified.decisionId}`;
  const objects = await prisma.knowledgeObject.findMany({ where: { sourceKeys: { array_contains: [sourceKey] } } });
  assert.ok(objects.some((object) => object.name === "Recovery"), "Another owner's deep history cannot starve the corrected owner");
  assert.equal(objects.some((object) => /Trauma|discardedmachineclaim/i.test(object.description)), false,
    `Human replacement is the sole meaning contributed by MODIFY: ${JSON.stringify(objects.map(({ name, description }) => ({ name, description })))}`);
});

test("PROOF-2 standalone modern Memory binds the exact review and recovers a corrected source family", async (t) => {
  const batch = await prisma.libraryBatch.create({ data: { name: "Synthetic standalone provenance" } });
  t.after(async () => { await prisma.libraryBatch.delete({ where: { id: batch.id } }); });
  const observations = [];
  for (let index = 0; index < 3; index++) {
    const document = await prisma.libraryDocument.create({ data: { batchId: batch.id, originalFileName: `standalone-${index}.txt`, normalizedFileName: `standalone-${index}.txt`,
      rawText: "Cobalt garden stories. Cobalt garden reflections." } });
    const observation = await prisma.observationSession.create({ data: { libraryDocumentId: document.id, status: "AWAITING_REVIEW", observerType: "OPENAI",
      confidence: 0.8, observations: [{ description: "Cobalt garden stories. Cobalt garden reflections." }], interpretations: [], explanation: [], planSuggestions: [], warnings: [] } });
    observations.push(observation);
    await reviews.saveHumanDecision(observation.id, { decisionType: "ACCEPT" });
  }
  const currentEntries = async () => {
    const page = await memory.getMemoryPageData();
    return [...page.themes, ...page.preferredTerms, ...page.recurringConcepts, ...page.humanPreferences, ...page.recentlyLearned];
  };
  const original = (await currentEntries()).find((entry) => /cobalt/i.test(entry.title));
  assert.ok(original, "Approved standalone derivation is a curation control");
  await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_standalone_memory() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected standalone Memory failure'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_standalone_memory BEFORE UPDATE ON "MemoryEntry" FOR EACH ROW EXECUTE FUNCTION fail_standalone_memory()`);
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_standalone_memory ON "MemoryEntry"'); await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS fail_standalone_memory()"); });
  await reviews.saveHumanDecision(observations[0].id, { decisionType: "MODIFY", editedSuggestion: "Amber orchard planning." });
  assert.equal((await currentEntries()).some((entry) => entry.id === original.id), false, "Old standalone statement fails closed at the committed authority change");
  await prisma.$executeRawUnsafe('DROP TRIGGER fail_standalone_memory ON "MemoryEntry"');
  await memory.recoverPendingObservationMemory();
  const corrected = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: original.id } });
  const manifest = (corrected.evidence as Array<Record<string, unknown>>).find((item) => item.kind === "MEMORY_PROVENANCE_REQUIRED");
  assert.ok(manifest, "Recovered Memory retains the complete source requirement");
  assert.deepEqual(new Set(manifest.sourceSessionIds as string[]), new Set(observations.slice(1).map((observation) => observation.id)));
  assert.ok((await currentEntries()).some((entry) => entry.id === original.id), "Remaining approved sources recover correct shared meaning");
});

test("RECOVER-1 forward migration repairs legacy authority and admits interrupted Memory", async (t) => {
  const data = await observationFixture(t, "legacy-migration-recovery");
  const id = data.rows[0].observationId;
  const decision = await prisma.humanDecision.create({ data: { observationSessionId: id, decisionType: "REJECT" } });
  await prisma.observationSession.update({ where: { id }, data: { status: "APPROVED", memoryReconciliationStatus: "NOT_REQUIRED" } });
  const migration = await readFile("prisma/migrations/20261007120000_system_authority_recovery/migration.sql", "utf8");
  const repair = migration.match(/UPDATE "ObservationSession"[\s\S]+?;/)?.[0];
  assert.ok(repair, "Exact forward migration contains authority reconciliation");
  await prisma.$executeRawUnsafe(repair);
  const current = await prisma.observationSession.findUniqueOrThrow({ where: { id } });
  assert.equal(current.status, "REJECTED"); assert.equal(current.memoryReconciliationStatus, `PENDING@${decision.id}`);
  await memory.recoverPendingObservationMemory();
  assert.equal((await prisma.observationSession.findUniqueOrThrow({ where: { id } })).memoryReconciliationStatus, `COMPLETED@${decision.id}`);
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function observationFixture(t: TestContext, name: string) {
  const data = await knowledgeScaleFixture(prisma, name, 3, () => "Cobalt garden workshop planning. Cobalt garden stories.");
  t.after(data.dispose);
  for (const row of data.rows) {
    await prisma.libraryDocument.update({ where: { id: row.documentId }, data: {
      checksum: row.checksum, previewText: row.text, rawText: row.text,
    } });
    await prisma.observationSession.update({ where: { id: row.observationId }, data: {
      status: row === data.rows[0] ? "AWAITING_REVIEW" : "APPROVED", observerType: "OPENAI",
      confidence: 0.8, observations: [{ description: row.text, evidence: [row.evidence] }],
    } });
    if (row !== data.rows[0]) await prisma.humanDecision.create({ data: {
      observationSessionId: row.observationId, decisionType: "ACCEPT",
    } });
  }
  for (const row of data.rows.slice(1)) await memory.buildMemoryFromApprovedSession(row.observationId);
  return data;
}

/** Observe PostgreSQL lock waits, not request scheduling or sleep duration. The
 * test-held owner is released only after both actual production transactions
 * have reached their authority lock, and the first waiter is already queued. */
async function waitForReviewWaiters(count: number, table = "ObservationSession", mode = "UPDATE") {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock' AND query LIKE ${`%SELECT id FROM "${table}"%FOR ${mode}%`}
    `);
    if (Number(row.count) >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`Expected ${count} production transactions waiting at the ${table} authority lock`);
}

type Review = "ACCEPT" | "REJECT" | "MODIFY";

test("SCALE-3 twenty thousand checksum copies select physical targets with bounded identity work", async () => {
  const duplicates = await import("../../src/lib/bridge/checksum-duplicates");
  const count = 20_000;
  const root = { id: "synthetic-root", bridgeRootId: "synthetic-bridge", canonicalConnectedLibraryId: null,
    folderFingerprint: null, localPath: "bridge://synthetic-bridge", displayName: "Synthetic", platform: "MACOS" };
  const files = Array.from({ length: count }, (_, index) => ({ id: `copy-${index}`, checksum: "synthetic-checksum", fileType: "TEXT",
    relativePath: `${index}.txt`, localPath: `bridge://synthetic-bridge/${index}.txt`, sessionId: "current", sizeBytes: 10n,
    sourceCreatedAt: null, lastModified: null, scanSession: { connectedFolder: root } }));
  const work: import("../../src/lib/bridge/physical-file-index").PhysicalIndexWork = {};
  const collapsed = duplicates.collapseHistoricalPhysicalFiles(files, "current", work);
  assert.equal(collapsed.length, count, "Byte-identical copies at distinct paths remain distinct physical files");
  const targets = duplicates.buildChecksumDuplicateTargets(collapsed, work);
  assert.equal(targets.size, count);
  for (const file of files) assert.notEqual(targets.get(file.id)?.relativePath, file.relativePath);
  assert.equal(work.fileVisits, count * 2); assert.ok(work.aliasLookups! <= count * 16);
  assert.ok(work.targetChecks! <= count * 6); assert.ok(work.unionMoves! <= count * 4);
  const history = files.map((file) => ({ ...file, id: `old-${file.id}`, sessionId: "historical" }));
  const copies = duplicates.collapseHistoricalPhysicalFiles([...history, ...files], "current");
  assert.equal(copies.length, count); assert.ok(copies.every((file) => file.sessionId === "current"));
});

test("SCALE-3 twenty thousand processing candidates use stable bounded production pages", async (t) => {
  const root = await prisma.connectedLibrary.create({ data: { displayName: "Synthetic page scale", localPath: `bridge://scale/${randomUUID()}` } });
  t.after(async () => { await prisma.connectedLibrary.delete({ where: { id: root.id } }); });
  const scan = await prisma.scanSession.create({ data: { connectedFolderId: root.id, status: "READING" } });
  const count = 20_000;
  for (let offset = 0; offset < count; offset += 500) await prisma.scannedFile.createMany({ data: Array.from({ length: 500 }, (_, index) => ({
    id: `page-${offset + index}`, sessionId: scan.id, relativePath: "same-path.txt", localPath: "synthetic://not-read",
    fileType: "TEXT", readStatus: "SUPPORTED" as const,
  })) });
  const pipeline = await import("../../src/lib/bridge/processing-pipeline");
  const work: import("../../src/lib/bridge/processing-pipeline").ProcessingPageWork = {};
  let cursor: import("../../src/lib/bridge/processing-pipeline").ProcessingPageCursor | undefined;
  const seen = new Set<string>();
  while (true) {
    const page = await pipeline.processingFilePage(scan.id, {}, cursor, 500, work);
    if (!page.length) break;
    for (const file of page) { assert.equal(seen.has(file.id), false); seen.add(file.id); }
    await prisma.scannedFile.updateMany({ where: { id: { in: page.map((file) => file.id) } }, data: { processingStage: "EXAMINED" } });
    cursor = page.at(-1);
  }
  assert.equal(seen.size, count); assert.equal(work.candidateRows, count); assert.equal(work.pageQueries, 41);
  assert.equal((await pipeline.processingFilePage(scan.id)).length, 0);
  await prisma.scannedFile.updateMany({ where: { id: { in: ["page-0", "page-1", "page-2"] } }, data: {
    readingStatus: "READ", aiModel: "synthetic-model", observationVersion: "synthetic-version", aiRequestCount: 1,
    aiHttpAttempts: 2, aiInputTokens: 3, aiOutputTokens: 4, observationOrigin: "NEW_AI" } });
  const progress = await (await import("../../src/lib/bridge/scan-sessions")).getBridgeScanSessionProgress(scan.id);
  assert.ok(progress); assert.equal(progress.progress.filesRead, 3); assert.equal(progress.progress.filesProcessed, 0);
  assert.equal(progress.progress.aiUsage.requests, 3); assert.equal(progress.progress.aiUsage.httpAttempts, 6);
  assert.equal(progress.progress.aiUsage.inputTokens, 9); assert.equal(progress.progress.aiUsage.outputTokens, 12);
  assert.deepEqual(progress.progress.aiUsage.models, ["synthetic-model"]);
});

test("SCALE-3 twenty thousand recommendation files share postings and skip an entire current folder", async () => {
  const suggestions = await import("../../src/lib/bridge/organization-suggestions");
  const count = 20_000;
  const siblings = Array.from({ length: count }, (_, index) => ({ id: `index-${index}`, fileType: "TEXT", checksum: null,
    localPath: "synthetic://not-read", relativePath: `${index < count - 2 ? "Bulk" : "Finance"}/invoice-payment-${index}.txt` }));
  const work: import("../../src/lib/bridge/organization-suggestions").RecommendationIndexWork = {};
  const index = suggestions.buildRecommendationContextIndex(siblings, undefined, work);
  for (let target = 0; target < count - 2; target++) {
    const candidates = suggestions.recommendationIndexedCandidates(index, ["invoice", "payment"], "Bulk");
    assert.equal(candidates.length, 2); assert.ok(candidates.every((file) => file.relativePath.startsWith("Finance/")));
  }
  assert.equal(work.fileVisits, count); assert.equal(work.candidateVisits, (count - 2) * 4);
});

test("SCALE-3 twenty thousand graph nodes in disjoint components visit each incident edge once", async () => {
  const graph = await import("../../src/lib/bridge/scan-working-knowledge");
  const count = 20_000;
  const files = Array.from({ length: count }, (_, index) => ({ id: `component-${index}`, fileType: "TEXT", connectedLibraryId: "synthetic",
    fileName: `${index}.txt`, relativePath: `${index}.txt`, normalizedIdentity: `${index}`, sourceEvidenceText: "", semanticPreview: "",
    semanticTerms: [], supportingTopics: [], approvedMemoryEvidence: [], trustedObservationEvidence: [], provisionalWorkingEvidence: [] }));
  const relationships = Array.from({ length: count / 2 }, (_, index) => ({ leftFileId: files[index * 2].id, rightFileId: files[index * 2 + 1].id,
    confidence: 0.8, evidenceKinds: ["CONTENT" as const], supportingTopicConfidence: { "operations-finance": 0.8 }, supportingTopics: ["operations-finance"],
    sharedTopics: ["operations-finance"], sharedTerms: ["invoice", "payment"] }));
  const work: import("../../src/lib/bridge/scan-working-knowledge").WorkingClusterWork = {};
  const clusters = graph.buildWorkingKnowledgeClusters(files, relationships, work);
  assert.equal(clusters.length, count / 2); assert.equal(work.nodeVisits, count);
  assert.ok(work.edgeVisits! <= relationships.length * 20, `Bounded edge work: ${JSON.stringify(work)}`);
  assert.ok(work.fileVisits! <= count * 20, `Bounded node work: ${JSON.stringify(work)}`);
});

async function localReadFixture(t: TestContext) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "nsn-invariant-source-"));
  const previousFallback = process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK;
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK = "true";
  const root = await prisma.connectedLibrary.create({ data: { localPath: folder, displayName: "Synthetic reader invariants", platform: "WINDOWS" } });
  const scan = await prisma.scanSession.create({ data: { connectedFolderId: root.id, status: "READING" } });
  const content = "Synthetic orchard invoice payment document.";
  const source = path.join(folder, "source.txt"); await writeFile(source, content);
  const file = await prisma.scannedFile.create({ data: { sessionId: scan.id, localPath: source, relativePath: "source.txt",
    fileType: "TEXT", readStatus: "SUPPORTED", checksum: createHash("sha256").update(content).digest("hex") } });
  t.after(async () => {
    await prisma.connectedLibrary.delete({ where: { id: root.id } });
    if (previousFallback === undefined) delete process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK;
    else process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK = previousFallback;
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep), "Synthetic cleanup stays inside temp root");
    await rm(folder, { recursive: true });
  });
  return { file, source, content, root, scan };
}

test("FILE-1 local document, audio, video and image entry points reject changed bytes before extraction", async (t) => {
  const data = await localReadFixture(t);
  const reader = await import("../../src/lib/bridge/reader");
  const valid = await reader.readScannedFile(data.file.id);
  assert.equal(valid.preview.sourceChecksum, data.file.checksum);
  assert.equal(valid.preview.extractedText.trim(), data.content);
  await writeFile(data.source, "External replacement with different bytes.");
  for (const [fileType, module, entry] of [
    ["TEXT", "reader", "readScannedFile"], ["AUDIO_MP3", "audio-reader", "readScannedAudioFile"],
    ["VIDEO_MP4", "video-reader", "readScannedVideoFile"], ["IMAGE_PNG", "image-reader", "readScannedImageFile"],
  ] as const) {
    await prisma.scannedFile.update({ where: { id: data.file.id }, data: { fileType } });
    const api = await import(`../../src/lib/bridge/${module}`);
    await assert.rejects(api[entry](data.file.id), /changed since it was scanned/);
    const current = await prisma.scannedFile.findUniqueOrThrow({ where: { id: data.file.id } });
    assert.equal(current.extractionStatus, "FAILED"); assert.equal(current.processingErrorCategory, "FILE_CHANGED_SINCE_SCAN");
    assert.equal(current.observationClaimedAt, null);
  }
  assert.equal(await prisma.observationSession.count({ where: { libraryDocument: { scannedFiles: { some: { id: data.file.id } } } } }), 0);
});

test("CURRENT-2 the production local reader write guard rejects an expired worker after a new owner publishes", async (t) => {
  const data = await localReadFixture(t);
  const authority = await import("../../src/lib/bridge/local-read-authority");
  const { claimObservationLease } = await import("../../src/lib/bridge/observation-authority");
  const entered = barrier(), release = barrier(); t.after(release.resolve);
  const stale = authority.withLocalReadAuthority(data.file.id, async () => {
    entered.resolve(); await release.promise;
    await authority.getLocalReadClient().scannedFile.update({ where: { id: data.file.id }, data: { previewText: "Stale overwrite" } });
    throw new Error("An obsolete write must never complete");
  }).then(() => null, (error: unknown) => error);
  await entered.promise;
  await prisma.scannedFile.update({ where: { id: data.file.id }, data: { observationClaimedAt: new Date(0) } });
  const owner = await claimObservationLease(data.file.id);
  const reader = await import("../../src/lib/bridge/reader");
  await reader.readScannedFile(data.file.id, owner);
  const current = await prisma.scannedFile.findUniqueOrThrow({ where: { id: data.file.id } });
  release.resolve(); assert.ok(await stale instanceof Error, "Stale publication loses its exact lease");
  assert.deepEqual(await prisma.scannedFile.findUniqueOrThrow({ where: { id: data.file.id } }), current);
  await prisma.scannedFile.updateMany({ where: { id: data.file.id, observationClaimedAt: owner }, data: { observationClaimedAt: null } });
});

test("RECOVER-2 local processing reclaims an abandoned file and atomically publishes observation completion", async (t) => {
  const data = await localReadFixture(t);
  await prisma.scannedFile.update({ where: { id: data.file.id }, data: { observationClaimedAt: new Date(0), processingStage: "READING" } });
  const pipeline = await import("../../src/lib/bridge/processing-pipeline");
  await pipeline.processBridgeScanSession(data.scan.id, { recordNotebook: false });
  const current = await prisma.scannedFile.findUniqueOrThrow({ where: { id: data.file.id }, include: { libraryDocument: { include: { observationSessions: true } } } });
  assert.equal(current.observationClaimedAt, null); assert.equal(current.libraryDocument?.observationSessions.length, 1);
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } })).observationsCreated, 1);
  await pipeline.processBridgeScanSession(data.scan.id, { recordNotebook: false });
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } })).observationsCreated, 1);
});

test("RECOVER-2 recommendation generation resumes an abandoned batch through ordinary polling", async (t) => {
  const data = await observationFixture(t, "abandoned-recommendations");
  await prisma.scannedFile.updateMany({ where: { sessionId: data.scan.id }, data: { processingStage: "EXAMINED" } });
  await prisma.scanSession.update({ where: { id: data.scan.id }, data: {
    status: "GENERATING_SUGGESTIONS", recommendationGeneration: "dead-worker", recommendationLeaseUntil: new Date(0),
  } });
  const device = await prisma.bridgeDevice.create({ data: { bridgeDeviceId: createBridgeDeviceId(), deviceDisplayName: "Synthetic", platform: "MACOS",
    architecture: "arm64", appVersion: "0.1.0",
    publicKey: createBridgeKeyPair().publicKey, status: "ONLINE" } });
  await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { bridgeDeviceId: device.bridgeDeviceId } });
  t.after(async () => { await prisma.bridgeDevice.delete({ where: { id: device.id } }); });
  const { fetchRecoverableBridgeCommands } = await import("../../src/lib/bridge/recoverable-commands");
  await fetchRecoverableBridgeCommands(device.bridgeDeviceId);
  const current = await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } });
  assert.equal(current.status, "COMPLETED"); assert.equal(current.recommendationGeneration, null);
  const count = await prisma.organizationSuggestion.count({ where: { scanSessionId: data.scan.id, invalidatedAt: null } });
  assert.ok(count > 0, "Recovered batch publishes actual recommendations");
  await fetchRecoverableBridgeCommands(device.bridgeDeviceId);
  assert.equal(await prisma.organizationSuggestion.count({ where: { scanSessionId: data.scan.id, invalidatedAt: null } }), count);
});

test("CURRENT-2 superseded recommendation worker cannot publish or fail a newer generation", async (t) => {
  const data = await observationFixture(t, "recommendation-stale-worker");
  await prisma.scannedFile.updateMany({ where: { sessionId: data.scan.id }, data: { processingStage: "EXAMINED" } });
  const batch = await import("../../src/lib/bridge/scan-recommendation-batch");
  const entered = barrier(), release = barrier(); t.after(release.resolve);
  const older = batch.generateScanRecommendationBatch(data.scan.id, { beforeFilePersist: async () => { entered.resolve(); await release.promise; } })
    .then(() => null, (error: unknown) => error);
  await entered.promise;
  await prisma.scanSession.update({ where: { id: data.scan.id }, data: { recommendationLeaseUntil: new Date(0) } });
  const newer = await batch.generateScanRecommendationBatchIfReady(data.scan.id); assert.ok(newer, "Expired owner is reclaimable");
  const before = await prisma.scannedFile.findMany({ where: { sessionId: data.scan.id }, orderBy: { id: "asc" } });
  const count = await prisma.organizationSuggestion.count({ where: { scanSessionId: data.scan.id } });
  release.resolve(); assert.ok(await older instanceof Error, "Replaced worker loses its publication authority");
  assert.deepEqual(await prisma.scannedFile.findMany({ where: { sessionId: data.scan.id }, orderBy: { id: "asc" } }), before);
  assert.equal(await prisma.organizationSuggestion.count({ where: { scanSessionId: data.scan.id } }), count);
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } })).status, "COMPLETED");
});

test("CURRENT-2 aborted recommendation work cannot publish a late result", async (t) => {
  const data = await observationFixture(t, "recommendation-cancellation");
  const suggestions = await import("../../src/lib/bridge/organization-suggestions");
  const controller = new AbortController();
  await assert.rejects(suggestions.generateOrganizationSuggestionsForScannedFileWithText(data.rows[0].id, "Invoice payment office billing.", {
    signal: controller.signal, beforePersist: async () => { controller.abort(); },
  }), /cancelled/);
  assert.equal(await prisma.organizationSuggestion.count({ where: { scannedFileId: data.rows[0].id } }), 0);
});

const reviewStatus = { ACCEPT: "APPROVED", REJECT: "REJECTED", MODIFY: "MODIFIED" } as const;
for (const pair of [["ACCEPT", "REJECT"], ["ACCEPT", "MODIFY"], ["REJECT", "MODIFY"]] as const) {
  for (const actions of [pair, [...pair].reverse() as Review[]]) {
    test(`AUTH-2 concurrent ${actions[0]} then ${actions[1]} preserves ordered status and Memory`, { timeout: 60_000 }, async (t) => {
      const data = await observationFixture(t, actions.join("-"));
      const id = data.rows[0].observationId;
      const held = barrier(), release = barrier(); t.after(release.resolve);
      const lock = prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "ObservationSession" WHERE id = ${id} FOR UPDATE`);
        held.resolve(); await release.promise;
      }, { timeout: 30_000 });
      await held.promise;
      const decide = (decisionType: Review) => reviews.saveHumanDecision(id, { decisionType,
        editedSuggestion: decisionType === "MODIFY" ? "Amber orchard planning. Prefer orchard stories." : undefined });
      const first = decide(actions[0]);
      await waitForReviewWaiters(1);
      const second = decide(actions[1]);
      await waitForReviewWaiters(2);
      release.resolve(); await lock;
      await Promise.all([first, second]);
      // Serializable derived builders may conflict, but durable pending admission
      // must converge without changing the committed human authority.
      await memory.recoverPendingObservationMemory();
      const current = await prisma.observationSession.findUniqueOrThrow({ where: { id },
        include: { humanDecisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] } } });
      assert.equal(current.humanDecisions.length, 2);
      assert.equal(current.humanDecisions[0].decisionType, actions[1]);
      assert.equal(current.status, reviewStatus[actions[1]]);
      assert.ok(current.humanDecisions[0].createdAt > current.humanDecisions[1].createdAt,
        "Serialized owner events have strictly increasing persisted times");
      assert.match(current.memoryReconciliationStatus, /^COMPLETED@/);
      const cobalt = await prisma.memoryEntry.findMany({ where: { status: "ACTIVE", searchProvenanceComplete: true,
        title: { contains: "cobalt", mode: "insensitive" }, searchSources: { some: { observationSessionId: id } } } });
      if (actions[1] === "ACCEPT") assert.ok(cobalt.length > 0, "Latest acceptance remains an eligible Memory source");
      else assert.equal(cobalt.length, 0, "Rejected/replaced machine meaning cannot remain an eligible Memory source");
    });
  }
}

test("AUTH-2 same-action retry and NOTE retain one human authority and stable Memory", async (t) => {
  const data = await observationFixture(t, "idempotent-authority");
  const id = data.rows[0].observationId;
  const input = { decisionType: "MODIFY" as const, editedSuggestion: "Amber orchard planning.", note: "Human correction" };
  const first = await reviews.saveHumanDecision(id, input);
  const retry = await reviews.saveHumanDecision(id, input);
  assert.equal(retry.decisionId, first.decisionId);
  assert.equal(await prisma.humanDecision.count({ where: { observationSessionId: id } }), 1);
  await reviews.saveHumanDecision(id, { decisionType: "NOTE", note: "Append-only context" });
  const afterNoteRetry = await reviews.saveHumanDecision(id, input);
  assert.equal(afterNoteRetry.decisionId, first.decisionId);
  assert.equal(await prisma.humanDecision.count({ where: { observationSessionId: id } }), 2);
  assert.equal((await prisma.observationSession.findUniqueOrThrow({ where: { id } })).status, "MODIFIED");
  assert.equal(await prisma.humanDecision.count({ where: { observationSessionId: id, decisionType: "MODIFY" } }), 1);
});

test("DERIVED-2 committed review recovers failed Memory child work through ordinary device polling", async (t) => {
  const data = await observationFixture(t, "memory-admission-crash");
  const id = data.rows[0].observationId;
  await prisma.$executeRawUnsafe(`CREATE FUNCTION "${schema}".memory_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected derived Memory failure'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER memory_fault BEFORE INSERT OR UPDATE ON "MemoryEntry" FOR EACH ROW EXECUTE FUNCTION "${schema}".memory_fault()`);
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS memory_fault ON "MemoryEntry"'); });
  const decision = await reviews.saveHumanDecision(id, { decisionType: "ACCEPT" });
  const pending = await prisma.observationSession.findUniqueOrThrow({ where: { id } });
  assert.equal(pending.status, "APPROVED");
  assert.equal(pending.memoryReconciliationStatus, `PENDING@${decision.decisionId}`);
  assert.equal(await prisma.memorySearchSource.count({ where: { observationSessionId: id } }), 0,
    "Failed derived transaction does not leave partial source rows");
  await prisma.$executeRawUnsafe('DROP TRIGGER memory_fault ON "MemoryEntry"');
  const device = await deviceFixture(t);
  const { fetchRecoverableBridgeCommands } = await import("../../src/lib/bridge/recoverable-commands");
  await fetchRecoverableBridgeCommands(device.bridgeDeviceId);
  const once = await prisma.observationSession.findUniqueOrThrow({ where: { id } });
  assert.equal(once.memoryReconciliationStatus, `COMPLETED@${decision.decisionId}`);
  assert.ok(await prisma.memorySearchSource.count({ where: { observationSessionId: id } }) > 0,
    "Ordinary polling completes the real approved-source Memory builder");
  const sources = await prisma.memorySearchSource.findMany({ where: { observationSessionId: id }, orderBy: { id: "asc" } });
  await fetchRecoverableBridgeCommands(device.bridgeDeviceId);
  assert.deepEqual(await prisma.memorySearchSource.findMany({ where: { observationSessionId: id }, orderBy: { id: "asc" } }), sources);
  assert.equal(await prisma.humanDecision.count({ where: { observationSessionId: id } }), 1);
});

async function deviceFixture(t: TestContext) {
  const keys = createBridgeKeyPair();
  const device = await prisma.bridgeDevice.create({ data: {
    bridgeDeviceId: `device-${randomUUID()}`, deviceDisplayName: "Synthetic audit device", platform: "MACOS",
    architecture: "arm64", appVersion: "0.1.0", publicKey: keys.publicKey,
    status: "ONLINE", lastSeenAt: new Date(), pairedAt: new Date(),
  } });
  t.after(async () => { await prisma.bridgeDevice.delete({ where: { id: device.id } }); });
  return { ...device, privateKey: keys.privateKey };
}

const rootStates = [
  ["read revoked", { readPermission: false }],
  ["hidden", { hiddenFromActiveListAt: new Date() }],
  ["merged", { mergedAt: new Date() }],
  ["noncanonical", { canonicalConnectedLibraryId: "other-root" }],
  ["disconnected-at", { disconnectedAt: new Date() }],
  ["disabled", { isEnabled: false }],
  ["paused", { status: "PAUSED" }],
  ["disconnected", { status: "DISCONNECTED" }],
  ["needs attention", { status: "NEEDS_ATTENTION" }],
] as const;
for (const [label, state] of rootStates) {
  test(`ROOT-1 remote read admission stops at ${label} and preserves retained evidence`, async (t) => {
    const device = await deviceFixture(t);
    const data = await knowledgeScaleFixture(prisma, `root-${label}`, 1, () => "Synthetic retained file");
    t.after(data.dispose);
    await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: {
      bridgeDeviceId: device.bridgeDeviceId, ...state,
    } });
    await prisma.scanSession.update({ where: { id: data.scan.id }, data: { status: "READING" } });
    await prisma.scannedFile.update({ where: { id: data.rows[0].id }, data: { processingStage: "DISCOVERED" } });
    assert.equal(await reads.queueNextRemoteReadBatchForDevice(device.bridgeDeviceId), 0);
    const cloud = await import("../../src/lib/bridge/cloud-coordinator");
    const manual = await import("../../src/lib/bridge/remote-read-commands");
    const watching = await import("../../src/lib/bridge/remote-monitoring");
    await assert.rejects(manual.queueRemoteReadRetryForScannedFile(data.rows[0].id), /Reconnect|permission/);
    await assert.rejects(reads.queueRemoteBridgeScan(data.root.id), /Reconnect/);
    await assert.rejects(watching.queueRemoteMonitoringAction(data.root.id, "start"), /Reconnect/);
    const target = { bridgeDeviceId: device.bridgeDeviceId, bridgeRootId: data.root.bridgeRootId,
      connectedLibraryId: data.root.id, commandType: "READ_FILE_TEMPORARILY" as const };
    await assert.rejects(cloud.createBridgeCloudCommand(target), /no longer authorizes/);
    assert.deepEqual(await cloud.authorizedBridgeCommands([target]), []);
    assert.equal(await prisma.bridgeCommand.count({ where: { bridgeDeviceId: device.bridgeDeviceId } }), 0);
    assert.equal(await prisma.observationSession.count({ where: { id: data.rows[0].observationId } }), 1);
    assert.equal((await prisma.scannedFile.findUniqueOrThrow({ where: { id: data.rows[0].id } })).checksum, data.rows[0].checksum);
  });
}

test("ROOT-1 valid read admission retains exact device ownership and retry is bounded", async (t) => {
  const device = await deviceFixture(t), other = await deviceFixture(t);
  const data = await knowledgeScaleFixture(prisma, "valid-read-owner", 1, () => "Synthetic valid file");
  t.after(data.dispose);
  await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { bridgeDeviceId: device.bridgeDeviceId } });
  await prisma.scanSession.update({ where: { id: data.scan.id }, data: { status: "READING" } });
  await prisma.scannedFile.update({ where: { id: data.rows[0].id }, data: { processingStage: "DISCOVERED", readingStatus: "NOT_READ" } });
  assert.equal(await reads.queueNextRemoteReadBatchForDevice(other.bridgeDeviceId), 0);
  assert.equal(await reads.queueNextRemoteReadBatchForDevice(device.bridgeDeviceId), 1);
  assert.equal(await reads.queueNextRemoteReadBatchForDevice(device.bridgeDeviceId), 0);
  const command = await prisma.bridgeCommand.findFirstOrThrow({ where: { bridgeDeviceId: device.bridgeDeviceId } });
  assert.equal(command.bridgeRootId, data.root.bridgeRootId);
  assert.equal(command.connectedLibraryId, data.root.id);
  assert.equal(command.commandType, "READ_FILE_TEMPORARILY");
});

test("ROOT-1 scan admission and its command commit together; simultaneous retry shares one owner", async (t) => {
  const device = await deviceFixture(t);
  const data = await knowledgeScaleFixture(prisma, "scan-admission", 0, () => ""); t.after(data.dispose);
  await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { bridgeDeviceId: device.bridgeDeviceId } });
  const results = await Promise.all([reads.queueRemoteBridgeScan(data.root.id), reads.queueRemoteBridgeScan(data.root.id)]);
  assert.equal(results.filter((result) => result.alreadyActive).length, 1);
  assert.equal(await prisma.bridgeCommand.count({ where: { connectedLibraryId: data.root.id, commandType: "SCAN_LIBRARY" } }), 1);
  assert.equal(await prisma.scanSession.count({ where: { connectedFolderId: data.root.id, status: "SCANNING" } }), 1);
});

test("RECOVER-2 partial remote scan retries complete every chunk and terminal replay cannot rewind", { timeout: 60_000 }, async (t) => {
  const device = await deviceFixture(t);
  const data = await knowledgeScaleFixture(prisma, "scan-chunk-recovery", 0, () => ""); t.after(data.dispose);
  await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { bridgeDeviceId: device.bridgeDeviceId } });
  await prisma.scanSession.update({ where: { id: data.scan.id }, data: { status: "SCANNING" } });
  const files = Array.from({ length: 601 }, (_, index) => ({ relativePath: `file-${String(index).padStart(4, "0")}.txt`,
    checksum: createHash("sha256").update(`synthetic-${index}`).digest("hex"), fileType: "TEXT", readStatus: "SUPPORTED" }));
  const input = { bridgeDeviceId: device.bridgeDeviceId, bridgeRootId: data.root.bridgeRootId!, connectedLibraryId: data.root.id,
    commandPayload: { scanSessionId: data.scan.id }, report: { commandId: "synthetic-report", status: "COMPLETED" as const,
      completedAt: new Date().toISOString(), safeErrorCategory: null, result: { files } } };
  await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_import_chunk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."relativePath" = 'file-0500.txt' THEN RAISE EXCEPTION 'injected chunk failure'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_import_chunk BEFORE INSERT ON "ScannedFile" FOR EACH ROW EXECUTE FUNCTION fail_import_chunk()`);
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_import_chunk ON "ScannedFile"'); await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS fail_import_chunk()"); });
  await assert.rejects(reads.importRemoteBridgeScanReport(input), /injected chunk failure/);
  assert.equal(await prisma.scannedFile.count({ where: { sessionId: data.scan.id } }), 500);
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } })).status, "SCANNING");
  await prisma.$executeRawUnsafe('DROP TRIGGER fail_import_chunk ON "ScannedFile"');
  await reads.importRemoteBridgeScanReport(input);
  assert.equal(await prisma.scannedFile.count({ where: { sessionId: data.scan.id } }), 601);
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } })).filesScanned, 601);
  await prisma.scanSession.update({ where: { id: data.scan.id }, data: { status: "COMPLETED", completedAt: new Date() } });
  await reads.importRemoteBridgeScanReport(input);
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } })).status, "COMPLETED");
  assert.equal(await prisma.scannedFile.count({ where: { sessionId: data.scan.id } }), 601);
});

test("ROOT-2 ordinary root sync preserves human disconnect/hide; explicit connection revision restores access", async (t) => {
  const device = await deviceFixture(t), other = await deviceFixture(t);
  const data = await knowledgeScaleFixture(prisma, "root-sync-authority", 0, () => ""); t.after(data.dispose);
  const rootId = `root_${createHash("sha256").update(data.root.id).digest("hex").slice(0, 24)}`;
  await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { bridgeRootId: rootId, folderFingerprint: rootId,
    localPath: `bridge://${rootId}`, bridgeDeviceId: device.bridgeDeviceId, nativeConnectionRevision: 1 } });
  const sync = await import("../../src/lib/bridge/device-root-sync");
  const libraries = await import("../../src/lib/bridge/connected-libraries");
  const incoming = { id: rootId, connectionRevision: 1, connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    displayName: "Synthetic root", safeLocation: "Synthetic folder", platform: "MACOS", status: "CONNECTED",
    watcherState: "WATCHING", readPermission: true, watchPermission: true, recommendationPermission: true,
    organizationPlanPermission: true, moveFilePermission: true, renameFilePermission: true, createFolderPermission: true };
  await libraries.disconnectConnectedLibrary(data.root.id);
  await libraries.hideConnectedLibrary(data.root.id);
  await sync.syncBridgeDeviceRoots(device.bridgeDeviceId, [incoming]);
  let root = await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: data.root.id } });
  assert.equal(root.status, "HIDDEN_FROM_ACTIVE_LIST"); assert.equal(root.isEnabled, false);
  assert.equal(root.watchPermission, false);
  assert.ok(root.hiddenFromActiveListAt && root.disconnectedAt, "Human lifecycle timestamps survive native heartbeat");
  assert.equal(await prisma.bridgeCommand.count({ where: { connectedLibraryId: root.id, commandType: "REVOKE_ROOT_ACCESS" } }), 1);
  await assert.rejects(sync.syncBridgeDeviceRoots(other.bridgeDeviceId, [{ ...incoming, connectionRevision: 2 }]), /another paired Mac/);
  await sync.syncBridgeDeviceRoots(device.bridgeDeviceId, [{ ...incoming, connectionRevision: 2, updatedAt: new Date(Date.now() + 1000).toISOString() }]);
  root = await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: data.root.id } });
  assert.equal(root.status, "CONNECTED"); assert.equal(root.isEnabled, true);
  assert.equal(root.hiddenFromActiveListAt, null); assert.equal(root.disconnectedAt, null);
  assert.equal(root.nativeConnectionRevision, 2);
  const cloud = await import("../../src/lib/bridge/cloud-coordinator");
  const obsoleteStops = await prisma.bridgeCommand.findMany({ where: { connectedLibraryId: root.id, commandType: "REVOKE_ROOT_ACCESS" } });
  assert.deepEqual(await cloud.authorizedBridgeCommands(obsoleteStops), [], "A revoke from the old connection cannot disconnect the explicit reconnect");
  await sync.syncBridgeDeviceRoots(device.bridgeDeviceId, [incoming]);
  root = await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: data.root.id } });
  assert.equal(root.nativeConnectionRevision, 2); assert.equal(root.status, "CONNECTED");
});

test("ROOT-2 one pairing code admits only one concurrently registering device/key", { timeout: 60_000 }, async (t) => {
  const cloud = await import("../../src/lib/bridge/cloud-coordinator");
  const code = await cloud.createBridgePairingCode();
  t.after(async () => { await prisma.bridgePairingCode.delete({ where: { id: code.id } }); });
  const held = barrier(), release = barrier(); t.after(release.resolve);
  const lock = prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "BridgePairingCode" WHERE id = ${code.id} FOR UPDATE`);
    held.resolve(); await release.promise;
  }, { timeout: 30_000 });
  await held.promise;
  const registration = () => ({ appVersion: "0.1.0", architecture: "arm64", bridgeDeviceId: createBridgeDeviceId(),
    deviceDisplayName: "Synthetic pairing race", pairingCode: code.code, platform: "MACOS" as const,
    publicKey: createBridgeKeyPair().publicKey });
  const a = registration(), b = registration();
  t.after(async () => { await prisma.bridgeDevice.deleteMany({ where: { bridgeDeviceId: { in: [a.bridgeDeviceId, b.bridgeDeviceId] } } }); });
  const first = cloud.pairBridgeDevice(a);
  await waitForReviewWaiters(1, "BridgePairingCode");
  const second = cloud.pairBridgeDevice(b);
  const outcomes = Promise.allSettled([first, second]);
  await waitForReviewWaiters(2, "BridgePairingCode");
  release.resolve(); await lock;
  const settled = await outcomes;
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter((item) => item.status === "rejected").length, 1);
  assert.equal(await prisma.bridgeDevice.count({ where: { bridgeDeviceId: { in: [a.bridgeDeviceId, b.bridgeDeviceId] } } }), 1);
  const pairing = await prisma.bridgePairingCode.findUniqueOrThrow({ where: { id: code.id } });
  assert.equal(pairing.status, "CONSUMED");
  assert.equal(pairing.pairedDeviceId, a.bridgeDeviceId);
  assert.equal(await prisma.bridgeAuditEntry.count({ where: { pairingCodeId: code.id, eventType: "DEVICE_PAIRED" } }), 1);
});

test("ROOT-2 a late heartbeat cannot overwrite serialized device revocation", { timeout: 60_000 }, async (t) => {
  const cloud = await import("../../src/lib/bridge/cloud-coordinator");
  const device = await deviceFixture(t);
  const held = barrier(), release = barrier(); t.after(release.resolve);
  const lock = prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "BridgeDevice" WHERE id = ${device.id} FOR UPDATE`);
    held.resolve(); await release.promise;
  }, { timeout: 30_000 });
  await held.promise;
  const revoke = cloud.revokeBridgeDevice(device.bridgeDeviceId);
  await waitForReviewWaiters(1, "BridgeDevice");
  const heartbeat = cloud.recordBridgeHeartbeat(device.bridgeDeviceId);
  const outcomes = Promise.allSettled([revoke, heartbeat]);
  await waitForReviewWaiters(2, "BridgeDevice");
  release.resolve(); await lock;
  const settled = await outcomes;
  assert.equal(settled[0].status, "fulfilled");
  assert.equal(settled[1].status, "rejected");
  const current = await prisma.bridgeDevice.findUniqueOrThrow({ where: { id: device.id } });
  assert.equal(current.status, "REVOKED"); assert.ok(current.revokedAt, "Revocation timestamp remains authoritative");
});

test("TX-1 device revocation rolls back all authority if root denial fails", async (t) => {
  const cloud = await import("../../src/lib/bridge/cloud-coordinator");
  const device = await deviceFixture(t);
  const data = await knowledgeScaleFixture(prisma, "atomic-revocation", 1, () => "Synthetic retained history");
  t.after(data.dispose);
  await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { bridgeDeviceId: device.bridgeDeviceId } });
  const command = await cloud.createBridgeCloudCommand({ bridgeDeviceId: device.bridgeDeviceId,
    bridgeRootId: data.root.bridgeRootId, connectedLibraryId: data.root.id, commandType: "STOP_WATCHING",
    authorizationContext: { initiatedBy: "Deanne" }, payload: {} });
  await prisma.$executeRawUnsafe(`CREATE FUNCTION "${schema}".revoke_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected root denial failure'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER revoke_fault BEFORE UPDATE ON "ConnectedFolder" FOR EACH ROW EXECUTE FUNCTION "${schema}".revoke_fault()`);
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS revoke_fault ON "ConnectedFolder"'); });
  await assert.rejects(cloud.revokeBridgeDevice(device.bridgeDeviceId), /injected root denial failure/);
  assert.equal((await prisma.bridgeDevice.findUniqueOrThrow({ where: { id: device.id } })).status, "ONLINE");
  assert.equal((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: command.commandId } })).status, "PENDING");
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: data.root.id } })).isEnabled, true);
  assert.equal(await prisma.bridgeAuditEntry.count({ where: { bridgeDeviceId: device.bridgeDeviceId, eventType: "DEVICE_REVOKED" } }), 0);
  await prisma.$executeRawUnsafe('DROP TRIGGER revoke_fault ON "ConnectedFolder"');
  await cloud.revokeBridgeDevice(device.bridgeDeviceId);
  assert.equal((await prisma.bridgeDevice.findUniqueOrThrow({ where: { id: device.id } })).status, "REVOKED");
  assert.equal((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: command.commandId } })).status, "CANCELLED");
  const root = await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: data.root.id } });
  assert.equal(root.isEnabled, false); assert.equal(root.status, "DISCONNECTED");
  assert.ok(root.disconnectedAt, "Root revocation has a durable human lifecycle timestamp");
});

async function remotePlanFixture(t: TestContext, count = 2) {
  const device = await deviceFixture(t), data = await knowledgeScaleFixture(prisma, "Synthetic remote authority", count, () => "Synthetic approved physical content");
  t.after(data.dispose);
  await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { bridgeDeviceId: device.bridgeDeviceId,
    createFolderPermission: true, moveFilePermission: true, renameFilePermission: true } });
  const { currentRecommendationGenerationVersion } = await import("../../src/lib/bridge/recommendation-generation");
  const generation = randomUUID(), actions = [];
  for (const [index, row] of data.rows.entries()) {
    row.checksum = createHash("sha256").update(`Synthetic content ${index}`).digest("hex");
    await prisma.scannedFile.update({ where: { id: row.id }, data: { checksum: row.checksum, processingStage: "RECOMMENDATIONS_READY" } });
    const suggestion = await prisma.organizationSuggestion.create({ data: { scannedFileId: row.id, scanSessionId: data.scan.id,
      suggestionKey: randomUUID(), suggestionType: "MOVE_FILE", currentRelativePath: row.relativePath, proposedRelativePath: `organized/${index}.txt`,
      title: "Synthetic approved move", explanation: "Human-approved synthetic fixture", status: "APPROVED", whySuggested: [], supportingInformation: [],
      recommendationGenerationId: generation, recommendationGenerationVersion: currentRecommendationGenerationVersion } });
    actions.push({ id: randomUUID(), order: index + 1, actionType: "MOVE_FILE", selectedForExecution: true, selectableForExecution: true,
      suggestionId: suggestion.id, suggestionType: "MOVE_FILE", sourceRelativePath: row.relativePath, plannedRelativePath: `organized/${index}.txt`,
      plannedFolderPath: "organized", plannedFileName: `${index}.txt`, recommendationGenerationId: generation,
      recommendationGenerationVersion: currentRecommendationGenerationVersion,
      sourceSnapshot: { scannedFileId: row.id, relativePath: row.relativePath, checksum: row.checksum, sizeBytes: null, lastModified: null },
      reason: "Explicit synthetic human approval", confidence: 1,
      originatingSuggestion: { title: suggestion.title, explanation: suggestion.explanation, status: "APPROVED" }, humanEdits: [],
      evidence: { approvedObservation: [], approvedMemory: [], humanModification: [], originatingSuggestion: [] } });
  }
  const plan = await prisma.organizationPlan.create({ data: { connectedLibraryId: data.root.id, scanSessionId: data.scan.id,
    createdBy: "Deanne", status: "READY_FOR_EXECUTION", totalActions: count, approvedActions: count, actions, warnings: [], skippedItems: [], history: [] } });
  return { ...data, device, plan };
}
async function queuedRemotePlan(t: TestContext, count = 2) {
  const f = await remotePlanFixture(t, count);
  const remote = await import("../../src/lib/bridge/remote-execution");
  const queued = await remote.queueRemoteOrganizationPlanExecution(f.plan.id, "EXECUTE"); assert.ok(queued);
  const run = await prisma.executionRun.findFirstOrThrow({ include: { actions: { orderBy: { sequence: "asc" } } }, where: { organizationPlanId: f.plan.id } });
  const command = await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: queued.command.commandId } });
  const results = run.actions.map((action) => ({ actionId: action.id, actionType: action.actionType, sourceRelativePath: action.sourceRelativePath,
    destinationRelativePath: action.destinationRelativePath, sourceChecksumBefore: action.sourceChecksumBefore,
    destinationChecksumAfter: action.sourceChecksumBefore, createdFilesystemItem: false, status: "COMPLETED" }));
  return { ...f, run, command, results, remote };
}

test("TX-1 remote execution command failure rolls back its claim, run, and children", async (t) => {
  const f = await remotePlanFixture(t);
  await prisma.$executeRawUnsafe(`CREATE FUNCTION "${schema}".command_admission_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic command admission fault'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER command_admission_fault BEFORE INSERT ON "BridgeCommand" FOR EACH ROW EXECUTE FUNCTION "${schema}".command_admission_fault()`);
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS command_admission_fault ON "BridgeCommand"'); });
  const remote = await import("../../src/lib/bridge/remote-execution");
  await assert.rejects(remote.queueRemoteOrganizationPlanExecution(f.plan.id, "EXECUTE"), /synthetic command admission fault/);
  assert.equal(await prisma.executionRun.count({ where: { organizationPlanId: f.plan.id } }), 0);
  assert.deepEqual((await prisma.organizationPlan.findUniqueOrThrow({ where: { id: f.plan.id } })).updatedAt, f.plan.updatedAt);
  await prisma.$executeRawUnsafe('DROP TRIGGER command_admission_fault ON "BridgeCommand"');
  assert.ok(await remote.queueRemoteOrganizationPlanExecution(f.plan.id, "EXECUTE"));
});

test("AUTH-2 simultaneous remote execution admits exactly one owned run and command", async (t) => {
  const f = await remotePlanFixture(t), remote = await import("../../src/lib/bridge/remote-execution");
  const held = barrier(), release = barrier(); t.after(release.resolve);
  const lock = prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${f.root.id} FOR UPDATE`; held.resolve(); await release.promise; }, { timeout: 30_000 });
  await held.promise;
  const one = remote.queueRemoteOrganizationPlanExecution(f.plan.id, "EXECUTE"); await waitForReviewWaiters(1, "ConnectedFolder", "SHARE");
  const two = remote.queueRemoteOrganizationPlanExecution(f.plan.id, "EXECUTE"); await waitForReviewWaiters(2, "ConnectedFolder", "SHARE");
  release.resolve(); await lock;
  const results = await Promise.allSettled([one, two]); assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(await prisma.executionRun.count({ where: { organizationPlanId: f.plan.id } }), 1);
  assert.equal(await prisma.bridgeCommand.count({ where: { connectedLibraryId: f.root.id, commandType: "EXECUTE_PLAN" } }), 1);
});

test("PROOF-1 incomplete remote action coverage cannot claim complete execution", async (t) => {
  const f = await queuedRemotePlan(t);
  await f.remote.applyRemoteExecutionReport({ commandPayload: f.command.payload,
    report: { commandId: f.command.commandId, status: "COMPLETED", result: { status: "COMPLETED", actions: f.results.slice(0, 1) } } });
  const run = await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } });
  assert.equal(run.status, "RUNNING"); assert.equal(run.successfulActions, 1); assert.equal(run.failedActions, 0);
  assert.equal(run.safeErrorCategory, "COMMAND_RECOVERY_REQUIRED", "Missing action proof retains uncertainty rather than inventing a failed outcome");
});

test("PROOF-1 mismatched and repeated remote physical identities write no action or path state", async (t) => {
  const f = await queuedRemotePlan(t);
  for (const actions of [[{ ...f.results[0], destinationRelativePath: "unauthorized.txt" }], [f.results[0], f.results[0]], [{ ...f.results[0], destinationChecksumAfter: "wrong" }]]) {
    await assert.rejects(f.remote.applyRemoteExecutionReport({ commandPayload: f.command.payload,
      report: { commandId: f.command.commandId, status: "COMPLETED", result: { status: "COMPLETED", actions } } }), /identity|paths and checksum/);
  }
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } })).status, "PENDING");
  assert.deepEqual((await prisma.scannedFile.findMany({ where: { sessionId: f.scan.id }, orderBy: { relativePath: "asc" } })).map((file) => file.relativePath), f.rows.map((row) => row.relativePath));
});

test("AUTH-2 simultaneous remote Undo admits one run and replay cannot undo the Undo", async (t) => {
  const f = await queuedRemotePlan(t), undo = await import("../../src/lib/bridge/remote-undo");
  const executionReport = { commandId: f.command.commandId, status: "COMPLETED" as const, result: { status: "COMPLETED", actions: f.results } };
  await f.remote.applyRemoteExecutionReport({ commandPayload: f.command.payload, report: executionReport });
  const held = barrier(), release = barrier(); t.after(release.resolve);
  const lock = prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${f.root.id} FOR UPDATE`; held.resolve(); await release.promise; }, { timeout: 30_000 });
  await held.promise;
  const one = undo.queueRemoteExecutionUndo(f.run.id, "UNDO"); await waitForReviewWaiters(1, "ConnectedFolder", "SHARE");
  const two = undo.queueRemoteExecutionUndo(f.run.id, "UNDO"); await waitForReviewWaiters(2, "ConnectedFolder", "SHARE");
  release.resolve(); await lock; const results = await Promise.allSettled([one, two]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const undoRun = await prisma.undoRun.findFirstOrThrow({ include: { actions: true }, where: { executionRunId: f.run.id } });
  assert.equal(await prisma.undoRun.count({ where: { executionRunId: f.run.id } }), 1);
  const command = await prisma.bridgeCommand.findFirstOrThrow({ where: { commandType: "EXECUTE_UNDO", connectedLibraryId: f.root.id } });
  const checksumByAction = new Map(f.run.actions.map((action) => [action.id, action.sourceChecksumBefore]));
  const restored = undoRun.actions.map((action) => ({ actionId: action.id, actionType: action.actionType, sourceRelativePath: action.sourceRelativePath,
    destinationRelativePath: action.destinationRelativePath, sourceChecksumBefore: checksumByAction.get(action.originalExecutionActionId)!,
    destinationChecksumAfter: checksumByAction.get(action.originalExecutionActionId)!, status: "COMPLETED" }));
  const report = { commandId: command.commandId, status: "COMPLETED" as const, result: { status: "COMPLETED", actions: restored } };
  await undo.applyRemoteUndoReport({ commandPayload: command.payload, report });
  const files = await prisma.scannedFile.findMany({ where: { sessionId: f.scan.id }, orderBy: { id: "asc" } });
  await f.remote.applyRemoteExecutionReport({ commandPayload: f.command.payload, report: executionReport });
  await undo.applyRemoteUndoReport({ commandPayload: command.payload, report });
  assert.deepEqual(await prisma.scannedFile.findMany({ where: { sessionId: f.scan.id }, orderBy: { id: "asc" } }), files);
  assert.equal((await prisma.undoRun.findUniqueOrThrow({ where: { id: undoRun.id } })).status, "COMPLETED");
});

test("RECOVER-1 partial remote Undo retries only unrestored actions and late reports preserve the aggregate restoration", async (t) => {
  const f = await queuedRemotePlan(t, 2), undo = await import("../../src/lib/bridge/remote-undo");
  await f.remote.applyRemoteExecutionReport({ commandPayload: f.command.payload,
    report: { commandId: f.command.commandId, status: "COMPLETED", result: { actions: f.results } } });
  const first = await undo.queueRemoteExecutionUndo(f.run.id, "UNDO"); assert.ok(first);
  const firstRun = await prisma.undoRun.findFirstOrThrow({ where: { executionRunId: f.run.id }, include: { actions: { orderBy: { sequence: "asc" } } } });
  const checksums = new Map(f.run.actions.map((action) => [action.id, action.sourceChecksumBefore]));
  const result = (action: typeof firstRun.actions[number], status: "COMPLETED" | "FAILED") => ({ actionId: action.id,
    actionType: action.actionType, sourceRelativePath: action.sourceRelativePath, destinationRelativePath: action.destinationRelativePath,
    sourceChecksumBefore: checksums.get(action.originalExecutionActionId)!, destinationChecksumAfter: checksums.get(action.originalExecutionActionId)!,
    physicalEffect: status === "FAILED" ? "NONE" : "CHANGED", status });
  const partialReport = { commandId: first.command.commandId, status: "FAILED" as const,
    result: { actions: firstRun.actions.map((action, index) => result(action, index === 0 ? "COMPLETED" : "FAILED")) } };
  await undo.applyRemoteUndoReport({ commandPayload: first.command.payload, report: partialReport });
  assert.equal((await prisma.undoRun.findUniqueOrThrow({ where: { id: firstRun.id } })).status, "PARTIALLY_COMPLETED");
  const second = await undo.queueRemoteExecutionUndo(f.run.id, "UNDO"); assert.ok(second);
  const secondRun = await prisma.undoRun.findFirstOrThrow({ where: { executionRunId: f.run.id, id: { not: firstRun.id } }, include: { actions: true } });
  assert.equal(secondRun.actions.length, 1);
  assert.equal(secondRun.actions[0].originalExecutionActionId, firstRun.actions[1].originalExecutionActionId);
  await undo.applyRemoteUndoReport({ commandPayload: second.command.payload,
    report: { commandId: second.command.commandId, status: "COMPLETED", result: { actions: secondRun.actions.map((action) => result(action, "COMPLETED")) } } });
  const restoredFiles = await prisma.scannedFile.findMany({ where: { sessionId: f.scan.id }, orderBy: { id: "asc" } });
  await undo.applyRemoteUndoReport({ commandPayload: first.command.payload, report: partialReport });
  assert.deepEqual(await prisma.scannedFile.findMany({ where: { sessionId: f.scan.id }, orderBy: { id: "asc" } }), restoredFiles);
  assert.equal(await prisma.undoAction.count({ where: { undoRun: { executionRunId: f.run.id }, status: "COMPLETED" } }), 2);
  assert.equal(new Set(restoredFiles.map((file) => file.relativePath)).size, 2);
  assert.deepEqual(restoredFiles.map((file) => file.relativePath).sort(), f.run.actions.map((action) => action.sourceRelativePath).sort());
  await assert.rejects(undo.queueRemoteExecutionUndo(f.run.id, "UNDO"), /Undo|undone|restor|available/i);
});

test("CLOSURE-1 definitive failed remote actions preserve the physical epoch and current evidence", async (t) => {
  const f = await remotePlanFixture(t, 2);
  for (const row of f.rows) {
    await prisma.libraryDocument.update({ where: { id: row.documentId }, data: { checksum: row.checksum, rawText: "Cobalt cobalt garden stories.", previewText: "Cobalt cobalt garden stories." } });
    await prisma.observationSession.update({ where: { id: row.observationId }, data: { status: "APPROVED", observerType: "OPENAI",
      observations: [{ description: "Cobalt cobalt garden stories.", evidence: ['Source characters 0-28: "Cobalt cobalt garden stories."'] }] } });
    await prisma.humanDecision.create({ data: { observationSessionId: row.observationId, decisionType: "ACCEPT" } });
    await memory.buildMemoryFromApprovedSession(row.observationId);
  }
  const search = await import("../../src/lib/library/search");
  const beforeMemory = await memory.getMemoryPageData();
  const beforeSearch = await search.searchLibrary("records", [f.root.id]);
  assert.ok(beforeSearch.length); assert.ok(beforeMemory.preferredTerms.length);
  const remote = await import("../../src/lib/bridge/remote-execution");
  const queued = await remote.queueRemoteOrganizationPlanExecution(f.plan.id, "EXECUTE"); assert.ok(queued);
  const run = await prisma.executionRun.findFirstOrThrow({ where: { organizationPlanId: f.plan.id }, include: { actions: true } });
  const command = await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: queued.command.commandId } });
  await remote.applyRemoteExecutionReport({ commandPayload: command.payload, report: { commandId: command.commandId, status: "FAILED",
    result: { actions: run.actions.map((action) => ({ actionId: action.id, actionType: action.actionType, sourceRelativePath: action.sourceRelativePath || null,
      destinationRelativePath: action.destinationRelativePath, status: "FAILED", safeErrorCategory: "DESTINATION_CONFLICT", physicalEffect: "NONE" })) } } });
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).physicalInventoryGeneration, 0,
    "A definitive no-effect failure must not invalidate a verified current inventory");
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: run.id } })).reconciliationStatus, "NOT_REQUESTED");
  assert.deepEqual(await search.searchLibrary("records", [f.root.id]), beforeSearch);
  assert.deepEqual(await memory.getMemoryPageData(), beforeMemory);
  const { latestKnowledgeSnapshot } = await import("../../src/lib/bridge/current-knowledge-query");
  assert.deepEqual(await prisma.$queryRaw(Prisma.sql`SELECT latest.id FROM "ConnectedFolder" root ${latestKnowledgeSnapshot} WHERE root.id = ${f.root.id}`), [{ id: f.scan.id }]);
});

test("CLOSURE-2 selected abandoned work cannot resurrect a scan retired by physical completion", async (t) => {
  const f = await queuedRemotePlan(t, 1), row = f.rows[0];
  const authority = await import("../../src/lib/bridge/observation-authority");
  const recovery = await import("../../src/lib/bridge/observation-recovery");
  const stale = new Date(Date.now() - authority.observationLeaseMs - 1000);
  await prisma.scanSession.update({ where: { id: f.scan.id }, data: { status: "READING", completedAt: null } });
  await prisma.scannedFile.update({ where: { id: row.id }, data: { libraryDocumentId: null, processingStage: "READING", observationClaimedAt: stale,
    observationRootRevision: 0, observationDeviceKeyFingerprint: authority.deviceKeyFingerprint(f.device.publicKey) } });
  const held = barrier(), finish = barrier(); t.after(finish.resolve);
  const physical = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${f.root.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ScannedFile" WHERE id = ${row.id} FOR UPDATE`;
    held.resolve(); await finish.promise;
    await f.remote.applyRemoteExecutionReport({ commandPayload: f.command.payload,
      report: { commandId: f.command.commandId, status: "COMPLETED", result: { actions: f.results } } }, tx);
  }, { timeout: 30_000 });
  await held.promise;
  const late = recovery.recoverAbandonedObservationFilesForDevice(f.device.bridgeDeviceId);
  const deadline = Date.now() + 15_000;
  let waiting = false;
  while (Date.now() < deadline) {
    const [state] = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*) FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND (query LIKE '%UPDATE%ScannedFile%' OR query LIKE '%SELECT id FROM "ConnectedFolder"%FOR SHARE%')`);
    if (Number(state.count)) { waiting = true; break; }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(waiting, "The real recovery transaction reached its mutation/authority barrier");
  finish.resolve(); await physical; const recovered = await late;
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: f.scan.id } })).status, "FAILED",
    "An old recovery candidate cannot revive a retired scan");
  assert.equal(recovered, 0);
  assert.equal((await prisma.scannedFile.findUniqueOrThrow({ where: { id: row.id } })).observationClaimedAt?.getTime(), stale.getTime());
  const reconcile = await import("../../src/lib/bridge/execution-reconciliation");
  await reconcile.recoverExecutionReconciliations({ bridgeDeviceId: f.device.bridgeDeviceId });
  const run = await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } });
  assert.equal(run.reconciliationStatus, "IN_PROGRESS"); assert.ok(run.reconciliationScanSessionId);
  assert.equal(await recovery.recoverAbandonedObservationFilesForDevice(f.device.bridgeDeviceId), 0);
});

for (const result of [undefined, { actions: [] }, { actions: [{ status: "FAILED" }] }]) {
  test(`CLOSURE-1 ${JSON.stringify(result) ?? "absent results"} cannot manufacture a no-effect outcome`, async (t) => {
    const f = await queuedRemotePlan(t, 1);
    const submitted = result?.actions.length ? { actions: [{ actionId: f.run.actions[0].id, status: "FAILED" }] } : result;
    await f.remote.applyRemoteExecutionReport({ commandPayload: f.command.payload, report: { commandId: f.command.commandId, status: "FAILED", result: submitted } });
    const run = await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id }, include: { actions: true } });
    assert.equal(run.status, "RUNNING"); assert.equal(run.actions[0].status, "PENDING");
    assert.equal(run.actions[0].safeErrorCategory, "COMMAND_RECOVERY_REQUIRED", "Unknown child results cannot claim execution was blocked before any effect");
    assert.equal(run.safeErrorCategory, "COMMAND_RECOVERY_REQUIRED"); assert.equal(run.reconciliationStatus, "INSPECTION_REQUIRED");
    assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).physicalInventoryGeneration, 0);
    const reconcile = await import("../../src/lib/bridge/execution-reconciliation");
    await reconcile.recoverExecutionReconciliations({ bridgeDeviceId: f.device.bridgeDeviceId });
    assert.equal(await prisma.bridgeCommand.count({ where: { connectedLibraryId: f.root.id, commandType: "RECONCILE_LIBRARY" } }), 0);
    await assert.rejects(prisma.$transaction((tx) => reconcile.assertInventoryAfterPhysicalOutcomes(tx, f.root.id, 0)), /unresolved/);
  });
}

test("CLOSURE-1 partial results, replay and FAILED parent retain one recoverable physical obligation", async (t) => {
  const f = await queuedRemotePlan(t, 2);
  const report = { commandId: f.command.commandId, status: "FAILED" as const,
    result: { actions: [f.results[0], { ...f.results[1], status: "FAILED", physicalEffect: "NONE" }] } };
  await f.remote.applyRemoteExecutionReport({ commandPayload: f.command.payload, report });
  let run = await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } });
  assert.equal(run.status, "PARTIALLY_COMPLETED"); assert.equal(run.successfulActions, 1); assert.equal(run.failedActions, 1);
  const generation = run.reconciliationGeneration;
  await f.remote.applyRemoteExecutionReport({ commandPayload: f.command.payload, report });
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).physicalInventoryGeneration, 1);
  // Older retained deployments can have FAILED parents with verified completed
  // children. The ordinary production coordinator must admit them too.
  await prisma.executionRun.update({ where: { id: f.run.id }, data: { status: "FAILED" } });
  const reconcile = await import("../../src/lib/bridge/execution-reconciliation");
  for (let attempt = 0; attempt < 3; attempt++) await reconcile.recoverExecutionReconciliations({ bridgeDeviceId: f.device.bridgeDeviceId });
  run = await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } });
  assert.equal(run.reconciliationStatus, "IN_PROGRESS"); assert.ok(run.reconciliationScanSessionId);
  assert.equal(run.reconciliationGeneration, generation);
  assert.equal(await prisma.bridgeCommand.count({ where: { connectedLibraryId: f.root.id, commandType: "RECONCILE_LIBRARY" } }), 1);
  const root = await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } });
  const latest = await prisma.scanSession.create({ data: { connectedFolderId: root.id, inventoryGeneration: root.physicalInventoryGeneration, status: "COMPLETED" } });
  await reconcile.recoverExecutionReconciliations({ bridgeDeviceId: f.device.bridgeDeviceId });
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } })).reconciliationStatus, "COMPLETED");
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: latest.id } })).searchIndexStatus, "COMPLETED");
});

test("CLOSURE-1 completed existing folder has no physical effect and failed Undo does not advance generation", async (t) => {
  const folder = await queuedRemotePlan(t, 1);
  await prisma.executionAction.update({ where: { id: folder.run.actions[0].id }, data: { actionType: "CREATE_FOLDER", sourceRelativePath: "", sourceChecksumBefore: null } });
  await folder.remote.applyRemoteExecutionReport({ commandPayload: folder.command.payload, report: { commandId: folder.command.commandId, status: "COMPLETED",
    result: { actions: [{ actionId: folder.run.actions[0].id, actionType: "CREATE_FOLDER", sourceRelativePath: null,
      destinationRelativePath: folder.run.actions[0].destinationRelativePath, status: "COMPLETED", createdFilesystemItem: false }] } } });
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: folder.root.id } })).physicalInventoryGeneration, 0);
  const f = await queuedRemotePlan(t, 1), undo = await import("../../src/lib/bridge/remote-undo");
  await f.remote.applyRemoteExecutionReport({ commandPayload: f.command.payload, report: { commandId: f.command.commandId, status: "COMPLETED", result: { actions: f.results } } });
  const queued = await undo.queueRemoteExecutionUndo(f.run.id, "UNDO"); assert.ok(queued);
  const command = await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: queued.command.commandId } });
  const owner = await prisma.undoRun.findFirstOrThrow({ where: { executionRunId: f.run.id }, include: { actions: true } });
  const before = await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } });
  await undo.applyRemoteUndoReport({ commandPayload: command.payload, report: { commandId: command.commandId, status: "FAILED",
    result: { actions: owner.actions.map((a) => ({ actionId: a.id, actionType: a.actionType, sourceRelativePath: a.sourceRelativePath,
      destinationRelativePath: a.destinationRelativePath, status: "FAILED", physicalEffect: "NONE" })) } } });
  assert.equal((await prisma.undoRun.findUniqueOrThrow({ where: { id: owner.id } })).status, "FAILED");
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).physicalInventoryGeneration, 1);
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } })).reconciliationGeneration, before.reconciliationGeneration);
});

test("CLOSURE-1 signed empty result remains recoverable and later proof advances the epoch exactly once", async (t) => {
  const f = await queuedRemotePlan(t, 1), cloud = await import("../../src/lib/bridge/cloud-coordinator");
  await cloud.acknowledgeBridgeCloudCommand(f.device.bridgeDeviceId, f.command.commandId);
  const route = await import("../../src/app/api/bridge/cloud/devices/[deviceId]/commands/[commandId]/complete/route");
  const pathname = `/api/bridge/cloud/devices/${f.device.bridgeDeviceId}/commands/${f.command.commandId}/complete`;
  const send = async (actions: unknown[]) => {
    const bodyText = JSON.stringify({ status: "COMPLETED", result: { actions } });
    return route.POST(new Request(`http://localhost:3000${pathname}`, { method: "POST", body: bodyText,
      headers: createBridgeDeviceRequestHeaders({ bodyText, bridgeDeviceId: f.device.bridgeDeviceId, method: "POST", pathname, privateKey: f.device.privateKey }) }),
    { params: Promise.resolve({ deviceId: f.device.bridgeDeviceId, commandId: f.command.commandId }) });
  };
  assert.equal((await send([])).status, 200);
  const unknown = await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: f.command.commandId } });
  assert.equal(unknown.status, "RUNNING"); assert.equal(unknown.safeErrorCategory, "COMMAND_RECOVERY_REQUIRED");
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).physicalInventoryGeneration, 0);
  assert.equal((await send(f.results)).status, 200); assert.equal((await send(f.results)).status, 200);
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).physicalInventoryGeneration, 1);
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } })).status, "COMPLETED");
});

test("CLOSURE-1 actual process death cannot split persisted action outcomes from reconciliation admission", async (t) => {
  const f = await queuedRemotePlan(t, 1), directory = await mkdtemp(path.join(os.tmpdir(), "nsn-closure-report-"));
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true, force: true }); });
  const inputPath = path.join(directory, "input.json");
  await writeFile(inputPath, JSON.stringify({ commandPayload: f.command.payload, report: { commandId: f.command.commandId, status: "COMPLETED", result: { actions: f.results } } }));
  const held = barrier(), release = barrier(); t.after(release.resolve);
  const lock = prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT pg_advisory_xact_lock(4213170295::bigint)::text`; held.resolve(); await release.promise; }, { timeout: 30_000 });
  await held.promise;
  await prisma.$executeRawUnsafe(`CREATE FUNCTION closure_epoch_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."physicalInventoryGeneration" > OLD."physicalInventoryGeneration" THEN PERFORM pg_advisory_xact_lock(4213170295::bigint); END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe('CREATE TRIGGER closure_epoch_pause BEFORE UPDATE ON "ConnectedFolder" FOR EACH ROW EXECUTE FUNCTION closure_epoch_pause()');
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS closure_epoch_pause ON "ConnectedFolder"'); });
  const child = () => spawn(process.execPath, ["--import", "tsx", "tests/fixtures/audit-closure-report-worker.ts", inputPath], { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const interrupted = child(); t.after(() => { interrupted.kill(); });
  const deadline = Date.now() + 15_000; let waiting = false;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
      AND wait_event_type = 'Lock' AND query LIKE '%UPDATE%ConnectedFolder%physicalInventoryGeneration%'`);
    if (Number(row.count)) { waiting = true; break; } await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(waiting, "Child persisted its action inside the transaction and reached the reconciliation trigger");
  interrupted.kill("SIGKILL"); await new Promise<void>((resolve) => interrupted.once("exit", () => resolve()));
  release.resolve(); await lock;
  assert.equal((await prisma.executionAction.findUniqueOrThrow({ where: { id: f.run.actions[0].id } })).status, "PENDING");
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } })).reconciliationStatus, "NOT_REQUESTED");
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).physicalInventoryGeneration, 0);
  await prisma.$executeRawUnsafe('DROP TRIGGER closure_epoch_pause ON "ConnectedFolder"');
  const committed = child(); t.after(() => { committed.kill(); });
  await new Promise<void>((resolve, reject) => { committed.once("message", () => resolve()); committed.once("exit", (code) => reject(new Error(`Report worker exited ${code}`))); });
  committed.kill("SIGKILL"); await new Promise<void>((resolve) => committed.once("exit", () => resolve()));
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } })).reconciliationStatus, "REQUIRED");
  const reconcile = await import("../../src/lib/bridge/execution-reconciliation");
  await reconcile.recoverExecutionReconciliations({ bridgeDeviceId: f.device.bridgeDeviceId });
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } })).reconciliationStatus, "IN_PROGRESS");
});

async function abandonedRemoteFixture(t: TestContext) {
  const f = await remotePlanFixture(t, 1), authority = await import("../../src/lib/bridge/observation-authority");
  const claimedAt = new Date(Date.now() - authority.observationLeaseMs - 1000);
  await prisma.scanSession.update({ where: { id: f.scan.id }, data: { status: "READING", completedAt: null } });
  await prisma.scannedFile.update({ where: { id: f.rows[0].id }, data: { libraryDocumentId: null,
    processingStage: "READING", observationClaimedAt: claimedAt, observationRootRevision: 0,
    observationDeviceKeyFingerprint: authority.deviceKeyFingerprint(f.device.publicKey) } });
  return { ...f, authority, claimedAt, recovery: await import("../../src/lib/bridge/observation-recovery") };
}

test("CLOSURE-2 competing recovery workers resume only one genuinely current abandoned owner", async (t) => {
  const f = await abandonedRemoteFixture(t), held = barrier(), release = barrier(); t.after(release.resolve);
  const lock = prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${f.root.id} FOR UPDATE`; held.resolve(); await release.promise; }, { timeout: 30_000 });
  await held.promise;
  const one = f.recovery.recoverAbandonedObservationFilesForDevice(f.device.bridgeDeviceId); await waitForReviewWaiters(1, "ConnectedFolder", "SHARE");
  const two = f.recovery.recoverAbandonedObservationFilesForDevice(f.device.bridgeDeviceId); await waitForReviewWaiters(2, "ConnectedFolder", "SHARE");
  release.resolve(); await lock;
  assert.deepEqual((await Promise.all([one, two])).sort(), [0, 1]);
  const file = await prisma.scannedFile.findUniqueOrThrow({ where: { id: f.rows[0].id } });
  assert.equal(file.processingStage, "DISCOVERED"); assert.equal(file.readingStatus, "NOT_READ"); assert.equal(file.observationClaimedAt, null);
  const state = await prisma.scanSession.findUniqueOrThrow({ where: { id: f.scan.id } });
  assert.equal(await f.recovery.recoverAbandonedObservationFilesForDevice(f.device.bridgeDeviceId), 0);
  assert.deepEqual(await prisma.scanSession.findUniqueOrThrow({ where: { id: f.scan.id } }), state);
  await assert.rejects(f.authority.withOwnedObservationLease(file.id, f.claimedAt, async (tx) => { await tx.scannedFile.update({ where: { id: file.id }, data: { processingStage: "EXAMINED" } }); }), /ownership/);
});

for (const state of ["FAILED", "COMPLETED", "COMPLETED_WITH_ERRORS", "GENERATING_SUGGESTIONS", "PENDING", "SCANNING"] as const) {
  test(`CLOSURE-2 late recovery preserves ${state} scan lifecycle`, async (t) => {
    const f = await abandonedRemoteFixture(t);
    await prisma.scanSession.update({ where: { id: f.scan.id }, data: { status: state } });
    const scan = await prisma.scanSession.findUniqueOrThrow({ where: { id: f.scan.id } });
    const file = await prisma.scannedFile.findUniqueOrThrow({ where: { id: f.rows[0].id } });
    assert.equal(await f.recovery.recoverAbandonedObservationFilesForDevice(f.device.bridgeDeviceId), 0);
    assert.deepEqual(await prisma.scanSession.findUniqueOrThrow({ where: { id: scan.id } }), scan);
    assert.deepEqual(await prisma.scannedFile.findUniqueOrThrow({ where: { id: file.id } }), file);
  });
}

test("CLOSURE-2 generation, connection and key mismatch never resume an old abandoned lease", async (t) => {
  const f = await abandonedRemoteFixture(t);
  for (const data of [{ observationRootRevision: null }, { observationDeviceKeyFingerprint: null }]) {
    await prisma.scannedFile.update({ where: { id: f.rows[0].id }, data });
    assert.equal(await f.recovery.recoverAbandonedObservationFilesForDevice(f.device.bridgeDeviceId), 0,
      "A timestamp without captured root/key authority is not a recoverable modern lease");
    await prisma.scannedFile.update({ where: { id: f.rows[0].id }, data: { observationRootRevision: 0,
      observationDeviceKeyFingerprint: f.authority.deviceKeyFingerprint(f.device.publicKey) } });
  }
  for (const data of [{ physicalInventoryGeneration: 1 }, { nativeConnectionRevision: 1 }, { readPermission: false }]) {
    await prisma.connectedLibrary.update({ where: { id: f.root.id }, data });
    assert.equal(await f.recovery.recoverAbandonedObservationFilesForDevice(f.device.bridgeDeviceId), 0);
    await prisma.connectedLibrary.update({ where: { id: f.root.id }, data: { physicalInventoryGeneration: 0, nativeConnectionRevision: 0, readPermission: true } });
  }
  await prisma.bridgeDevice.update({ where: { id: f.device.id }, data: { publicKey: createBridgeKeyPair().publicKey } });
  assert.equal(await f.recovery.recoverAbandonedObservationFilesForDevice(f.device.bridgeDeviceId), 0);
  assert.equal((await prisma.scannedFile.findUniqueOrThrow({ where: { id: f.rows[0].id } })).observationClaimedAt?.getTime(), f.claimedAt.getTime());
});

test("CLOSURE-2 new lease owner wins while the selected old recovery candidate waits", async (t) => {
  const f = await abandonedRemoteFixture(t), held = barrier(), release = barrier(); t.after(release.resolve);
  const newer = new Date();
  const lock = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${f.root.id} FOR UPDATE`;
    held.resolve(); await release.promise;
    await tx.scannedFile.update({ where: { id: f.rows[0].id }, data: { observationClaimedAt: newer } });
  }, { timeout: 30_000 });
  await held.promise;
  const late = f.recovery.recoverAbandonedObservationFilesForDevice(f.device.bridgeDeviceId); await waitForReviewWaiters(1, "ConnectedFolder", "SHARE");
  release.resolve(); await lock; assert.equal(await late, 0);
  const file = await prisma.scannedFile.findUniqueOrThrow({ where: { id: f.rows[0].id } });
  assert.equal(file.observationClaimedAt?.getTime(), newer.getTime()); assert.equal(file.processingStage, "READING");
  await f.authority.withOwnedObservationLease(file.id, newer, async (tx) => { await tx.scannedFile.update({ where: { id: file.id }, data: { processingStage: "EXAMINED", observationClaimedAt: null } }); });
  await assert.rejects(f.authority.withOwnedObservationLease(file.id, f.claimedAt, async (tx) => { await tx.scannedFile.update({ where: { id: file.id }, data: { processingStage: "READING" } }); }), /ownership/);
  assert.equal((await prisma.scannedFile.findUniqueOrThrow({ where: { id: file.id } })).processingStage, "EXAMINED");
});

test("CLOSURE-2 terminal candidates cannot starve current abandoned work and no observation success is invented", async (t) => {
  const f = await abandonedRemoteFixture(t), row = f.rows[0];
  const failed = await prisma.scanSession.create({ data: { connectedFolderId: f.root.id, status: "FAILED" } });
  await prisma.scannedFile.createMany({ data: Array.from({ length: 51 }, (_, i) => ({ sessionId: failed.id, relativePath: `old-${i}.txt`,
    localPath: `bridge://old-${i}`, checksum: row.checksum, fileType: "TEXT", readStatus: "SUPPORTED" as const, processingStage: "READING" as const,
    observationClaimedAt: new Date(0), observationRootRevision: 0, observationDeviceKeyFingerprint: f.authority.deviceKeyFingerprint(f.device.publicKey) })) });
  const observations = await prisma.observationSession.count();
  assert.equal(await f.recovery.recoverAbandonedObservationFilesForDevice(f.device.bridgeDeviceId), 1);
  assert.equal(await prisma.observationSession.count(), observations);
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: failed.id } })).status, "FAILED");
  assert.equal((await prisma.scannedFile.findUniqueOrThrow({ where: { id: row.id } })).processingStage, "DISCOVERED");
});

test("CLOSURE-1 later definitive no-effect proof releases uncertainty without advancing generation", async (t) => {
  const f = await queuedRemotePlan(t, 1), input = { commandPayload: f.command.payload,
    report: { commandId: f.command.commandId, status: "FAILED" as const, result: { actions: [] as unknown[] } } };
  await f.remote.applyRemoteExecutionReport(input);
  await f.remote.applyRemoteExecutionReport({ ...input, report: { ...input.report, result: { actions: [{ ...f.results[0], status: "FAILED", physicalEffect: "NONE" }] } } });
  const run = await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } });
  assert.equal(run.status, "FAILED"); assert.equal(run.reconciliationStatus, "NOT_REQUESTED");
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).physicalInventoryGeneration, 0);
  const malformed = await queuedRemotePlan(t, 1);
  await assert.rejects(malformed.remote.applyRemoteExecutionReport({ commandPayload: malformed.command.payload,
    report: { commandId: malformed.command.commandId, status: "FAILED", result: { actions: [{ ...malformed.results[0], status: "FAILED", physicalEffect: "NONE", destinationRelativePath: "different.txt" }] } } }), /No-effect proof/);
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: malformed.run.id } })).status, "PENDING");
});

test("ROOT-2 pairing key replacement atomically denies roots and settles unstarted physical owners", async (t) => {
  const f = await queuedRemotePlan(t, 1), cloud = await import("../../src/lib/bridge/cloud-coordinator");
  const code = await cloud.createBridgePairingCode();
  t.after(async () => { await prisma.bridgePairingCode.delete({ where: { id: code.id } }); });
  const replacement = createBridgeKeyPair();
  await cloud.pairBridgeDevice({ bridgeDeviceId: f.device.bridgeDeviceId, publicKey: replacement.publicKey,
    appVersion: "0.1.0", architecture: "arm64", deviceDisplayName: "Explicit replacement key", pairingCode: code.code, platform: "MACOS" });
  assert.equal((await prisma.bridgeDevice.findUniqueOrThrow({ where: { id: f.device.id } })).publicKey, replacement.publicKey.trim());
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).status, "DISCONNECTED");
  assert.equal((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: f.command.commandId } })).status, "CANCELLED");
  const settled = await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id }, include: { actions: true } });
  assert.equal(settled.status, "BLOCKED"); assert.equal(settled.safeErrorCategory, "DEVICE_KEY_CHANGED");
  assert.ok(settled.completedAt); assert.equal(settled.actions[0].status, "BLOCKED");
  assert.equal(settled.successfulActions, 0);
});

test("RECOVER-1 expiry settles unstarted execution and retains acknowledged physical history", async (t) => {
  const pending = await queuedRemotePlan(t, 1), active = await queuedRemotePlan(t, 1);
  const cloud = await import("../../src/lib/bridge/cloud-coordinator"), lifecycle = await import("../../src/lib/bridge/command-lifecycle");
  await cloud.acknowledgeBridgeCloudCommand(active.device.bridgeDeviceId, active.command.commandId);
  await prisma.bridgeCommand.updateMany({ where: { commandId: { in: [pending.command.commandId, active.command.commandId] } }, data: { expiresAt: new Date(0) } });
  await lifecycle.expireUnstartedCommands();
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: pending.run.id } })).status, "BLOCKED");
  assert.equal((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: pending.command.commandId } })).status, "EXPIRED");
  assert.equal((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: active.command.commandId } })).status, "ACKNOWLEDGED");
  await cloud.revokeBridgeDevice(active.device.bridgeDeviceId);
  assert.equal((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: active.command.commandId } })).status, "ACKNOWLEDGED");
});

test("CURRENT-2 root reconnection and device key replacement fence old observation leases", async (t) => {
  const f = await remotePlanFixture(t, 1), authority = await import("../../src/lib/bridge/observation-authority");
  const id = f.rows[0].id, old = await authority.claimObservationLease(id);
  await prisma.connectedLibrary.update({ where: { id: f.root.id }, data: { nativeConnectionRevision: { increment: 1 } } });
  await assert.rejects(authority.withOwnedObservationLease(id, old, async (tx) => { await tx.scannedFile.update({ where: { id }, data: { scanError: "stale" } }); }), /ownership changed/);
  await prisma.scannedFile.update({ where: { id }, data: { observationClaimedAt: null } });
  const current = await authority.claimObservationLease(id);
  await prisma.bridgeDevice.update({ where: { id: f.device.id }, data: { publicKey: createBridgeKeyPair().publicKey } });
  await assert.rejects(authority.withOwnedObservationLease(id, current, async (tx) => { await tx.scannedFile.update({ where: { id }, data: { scanError: "stale" } }); }), /no longer authorizes/);
  assert.equal((await prisma.scannedFile.findUniqueOrThrow({ where: { id } })).scanError, null);
});

async function monitoringFixture(t: TestContext) {
  const f = await remotePlanFixture(t, 2);
  await prisma.connectedLibrary.update({ where: { id: f.root.id }, data: { recommendationPermission: false, watchPermission: true, monitoringState: "WATCHING" } });
  const event = await prisma.monitoringEvent.create({ data: { connectedFolderId: f.root.id, eventType: "FILE_DELETED", eventKey: randomUUID(),
    previousRelativePath: f.rows[0].relativePath, checksumBefore: f.rows[0].checksum, processingStatus: "QUEUED", detectedAt: new Date(0) } });
  const monitor = await import("../../src/lib/bridge/monitor");
  return { ...f, event, monitor };
}
test("CURRENT-1 watch deletion hints reconcile a full inventory and preserve unchanged and historical owners", async (t) => {
  const f = await monitoringFixture(t);
  await f.monitor.processMonitoringQueue({ connectedFolderId: f.root.id });
  const batch = await prisma.monitoringBatch.findFirstOrThrow({ where: { connectedFolderId: f.root.id } });
  assert.equal(batch.status, "PROCESSING"); assert.ok(batch.scanSessionId);
  const command = await prisma.bridgeCommand.findFirstOrThrow({ where: { connectedLibraryId: f.root.id, commandType: "RECONCILE_LIBRARY" } });
  assert.equal((await prisma.scannedFile.findUniqueOrThrow({ where: { id: f.rows[0].id } })).sourceUnavailableAt, null);
  const files = f.rows.map((row, index) => ({ relativePath: row.relativePath, checksum: index === 0 ? createHash("sha256").update("replacement").digest("hex") : row.checksum,
    fileType: "TEXT", readStatus: "FAILED", sizeBytes: null, lastModified: null, sourceCreatedAt: null, scanError: "Synthetic temporarily unavailable source" }));
  await reads.importRemoteBridgeScanReport({ bridgeDeviceId: f.device.bridgeDeviceId, bridgeRootId: f.root.bridgeRootId!, connectedLibraryId: f.root.id,
    commandPayload: command.payload, report: { commandId: command.commandId, status: "COMPLETED",
      completedAt: new Date().toISOString(), result: { files } } });
  assert.equal(await prisma.scannedFile.count({ where: { sessionId: batch.scanSessionId! } }), 2, "A change to one file retains the full current inventory");
  await f.monitor.recoverMonitoringBatchesForDevice(f.device.bridgeDeviceId);
  const current = await prisma.monitoringBatch.findUniqueOrThrow({ where: { id: batch.id } });
  assert.ok(["READY_FOR_REVIEW", "COMPLETED_WITH_ERRORS"].includes(current.status));
  const historical = await prisma.scannedFile.findUniqueOrThrow({ where: { id: f.rows[0].id } });
  assert.equal(historical.sourceUnavailableAt, null); assert.equal(historical.checksum, f.rows[0].checksum); assert.equal(historical.relativePath, f.rows[0].relativePath);
  assert.ok(await prisma.scannedFile.count({ where: { sessionId: batch.scanSessionId!, relativePath: f.rows[1].relativePath, checksum: f.rows[1].checksum } }), "Unchanged physical owner remains present");
});

test("TX-1 concurrent watch claims commit one full reconcile command and recover without re-admission", async (t) => {
  const f = await monitoringFixture(t);
  await Promise.all([f.monitor.processMonitoringQueue({ connectedFolderId: f.root.id }), f.monitor.processMonitoringQueue({ connectedFolderId: f.root.id })]);
  assert.equal(await prisma.monitoringBatch.count({ where: { connectedFolderId: f.root.id } }), 1);
  assert.equal(await prisma.bridgeCommand.count({ where: { connectedLibraryId: f.root.id, commandType: "RECONCILE_LIBRARY" } }), 1);
  const batch = await prisma.monitoringBatch.findFirstOrThrow({ where: { connectedFolderId: f.root.id } });
  await prisma.monitoringBatch.update({ where: { id: batch.id }, data: { processingLeaseUntil: new Date(0) } });
  await f.monitor.processMonitoringQueue({ connectedFolderId: f.root.id });
  const recovered = await prisma.monitoringBatch.findUniqueOrThrow({ where: { id: batch.id } });
  assert.notEqual(recovered.processingGeneration, batch.processingGeneration);
  assert.equal(recovered.scanSessionId, batch.scanSessionId);
  assert.equal(await prisma.bridgeCommand.count({ where: { connectedLibraryId: f.root.id, commandType: "RECONCILE_LIBRARY" } }), 1);
  const { lockMonitoringBatch } = await import("../../src/lib/bridge/monitoring-authority");
  await assert.rejects(prisma.$transaction((tx) => lockMonitoringBatch(tx, { batchId: batch.id, generation: batch.processingGeneration! })), /ownership/);
});

test("CURRENT-2 scan import from an older connection cannot publish current inventory", async (t) => {
  const f = await monitoringFixture(t);
  await f.monitor.processMonitoringQueue({ connectedFolderId: f.root.id });
  const command = await prisma.bridgeCommand.findFirstOrThrow({ where: { connectedLibraryId: f.root.id, commandType: "RECONCILE_LIBRARY" } });
  await prisma.connectedLibrary.update({ where: { id: f.root.id }, data: { nativeConnectionRevision: { increment: 1 } } });
  const payload = command.payload as Record<string, string>;
  await assert.rejects(reads.importRemoteBridgeScanReport({ bridgeDeviceId: f.device.bridgeDeviceId, bridgeRootId: f.root.bridgeRootId!,
    connectedLibraryId: f.root.id, commandPayload: command.payload, expectedRootRevision: 0,
    report: { commandId: command.commandId, status: "COMPLETED", completedAt: new Date().toISOString(), result: { files: [] } } }), /older root or device authority/);
  assert.equal(await prisma.scannedFile.count({ where: { sessionId: payload.scanSessionId } }), 0);
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: payload.scanSessionId } })).status, "SCANNING");
});

test("SCALE-3 twenty thousand duplicate owners persist bounded durable pages and resume a failed later page", async (t) => {
  const root = await prisma.connectedLibrary.create({ data: { displayName: "Synthetic duplicate persistence", localPath: `bridge://${randomUUID()}`,
    recommendationPermission: true } });
  t.after(async () => { await prisma.connectedLibrary.delete({ where: { id: root.id } }); });
  const scan = await prisma.scanSession.create({ data: { connectedFolderId: root.id, status: "COMPLETED" } });
  const prefix = randomUUID(), count = 20_000;
  for (let offset = 0; offset < count; offset += 500) await prisma.scannedFile.createMany({ data: Array.from({ length: 500 }, (_, index) => {
    const key = String(offset + index).padStart(5, "0");
    return { id: `${prefix}-${key}`, sessionId: scan.id, relativePath: `copy-${key}.txt`, localPath: `${root.localPath}/copy-${key}.txt`,
      checksum: "a".repeat(64), fileType: "TEXT", sizeBytes: 12n, readStatus: "SUPPORTED" as const };
  }) });
  const duplicates = await import("../../src/lib/bridge/checksum-duplicates");
  await prisma.$executeRawUnsafe(`CREATE FUNCTION duplicate_page_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."scannedFileId" = '${prefix}-00100' THEN RAISE EXCEPTION 'injected second duplicate page failure'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe('CREATE TRIGGER duplicate_page_fault BEFORE INSERT ON "OrganizationSuggestion" FOR EACH ROW EXECUTE FUNCTION duplicate_page_fault()');
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS duplicate_page_fault ON "OrganizationSuggestion"'); });
  const first = { transactions: 0, files: 0, maximumFilesPerTransaction: 0 };
  await assert.rejects(duplicates.recordChecksumDuplicateSuggestionsForSession(scan.id, first), /second duplicate page/);
  assert.equal(await prisma.organizationSuggestion.count({ where: { scanSessionId: scan.id, invalidatedAt: null } }), 100);
  assert.deepEqual(first, { transactions: 1, files: 100, maximumFilesPerTransaction: 100 });
  const reviewed = await prisma.organizationSuggestion.findFirstOrThrow({ where: { scanSessionId: scan.id } });
  await prisma.organizationSuggestion.update({ where: { id: reviewed.id }, data: { status: "REJECTED" } });
  await prisma.$executeRawUnsafe('DROP TRIGGER duplicate_page_fault ON "OrganizationSuggestion"');
  const retry = { transactions: 0, files: 0, maximumFilesPerTransaction: 0 };
  const result = await duplicates.recordChecksumDuplicateSuggestionsForSession(scan.id, retry);
  assert.equal(result.duplicateFiles, count);
  assert.deepEqual(retry, { transactions: 200, files: count, maximumFilesPerTransaction: 100 });
  assert.equal(await prisma.organizationSuggestion.count({ where: { scanSessionId: scan.id, invalidatedAt: null } }), count);
  assert.equal((await prisma.organizationSuggestion.findUniqueOrThrow({ where: { id: reviewed.id } })).status, "REJECTED");
});

async function localPhysicalFixture(t: TestContext, count = 1) {
  const f = await remotePlanFixture(t, count);
  const folder = await mkdtemp(path.join(os.tmpdir(), "nsn-physical-invariant-"));
  assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep));
  const previousData = process.env.NSN_BRIDGE_DATA_DIR, previousUrl = process.env.NSN_LOCAL_BRIDGE_URL;
  process.env.NSN_BRIDGE_DATA_DIR = path.join(folder, ".bridge-state");
  const registry = await import("../../bridge-app/src/main/registry");
  const selection = await registry.createFolderSelection(folder);
  const native = await registry.registerRootFromSelection({ selectionToken: selection.selectionToken,
    permissions: { readPermission: true, createFolderPermission: true, moveFilePermission: true, renameFilePermission: true } });
  const server = (await import("../../bridge-app/src/api/server")).createBridgeServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.NSN_LOCAL_BRIDGE_URL = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousData === undefined) delete process.env.NSN_BRIDGE_DATA_DIR; else process.env.NSN_BRIDGE_DATA_DIR = previousData;
    if (previousUrl === undefined) delete process.env.NSN_LOCAL_BRIDGE_URL; else process.env.NSN_LOCAL_BRIDGE_URL = previousUrl;
    await rm(folder, { recursive: true, force: true });
  });
  await mkdir(path.join(folder, "organized")); await mkdir(path.join(folder, "records"));
  await prisma.connectedLibrary.update({ where: { id: f.root.id }, data: { bridgeDeviceId: null, bridgeRootId: native.id, localPath: `bridge://${native.id}`,
    nativeConnectionRevision: native.connectionRevision } });
  for (const [index, row] of f.rows.entries()) {
    const localPath = path.join(folder, ...row.relativePath.split("/"));
    await writeFile(localPath, `Synthetic content ${index}`);
    await prisma.scannedFile.update({ where: { id: row.id }, data: { localPath: `bridge://${native.id}/${row.relativePath}` } });
  }
  return { ...f, folder, executor: await import("../../src/lib/bridge/executor"), planner: await import("../../src/lib/bridge/planner") };
}

test("RECOVER-1 real local move survives database publication failure and ordinary history recovery is idempotent", async (t) => {
  const f = await localPhysicalFixture(t);
  await prisma.$executeRawUnsafe(`CREATE FUNCTION physical_publication_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'COMPLETED' THEN RAISE EXCEPTION 'injected physical publication failure'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER physical_publication_fault BEFORE UPDATE ON "ExecutionAction" FOR EACH ROW EXECUTE FUNCTION physical_publication_fault()`);
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS physical_publication_fault ON "ExecutionAction"'); });
  await assert.rejects(f.executor.executeOrganizationPlan(f.plan.id, "EXECUTE"), /injected physical publication failure/);
  const run = await prisma.executionRun.findFirstOrThrow({ where: { organizationPlanId: f.plan.id } });
  assert.equal(run.status, "RUNNING"); assert.equal(run.completedAt, null);
  assert.equal(await readFile(path.join(f.folder, "organized/0.txt"), "utf8"), "Synthetic content 0");
  await assert.rejects(readFile(path.join(f.folder, ...f.rows[0].relativePath.split("/"))), /ENOENT/);
  await prisma.$executeRawUnsafe('DROP TRIGGER physical_publication_fault ON "ExecutionAction"');
  const page = await f.planner.getOrganizationPlanPageData(f.scan.id);
  assert.equal(page?.latestExecution?.status, "COMPLETED");
  assert.equal((await prisma.scannedFile.findUniqueOrThrow({ where: { id: f.rows[0].id } })).relativePath, "organized/0.txt");
  await f.planner.getOrganizationPlanPageData(f.scan.id);
  assert.equal(await prisma.executionRun.count({ where: { organizationPlanId: f.plan.id } }), 1);
  assert.equal(await readFile(path.join(f.folder, "organized/0.txt"), "utf8"), "Synthetic content 0");
});

test("RECOVER-1 legacy local runs without journal authority remain unresolved without repeating filesystem work", async (t) => {
  const f = await localPhysicalFixture(t);
  const run = await prisma.executionRun.create({ data: { organizationPlanId: f.plan.id, connectedLibraryId: f.root.id,
    status: "RUNNING", totalActions: 1, actions: { create: { actionType: "MOVE_FILE", sourceRelativePath: f.rows[0].relativePath,
      destinationRelativePath: "organized/0.txt", sourceChecksumBefore: f.rows[0].checksum, sequence: 0, status: "PENDING" } } } });
  for (let retry = 0; retry < 2; retry++) {
    const page = await f.planner.getOrganizationPlanPageData(f.scan.id);
    assert.equal(page?.latestExecution?.status, "RUNNING");
    const current = await prisma.executionRun.findUniqueOrThrow({ where: { id: run.id }, include: { actions: true } });
    assert.equal(current.completedAt, null); assert.equal(current.successfulActions, 0); assert.equal(current.failedActions, 0);
    assert.equal(current.actions[0].status, "PENDING"); assert.equal(current.safeErrorCategory, "COMMAND_RECOVERY_REQUIRED");
    assert.equal(await readFile(path.join(f.folder, ...f.rows[0].relativePath.split("/")), "utf8"), "Synthetic content 0");
    await assert.rejects(readFile(path.join(f.folder, "organized/0.txt")), /ENOENT/);
  }
});

test("AUTH-2 revoked local authority recovers a proven move without admitting remaining actions", async (t) => {
  const f = await localPhysicalFixture(t, 2);
  await assert.rejects(f.executor.executeOrganizationPlan(f.plan.id, "EXECUTE", { afterPhysical: async () => { throw new Error("synthetic process death"); } }), /synthetic process death/);
  const interrupted = await prisma.executionRun.findFirstOrThrow({ where: { organizationPlanId: f.plan.id }, include: { actions: { orderBy: { sequence: "asc" } } } });
  assert.match(interrupted.actions[0].safeErrorCategory ?? "", /^PHYSICAL_ACTION_STARTED:/u);
  assert.equal(interrupted.actions[1].safeErrorCategory, "PHYSICAL_ACTION_PREPARED");
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).physicalInventoryGeneration, 0);
  await prisma.connectedLibrary.update({ where: { id: f.root.id }, data: { readPermission: false, isEnabled: false, disconnectedAt: new Date(), status: "DISCONNECTED" } });
  const page = await f.planner.getOrganizationPlanPageData(f.scan.id);
  assert.equal(page?.latestExecution?.status, "PARTIALLY_COMPLETED");
  assert.equal(page.latestExecution.successfulActions, 1);
  assert.equal(await readFile(path.join(f.folder, "organized/0.txt"), "utf8"), "Synthetic content 0");
  assert.equal(await readFile(path.join(f.folder, ...f.rows[1].relativePath.split("/")), "utf8"), "Synthetic content 1");
  await assert.rejects(readFile(path.join(f.folder, "organized/1.txt")), /ENOENT/);
  assert.equal((await prisma.executionAction.findUniqueOrThrow({ where: { id: interrupted.actions[1].id } })).status, "FAILED");
  await f.planner.getOrganizationPlanPageData(f.scan.id);
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).physicalInventoryGeneration, 1);
});

test("CLOSURE-1 durable local preparation proves revoked unstarted actions had no effect", async (t) => {
  const f = await localPhysicalFixture(t);
  await assert.rejects(f.executor.executeOrganizationPlan(f.plan.id, "EXECUTE", { afterStartClaim: async () => { throw new Error("admission interrupted"); } }), /admission interrupted/);
  await prisma.connectedLibrary.update({ where: { id: f.root.id }, data: { moveFilePermission: false } });
  const page = await f.planner.getOrganizationPlanPageData(f.scan.id);
  assert.equal(page?.latestExecution?.status, "FAILED");
  assert.equal(page.latestExecution.successfulActions, 0);
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).physicalInventoryGeneration, 0);
  assert.equal(await readFile(path.join(f.folder, ...f.rows[0].relativePath.split("/")), "utf8"), "Synthetic content 0");
  await assert.rejects(readFile(path.join(f.folder, "organized/0.txt")), /ENOENT/);
});

test("RECOVER-1 real local Undo survives its database gap and cannot reverse the same action twice", async (t) => {
  const f = await localPhysicalFixture(t);
  const execution = await f.executor.executeOrganizationPlan(f.plan.id, "EXECUTE");
  const undo = await import("../../src/lib/bridge/undo");
  await prisma.$executeRawUnsafe(`CREATE FUNCTION undo_publication_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'COMPLETED' THEN RAISE EXCEPTION 'injected undo publication failure'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER undo_publication_fault BEFORE UPDATE ON "UndoAction" FOR EACH ROW EXECUTE FUNCTION undo_publication_fault()`);
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS undo_publication_fault ON "UndoAction"'); });
  await assert.rejects(undo.executeExecutionUndo(execution.run.id, "UNDO"), /injected undo publication failure/);
  assert.equal(await readFile(path.join(f.folder, ...f.rows[0].relativePath.split("/")), "utf8"), "Synthetic content 0");
  await prisma.$executeRawUnsafe('DROP TRIGGER undo_publication_fault ON "UndoAction"');
  const page = await f.planner.getOrganizationPlanPageData(f.scan.id);
  assert.equal(page?.latestExecution?.latestUndoRun?.status, "COMPLETED");
  assert.equal((await prisma.scannedFile.findUniqueOrThrow({ where: { id: f.rows[0].id } })).relativePath, f.rows[0].relativePath);
  await assert.rejects(undo.executeExecutionUndo(execution.run.id, "UNDO"), /safety issues|already restored/);
  assert.equal(await prisma.undoRun.count({ where: { executionRunId: execution.run.id } }), 1);
});

test("ROOT-2 old authenticated keys cannot heartbeat, synchronize roots, or receive commands after replacement", async (t) => {
  const f = await remotePlanFixture(t, 1);
  const cloud = await import("../../src/lib/bridge/cloud-coordinator");
  const old = (await prisma.bridgeDevice.findUniqueOrThrow({ where: { id: f.device.id } })).publicKey;
  await prisma.bridgeDevice.update({ where: { id: f.device.id }, data: { publicKey: createBridgeKeyPair().publicKey } });
  await assert.rejects(cloud.recordBridgeHeartbeat(f.device.bridgeDeviceId, {}, old), /not paired/);
  const sync = await import("../../src/lib/bridge/device-root-sync");
  await assert.rejects(sync.syncBridgeDeviceRoots(f.device.bridgeDeviceId, [{ id: `root_${"a".repeat(24)}`, displayName: "Synthetic old key",
    safeLocation: "Synthetic library", platform: "MACOS", status: "CONNECTED", watcherState: "STOPPED", connectionRevision: 0,
    connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), readPermission: true }], old), /older device key/);
  const coordinator = await import("../../src/lib/bridge/recoverable-commands");
  await assert.rejects(coordinator.fetchRecoverableBridgeCommands(f.device.bridgeDeviceId, old), /not paired/);
});

test("TX-1 root permission outcome and command completion roll back together and replay preserves newer authority", async (t) => {
  const f = await remotePlanFixture(t, 1);
  const cloud = await import("../../src/lib/bridge/cloud-coordinator"), reports = await import("../../src/lib/bridge/cloud-command-results");
  const command = await cloud.createBridgeCloudCommand({ bridgeDeviceId: f.device.bridgeDeviceId, bridgeRootId: f.root.bridgeRootId,
    connectedLibraryId: f.root.id, commandType: "UPDATE_ROOT_PERMISSIONS", payload: { readPermission: false } });
  await cloud.acknowledgeBridgeCloudCommand(f.device.bridgeDeviceId, command.commandId);
  const report = { commandId: command.commandId, status: "COMPLETED" as const,
    result: { id: f.root.bridgeRootId!, readPermission: false, status: "CONNECTED", updatedAt: new Date().toISOString() } };
  await prisma.$executeRawUnsafe(`CREATE FUNCTION control_completion_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'COMPLETED' THEN RAISE EXCEPTION 'injected control completion failure'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER control_completion_fault BEFORE UPDATE ON "BridgeCommand" FOR EACH ROW EXECUTE FUNCTION control_completion_fault()`);
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS control_completion_fault ON "BridgeCommand"'); });
  const key = (await prisma.bridgeDevice.findUniqueOrThrow({ where: { id: f.device.id } })).publicKey;
  await assert.rejects(reports.persistBridgeControlCommandReport(f.device.bridgeDeviceId, report, key), /injected control completion failure/);
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).readPermission, true);
  assert.equal((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: command.commandId } })).status, "ACKNOWLEDGED");
  await prisma.$executeRawUnsafe('DROP TRIGGER control_completion_fault ON "BridgeCommand"');
  await reports.persistBridgeControlCommandReport(f.device.bridgeDeviceId, report, key);
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).readPermission, false);
  await prisma.connectedLibrary.update({ where: { id: f.root.id }, data: { readPermission: true, nativeConnectionRevision: 1 } });
  await reports.persistBridgeControlCommandReport(f.device.bridgeDeviceId, report, key);
  assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } })).readPermission, true);
});

test("RECOVER-1 execution reconciliation command admission is atomic and ordinary retry retains one generation", async (t) => {
  const f = await queuedRemotePlan(t, 1);
  await f.remote.applyRemoteExecutionReport({ commandPayload: f.command.payload, report: { commandId: f.command.commandId, status: "COMPLETED", result: { actions: f.results } } });
  const reconcile = await import("../../src/lib/bridge/execution-reconciliation");
  const count = await prisma.scanSession.count({ where: { connectedFolderId: f.root.id } });
  await prisma.$executeRawUnsafe(`CREATE FUNCTION reconciliation_command_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."commandType" = 'RECONCILE_LIBRARY' THEN RAISE EXCEPTION 'injected reconcile command failure'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER reconciliation_command_fault BEFORE INSERT ON "BridgeCommand" FOR EACH ROW EXECUTE FUNCTION reconciliation_command_fault()`);
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS reconciliation_command_fault ON "BridgeCommand"'); });
  await reconcile.recoverExecutionReconciliations({ bridgeDeviceId: f.device.bridgeDeviceId });
  assert.equal(await prisma.scanSession.count({ where: { connectedFolderId: f.root.id } }), count);
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } })).reconciliationStatus, "REQUIRED");
  await prisma.$executeRawUnsafe('DROP TRIGGER reconciliation_command_fault ON "BridgeCommand"');
  await reconcile.recoverExecutionReconciliations({ bridgeDeviceId: f.device.bridgeDeviceId });
  const current = await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } });
  assert.equal(current.reconciliationStatus, "IN_PROGRESS"); assert.ok(current.reconciliationScanSessionId);
  await reconcile.recoverExecutionReconciliations({ bridgeDeviceId: f.device.bridgeDeviceId });
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } })).reconciliationScanSessionId, current.reconciliationScanSessionId);
  assert.equal(await prisma.bridgeCommand.count({ where: { connectedLibraryId: f.root.id, commandType: "RECONCILE_LIBRARY" } }), 1);
});

test("CURRENT-1 post-move reconciliation rejects pre-move inventory, retries, and adopts a newer published full snapshot", async (t) => {
  const f = await queuedRemotePlan(t, 1);
  const cloud = await import("../../src/lib/bridge/cloud-coordinator"), reconcile = await import("../../src/lib/bridge/execution-reconciliation");
  const oldScan = await reads.queueRemoteBridgeScan(f.root.id);
  const oldCommand = await prisma.bridgeCommand.findFirstOrThrow({ where: { connectedLibraryId: f.root.id, commandType: "SCAN_LIBRARY" } });
  await cloud.acknowledgeBridgeCloudCommand(f.device.bridgeDeviceId, oldCommand.commandId);
  await f.remote.applyRemoteExecutionReport({ commandPayload: f.command.payload, report: { commandId: f.command.commandId, status: "COMPLETED", result: { actions: f.results } } });
  await assert.rejects(reads.importRemoteBridgeScanReport({ bridgeDeviceId: f.device.bridgeDeviceId, bridgeRootId: f.root.bridgeRootId!,
    connectedLibraryId: f.root.id, commandPayload: oldCommand.payload,
    report: { commandId: oldCommand.commandId, status: "COMPLETED", result: { files: [] } } }), /preceded an authorized filesystem outcome/);
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: oldScan.session.id } })).status, "FAILED");
  assert.equal((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: oldCommand.commandId } })).status, "CANCELLED");
  await reconcile.recoverExecutionReconciliations({ bridgeDeviceId: f.device.bridgeDeviceId });
  const admitted = await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } });
  assert.ok(admitted.reconciliationScanSessionId); assert.equal(admitted.reconciliationStatus, "IN_PROGRESS");
  // A later ordinary full snapshot is authoritative; the owner adopts it only
  // after all physical outcomes, and completion requires both derived stages.
  const currentRoot = await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } });
  const latest = await prisma.scanSession.create({ data: { connectedFolderId: f.root.id, status: "COMPLETED", inventoryGeneration: currentRoot.physicalInventoryGeneration } });
  await reconcile.recoverExecutionReconciliations({ bridgeDeviceId: f.device.bridgeDeviceId });
  const done = await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } });
  assert.equal(done.reconciliationScanSessionId, latest.id); assert.equal(done.reconciliationStatus, "COMPLETED");
  const published = await prisma.scanSession.findUniqueOrThrow({ where: { id: latest.id } });
  assert.equal(published.knowledgePersistenceStatus, "COMPLETED"); assert.equal(published.searchIndexStatus, "COMPLETED");
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: f.scan.id } })).status, "COMPLETED", "Original retained history remains complete");
});

test("CURRENT-1 unresolved physical work fences inventory publication and current Search while retaining history", async (t) => {
  const f = await queuedRemotePlan(t, 1);
  const publication = await import("../../src/lib/bridge/scan-publication");
  const reconcile = await import("../../src/lib/bridge/execution-reconciliation");
  const search = await import("../../src/lib/library/search");
  await prisma.executionRun.update({ where: { id: f.run.id }, data: { status: "RUNNING" } });
  const authority = await import("../../src/lib/bridge/observation-authority");
  const recommendations = await import("../../src/lib/bridge/scan-recommendation-batch");
  await assert.rejects(authority.claimObservationLease(f.rows[0].id), /unresolved/);
  await assert.rejects(recommendations.generateScanRecommendationBatch(f.scan.id), /unresolved/);
  assert.equal(await publication.publishScanDerivedKnowledge(f.scan.id), false);
  await assert.rejects(prisma.$transaction((tx) => reconcile.assertInventoryAfterPhysicalOutcomes(tx, f.root.id, 0)), /unresolved/);
  assert.equal((await search.searchLibrary("source", [f.root.id])).length, 0);
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: f.scan.id } })).status, "COMPLETED");
  await f.remote.applyRemoteExecutionReport({ commandPayload: f.command.payload, report: { commandId: f.command.commandId, status: "COMPLETED", result: { actions: f.results } } });
  assert.equal(await publication.publishScanDerivedKnowledge(f.scan.id), false);
  assert.equal((await search.searchLibrary("source", [f.root.id])).length, 0);
  await assert.rejects(prisma.$transaction((tx) => reconcile.assertInventoryAfterPhysicalOutcomes(tx, f.root.id, 0)), /preceded/);
  await assert.rejects(authority.claimObservationLease(f.rows[0].id), /preceded/);
  await assert.rejects(recommendations.generateScanRecommendationBatch(f.scan.id), /preceded/);
  const root = await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: f.root.id } });
  const latest = await prisma.scanSession.create({ data: { connectedFolderId: f.root.id, inventoryGeneration: root.physicalInventoryGeneration, status: "COMPLETED" } });
  assert.equal(await publication.publishScanDerivedKnowledge(latest.id), true);
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: latest.id } })).searchIndexStatus, "COMPLETED");
});

test("TX-1 signed acknowledged physical completion remains atomic after revocation and rejects a rotated key", async (t) => {
  const f = await queuedRemotePlan(t, 1);
  const cloud = await import("../../src/lib/bridge/cloud-coordinator");
  await cloud.acknowledgeBridgeCloudCommand(f.device.bridgeDeviceId, f.command.commandId);
  await cloud.revokeBridgeDevice(f.device.bridgeDeviceId);
  const route = await import("../../src/app/api/bridge/cloud/devices/[deviceId]/commands/[commandId]/complete/route");
  const pathname = `/api/bridge/cloud/devices/${f.device.bridgeDeviceId}/commands/${f.command.commandId}/complete`;
  const bodyText = JSON.stringify({ status: "COMPLETED", result: { actions: f.results } });
  const request = () => new Request(`http://localhost:3000${pathname}`, { method: "POST", body: bodyText,
    headers: createBridgeDeviceRequestHeaders({ bodyText, bridgeDeviceId: f.device.bridgeDeviceId, method: "POST", pathname, privateKey: f.device.privateKey }) });
  const params = { params: Promise.resolve({ deviceId: f.device.bridgeDeviceId, commandId: f.command.commandId }) };
  await prisma.$executeRawUnsafe(`CREATE FUNCTION physical_completion_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'COMPLETED' THEN RAISE EXCEPTION 'injected physical command completion failure'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe('CREATE TRIGGER physical_completion_fault BEFORE UPDATE ON "BridgeCommand" FOR EACH ROW EXECUTE FUNCTION physical_completion_fault()');
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS physical_completion_fault ON "BridgeCommand"'); });
  assert.equal((await route.POST(request(), params)).status, 500);
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } })).status, "PENDING");
  assert.equal((await prisma.scannedFile.findUniqueOrThrow({ where: { id: f.rows[0].id } })).relativePath, f.rows[0].relativePath);
  await prisma.$executeRawUnsafe('DROP TRIGGER physical_completion_fault ON "BridgeCommand"');
  assert.equal((await route.POST(request(), params)).status, 200);
  assert.equal((await prisma.executionRun.findUniqueOrThrow({ where: { id: f.run.id } })).status, "COMPLETED");
  await prisma.bridgeDevice.update({ where: { id: f.device.id }, data: { publicKey: createBridgeKeyPair().publicKey } });
  assert.equal((await route.POST(request(), params)).status, 401);
});

test("ROOT-2 signed watch ingestion rejects rotated device authority and root denial without creating hints", async (t) => {
  const f = await monitoringFixture(t), originalKey = f.device.publicKey;
  const event = { eventId: randomUUID(), bridgeRootId: f.root.bridgeRootId, eventType: "FILE_ADDED", relativePath: "new.txt", detectedAt: new Date().toISOString() };
  await prisma.bridgeDevice.update({ where: { id: f.device.id }, data: { publicKey: createBridgeKeyPair().publicKey } });
  await assert.rejects(f.monitor.ingestBridgeWatchEvents(f.device.bridgeDeviceId, [event], originalKey), /device key/);
  assert.equal(await prisma.monitoringEvent.count({ where: { eventKey: `bridge:${f.device.bridgeDeviceId}:${event.eventId}` } }), 0);
  const currentKey = (await prisma.bridgeDevice.findUniqueOrThrow({ where: { id: f.device.id } })).publicKey;
  await prisma.connectedLibrary.update({ where: { id: f.root.id }, data: { hiddenFromActiveListAt: new Date() } });
  await assert.rejects(f.monitor.ingestBridgeWatchEvents(f.device.bridgeDeviceId, [event], currentKey), /does not belong/);
  assert.equal(await prisma.monitoringEvent.count({ where: { eventKey: `bridge:${f.device.bridgeDeviceId}:${event.eventId}` } }), 0);
});
