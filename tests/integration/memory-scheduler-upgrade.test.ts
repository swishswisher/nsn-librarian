import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { accessMemory, startWebServer, stopWebServer } from "./web-request-fixture";

const schema = `memory_scheduler_${process.pid}_${Date.now()}`;
let schedulerPath = "/api/cron/memory-recovery";
const secret = "synthetic-scheduler-secret-of-at-least-thirty-two-characters";
let prisma: PrismaClient, temporary: string;
const id = (key: string) => `scheduler-${key}`;
const checksum = (text: string) => createHash("sha256").update(text).digest("hex");
const owners = Array.from({ length: 120 }, (_, index) => {
  const term = index < 116 ? `synth${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}term`
    : index < 118 ? "orchidfamilyone" : "orchidfamilytwo";
  return { key: String(index).padStart(4, "0"), term, text: `${term} ${term}.`, decision: "ACCEPT", root: "current", scan: "current", eligible: true };
}).concat([
  { key: "9000-rejected", term: "vermillioncontrol", text: "vermillioncontrol vermillioncontrol.", decision: "REJECT", root: "current", scan: "current", eligible: false },
  { key: "9001-revoked", term: "obsidiancontrol", text: "obsidiancontrol obsidiancontrol.", decision: "ACCEPT", root: "revoked", scan: "revoked", eligible: false },
  { key: "9002-historical", term: "legacycontrol", text: "legacycontrol legacycontrol.", decision: "ACCEPT", root: "current", scan: "old", eligible: false },
]);
const validIds = owners.filter((owner) => owner.eligible).map((owner) => id(`obs-${owner.key}`));
const originalMemoryIds = [...new Set(owners.map((owner) => id(`memory-${owner.term}`))), id("curated")];
const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function scheduledRequest(authorization: string | null = `Bearer ${secret}`, extraHeaders: Record<string, string> = {}) {
  const baseUrl = await startWebServer();
  return fetch(`${baseUrl}${schedulerPath}`, { method: "GET", redirect: "manual",
    headers: { "user-agent": "vercel-cron/1.0", ...(authorization ? { authorization } : {}), ...extraHeaders } });
}

async function pending(ids = validIds) {
  return prisma.observationSession.count({ where: { id: { in: ids }, memoryReconciliationStatus: { startsWith: "PENDING@" } } });
}

async function semanticState() {
  return {
    observations: await prisma.observationSession.findMany({ orderBy: { id: "asc" } }),
    decisions: await prisma.humanDecision.findMany({ orderBy: { id: "asc" } }),
    memory: await prisma.memoryEntry.findMany({ orderBy: { id: "asc" } }),
    sources: await prisma.memorySearchSource.findMany({ orderBy: { id: "asc" } }),
  };
}

