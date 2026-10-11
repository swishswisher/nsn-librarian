import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { knowledgeScaleFixture } from "./knowledge-scale-fixtures";

const schema = `scan_publication_${process.pid}_${Date.now()}`;
let prisma: PrismaClient;
let publication: typeof import("../../src/lib/bridge/scan-publication");
let polling: typeof import("../../src/lib/bridge/recoverable-commands");
let deviceId: string;
before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "5432");
  assert.equal(url.pathname, "/nsn_library_machine_test");
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = process.env.DIRECT_URL = url.toString();
  delete process.env.OPENAI_API_KEY;
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { stdio: "pipe" });
  prisma = new PrismaClient();
  publication = await import("../../src/lib/bridge/scan-publication");
  polling = await import("../../src/lib/bridge/recoverable-commands");
  const device = await prisma.bridgeDevice.create({ data: { bridgeDeviceId: crypto.randomUUID(),
    deviceDisplayName: "Publication recovery fixture", architecture: "arm64", appVersion: "test", publicKey: "test", status: "PAIRED" } });
  deviceId = device.bridgeDeviceId;
});
after(async () => {
  await prisma?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await prisma?.$disconnect();
});

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, name: string) {
  const result = await knowledgeScaleFixture(prisma, name, 2, (i) =>
    `Client ID: PUB-1; Document ID: PUB-DOC; Document Title: Publication; Version: ${i + 1}; Date: 2026-0${i + 1}-01`);
  t.after(result.dispose);
  await prisma.connectedLibrary.update({ where: { id: result.root.id }, data: { bridgeDeviceId: deviceId } });
  await prisma.scanSession.update({ where: { id: result.scan.id }, data: { searchIndexStatus: "NOT_ATTEMPTED" } });
  for (const row of result.rows) {
    await prisma.observationSession.update({ where: { id: row.observationId }, data: { observerType: "OPENAI",
      observations: [{ description: "Verified fields", evidence: [row.evidence] }], status: "AWAITING_REVIEW" } });
    await prisma.scannedFile.update({ where: { id: row.id }, data: { processingStage: "EXAMINED", previewText: row.text } });
  }
  return result;
}

async function snapshot(rootId: string) {
  return {
    signals: await prisma.knowledgeDocumentSignal.findMany({ where: { connectedLibraryId: rootId }, orderBy: { id: "asc" } }),
    relationships: await prisma.knowledgeConnection.findMany({ where: { sourceEvidence: { path: ["connectedLibraryId"], equals: rootId } }, orderBy: { id: "asc" }, include: { decisions: true } }),
    search: await prisma.librarySearchEntry.findMany({ where: { connectedLibraryId: rootId }, orderBy: { id: "asc" } }),
  };
}

function semantics(state: Awaited<ReturnType<typeof snapshot>>) {
  const sorted = (items: unknown[]) => items.map((item) => JSON.stringify(item)).sort();
  return {
    signals: sorted(state.signals.map((row) => [row.relativePath, row.checksum, row.kind, row.revisionNumber, row.revisionDate, row.status, row.sourceRanges])),
    relationships: sorted(state.relationships.map((row) => [row.relationshipKind, [row.sourceChecksum, row.targetChecksum].sort(),
      row.status, row.generationVersion, row.sourceEvidence && typeof row.sourceEvidence === "object" && !Array.isArray(row.sourceEvidence)
        ? [[row.sourceEvidence.sourceRelativePath, row.sourceEvidence.targetRelativePath].sort(), row.sourceEvidence.supportingTopics] : null])),
    search: sorted(state.search.map((row) => [row.relativePath, row.checksum, row.isCurrent, row.sourceExcerpts,
      row.sourceTerms, row.reviewedTerms, row.concepts, row.knowledgeState, row.entityHashes.length])),
  };
}

async function installTrigger(table: "KnowledgeDocumentSignal" | "LibrarySearchEntry", action: "sleep" | "fail", rootId: string) {
  // Identifiers and action are fixed test constants; rootId is generated UUID.
  assert.match(rootId, /^[a-zA-Z0-9-]+$/);
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "${schema}".publication_probe() RETURNS trigger AS $$
    BEGIN IF NEW."connectedLibraryId" = '${rootId}' THEN ${action === "sleep" ? "PERFORM pg_sleep(60);" : "RAISE EXCEPTION 'publication fixture failure';"} END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER publication_probe BEFORE INSERT OR UPDATE ON "${table}" FOR EACH ROW EXECUTE FUNCTION "${schema}".publication_probe()`);
  return async () => { await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS publication_probe ON "${table}"`); };
}

