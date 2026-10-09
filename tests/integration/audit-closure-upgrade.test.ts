import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { accessMemory, accessSearch, accessAsk, stopWebServer } from "./web-request-fixture";

const schema = `audit_closure_upgrade_${process.pid}_${Date.now()}`;
let prisma: PrismaClient, temporary: string;
const id = (key: string) => `closure-upgrade-${key}`;
const checksum = (text: string) => createHash("sha256").update(text).digest("hex");
const owners = [
  { key: "single", text: "Cobalt cobalt garden stories.", status: "APPROVED", decision: "ACCEPT", scan: "current", root: "current", term: "cobalt" },
  { key: "multi-a", text: "Orchid orchid garden stories.", status: "APPROVED", decision: "ACCEPT", scan: "current", root: "current", term: "orchid" },
  { key: "multi-b", text: "Orchid orchid forest reflections.", status: "APPROVED", decision: "ACCEPT", scan: "current", root: "current", term: "orchid" },
  { key: "rejected", text: "Vermillion vermillion notes.", status: "APPROVED", decision: "REJECT", scan: "current", root: "current", term: "vermillion" },
  { key: "denied", text: "Obsidian obsidian notes.", status: "APPROVED", decision: "ACCEPT", scan: "denied", root: "denied", term: "obsidian" },
  { key: "stale", text: "Legacyold legacyold notes.", status: "APPROVED", decision: "ACCEPT", scan: "old", root: "current", term: "legacyold" },
];