async function seedPending(group: string, count: number, dedicatedRoot = false) {
  const rootId = dedicatedRoot ? id(`root-${group}`) : id("root-current");
  const scanId = dedicatedRoot ? id(`scan-${group}`) : id("scan-current");
  if (dedicatedRoot) {
    await prisma.connectedLibrary.create({ data: { id: rootId, displayName: group, localPath: `bridge://synthetic-${group}`, platform: "MACOS" } });
    await prisma.scanSession.create({ data: { id: scanId, connectedFolderId: rootId, status: "COMPLETED", knowledgePersistenceStatus: "COMPLETED", searchIndexStatus: "COMPLETED" } });
  }
  const result: Array<{ sessionId: string; memoryId: string; term: string; rootId: string }> = [];
  for (let index = 0; index < count; index++) {
    const key = `${group}-${String(index).padStart(3, "0")}`;
    const term = `${group.replaceAll("-", "")}term${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`;
    const text = `${term} ${term}.`, sessionId = id(`obs-${key}`), memoryId = id(`memory-${key}`);
    const createdAt = new Date(Date.now() - count * 1000 + index * 1000);
    await prisma.libraryDocument.create({ data: { id: id(`doc-${key}`), batchId: id("batch"), originalFileName: `${key}.txt`, normalizedFileName: `${key}.txt`, rawText: text, previewText: text, checksum: checksum(text) } });
    await prisma.observationSession.create({ data: { id: sessionId, libraryDocumentId: id(`doc-${key}`), observerType: "OPENAI", status: "APPROVED", createdAt, updatedAt: createdAt,
      observations: [{ description: text, evidence: [`Source characters 0-${text.length}: ${JSON.stringify(text)}`] }], interpretations: [], explanation: [], planSuggestions: [], warnings: [], memoryReconciliationStatus: `PENDING@${id(`decision-${key}`)}` } });
    await prisma.humanDecision.create({ data: { id: id(`decision-${key}`), observationSessionId: sessionId, decisionType: "ACCEPT", createdAt } });
    await prisma.scannedFile.create({ data: { id: id(`file-${key}`), sessionId: scanId, libraryDocumentId: id(`doc-${key}`), relativePath: `records/${key}.txt`, localPath: `bridge://synthetic-${group}/${key}.txt`, fileType: "TEXT", readStatus: "SUPPORTED", checksum: checksum(text) } });
    await prisma.memoryEntry.create({ data: { id: memoryId, memoryKey: `TERM:${term}`, memoryType: "TERM", title: term, description: `Retained ${term}`, evidence: [`Approved item: ${key}.txt`, `Recurring term: ${term}`, { kind: "MEMORY_PROVENANCE_REQUIRED", sourceSessionIds: [sessionId] }], searchSourceCount: 1,
      searchSources: { create: { observationSessionId: sessionId, connectedLibraryId: rootId } } } });
    result.push({ sessionId, memoryId, term, rootId });
  }
  return result;
}