async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Production worker did not reach the expected durable boundary.");
}

for (const boundary of ["before Knowledge", "after Knowledge before Search"] as const) {
  test(`publication recovery survives process termination ${boundary}`, async (t) => {
    let cleanup = async () => {};
    t.after(() => cleanup());
    const data = await fixture(t, boundary);
    const table = boundary === "before Knowledge" ? "KnowledgeDocumentSignal" : "LibrarySearchEntry";
    if (boundary === "before Knowledge") await prisma.scanSession.update({ where: { id: data.scan.id }, data: { status: "EXAMINING" } });
    const remove = await installTrigger(table, "sleep", data.root.id);
    t.after(remove);
    const child = spawn(process.execPath, ["--import", "tsx", "tests/integration/helpers/scan-publication-worker.ts", data.scan.id,
      boundary === "before Knowledge" ? "batch" : "publication"], { env: process.env, stdio: "pipe" });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let backendPid: number | undefined;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "pipe" });
      else child.kill("SIGKILL");
    };
    cleanup = async () => {
      stop(); await exited;
      // A deliberately sleeping PostgreSQL backend need not notice TCP death
      // until its sleep ends. Terminate only this fixture worker's exact backend
      // to model immediate connection loss, without waiting sixty seconds.
      if (backendPid) await prisma.$queryRaw(Prisma.sql`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE pid = ${backendPid} AND query LIKE ${`%${schema}%${table}%`}
      `);
    };
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(stderr);
      const rows = await prisma.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
        SELECT pid FROM pg_stat_activity WHERE state = 'active' AND wait_event = 'PgSleep'
          AND query LIKE ${`%${schema}%${table}%`}
      `);
      backendPid = rows[0]?.pid;
      return backendPid !== undefined;
    });
    const pending = await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } });
    assert.equal(pending.status, "COMPLETED");
    if (boundary === "before Knowledge") {
      assert.ok(pending.knowledgePersistenceStatus.startsWith("NOT_ATTEMPTED@"));
      assert.equal(pending.searchIndexStatus, pending.knowledgePersistenceStatus);
    } else {
      assert.equal(pending.knowledgePersistenceStatus, "COMPLETED");
      assert.equal(pending.searchIndexStatus, "NOT_ATTEMPTED");
    }
    const before = await snapshot(data.root.id);
    await cleanup(); await remove();
    await polling.fetchRecoverableBridgeCommands(deviceId);
    const complete = await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } });
    assert.equal(complete.status, "COMPLETED");
    assert.equal(complete.knowledgePersistenceStatus, "COMPLETED");
    assert.equal(complete.searchIndexStatus, "COMPLETED");
    const final = await snapshot(data.root.id);
    assert.ok(final.signals.some((signal) => signal.kind === "CLIENT"));
    assert.ok(final.relationships.some((row) => row.relationshipKind === "SAME_CLIENT"));
    assert.ok(final.relationships.some((row) => row.relationshipKind === "PROBABLE_REVISION"));
    assert.equal(final.signals.filter((row) => row.kind === "DOCUMENT_FAMILY").length, 2);
    assert.equal(final.search.length, 2);
    assert.ok(final.search.every((row) => row.entityHashes.length > 0 && row.isCurrent));
    if (boundary === "after Knowledge before Search") {
      assert.deepEqual(final.signals, before.signals); assert.deepEqual(final.relationships, before.relationships);
    }
    const control = await fixture(t, "Uninterrupted publication control");
    assert.equal(await publication.publishScanDerivedKnowledge(control.scan.id), true);
    assert.deepEqual(semantics(final), semantics(await snapshot(control.root.id)));
    await polling.fetchRecoverableBridgeCommands(deviceId);
    assert.equal(await publication.publishScanDerivedKnowledge(data.scan.id), true);
    assert.deepEqual(await snapshot(data.root.id), final);
  });
}

for (const stage of ["KnowledgeDocumentSignal", "LibrarySearchEntry"] as const) {
  test(`publication recovery retries atomic failure during ${stage}`, async (t) => {
    const data = await fixture(t, stage);
    const remove = await installTrigger(stage, "fail", data.root.id); t.after(remove);
    assert.equal(await publication.publishScanDerivedKnowledge(data.scan.id), false);
    const pending = await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } });
    assert.equal(pending.status, "COMPLETED");
    assert.ok(pending[stage === "KnowledgeDocumentSignal" ? "knowledgePersistenceStatus" : "searchIndexStatus"].startsWith("INCOMPLETE@"));
    assert.notEqual(pending.searchIndexStatus, "COMPLETED");
    if (stage === "LibrarySearchEntry") assert.equal(pending.knowledgePersistenceStatus, "COMPLETED");
    const before = await snapshot(data.root.id);
    assert.equal(before.search.length, 0);
    if (stage === "KnowledgeDocumentSignal") assert.equal(before.signals.length, 0);
    await remove();
    assert.equal((await publication.recoverScanPublicationsForDevice(deviceId)).attempted, 0);
    assert.equal((await publication.recoverScanPublicationsForDevice(deviceId, new Date(Date.now() + 65_000))).completed, 1);
    const final = await snapshot(data.root.id);
    assert.equal(final.search.length, 2);
    if (stage === "LibrarySearchEntry") assert.deepEqual(final.signals, before.signals);
    await publication.publishScanDerivedKnowledge(data.scan.id);
    assert.deepEqual(await snapshot(data.root.id), final);
  });
}

test("publication recovery simultaneous workers serialize and late failure cannot undo newer success", async (t) => {
  const data = await fixture(t, "Concurrent recovery");
  const results = await Promise.all([publication.publishScanDerivedKnowledge(data.scan.id), publication.publishScanDerivedKnowledge(data.scan.id)]);
  assert.ok(results.includes(true));
  const state = await snapshot(data.root.id);
  await publication.publishScanDerivedKnowledge(data.scan.id);
  assert.deepEqual(await snapshot(data.root.id), state);
  // Worker A's transaction fails, but its failure report is delayed until B has
  // committed. This probes the real status compare-and-set, not a helper oracle.
  const late = await fixture(t, "Late failed owner");
  assert.equal(await publication.publishScanDerivedKnowledge(late.scan.id, "KNOWLEDGE"), true);
  const remove = await installTrigger("LibrarySearchEntry", "fail", late.root.id); t.after(remove);
  const { getPrismaClient } = await import("../../src/lib/db/prisma");
  const client = getPrismaClient();
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cache = globalThis as unknown as { prismaClient: PrismaClient };
  cache.prismaClient = client.$extends({ query: { scanSession: {
    async updateMany({ args, query }) { reached(); await gate; return query(args); },
  } } }) as unknown as PrismaClient;
  t.after(() => { cache.prismaClient = client; release(); });
  const workerA = publication.publishScanDerivedKnowledge(late.scan.id);
  await blocked; cache.prismaClient = client; await remove();
  assert.equal(await publication.publishScanDerivedKnowledge(late.scan.id), true);
  const newer = await snapshot(late.root.id);
  release(); assert.equal(await workerA, false);
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: late.scan.id } })).searchIndexStatus, "COMPLETED");
  assert.deepEqual(await snapshot(late.root.id), newer);
});

test("publication recovery excludes revoked roots and superseded snapshots", async (t) => {
  const data = await fixture(t, "Revoked publication");
  await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { readPermission: false } });
  assert.equal(await publication.publishScanDerivedKnowledge(data.scan.id), false);
  assert.equal((await publication.recoverScanPublicationsForDevice(deviceId)).attempted, 0);
  assert.equal((await snapshot(data.root.id)).signals.length, 0);
  await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { readPermission: true } });
  await prisma.scanSession.create({ data: { connectedFolderId: data.root.id, status: "COMPLETED",
    startedAt: new Date(data.scan.startedAt.getTime() + 10_000), knowledgePersistenceStatus: "COMPLETED", searchIndexStatus: "COMPLETED" } });
  assert.equal(await publication.publishScanDerivedKnowledge(data.scan.id), false);
  assert.equal((await publication.recoverScanPublicationsForDevice(deviceId)).attempted, 0);
  const afterKnowledge = await fixture(t, "Revoked between durable stages");
  assert.equal(await publication.publishScanDerivedKnowledge(afterKnowledge.scan.id, "KNOWLEDGE"), true);
  const durable = await snapshot(afterKnowledge.root.id);
  await prisma.connectedLibrary.update({ where: { id: afterKnowledge.root.id }, data: { status: "DISCONNECTED", disconnectedAt: new Date() } });
  assert.equal(await publication.publishScanDerivedKnowledge(afterKnowledge.scan.id), false);
  assert.deepEqual(await snapshot(afterKnowledge.root.id), durable);
  assert.equal((await publication.recoverScanPublicationsForDevice(deviceId)).attempted, 0);
});

test("publication recovery discovers multiple completed scans with a deterministic eligible budget", async (t) => {
  const data = await Promise.all(Array.from({ length: 5 }, (_, i) => fixture(t, `Bounded ${i}`)));
  for (const [i, item] of data.entries()) await prisma.scanSession.update({ where: { id: item.scan.id },
    data: { startedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)) } });
  const first = await publication.recoverScanPublicationsForDevice(deviceId);
  assert.deepEqual(first, { attempted: 2, completed: 2 });
  const rows = await prisma.scanSession.findMany({ where: { id: { in: data.map((item) => item.scan.id) } }, orderBy: { startedAt: "asc" } });
  assert.deepEqual(rows.map((row) => row.searchIndexStatus), ["COMPLETED", "COMPLETED", "NOT_ATTEMPTED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"]);
  assert.deepEqual(await publication.recoverScanPublicationsForDevice(deviceId), { attempted: 2, completed: 2 });
  assert.deepEqual(await publication.recoverScanPublicationsForDevice(deviceId), { attempted: 1, completed: 1 });
  assert.deepEqual(await publication.recoverScanPublicationsForDevice(deviceId), { attempted: 0, completed: 0 });
});

test("publication recovery defers a failed oldest scan so other authorized scans progress", async (t) => {
  const data = await Promise.all(Array.from({ length: 3 }, (_, i) => fixture(t, `Retry fairness ${i}`)));
  for (const [i, item] of data.entries()) await prisma.scanSession.update({ where: { id: item.scan.id },
    data: { startedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)) } });
  const remove = await installTrigger("KnowledgeDocumentSignal", "fail", data[0].root.id); t.after(remove);
  assert.deepEqual(await publication.recoverScanPublicationsForDevice(deviceId), { attempted: 2, completed: 1 });
  assert.deepEqual(await publication.recoverScanPublicationsForDevice(deviceId), { attempted: 1, completed: 1 });
  await remove();
  assert.deepEqual(await publication.recoverScanPublicationsForDevice(deviceId, new Date(Date.now() + 65_000)), { attempted: 1, completed: 1 });
});

test("publication recovery gates bounded Search backfill on durable Knowledge", async (t) => {
  const data = await fixture(t, "Knowledge before backfill");
  const remove = await installTrigger("KnowledgeDocumentSignal", "fail", data.root.id); t.after(remove);
  const { prepareSearchBatch } = await import("../../src/lib/library/search-backfill");
  const pending = await prepareSearchBatch(data.scan.id);
  assert.equal(pending.completed, false); assert.equal(pending.processedFiles, 0);
  assert.equal((await snapshot(data.root.id)).search.length, 0);
  assert.notEqual((await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } })).searchIndexStatus, "COMPLETED");
  await remove();
  assert.equal((await prepareSearchBatch(data.scan.id)).completed, true);
  const complete = await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } });
  assert.equal(complete.knowledgePersistenceStatus, "COMPLETED"); assert.equal(complete.searchIndexStatus, "COMPLETED");
});

test("publication recovery discovers local completed scans without a Bridge device on normal scan reads", async (t) => {
  const data = await fixture(t, "Local completion recovery");
  await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { bridgeDeviceId: null } });
  assert.deepEqual(await publication.recoverScanPublicationsForDevice(deviceId), { attempted: 0, completed: 0 });
  const { getBridgeScanSessionProgress, getBridgeScanSessions } = await import("../../src/lib/bridge/scan-sessions");
  assert.ok(await getBridgeScanSessionProgress(data.scan.id));
  const complete = await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } });
  assert.equal(complete.knowledgePersistenceStatus, "COMPLETED"); assert.equal(complete.searchIndexStatus, "COMPLETED");
  const state = await snapshot(data.root.id);
  await getBridgeScanSessionProgress(data.scan.id);
  assert.deepEqual(await snapshot(data.root.id), state);
  const listed = await fixture(t, "Local scan list recovery");
  await prisma.connectedLibrary.update({ where: { id: listed.root.id }, data: { bridgeDeviceId: null } });
  assert.ok((await getBridgeScanSessions()).some((row) => row.id === listed.scan.id));
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: listed.scan.id } })).searchIndexStatus, "COMPLETED");
});

test("publication recovery resumes observation-derived indexing after a durable human decision", async (t) => {
  const data = await fixture(t, "Durable reviewed publication");
  assert.equal(await publication.publishScanDerivedKnowledge(data.scan.id), true);
  const remove = await installTrigger("LibrarySearchEntry", "fail", data.root.id); t.after(remove);
  const { saveHumanDecision } = await import("../../src/lib/library/observation-sessions");
  const input = { decisionType: "MODIFY" as const, editedSuggestion: "Client ID: PUB-2", note: "Use the corrected client." };
  await saveHumanDecision(data.rows[0].observationId, input);
  assert.equal((await prisma.observationSession.findUniqueOrThrow({ where: { id: data.rows[0].observationId } })).status, "MODIFIED");
  const pending = await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } });
  assert.equal(pending.knowledgePersistenceStatus, "COMPLETED"); assert.notEqual(pending.searchIndexStatus, "COMPLETED");
  await remove();
  assert.equal((await publication.recoverScanPublicationsForDevice(deviceId, new Date(Date.now() + 65_000))).completed, 1);
  const { searchLibrary } = await import("../../src/lib/library/search");
  assert.ok((await searchLibrary("client PUB-2", [data.root.id])).some((row) => row.relativePath === data.rows[0].relativePath));
  const final = await snapshot(data.root.id);
  const count = await prisma.humanDecision.count({ where: { observationSessionId: data.rows[0].observationId } });
  await saveHumanDecision(data.rows[0].observationId, input);
  assert.equal(await prisma.humanDecision.count({ where: { observationSessionId: data.rows[0].observationId } }), count);
  assert.deepEqual(await snapshot(data.root.id), final);
});

test("publication recovery records fresh work when the same scan completes another primary cycle", async (t) => {
  const data = await fixture(t, "Repeated primary cycle");
  assert.equal(await publication.publishScanDerivedKnowledge(data.scan.id), true);
  const original = await prisma.libraryDocument.findUniqueOrThrow({ where: { id: data.rows[0].documentId } });
  const text = "Client ID: PUB-3";
  const document = await prisma.libraryDocument.create({ data: { batchId: original.batchId,
    normalizedFileName: data.rows[0].relativePath, originalFileName: data.rows[0].relativePath } });
  await prisma.observationSession.create({ data: { libraryDocumentId: document.id, observerType: "OPENAI",
    observations: [{ description: "New durable bytes", evidence: [`Source characters 0-${text.length}: ${JSON.stringify(text)}`] }],
    interpretations: [], explanation: [], warnings: [], planSuggestions: [] } });
  await prisma.scannedFile.update({ where: { id: data.rows[0].id }, data: { checksum: "changed-checksum",
    libraryDocumentId: document.id, previewText: text, processingStage: "EXAMINED" } });
  await prisma.scanSession.update({ where: { id: data.scan.id }, data: { status: "EXAMINING", completedAt: null } });
  const remove = await installTrigger("KnowledgeDocumentSignal", "fail", data.root.id); t.after(remove);
  const { generateScanRecommendationBatchIfReady } = await import("../../src/lib/bridge/scan-recommendation-batch");
  assert.ok(await generateScanRecommendationBatchIfReady(data.scan.id));
  const pending = await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } });
  assert.equal(pending.status, "COMPLETED");
  assert.notEqual(pending.knowledgePersistenceStatus, "COMPLETED"); assert.notEqual(pending.searchIndexStatus, "COMPLETED");
  await remove();
  assert.equal((await publication.recoverScanPublicationsForDevice(deviceId, new Date(Date.now() + 65_000))).completed, 1);
  const { searchLibrary } = await import("../../src/lib/library/search");
  assert.ok((await searchLibrary("client PUB-3", [data.root.id])).some((row) => row.relativePath === data.rows[0].relativePath));
  const entries = await prisma.librarySearchEntry.findMany({ where: { connectedLibraryId: data.root.id,
    relativePath: data.rows[0].relativePath, isCurrent: true } });
  assert.deepEqual(entries.map((row) => row.checksum), ["changed-checksum"]);
});