before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "5432"); assert.equal(url.pathname, "/nsn_library_machine_test");
  assert.equal(process.env.OPENAI_API_KEY, undefined); assert.equal(await readFile("prisma/migrations/20261007120000_system_authority_recovery/migration.sql", "utf8").then((text) => checksum(text.replaceAll("\r\n", "\n"))),
    "1222771b34936e078e602c04da0a9c6ee5c172bfb428d671f245f142064253e2");
  url.searchParams.set("schema", schema); process.env.DATABASE_URL = process.env.DIRECT_URL = url.toString();
  temporary = await mkdtemp(path.join(os.tmpdir(), "nsn-closure-upgrade-"));
  await mkdir(path.join(temporary, "prisma/migrations"), { recursive: true });
  // migrate deploy takes the datasource from this loader; the database schema
  // comes exclusively from the actual 34 immutable SQL migrations, never push.
  // This also works in a shallow CI checkout with no historical Git objects.
  await cp("prisma/schema.prisma", path.join(temporary, "prisma/schema.prisma"));
  for (const name of (await readdir("prisma/migrations")).filter((name) => name === "migration_lock.toml" || name < "20261007120000_system_authority_recovery"))
    await cp(path.join("prisma/migrations", name), path.join(temporary, "prisma/migrations", name), { recursive: true });
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", path.join(temporary, "prisma/schema.prisma")], { stdio: "pipe" });
  prisma = (await import("../../src/lib/db/prisma")).getPrismaClient();
  assert.equal((await prisma.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) FROM "_prisma_migrations"'))[0].count, 34n);
  const columns = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string; udt_name: string; data_type: string }>>(
    "SELECT table_name,column_name,udt_name,data_type FROM information_schema.columns WHERE table_schema=$1", schema);
  assert.ok(!columns.some((c) => c.column_name === "memoryReconciliationStatus"));
  async function insert(table: string, data: Record<string, unknown>) {
    if (columns.some((c) => c.table_name === table && c.column_name === "updatedAt")) data.updatedAt = new Date("2026-10-07T10:00:00Z");
    const names = Object.keys(data), values: unknown[] = [];
    const expressions = names.map((name, index) => {
      const column = columns.find((c) => c.table_name === table && c.column_name === name); assert.ok(column);
      assert.match(column.udt_name, /^[A-Za-z_][A-Za-z0-9_]*$/);
      values.push(column.udt_name === "jsonb" || column.data_type === "ARRAY" ? JSON.stringify(data[name]) : data[name]);
      return column.data_type === "ARRAY" ? `ARRAY(SELECT jsonb_array_elements_text($${index + 1}::jsonb))` : `$${index + 1}::"${column.udt_name}"`;
    });
    await prisma.$executeRawUnsafe(`INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${expressions.join(",")})`, ...values);
  }
  await insert("LibraryBatch", { id: id("batch"), name: "Populated actual 34 to 35 web-only upgrade" });
  for (const root of ["current", "denied"]) await insert("ConnectedFolder", { id: id(`root-${root}`), displayName: root, localPath: `bridge://closure-${root}`,
    platform: "MACOS", status: root === "denied" ? "DISCONNECTED" : "CONNECTED", readPermission: root === "current" });
  for (const scan of ["old", "current", "denied"]) await insert("ScanSession", { id: id(`scan-${scan}`), connectedFolderId: id(`root-${scan === "old" ? "current" : scan}`),
    status: "COMPLETED", startedAt: new Date(scan === "old" ? "2026-10-01" : "2026-10-06"), completedAt: new Date("2026-10-07"),
    knowledgePersistenceStatus: "COMPLETED", searchIndexStatus: "COMPLETED" });
  for (const owner of owners) {
    await insert("LibraryDocument", { id: id(`doc-${owner.key}`), batchId: id("batch"), originalFileName: `${owner.key}.txt`, normalizedFileName: `${owner.key}.txt`,
      rawText: owner.text, previewText: owner.text, checksum: checksum(owner.text) });
    await insert("ObservationSession", { id: id(`obs-${owner.key}`), libraryDocumentId: id(`doc-${owner.key}`), observerType: "OPENAI", status: owner.status,
      observations: [{ description: owner.text, evidence: [`Source characters 0-${owner.text.length}: ${JSON.stringify(owner.text)}`] }], interpretations: [], explanation: [], planSuggestions: [], warnings: [] });
    await insert("HumanDecision", { id: id(`decision-${owner.key}`), observationSessionId: id(`obs-${owner.key}`), decisionType: owner.decision });
    await insert("ScannedFile", { id: id(`file-${owner.key}`), sessionId: id(`scan-${owner.scan}`), libraryDocumentId: id(`doc-${owner.key}`),
      relativePath: `records/${owner.key}.txt`, localPath: `bridge://closure-${owner.root}/records/${owner.key}.txt`, fileType: "TEXT", checksum: checksum(owner.text), readStatus: "SUPPORTED" });
  }
  for (const term of ["cobalt", "orchid", "vermillion", "obsidian", "legacyold"]) {
    const sources = owners.filter((o) => o.term === term);
    await insert("MemoryEntry", { id: id(`memory-${term}`), memoryKey: `TERM:${term}`, memoryType: "TERM", title: term, description: `Approved recurring ${term} meaning`,
      evidence: [...(sources.length === 1 ? [`Approved item: ${sources[0].key}.txt`] : [`Approved items: ${sources.map((o) => `${o.key}.txt`).join(", ")}`]),
        `Recurring term: ${term}`, { kind: "MEMORY_PROVENANCE_REQUIRED", sourceSessionIds: sources.map((o) => id(`obs-${o.key}`)).sort() }],
      occurrenceCount: sources.length, searchSourceCount: sources.length, searchProvenanceComplete: true });
    for (const owner of sources) await insert("MemorySearchSource", { id: id(`source-${owner.key}`), memoryEntryId: id(`memory-${term}`),
      observationSessionId: id(`obs-${owner.key}`), connectedLibraryId: id(`root-${owner.root}`) });
  }
  await insert("MemoryEntry", { id: id("curated"), memoryKey: "NOTE:curated", memoryType: "NOTE", title: "Retained human curation", description: "The human's standalone note", evidence: [] });
  await cp("prisma/migrations/20261007120000_system_authority_recovery", path.join(temporary, "prisma/migrations/20261007120000_system_authority_recovery"), { recursive: true });
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", path.join(temporary, "prisma/schema.prisma")], { stdio: "pipe" });
  assert.equal((await prisma.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) FROM "_prisma_migrations"'))[0].count, 35n);
  await cp("prisma/migrations/20261008120000_memory_recovery_scheduler", path.join(temporary, "prisma/migrations/20261008120000_memory_recovery_scheduler"), { recursive: true });
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", path.join(temporary, "prisma/schema.prisma")], { stdio: "pipe" });
  assert.equal((await prisma.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) FROM "_prisma_migrations"'))[0].count, 36n);
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { stdio: "pipe" });
  assert.equal((await prisma.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) FROM "_prisma_migrations"'))[0].count, 37n);
  assert.equal(await prisma.bridgeDevice.count(), 0); assert.equal(await prisma.bridgeCommand.count(), 0);
  assert.equal(await prisma.memoryEntry.count({ where: { searchSourceCount: { gt: 0 }, searchProvenanceComplete: true } }), 0);
});