async function installMemoryFault(memoryId: string, delaySeconds?: number) {
  assert.match(memoryId, /^[a-z0-9-]+$/);
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION scheduler_memory_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id = '${memoryId}' AND NEW."searchProvenanceComplete" AND NOT OLD."searchProvenanceComplete" THEN
      ${delaySeconds ? `PERFORM pg_sleep(${delaySeconds});` : "RAISE EXCEPTION 'synthetic restoration failure';"}
    END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe('CREATE TRIGGER scheduler_memory_fault BEFORE UPDATE ON "MemoryEntry" FOR EACH ROW EXECUTE FUNCTION scheduler_memory_fault()');
}
async function removeMemoryFault() {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS scheduler_memory_fault ON "MemoryEntry"');
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS scheduler_memory_fault()');
}
async function waitForSleep() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<Array<{ active: boolean }>>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event = 'PgSleep' AND query LIKE '%MemoryEntry%') AS active`);
    if (rows[0].active) return;
    await pause(30);
  }
  assert.fail("Production scheduler did not reach the database fault barrier");
}
async function drain(ids: string[], attempts = 12) {
  for (let attempt = 0; attempt < attempts && await pending(ids); attempt++) {
    const response = await scheduledRequest(); assert.ok([200, 503].includes(response.status));
    const result = await response.json(); assert.ok(result.attempted <= 20); assert.ok(result.elapsedMs < 55_000);
    if (await pending(ids)) await pause(1100);
  }
  assert.equal(await pending(ids), 0);
}

before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "5432"); assert.equal(url.pathname, "/nsn_library_machine_test");
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  process.env.CRON_SECRET = secret;
  url.searchParams.set("schema", schema); process.env.DATABASE_URL = process.env.DIRECT_URL = url.toString();
  temporary = await mkdtemp(path.join(os.tmpdir(), "nsn-memory-scheduler-"));
  async function migrationLoader(name: string, keep: (migration: string) => boolean) {
    const loader = path.join(temporary, name, "prisma"); await mkdir(path.join(loader, "migrations"), { recursive: true });
    await cp("prisma/schema.prisma", path.join(loader, "schema.prisma"));
    for (const migration of await readdir("prisma/migrations")) if (migration === "migration_lock.toml" || keep(migration))
      await cp(path.join("prisma/migrations", migration), path.join(loader, "migrations", migration), { recursive: true });
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", path.join(loader, "schema.prisma")], { stdio: "pipe" });
  }
  await migrationLoader("first34", (migration) => migration < "20261007120000_system_authority_recovery");
  prisma = (await import("../../src/lib/db/prisma")).getPrismaClient();
  assert.equal((await prisma.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) FROM "_prisma_migrations"'))[0].count, BigInt(34));
  const columns = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string; udt_name: string; data_type: string }>>(
    "SELECT table_name,column_name,udt_name,data_type FROM information_schema.columns WHERE table_schema=$1", schema);
  assert.ok(!columns.some((column) => column.column_name === "memoryReconciliationStatus"));
  async function insert(table: string, data: Record<string, unknown>) {
    if (columns.some((column) => column.table_name === table && column.column_name === "updatedAt") && !data.updatedAt) data.updatedAt = new Date("2026-10-07T10:00:00Z");
    const names = Object.keys(data), values: unknown[] = [];
    const expressions = names.map((name, index) => {
      const column = columns.find((entry) => entry.table_name === table && entry.column_name === name); assert.ok(column);
      assert.match(column.udt_name, /^[A-Za-z_][A-Za-z0-9_]*$/);
      values.push(column.udt_name === "jsonb" || column.data_type === "ARRAY" ? JSON.stringify(data[name]) : data[name]);
      return column.data_type === "ARRAY" ? `ARRAY(SELECT jsonb_array_elements_text($${index + 1}::jsonb))` : `$${index + 1}::"${column.udt_name}"`;
    });
    await prisma.$executeRawUnsafe(`INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${expressions.join(",")})`, ...values);
  }
  await insert("LibraryBatch", { id: id("batch"), name: "120-owner actual populated scheduled recovery upgrade" });
  for (const root of ["current", "revoked"]) await insert("ConnectedFolder", { id: id(`root-${root}`), displayName: root, localPath: `bridge://synthetic-${root}`,
    platform: "MACOS", status: root === "current" ? "CONNECTED" : "DISCONNECTED", readPermission: root === "current" });
  for (const scan of ["old", "current", "revoked"]) await insert("ScanSession", { id: id(`scan-${scan}`), connectedFolderId: id(`root-${scan === "old" ? "current" : scan}`),
    status: "COMPLETED", startedAt: new Date(scan === "old" ? "2026-10-01" : "2026-10-06"), completedAt: new Date("2026-10-07"), knowledgePersistenceStatus: "COMPLETED", searchIndexStatus: "COMPLETED" });
  for (const owner of owners) {
    const reviewedAt = new Date(Date.parse("2026-10-07T10:00:00Z") + Number(owner.key.slice(0, 4)) * 1000);
    await insert("LibraryDocument", { id: id(`doc-${owner.key}`), batchId: id("batch"), originalFileName: `${owner.key}.txt`, normalizedFileName: `${owner.key}.txt`,
      rawText: owner.text, previewText: owner.text, checksum: checksum(owner.text) });
    await insert("ObservationSession", { id: id(`obs-${owner.key}`), libraryDocumentId: id(`doc-${owner.key}`), observerType: "OPENAI", status: "APPROVED", createdAt: reviewedAt, updatedAt: reviewedAt,
      observations: [{ description: owner.text, evidence: [`Source characters 0-${owner.text.length}: ${JSON.stringify(owner.text)}`] }], interpretations: [], explanation: [], planSuggestions: [], warnings: [] });
    await insert("HumanDecision", { id: id(`decision-${owner.key}`), observationSessionId: id(`obs-${owner.key}`), decisionType: owner.decision, createdAt: reviewedAt });
    await insert("ScannedFile", { id: id(`file-${owner.key}`), sessionId: id(`scan-${owner.scan}`), libraryDocumentId: id(`doc-${owner.key}`), relativePath: `records/${owner.key}.txt`,
      localPath: `bridge://synthetic-${owner.root}/records/${owner.key}.txt`, fileType: "TEXT", checksum: checksum(owner.text), readStatus: "SUPPORTED" });
  }
  for (const term of [...new Set(owners.map((owner) => owner.term))]) {
    const sources = owners.filter((owner) => owner.term === term);
    await insert("MemoryEntry", { id: id(`memory-${term}`), memoryKey: `TERM:${term}`, memoryType: "TERM", title: term, description: `Approved recurring ${term} meaning`,
      evidence: [sources.length === 1 ? `Approved item: ${sources[0].key}.txt` : `Approved items: ${sources.map((source) => `${source.key}.txt`).join(", ")}`,
        `Recurring term: ${term}`, { kind: "MEMORY_PROVENANCE_REQUIRED", sourceSessionIds: sources.map((source) => id(`obs-${source.key}`)).sort() }],
      occurrenceCount: sources.length, searchSourceCount: sources.length, searchProvenanceComplete: true });
    for (const source of sources) await insert("MemorySearchSource", { id: id(`source-${source.key}`), memoryEntryId: id(`memory-${term}`), observationSessionId: id(`obs-${source.key}`), connectedLibraryId: id(`root-${source.root}`) });
  }
  await insert("MemoryEntry", { id: id("curated"), memoryKey: "NOTE:curated", memoryType: "NOTE", title: "Retained human curation", description: "The human's standalone note", evidence: [] });
  await migrationLoader("first35", (migration) => migration <= "20261007120000_system_authority_recovery");
  assert.equal((await prisma.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) FROM "_prisma_migrations"'))[0].count, BigInt(35));
  const [postUpgrade] = await prisma.$queryRawUnsafe<Array<{ pending: bigint; retained: bigint; complete: bigint }>>(`SELECT
    (SELECT count(*) FROM "ObservationSession" WHERE "memoryReconciliationStatus" LIKE 'PENDING@%') AS pending,
    (SELECT count(*) FROM "MemoryEntry") AS retained,
    (SELECT count(*) FROM "MemoryEntry" WHERE "searchSourceCount">0 AND "searchProvenanceComplete") AS complete`);
  assert.equal(postUpgrade.pending, BigInt(123)); assert.equal(postUpgrade.retained, BigInt(122)); assert.equal(postUpgrade.complete, BigInt(0));
  await migrationLoader("first36", (migration) => migration <= "20261008120000_memory_recovery_scheduler");
  assert.equal((await prisma.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) FROM "_prisma_migrations"'))[0].count, BigInt(36));
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { stdio: "pipe" });
  if (!process.env.NSN_TEST_WEB_APPLICATION_DIR) {
    assert.equal((await prisma.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) FROM "_prisma_migrations"'))[0].count, BigInt(37));
    const configuration = JSON.parse(await readFile("vercel.json", "utf8"));
    assert.equal(configuration.crons.length, 1); assert.equal(configuration.crons[0].path, schedulerPath);
    schedulerPath = configuration.crons[0].path;
  }
  assert.equal(await prisma.bridgeDevice.count(), 0); assert.equal(await prisma.bridgeCommand.count(), 0);
});

after(async () => {
  await stopWebServer(); await prisma?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await prisma?.$disconnect();
  if (temporary) { assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(temporary, { recursive: true, force: true }); }
});

test("SCHEDULER-1 one Memory visit then only configured protected scheduler deliveries drain 120 migrated owners", async (t) => {
  assert.equal(await pending(), 120);
  const decisions = await prisma.humanDecision.findMany({ orderBy: { id: "asc" } });
  const documents = await prisma.libraryDocument.findMany({ orderBy: { id: "asc" } });
  const retainedObservations = await prisma.observationSession.findMany({ orderBy: { id: "asc" }, select: { id: true, libraryDocumentId: true, observations: true, interpretations: true, explanation: true, planSuggestions: true, warnings: true } });
  const curated = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: id("curated") } });
  const response = await accessMemory(); assert.equal(response.status, 200); const html = await response.text();
  assert.equal(await pending(), 119, "A normal visit is only an accelerator; the independent scheduler owns remaining progress");
  await pause(1000); assert.equal(await pending(), 119);
  t.diagnostic("Actual migration 34→35: 120 eligible pending → one authenticated Memory GET → 119 pending; no Bridge and no further human Memory/Search/Ask requests");
  const progression = [119];
  for (let invocation = 0; invocation < 12 && await pending(); invocation++) {
    const scheduled = await scheduledRequest();
    t.diagnostic(`Scheduled HTTP ${scheduled.status}; eligible pending ${await pending()}`);
    assert.equal(scheduled.status, 200, "The configured independent scheduler must reach a protected production worker without a human session");
    const result = await scheduled.json(); assert.ok(result.completed <= 20); assert.ok(result.elapsedMs < 55_000);
    progression.push(await pending());
  }
  assert.equal(await pending(), 0, `Healthy migrated owners must converge solely through scheduled delivery: ${progression.join(" → ")}`);
  t.diagnostic(`Scheduled progression: ${progression.join(" → ")}`);
  assert.match(html, /Existing Memory is still being restored/); assert.match(html, /119/);
  assert.equal(await prisma.memoryEntry.count({ where: { id: { in: originalMemoryIds } } }), 122);
  assert.deepEqual(await prisma.humanDecision.findMany({ orderBy: { id: "asc" } }), decisions);
  assert.deepEqual(await prisma.libraryDocument.findMany({ orderBy: { id: "asc" } }), documents);
  assert.deepEqual(await prisma.observationSession.findMany({ orderBy: { id: "asc" }, select: { id: true, libraryDocumentId: true, observations: true, interpretations: true, explanation: true, planSuggestions: true, warnings: true } }), retainedObservations);
  assert.equal(await prisma.memoryEntry.count({ where: { id: { in: originalMemoryIds }, searchProvenanceComplete: true, searchSourceCount: { gt: 0 } } }), 118);
  assert.deepEqual(await prisma.memoryEntry.findUniqueOrThrow({ where: { id: id("curated") } }), curated);
  for (const term of ["orchidfamilyone", "orchidfamilytwo"]) {
    const family = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: id(`memory-${term}`) }, include: { searchSources: true } });
    assert.equal(family.searchProvenanceComplete, true); assert.equal(family.searchSourceCount, 2); assert.equal(family.searchSources.length, 2);
  }
  for (const owner of owners.filter((entry) => !entry.eligible)) assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: id(`memory-${owner.term}`) } })).searchProvenanceComplete, false);
  assert.equal(await prisma.bridgeDevice.count(), 0); assert.equal(await prisma.bridgeCommand.count(), 0);
});