after(async () => { await stopWebServer(); await prisma?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await prisma?.$disconnect();
  if (temporary) { assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(temporary, { recursive: true, force: true }); } });

test("CLOSURE-3 populated 34 to 35 ordinary authenticated Memory access recovers without a Bridge", async () => {
  for (let attempt = 0; attempt < 12; attempt++) assert.equal((await accessMemory()).status, 200);
  const valid = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: id("memory-cobalt") } });
  assert.equal(valid.searchProvenanceComplete, true, "Normal authenticated web-only Memory access must revalidate migrated sources");
  const multiple = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: id("memory-orchid") }, include: { searchSources: true } });
  assert.equal(multiple.searchProvenanceComplete, true); assert.equal(multiple.searchSourceCount, 2); assert.equal(multiple.searchSources.length, 2);
  const page = await (await import("../../src/lib/library/memory")).getMemoryPageData();
  const visible = [...page.preferredTerms, ...page.recurringConcepts, ...page.recentlyLearned].map((entry) => entry.id);
  assert.ok(visible.includes(id("curated")));
  for (const term of ["vermillion", "obsidian", "legacyold"]) assert.ok(!visible.includes(id(`memory-${term}`)));
  assert.equal(await prisma.humanDecision.count(), 6); assert.equal(await prisma.observationSession.count(), 6);
  for (const term of ["cobalt", "orchid", "vermillion", "obsidian", "legacyold"]) assert.ok(await prisma.memoryEntry.findUnique({ where: { id: id(`memory-${term}`) } }));
  const search = await accessSearch(); assert.equal(search.status, 200);
  assert.ok(JSON.stringify(await search.json()).includes(id("memory-cobalt")));
});

test("CLOSURE-3 Search and Ask independently reach durable recovery and unauthorized requests do not", async () => {
  for (const access of [() => accessSearch(), accessAsk]) {
    await prisma.observationSession.updateMany({ where: { id: { in: [id("obs-single"), id("obs-multi-a"), id("obs-multi-b")] } }, data: { memoryReconciliationStatus: "PENDING@web-retry" } });
    await prisma.memoryEntry.updateMany({ where: { id: { in: [id("memory-cobalt"), id("memory-orchid")] } }, data: { searchProvenanceComplete: false } });
    assert.equal((await accessSearch("cobalt", false)).status, 401);
    assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: id("memory-cobalt") } })).searchProvenanceComplete, false);
    for (let attempt = 0; attempt < 6; attempt++) assert.equal((await access()).status, 200);
    assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: id("memory-cobalt") } })).searchProvenanceComplete, true);
  }
});

async function semanticState() {
  return {
    memory: await prisma.memoryEntry.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, memoryKey: true, evidence: true,
      occurrenceCount: true, searchProvenanceComplete: true, searchSourceCount: true, title: true, description: true } }),
    sources: await prisma.memorySearchSource.findMany({ orderBy: { id: "asc" }, select: { id: true, memoryEntryId: true, connectedLibraryId: true, observationSessionId: true } }),
    decisions: await prisma.humanDecision.findMany({ orderBy: { id: "asc" } }),
    sessions: await prisma.observationSession.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, memoryReconciliationStatus: true } }),
  };
}

test("CLOSURE-3 concurrent web requests have bounded duplicate-safe recovery and repeated access is semantically idempotent", async () => {
  const reviewed = [id("obs-single"), id("obs-multi-a"), id("obs-multi-b")];
  await prisma.observationSession.updateMany({ where: { id: { in: reviewed } }, data: { memoryReconciliationStatus: "PENDING@concurrent-web" } });
  await prisma.memoryEntry.updateMany({ where: { id: { in: [id("memory-cobalt"), id("memory-orchid")] } }, data: { searchProvenanceComplete: false } });
  const unauthorized = await accessMemory(false); assert.ok([303, 307].includes(unauthorized.status));
  assert.equal(await prisma.observationSession.count({ where: { id: { in: reviewed }, memoryReconciliationStatus: { startsWith: "PENDING@" } } }), 3);
  assert.equal((await accessSearch()).status, 200);
  assert.equal(await prisma.observationSession.count({ where: { id: { in: reviewed }, memoryReconciliationStatus: { startsWith: "PENDING@" } } }), 2,
    "One request processes at most one durable owner");
  for (let wave = 0; wave < 4; wave++) {
    const replies = await Promise.all(Array.from({ length: 8 }, () => accessSearch()));
    assert.ok(replies.every((response) => response.status === 200));
  }
  assert.equal(await prisma.observationSession.count({ where: { id: { in: reviewed }, memoryReconciliationStatus: { startsWith: "PENDING@" } } }), 0);
  const settled = await semanticState();
  for (let attempt = 0; attempt < 3; attempt++) { await accessMemory(); await accessSearch(); await accessAsk(); }
  assert.deepEqual(await semanticState(), settled);
  assert.equal(await prisma.bridgeDevice.count(), 0); assert.equal(await prisma.bridgeCommand.count(), 0);
});