test("SCHEDULER-2 anonymous, invalid, and ordinary human credentials cannot mutate scheduled recovery", async () => {
  const before = await semanticState();
  const health = await prisma.memoryRecoveryState.findMany();
  for (const token of [null, "Bearer incorrect-scheduler-secret", "Basic credential"]) {
    assert.equal((await scheduledRequest(token)).status, 401); assert.deepEqual(await semanticState(), before);
    assert.deepEqual(await prisma.memoryRecoveryState.findMany(), health);
  }
  const { createHumanSessionToken, HUMAN_SESSION_COOKIE } = await import("../../src/lib/auth/token");
  const user = { email: "ci@example.com", googleSubject: "ci-google-subject", name: "CI User", role: "OWNER" as const };
  assert.equal((await scheduledRequest(null, { cookie: `${HUMAN_SESSION_COOKIE}=${createHumanSessionToken(user, { ...user, picture: null })}` })).status, 401);
  assert.deepEqual(await semanticState(), before);
  assert.deepEqual(await prisma.memoryRecoveryState.findMany(), health);
});

test("SCHEDULER-3 missing and weak scheduler secrets fail closed through the actual HTTP proxy and endpoint", async () => {
  const before = await semanticState();
  const health = await prisma.memoryRecoveryState.findMany();
  for (const configured of [undefined, "weak-secret"]) {
    await stopWebServer();
    if (configured === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = configured;
    assert.equal((await scheduledRequest()).status, 401); assert.deepEqual(await semanticState(), before);
    assert.deepEqual(await prisma.memoryRecoveryState.findMany(), health);
  }
  await stopWebServer(); process.env.CRON_SECRET = secret;
});

test("SCHEDULER-4 duplicate scheduled delivery preserves all completed Memory and exact source counts", async () => {
  const before = await semanticState();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await scheduledRequest(); assert.equal(response.status, 200); assert.equal((await response.json()).completed, 0);
    assert.deepEqual(await semanticState(), before);
  }
});

test("SCHEDULER-5 an owner exceeding the interactive deadline completes without starving healthy owners", async (t) => {
  const seeded = await seedPending("slow", 25);
  await installMemoryFault(seeded[0].memoryId, 6);
  try {
    const response = await scheduledRequest(); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.completed, 20); assert.ok(result.elapsedMs >= 6000); assert.ok(result.elapsedMs < 55_000);
    assert.equal(await pending(seeded.map((owner) => owner.sessionId)), 5);
    assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: seeded[0].memoryId } })).searchProvenanceComplete, true);
    await drain(seeded.map((owner) => owner.sessionId));
    t.diagnostic(`Slow six-second owner plus 19 healthy owners committed in ${result.elapsedMs}ms; remaining five completed next delivery`);
  } finally { await removeMemoryFault(); }
});

test("SCHEDULER-6 durable retry backoff rotates a repeatedly failing owner behind healthy work and exposes inspection", async (t) => {
  const seeded = await seedPending("failure", 25), failedOwner = seeded[0];
  await installMemoryFault(failedOwner.memoryId);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await scheduledRequest(); assert.equal(response.status, 503);
      const result = await response.json(); assert.equal(result.failed, 1);
      assert.ok(!JSON.stringify(result).includes(failedOwner.sessionId)); assert.ok(!JSON.stringify(result).includes("synthetic restoration failure"));
      const durable = await prisma.observationSession.findUniqueOrThrow({ where: { id: failedOwner.sessionId } });
      assert.equal(durable.memoryRecoveryFailureCount, attempt + 1); assert.equal(durable.memoryRecoveryFailureGeneration, durable.memoryReconciliationStatus);
      assert.ok(durable.memoryRecoveryNextAttemptAt);
      assert.ok(durable.memoryRecoveryNextAttemptAt.getTime() - Date.now() < 5000, "Retry timestamps must be UTC, independent of the PostgreSQL session timezone");
      if (attempt < 2) await pause(Math.max(0, durable.memoryRecoveryNextAttemptAt.getTime() - Date.now()) + 100);
    }
    assert.equal(await pending(seeded.slice(1).map((owner) => owner.sessionId)), 0, "Healthy owners cannot be starved by a permanent failure");
    assert.equal(await pending([failedOwner.sessionId]), 1);
    const { getMemoryRecoveryProgress } = await import("../../src/lib/library/memory-recovery");
    const progress = await getMemoryRecoveryProgress(); assert.equal(progress.needsInspection, 1); assert.equal(progress.lastRunStatus, "RETRY_REQUIRED");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MemoryRecoveryStatus } = await import("../../src/components/library/MemoryRecoveryStatus");
    const { createElement } = await import("react");
    const markup = renderToStaticMarkup(createElement(MemoryRecoveryStatus, { progress }));
    assert.match(markup, /Existing Memory is still being restored/); assert.match(markup, /repeated attempts and may need inspection/);
    t.diagnostic("Three failed scheduler deliveries retained the exact pending generation and durable retry count; all 24 healthy owners drained");
  } finally { await removeMemoryFault(); }
  const owner = await prisma.observationSession.findUniqueOrThrow({ where: { id: failedOwner.sessionId } });
  await pause(Math.max(0, owner.memoryRecoveryNextAttemptAt!.getTime() - Date.now()) + 100);
  await drain([failedOwner.sessionId]);
  assert.equal((await prisma.observationSession.findUniqueOrThrow({ where: { id: failedOwner.sessionId } })).memoryRecoveryFailureCount, 0);
});

test("SCHEDULER-7 overlapping scheduler invocations publish each owner once and converge without duplicate sources", async (t) => {
  const seeded = await seedPending("overlap", 45);
  const responses = await Promise.all([scheduledRequest(), scheduledRequest()]);
  const results = [];
  for (const response of responses) { assert.ok([200, 503].includes(response.status)); results.push(await response.json()); }
  await drain(seeded.map((owner) => owner.sessionId));
  for (const owner of seeded) {
    const memory = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: owner.memoryId }, include: { searchSources: true } });
    assert.equal(memory.searchProvenanceComplete, true); assert.equal(memory.searchSourceCount, 1); assert.equal(memory.searchSources.length, 1);
  }
  const stable = await semanticState(); assert.equal((await scheduledRequest()).status, 200); assert.deepEqual(await semanticState(), stable);
  t.diagnostic(`Concurrent delivery results: ${JSON.stringify(results)}; all 45 owners completed with exactly one source each`);
});