test("CLOSURE-3 actual web process termination mid-recovery preserves pending work and ordinary restart completes it", async (t) => {
  await prisma.observationSession.update({ where: { id: id("obs-single") }, data: { memoryReconciliationStatus: "PENDING@process-restart" } });
  await prisma.memoryEntry.update({ where: { id: id("memory-cobalt") }, data: { searchProvenanceComplete: false } });
  const before = await semanticState();
  let held!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { held = resolve; }), finish = new Promise<void>((resolve) => { release = resolve; }); t.after(release);
  const lock = prisma.$transaction(async (tx) => { await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(4213170306::bigint)::text"); held(); await finish; }, { timeout: 30_000 });
  await ready;
  await prisma.$executeRawUnsafe(`CREATE FUNCTION closure_memory_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${id("memory-cobalt")}' THEN PERFORM set_config('lock_timeout', '10s', true); PERFORM pg_advisory_xact_lock(4213170306::bigint); END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe('CREATE TRIGGER closure_memory_pause BEFORE UPDATE ON "MemoryEntry" FOR EACH ROW EXECUTE FUNCTION closure_memory_pause()');
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS closure_memory_pause ON "MemoryEntry"'); });
  const interrupted = accessSearch().catch(() => null);
  const deadline = Date.now() + 15_000; let waiting = false;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
      AND wait_event_type = 'Lock' AND query LIKE '%UPDATE%MemoryEntry%'`);
    if (Number(row.count)) { waiting = true; break; } await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(waiting, "The HTTP request reached the real Memory mutation transaction");
  await stopWebServer(); release(); await lock; await interrupted;
  await prisma.$executeRawUnsafe('DROP TRIGGER closure_memory_pause ON "MemoryEntry"');
  assert.deepEqual(await semanticState(), before, "Death rolls back derived rows and retains exact pending authority");
  for (let attempt = 0; attempt < 6; attempt++) assert.equal((await accessSearch()).status, 200);
  assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: id("memory-cobalt") } })).searchProvenanceComplete, true);
  assert.equal((await prisma.observationSession.findUniqueOrThrow({ where: { id: id("obs-single") } })).memoryReconciliationStatus, "COMPLETED@process-restart");
  assert.equal(await prisma.humanDecision.count(), 6);
});

test("CLOSURE-3 a source family exceeding the interactive deadline finishes through bounded post-response recovery", async (t) => {
  await prisma.observationSession.update({ where: { id: id("obs-single") }, data: { memoryReconciliationStatus: "PENDING@slow-family" } });
  await prisma.memoryEntry.update({ where: { id: id("memory-cobalt") }, data: { searchProvenanceComplete: false } });
  await prisma.$executeRawUnsafe(`CREATE FUNCTION closure_slow_family() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${id("memory-cobalt")}' AND NEW."searchProvenanceComplete" THEN PERFORM pg_sleep(5); END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe('CREATE TRIGGER closure_slow_family BEFORE UPDATE ON "MemoryEntry" FOR EACH ROW EXECUTE FUNCTION closure_slow_family()');
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS closure_slow_family ON "MemoryEntry"'); });
  const started = Date.now(); assert.equal((await accessSearch()).status, 200);
  assert.ok(Date.now() - started < 7000, "The interactive request rolls back at its own bounded deadline");
  assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: id("memory-cobalt") } })).searchProvenanceComplete, false);
  const deadline = Date.now() + 15_000; let recovered = false;
  while (Date.now() < deadline) {
    const session = await prisma.observationSession.findUniqueOrThrow({ where: { id: id("obs-single") } });
    if (session.memoryReconciliationStatus === "COMPLETED@slow-family") { recovered = true; break; }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(recovered, "The same authenticated response completed durable work without another request, manual helper or Bridge");
  assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: id("memory-cobalt") } })).searchProvenanceComplete, true);
  assert.equal(await prisma.humanDecision.count(), 6);
});