test("SCHEDULER-8 process termination halfway through a batch preserves commits and restart resumes through scheduler HTTP alone", async (t) => {
  const seeded = await seedPending("restart", 45), ids = seeded.map((owner) => owner.sessionId);
  await installMemoryFault(seeded[8].memoryId, 10);
  const interrupted = scheduledRequest().then((response) => response.text(), () => "terminated");
  await waitForSleep();
  const beforeKill = await pending(ids); assert.equal(beforeKill, 37, "Eight independent owner transactions must already be committed");
  await stopWebServer(); await interrupted;
  await removeMemoryFault(); await pause(300);
  assert.equal(await pending(ids), beforeKill);
  const state = await prisma.memoryRecoveryState.findUniqueOrThrow({ where: { id: "memory-recovery" } }); assert.equal(state.lastRunStatus, "RUNNING");
  await drain(ids);
  assert.equal((await prisma.memoryRecoveryState.findUniqueOrThrow({ where: { id: "memory-recovery" } })).lastRunStatus, "SUCCEEDED");
  t.diagnostic(`Killed actual Next process in owner nine: 45 -> ${beforeKill} pending; same persisted backlog after death; restarted scheduler-only deliveries -> 0`);
});

test("SCHEDULER-9 a newer human decision supersedes a generation already selected by a scheduled batch", async () => {
  const seeded = await seedPending("review", 2);
  await installMemoryFault(seeded[0].memoryId, 6);
  try {
    const delivery = scheduledRequest(); await waitForSleep();
    const { saveHumanDecision } = await import("../../src/lib/library/observation-sessions");
    const review = await saveHumanDecision(seeded[1].sessionId, { decisionType: "MODIFY", editedSuggestion: "saffroncorrection saffroncorrection." });
    const response = await delivery; assert.ok([200, 503].includes(response.status));
    const current = await prisma.observationSession.findUniqueOrThrow({ where: { id: seeded[1].sessionId } });
    assert.equal(current.status, "MODIFIED"); assert.equal(current.memoryReconciliationStatus, `COMPLETED@${review.decisionId}`);
    const original = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: seeded[1].memoryId } });
    assert.equal(original.searchProvenanceComplete, false);
    assert.equal(await prisma.humanDecision.count({ where: { observationSessionId: seeded[1].sessionId } }), 2);
    assert.ok(await prisma.memoryEntry.findUnique({ where: { memoryKey: "TERM:saffroncorrection" } }));
  } finally { await removeMemoryFault(); }
});

test("SCHEDULER-10 human rejection racing an active owner remains authoritative and retains both history events", async () => {
  const [owner] = await seedPending("rejection", 1);
  await installMemoryFault(owner.memoryId, 6);
  try {
    const delivery = scheduledRequest(); await waitForSleep();
    const { saveHumanDecision } = await import("../../src/lib/library/observation-sessions");
    const changed = saveHumanDecision(owner.sessionId, { decisionType: "REJECT", note: "Synthetic human rejection during restoration" });
    const response = await delivery; assert.ok([200, 503].includes(response.status));
    const review = await changed;
    const current = await prisma.observationSession.findUniqueOrThrow({ where: { id: owner.sessionId } });
    assert.equal(current.status, "REJECTED"); assert.equal(current.memoryReconciliationStatus, `COMPLETED@${review.decisionId}`);
    assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: owner.memoryId } })).searchProvenanceComplete, false);
    assert.equal(await prisma.humanDecision.count({ where: { observationSessionId: owner.sessionId } }), 2);
    assert.equal(await prisma.observationSession.count({ where: { id: owner.sessionId } }), 1);
  } finally { await removeMemoryFault(); }
});

test("SCHEDULER-11 read revocation during recovery is serialized and immediately removes application trust", async () => {
  const [owner] = await seedPending("revocation", 1, true);
  await installMemoryFault(owner.memoryId, 6);
  try {
    const delivery = scheduledRequest(); await waitForSleep();
    const revoked = prisma.connectedLibrary.update({ where: { id: owner.rootId }, data: { readPermission: false } });
    const response = await delivery; assert.ok([200, 503].includes(response.status)); await revoked;
    const { eligibleMemorySql } = await import("../../src/lib/library/memory-provenance");
    const trusted = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT memory.id FROM "MemoryEntry" memory WHERE memory.id = ${owner.memoryId} AND ${eligibleMemorySql()}`);
    assert.deepEqual(trusted, []);
    assert.equal(await prisma.memorySearchSource.count({ where: { memoryEntryId: owner.memoryId } }), 1, "Revocation preserves provenance history");
    assert.equal((await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: owner.rootId } })).readPermission, false);
  } finally { await removeMemoryFault(); }
});

test("SCHEDULER-12 checksum mismatch and superseded or unknown observations never become trusted", async () => {
  const seeded = await seedPending("invalid", 3, true);
  await prisma.scannedFile.updateMany({ where: { libraryDocumentId: id("doc-invalid-000") }, data: { checksum: checksum("different bytes") } });
  await prisma.observationSession.create({ data: { libraryDocumentId: id("doc-invalid-001"), observerType: "OPENAI", status: "AWAITING_REVIEW", observations: [], interpretations: [], explanation: [], planSuggestions: [], warnings: [] } });
  await prisma.observationSession.update({ where: { id: seeded[2].sessionId }, data: { status: "AWAITING_REVIEW" } });
  const original = await semanticState();
  for (let attempt = 0; attempt < 2; attempt++) { const response = await scheduledRequest(); assert.equal(response.status, 200); assert.equal((await response.json()).completed, 0); }
  assert.deepEqual(await semanticState(), original);
  for (const owner of seeded) assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: owner.memoryId } })).searchProvenanceComplete, false);
  assert.equal(await pending(seeded.map((owner) => owner.sessionId)), 3);
});

test("SCHEDULER-13 recovery UI communicates inactive, unverified, failed, and completed states without private details", async () => {
  const { getMemoryRecoveryProgress } = await import("../../src/lib/library/memory-recovery");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { MemoryRecoveryStatus } = await import("../../src/components/library/MemoryRecoveryStatus");
  const { createElement } = await import("react");
  const progress = { ...await getMemoryRecoveryProgress(), pending: 10, completed: 110, needsInspection: 0 };
  const render = (overrides: Partial<typeof progress>) => renderToStaticMarkup(createElement(MemoryRecoveryStatus, { progress: { ...progress, ...overrides } }));
  assert.match(render({ schedulerConfigured: false }), /Automatic restoration has not been configured/);
  assert.match(render({ schedulerConfigured: true, lastSuccessfulRunAt: null }), /Automatic restoration has not yet been verified/);
  assert.match(render({ lastRunStatus: "FAILED" }), /last automatic check could not finish/);
  assert.equal(render({ pending: 0 }), "");
  assert.match(render({}), /110 reviews restored; 10 still waiting/);
  assert.ok(!render({}).includes("bridge://")); assert.ok(!render({}).includes("CRON_SECRET"));
});

test("SCHEDULER-14 deployment configuration registers the exact protected route with a daily supported expression", async () => {
  const configuration = JSON.parse(await readFile("vercel.json", "utf8"));
  assert.deepEqual(configuration.crons, [{ path: schedulerPath, schedule: "0 3 * * *" }]);
  assert.equal(configuration.$schema, "https://openapi.vercel.sh/vercel.json");
  assert.equal(configuration.env, undefined);
  const { maxDuration, runtime } = await import("../../src/app/api/cron/memory-recovery/route");
  const { memoryRecoveryBudget } = await import("../../src/lib/library/memory-recovery");
  assert.equal(runtime, "nodejs"); assert.equal(maxDuration, 60);
  assert.ok(memoryRecoveryBudget.durationMs + 10_000 < maxDuration * 1000);
  if (process.env.NSN_TEST_WEB_MODE === "production") {
    const manifest = JSON.parse(await readFile(".next/server/app-paths-manifest.json", "utf8"));
    assert.ok(manifest[`${schedulerPath}/route`]);
  }
});
