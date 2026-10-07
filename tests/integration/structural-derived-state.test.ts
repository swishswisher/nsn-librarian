import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test, type TestContext } from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { knowledgeScaleFixture } from "./knowledge-scale-fixtures";

const schema = `derived_state_${process.pid}_${Date.now()}`;
let prisma: PrismaClient;
let publication: typeof import("../../src/lib/bridge/scan-publication");
let backfill: typeof import("../../src/lib/library/search-backfill");
let memory: typeof import("../../src/lib/library/memory");
let preferences: typeof import("../../src/lib/library/organization-preferences");
let suggestions: typeof import("../../src/lib/bridge/organization-suggestions");
let generation: string;

before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "5432");
  assert.equal(url.pathname, "/nsn_library_machine_test");
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = process.env.DIRECT_URL = url.toString();
  delete process.env.OPENAI_API_KEY;
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { stdio: "pipe" });
  prisma = (await import("../../src/lib/db/prisma")).getPrismaClient();
  publication = await import("../../src/lib/bridge/scan-publication");
  backfill = await import("../../src/lib/library/search-backfill");
  memory = await import("../../src/lib/library/memory");
  preferences = await import("../../src/lib/library/organization-preferences");
  suggestions = await import("../../src/lib/bridge/organization-suggestions");
  generation = (await import("../../src/lib/bridge/recommendation-generation")).currentRecommendationGenerationVersion;
});
after(async () => {
  await prisma?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await prisma?.$disconnect();
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, name: string, count = 2) {
  const data = await knowledgeScaleFixture(prisma, name, count, (i) =>
    `Client ID: HARDEN-1; Document Title: Cobalt Garden; Document ID: HARDEN-DOC; Version: ${i + 1}; Date: 2026-0${i + 1}-01`);
  t.after(data.dispose);
  for (const row of data.rows) {
    await prisma.libraryDocument.update({ where: { id: row.documentId }, data: { checksum: row.checksum, rawText: row.text, previewText: row.text } });
    await prisma.observationSession.update({ where: { id: row.observationId }, data: {
      observations: [{ description: "Cobalt garden workshop planning", evidence: [row.evidence] }],
      interpretations: [], status: "APPROVED", observerType: "OPENAI",
    } });
    await prisma.humanDecision.create({ data: { observationSessionId: row.observationId, decisionType: "ACCEPT" } });
    await prisma.scannedFile.update({ where: { id: row.id }, data: { previewText: row.text, processingStage: "EXAMINED" } });
  }
  await prisma.scanSession.update({ where: { id: data.scan.id }, data: { searchIndexStatus: "NOT_ATTEMPTED" } });
  return data;
}

async function nextScan(data: Awaited<ReturnType<typeof fixture>>) {
  const scan = await prisma.scanSession.create({ data: { connectedFolderId: data.root.id,
    startedAt: new Date(data.scan.startedAt.getTime() + 1000), status: "COMPLETED" } });
  for (const row of data.rows) {
    await prisma.scannedFile.create({ data: { sessionId: scan.id, libraryDocumentId: row.documentId,
      relativePath: row.relativePath, localPath: `bridge://${data.root.id}/${row.relativePath}`,
      checksum: row.checksum, fileType: "TEXT", readStatus: "SUPPORTED", readingStatus: "READ",
      extractionStatus: "COMPLETED", previewText: row.text } });
  }
  return scan;
}

for (const position of ["after indexing", "before indexing"] as const) {
  test(`Search stale preparation ${position} cannot retire newer publication`, { timeout: 60_000 }, async (t) => {
    const data = await fixture(t, position, 1);
    const reached = barrier(), resume = barrier();
    t.after(resume.resolve);
    const oldWorker = backfill.prepareSearchBatch(data.scan.id, false, async (session, file) => {
      if (position === "after indexing") await backfill.indexOneFile(session, file);
      reached.resolve(); await resume.promise;
      return position === "before indexing" ? backfill.indexOneFile(session, file) : "INDEXED";
    });
    await reached.promise;
    const newer = await nextScan(data);
    assert.equal(await publication.publishScanDerivedKnowledge(newer.id), true);
    const currentBefore = await prisma.librarySearchEntry.findMany({ where: { connectedLibraryId: data.root.id, isCurrent: true } });
    resume.resolve();
    const oldResult = await oldWorker;
    const currentAfter = await prisma.librarySearchEntry.findMany({ where: { connectedLibraryId: data.root.id, isCurrent: true } });
    assert.deepEqual(currentAfter, currentBefore);
    assert.equal(currentAfter.length, 1); assert.equal(currentAfter[0].scanSessionId, newer.id);
    assert.equal(oldResult.completed, false);
  });
}

test("Search reversed ordering, repeated latest backfill and recovered stale claim converge", async (t) => {
  const data = await fixture(t, "reverse-recovery", 1);
  assert.equal((await backfill.prepareSearchBatch(data.scan.id)).completed, true);
  const newer = await nextScan(data);
  assert.equal(await publication.publishScanDerivedKnowledge(newer.id), true);
  await prisma.librarySearchBackfillFile.updateMany({ where: { scanSessionId: data.scan.id },
    data: { status: "PROCESSING", updatedAt: new Date(0) } });
  await prisma.scanSession.update({ where: { id: data.scan.id }, data: { searchIndexStatus: "PREPARING" } });
  const before = await prisma.librarySearchEntry.findMany({ where: { connectedLibraryId: data.root.id } });
  assert.equal((await backfill.prepareSearchBatch(data.scan.id, true)).completed, false);
  assert.equal((await backfill.prepareSearchBatch(newer.id)).completed, true);
  const once = await prisma.librarySearchEntry.findMany({ where: { connectedLibraryId: data.root.id } });
  assert.equal((await backfill.prepareSearchBatch(newer.id)).completed, true);
  assert.deepEqual(await prisma.librarySearchEntry.findMany({ where: { connectedLibraryId: data.root.id } }), once);
  assert.deepEqual(once, before);
});

test("Search publication root lock allows unrelated roots and releases after backend death", { timeout: 60_000 }, async (t) => {
  const reached = barrier(), release = barrier(); t.after(release.resolve);
  const a = await fixture(t, "root-lock-A", 1), b = await fixture(t, "root-lock-B", 1);
  const locks = await import("../../src/lib/bridge/scan-publication-lock");
  let pid = 0;
  const owner = locks.withCurrentScanPublication(a.scan.id, async (tx) => {
    pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
    reached.resolve(); await release.promise;
    await tx.scanSession.findUniqueOrThrow({ where: { id: a.scan.id } });
  });
  const stopped = assert.rejects(owner); // Install rejection handling before killing the exact owned backend.
  await reached.promise;
  assert.equal(await publication.publishScanDerivedKnowledge(b.scan.id), true);
  assert.equal(await publication.publishScanDerivedKnowledge(a.scan.id), false);
  await prisma.$queryRaw(Prisma.sql`SELECT pg_terminate_backend(${pid}::int)`);
  release.resolve(); await stopped;
  assert.equal(await publication.publishScanDerivedKnowledge(a.scan.id), true);
});

async function builtMemory(t: TestContext, name: string) {
  const data = await fixture(t, name, 3);
  t.after(async () => { await prisma.memoryEntry.deleteMany({ where: { id: { in: entries.map((entry) => entry.id) } } }); });
  for (const row of data.rows) await memory.buildMemoryFromApprovedSession(row.observationId);
  const entries = await prisma.memoryEntry.findMany({ where: { searchSources: { some: { connectedLibraryId: data.root.id } } }, include: { searchSources: true } });
  const entry = entries.find((item) => item.title.toLowerCase().includes("cobalt") && new Set(item.searchSources.map((source) => source.observationSessionId)).size >= 2);
  assert.ok(entry, "The real builder must produce a multi-source candidate");
  assert.equal(entry.searchProvenanceComplete, true);
  return { ...data, entry };
}

for (const retained of [0, 1]) {
  test(`Memory real builder recovers parent with ${retained} retained provenance rows and duplicate retry`, async (t) => {
    const data = await builtMemory(t, `partial-${retained}`);
    const required = data.entry.searchSources;
    await prisma.memorySearchSource.deleteMany({ where: { memoryEntryId: data.entry.id,
      id: { notIn: required.slice(0, retained).map((row) => row.id) } } });
    await prisma.memoryEntry.update({ where: { id: data.entry.id }, data: { searchProvenanceComplete: false, searchSourceCount: retained } });
    await memory.buildMemoryFromApprovedSession(data.rows.at(-1)!.observationId);
    const once = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: data.entry.id }, include: { searchSources: { orderBy: { observationSessionId: "asc" } } } });
    assert.equal(once.searchProvenanceComplete, true);
    assert.equal(once.searchSources.length, required.length); assert.equal(once.searchSourceCount, required.length);
    const search = await import("../../src/lib/library/search");
    assert.ok((await search.searchLibrary("cobalt", [data.root.id])).some((item) => item.kind === "MEMORY" && item.id === data.entry.id));
    const qa = await import("../../src/lib/library/qa/retrieve");
    const retrieved = await qa.retrieveQuestionContext("cobalt", [data.root.id]);
    assert.ok(JSON.stringify(retrieved).includes(data.entry.id));
    await memory.buildMemoryFromApprovedSession(data.rows.at(-1)!.observationId);
    assert.deepEqual(await prisma.memoryEntry.findUniqueOrThrow({ where: { id: data.entry.id }, include: { searchSources: { orderBy: { observationSessionId: "asc" } } } }), once);
  });
}

for (const invalid of ["revoked", "missing file", "historical observation", "rejected", "archived"] as const) {
  test(`Memory retry fails closed for ${invalid} authority`, async (t) => {
    const data = await builtMemory(t, invalid);
    await prisma.memoryEntry.update({ where: { id: data.entry.id }, data: { searchProvenanceComplete: false,
      ...(invalid === "archived" ? { status: "ARCHIVED" } : {}) } });
    if (invalid === "revoked") await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { readPermission: false } });
    if (invalid === "missing file") await prisma.scannedFile.updateMany({ where: { sessionId: data.scan.id }, data: { sourceUnavailableAt: new Date() } });
    if (invalid === "historical observation") {
      const old = await prisma.observationSession.findUniqueOrThrow({ where: { id: data.rows[0].observationId } });
      await prisma.observationSession.create({ data: { libraryDocumentId: old.libraryDocumentId, status: "AWAITING_REVIEW", observerType: "OPENAI",
        observations: [], interpretations: [], explanation: [], planSuggestions: [], warnings: [], createdAt: new Date(old.createdAt.getTime() + 1000) } });
    }
    if (invalid === "rejected") await prisma.observationSession.update({ where: { id: data.rows[0].observationId }, data: { status: "REJECTED" } });
    await memory.buildMemoryFromApprovedSession(data.rows.at(-1)!.observationId);
    const entry = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: data.entry.id } });
    assert.equal(entry.searchProvenanceComplete, false);
    if (invalid === "archived") assert.equal(entry.status, "ARCHIVED");
  });
}

async function preferenceFixture(t: TestContext, name: string) {
  const data = await fixture(t, name);
  const decisions = await Promise.all(data.rows.map((row) => prisma.organizationSuggestion.create({ data: {
    scanSessionId: data.scan.id, scannedFileId: row.id, suggestionKey: crypto.randomUUID(), suggestionType: "MOVE_FILE",
    currentRelativePath: row.relativePath, proposedRelativePath: `Garden/${row.id}.txt`, title: "Garden",
    explanation: "Cobalt garden", whySuggested: ["Content concepts: cobalt, garden"], supportingInformation: [],
    status: "APPROVED", reviewedAt: new Date(), recommendationGenerationVersion: generation, recommendationGenerationId: crypto.randomUUID(),
  } })));
  const preference = await prisma.organizationPreference.create({ data: { connectedLibraryId: data.root.id,
    destinationRelativePath: "Garden", scopeTerms: ["cobalt", "garden"], sourceDecisionIds: decisions.map((row) => row.id),
    evidence: [], proposalKey: crypto.randomUUID(), status: "APPROVED", approvedAt: new Date() } });
  t.after(async () => { await prisma.organizationPreference.deleteMany({ where: { connectedLibraryId: data.root.id } }); });
  return { ...data, decisions, preference };
}

for (const mode of ["regeneration", "single reset", "bulk reset", "automatic replacement"] as const) {
  test(`Preference ${mode} rolls back at derived fault, then converges with one dispute history`, async (t) => {
    const data = await preferenceFixture(t, mode);
    const invoke = () => mode === "regeneration" ? suggestions.prepareOrganizationRecommendationRegeneration(data.scan.id, { confirmedReviewedDecisions: true }) :
      mode === "single reset" ? suggestions.resetOrganizationSuggestionDecision(data.decisions[0].id, data.scan.id) :
      mode === "bulk reset" ? suggestions.resetOrganizationSuggestionDecisionsForScanSession(data.scan.id) :
      suggestions.generateOrganizationSuggestionsForScannedFileWithText(data.rows[0].id, data.rows[0].text);
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "${schema}".preference_fault() RETURNS trigger AS $$
      BEGIN IF NEW.id = '${data.preference.id}' THEN RAISE EXCEPTION 'derived invalidation fault'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER preference_fault BEFORE UPDATE ON "OrganizationPreference" FOR EACH ROW EXECUTE FUNCTION "${schema}".preference_fault()`);
    const remove = () => prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS preference_fault ON "OrganizationPreference"`);
    t.after(remove);
    const before = await prisma.organizationSuggestion.findMany({ where: { scanSessionId: data.scan.id }, orderBy: { id: "asc" } });
    await assert.rejects(invoke(), /derived invalidation fault/);
    assert.deepEqual(await prisma.organizationSuggestion.findMany({ where: { scanSessionId: data.scan.id }, orderBy: { id: "asc" } }), before);
    assert.equal(await prisma.organizationSuggestionDecisionEvent.count({ where: { scanSessionId: data.scan.id } }), 0);
    assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: data.root.id, contentText: "cobalt garden" })).length, 1);
    await remove(); await invoke();
    const result = await prisma.organizationPreference.findUniqueOrThrow({ where: { id: data.preference.id } });
    assert.ok(result.disputedAt); assert.equal(result.status, "APPROVED");
    assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: data.root.id, contentText: "cobalt garden" })).length, 0);
    const events = await prisma.organizationSuggestionDecisionEvent.count({ where: { scanSessionId: data.scan.id } });
    await invoke();
    assert.equal(await prisma.organizationSuggestionDecisionEvent.count({ where: { scanSessionId: data.scan.id } }), events);
    assert.equal(await prisma.organizationPreferenceRevision.count({ where: { preferenceId: result.id, action: "DISPUTE" } }), 1);
    // Existing semantics dispute on ANY changed support. Unrelated rules remain intact.
    assert.equal((await prisma.organizationSuggestion.findUniqueOrThrow({ where: { id: data.decisions[1].id } })).status,
      mode === "bulk reset" ? "PENDING" : "APPROVED");
  });
}

for (const [name, mutation] of [
  ["revoked read", { readPermission: false }], ["hidden", { hiddenFromActiveListAt: new Date() }],
  ["merged", { mergedAt: new Date() }], ["noncanonical", { canonicalConnectedLibraryId: "another-root" }],
  ["disconnected status", { status: "DISCONNECTED" }], ["disconnected timestamp", { disconnectedAt: new Date() }],
  ["disabled", { isEnabled: false }],
] as const) {
  test(`Preference canonical root excludes ${name} and allows restoration`, async (t) => {
    const data = await preferenceFixture(t, name);
    const valid = await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: data.root.id } });
    assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: data.root.id, contentText: "cobalt garden" })).length, 1);
    await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: mutation });
    assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: data.root.id, contentText: "cobalt garden" })).length, 0);
    assert.equal(await preferences.proposeOrganizationPreferences(data.root.id), 0);
    assert.ok(!(await preferences.getOrganizationPreferencePageData()).some((row) => row.id === data.preference.id));
    await assert.rejects(preferences.reviewOrganizationPreference(data.preference.id, { action: "DEFER" }));
    await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { isEnabled: valid.isEnabled,
      readPermission: valid.readPermission, status: valid.status, hiddenFromActiveListAt: valid.hiddenFromActiveListAt,
      mergedAt: valid.mergedAt, canonicalConnectedLibraryId: valid.canonicalConnectedLibraryId, disconnectedAt: valid.disconnectedAt } });
    assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: data.root.id, contentText: "cobalt garden" })).length, 1);
  });
}

test("Preference independent actionable, active and history budgets remain bounded with deterministic timestamp ties", async (t) => {
  const data = await preferenceFixture(t, "caps");
  const older = new Date("2020-01-01"), newer = new Date("2026-01-01");
  await prisma.organizationPreference.createMany({ data: Array.from({ length: 90 }, (_, i) => ({
    id: `action-${String(i).padStart(3, "0")}`, connectedLibraryId: data.root.id, proposalKey: crypto.randomUUID(),
    destinationRelativePath: "Garden", scopeTerms: ["cobalt", "garden"], sourceDecisionIds: [], evidence: [],
    status: i % 2 ? "PROPOSED" as const : "DEFERRED" as const, updatedAt: older,
  })) });
  await prisma.organizationPreference.createMany({ data: Array.from({ length: 100 }, (_, i) => ({
    id: `history-${String(i).padStart(3, "0")}`, connectedLibraryId: data.root.id, proposalKey: crypto.randomUUID(),
    destinationRelativePath: "Garden", scopeTerms: ["cobalt", "garden"], sourceDecisionIds: [], evidence: [],
    status: i % 3 === 0 ? "REJECTED" as const : i % 3 === 1 ? "ARCHIVED" as const : "APPROVED" as const,
    disputedAt: i % 3 === 2 ? newer : null, updatedAt: newer,
  })) });
  const page = await preferences.getOrganizationPreferencePageData();
  const actionable = page.filter((row) => row.status === "PROPOSED" || row.status === "DEFERRED");
  assert.deepEqual(actionable.map((row) => row.id), Array.from({ length: 80 }, (_, i) => `action-${String(89 - i).padStart(3, "0")}`));
  assert.equal(page.filter((row) => row.id.startsWith("history-")).length, 80);
  assert.ok(page.some((row) => row.id === data.preference.id && row.status === "APPROVED" && !row.disputed));
  assert.deepEqual(await preferences.getOrganizationPreferencePageData(), page);
  await prisma.organizationPreference.deleteMany({ where: { connectedLibraryId: data.root.id, status: { in: ["PROPOSED", "DEFERRED"] } } });
  assert.equal((await preferences.getOrganizationPreferencePageData()).length, 81);
});

test("Preference live source authority excludes a stranded legacy rule and preserves unrelated partial support", async (t) => {
  const data = await preferenceFixture(t, "legacy-support");
  const other = await prisma.organizationPreference.create({ data: { connectedLibraryId: data.root.id,
    destinationRelativePath: "Other", scopeTerms: ["cobalt", "orchids"], sourceDecisionIds: [data.decisions[1].id],
    evidence: [], proposalKey: crypto.randomUUID(), status: "APPROVED", approvedAt: new Date() } });
  await suggestions.resetOrganizationSuggestionDecision(data.decisions[0].id, data.scan.id);
  assert.ok((await prisma.organizationPreference.findUniqueOrThrow({ where: { id: data.preference.id } })).disputedAt);
  assert.equal((await prisma.organizationPreference.findUniqueOrThrow({ where: { id: other.id } })).disputedAt, null);
  assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: data.root.id, contentText: "cobalt orchids" })).length, 1);
  // The reviewed release can already contain an interrupted invalidation.
  await prisma.organizationPreference.update({ where: { id: data.preference.id }, data: { disputedAt: null } });
  assert.equal((await preferences.applicableApprovedPreferences({ connectedLibraryId: data.root.id, contentText: "cobalt garden" })).length, 0);
});

test("Preference proposal budget is reserved for distinct usable reviewed destinations", async (t) => {
  const data = await preferenceFixture(t, "proposal-eligibility");
  await prisma.organizationPreference.delete({ where: { id: data.preference.id } });
  await prisma.organizationSuggestion.createMany({ data: Array.from({ length: 205 }, (_, i) => ({
    scannedFileId: data.rows[0].id, scanSessionId: data.scan.id, suggestionKey: crypto.randomUUID(), suggestionType: "MOVE_FILE" as const,
    currentRelativePath: data.rows[0].relativePath, proposedRelativePath: null, title: `No destination ${i}`,
    explanation: "No usable destination", whySuggested: ["Content concepts: cobalt, garden"], supportingInformation: [],
    status: "MODIFIED" as const, reviewedAt: new Date(Date.now() + 1000), recommendationGenerationVersion: generation,
  })) });
  assert.equal(await preferences.proposeOrganizationPreferences(data.root.id), 1);
  assert.equal(await preferences.proposeOrganizationPreferences(data.root.id), 0);
});

test("Memory invalid provenance cannot consume Search or working-knowledge eligibility budgets", async (t) => {
  const data = await fixture(t, "memory-caps", 1);
  const good = await prisma.memoryEntry.create({ data: { memoryKey: crypto.randomUUID(), memoryType: "NOTE",
    title: "cobalt durable memory", description: "cobalt garden approved", evidence: [], status: "ACTIVE",
    searchProvenanceComplete: true, searchSourceCount: 1,
    searchSources: { create: { connectedLibraryId: data.root.id, observationSessionId: data.rows[0].observationId } } } });
  const ids = [good.id]; t.after(() => prisma.memoryEntry.deleteMany({ where: { id: { in: ids } } }));
  for (let i = 0; i < 85; i++) {
    const bad = await prisma.memoryEntry.create({ data: { memoryKey: crypto.randomUUID(), memoryType: "NOTE",
      title: `cobalt A ${i}`, description: "cobalt", evidence: [], status: "ACTIVE", occurrenceCount: 1000,
      searchProvenanceComplete: true, searchSourceCount: 2,
      searchSources: { create: { connectedLibraryId: data.root.id, observationSessionId: data.rows[0].observationId } } } });
    ids.push(bad.id);
  }
  const search = await import("../../src/lib/library/search");
  assert.ok((await search.searchLibrary("cobalt", [data.root.id])).some((item) => item.id === good.id));
  const working = await import("../../src/lib/bridge/scan-working-knowledge");
  const index = await working.loadScanWorkingKnowledge(data.scan.id);
  assert.ok(JSON.stringify(index.files[0].approvedMemoryEvidence).includes(good.title));
});

test("Memory provenance child failure rolls back parent creation and production retry repairs it", async (t) => {
  const data = await fixture(t, "memory-child-failure", 1);
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "${schema}".memory_child_fault() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'memory provenance child fault'; END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER memory_child_fault BEFORE INSERT ON "MemorySearchSource" FOR EACH ROW EXECUTE FUNCTION "${schema}".memory_child_fault()`);
  const remove = () => prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS memory_child_fault ON "MemorySearchSource"`); t.after(remove);
  const before = await prisma.memoryEntry.count();
  await assert.rejects(memory.buildMemoryFromApprovedSession(data.rows[0].observationId), /memory provenance child fault/);
  assert.equal(await prisma.memoryEntry.count(), before);
  await remove(); await memory.buildMemoryFromApprovedSession(data.rows[0].observationId);
  const entries = await prisma.memoryEntry.findMany({ where: { searchSources: { some: { connectedLibraryId: data.root.id } } } });
  t.after(() => prisma.memoryEntry.deleteMany({ where: { id: { in: entries.map((row) => row.id) } } }));
  assert.ok(entries.length); assert.ok(entries.every((entry) => entry.searchProvenanceComplete));
});

test("Search file-type eligibility is applied before indexed and metadata windows", async (t) => {
  const data = await fixture(t, "search-type-cap", 55);
  for (const row of data.rows) await prisma.scannedFile.update({ where: { id: row.id },
    data: { relativePath: `pdf/${row.relativePath}` } });
  const wanted = data.rows.at(-1)!;
  await prisma.scannedFile.update({ where: { id: wanted.id }, data: { fileType: "PDF" } });
  const search = await import("../../src/lib/library/search");
  assert.ok((await search.searchLibrary("pdf", [data.root.id])).some((row) => row.id === wanted.id));
  assert.equal(await publication.publishScanDerivedKnowledge(data.scan.id), true);
  const indexed = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: wanted.id } });
  assert.ok((await search.searchLibrary("pdf", [data.root.id])).some((row) => row.id === indexed.id));
});

test("Memory relationship budget counts useful approved support rather than raw top scores", async (t) => {
  const data = await fixture(t, "relationship-cap");
  for (let i = 0; i < 8; i++) await prisma.knowledgeConnection.create({ data: {
    sourceObservationSessionId: data.rows[0].observationId, targetObservationSessionId: data.rows[1].observationId,
    relationshipKey: crypto.randomUUID(), confidence: 0.9, similarityScore: 100 - i, reasoning: "Related reviewed concepts",
    sharedTerms: i < 7 ? ["about", "file123"] : ["cobalt", "garden"], status: "NEW",
  } });
  await memory.buildMemoryFromApprovedSession(data.rows[0].observationId);
  const entries = await prisma.memoryEntry.findMany({ where: { searchSources: { some: { connectedLibraryId: data.root.id } } } });
  t.after(() => prisma.memoryEntry.deleteMany({ where: { id: { in: entries.map((row) => row.id) } } }));
  assert.ok(entries.some((entry) => entry.memoryType === "RELATIONSHIP" && entry.searchProvenanceComplete));
});

test("Earlier relationship context skips malformed history before its semantic cap", async (t) => {
  const data = await fixture(t, "earlier-cap");
  const version = (await import("../../src/lib/bridge/document-signals")).documentSignalVersion;
  await prisma.knowledgeConnection.createMany({ data: Array.from({ length: 108 }, (_, i) => ({
    sourceObservationSessionId: data.rows[0].observationId, targetObservationSessionId: data.rows[1].observationId,
    sourceFileKey: data.rows[0].fileKey, sourceChecksum: data.rows[0].checksum,
    targetFileKey: data.rows[1].fileKey, targetChecksum: data.rows[1].checksum,
    sourceEvidence: i < 105 ? { connectedLibraryId: data.root.id } : { connectedLibraryId: data.root.id,
      sourceRelativePath: data.rows[0].relativePath, targetRelativePath: data.rows[1].relativePath, supportingTopics: ["cobalt"] },
    relationshipKey: crypto.randomUUID(), generationVersion: version, relationshipKind: "SAME_CLIENT",
    confidence: 0.9, similarityScore: 10, reasoning: "Earlier support", sharedTerms: [], status: "NEW" as const,
    createdAt: new Date(i < 105 ? "2030-01-01" : "2020-01-01"),
  })) });
  const knowledge = await import("../../src/lib/bridge/persistent-knowledge");
  const context = await knowledge.earlierRelationshipContext({ connectedLibraryId: data.root.id,
    checksum: data.rows[0].checksum, relativePath: data.rows[0].relativePath, scanStartedAt: new Date("2040-01-01") });
  assert.equal(context.length, 3); assert.ok(context.every((row) => row.supportingTopics.includes("cobalt")));
});

test("Ask relationship cap excludes historical checksums before reserving current support", async (t) => {
  const data = await fixture(t, "qa-relationship-checksum");
  assert.equal(await publication.publishScanDerivedKnowledge(data.scan.id), true);
  const version = (await import("../../src/lib/bridge/persistent-knowledge")).relationshipGenerationVersion;
  await prisma.knowledgeConnection.createMany({ data: Array.from({ length: 30 }, (_, i) => ({
    id: `qa-old-${i.toString().padStart(3, "0")}`, relationshipKey: crypto.randomUUID(), generationVersion: version,
    sourceObservationSessionId: data.rows[0].observationId, targetObservationSessionId: data.rows[1].observationId,
    sourceChecksum: "historical-bytes", targetChecksum: "historical-bytes", status: "CONFIRMED", reasoning: "Historical support", sharedTerms: ["cobalt"],
  })) });
  await prisma.knowledgeConnection.create({ data: { id: "qa-z-current", relationshipKey: crypto.randomUUID(), generationVersion: version,
    sourceObservationSessionId: data.rows[0].observationId, targetObservationSessionId: data.rows[1].observationId,
    sourceChecksum: data.rows[0].checksum, targetChecksum: data.rows[1].checksum, status: "CONFIRMED", reasoning: "Current cobalt support", sharedTerms: ["cobalt"],
  } });
  const context = await (await import("../../src/lib/library/qa/retrieve")).retrieveQuestionContext("cobalt", [data.root.id]);
  assert.ok(context.relationships.some((row) => row.explanation === "Current cobalt support"));
});

test("Memory aggregation reserves its budget for authorized current observations", async (t) => {
  const good = await fixture(t, "memory-current-aggregation", 2);
  const revoked = await fixture(t, "memory-revoked-aggregation", 105);
  await prisma.connectedLibrary.update({ where: { id: revoked.root.id }, data: { readPermission: false } });
  await memory.buildMemoryFromApprovedSession(good.rows[0].observationId);
  const entries = await prisma.memoryEntry.findMany({ where: { searchSources: { some: { connectedLibraryId: good.root.id } } }, include: { searchSources: true } });
  t.after(() => prisma.memoryEntry.deleteMany({ where: { id: { in: entries.map((row) => row.id) } } }));
  assert.ok(entries.some((entry) => entry.title.toLowerCase().includes("cobalt") && entry.searchProvenanceComplete));
  assert.ok(entries.every((entry) => entry.searchSources.every((source) => source.connectedLibraryId === good.root.id)));
});

test("Memory curation cannot mistake a revoked physical source for a standalone upload", async (t) => {
  const data = await builtMemory(t, "memory-unbound-revoked");
  await prisma.memorySearchSource.deleteMany({ where: { memoryEntryId: data.entry.id } });
  await prisma.memoryEntry.update({ where: { id: data.entry.id }, data: { searchSourceCount: 0, searchProvenanceComplete: false } });
  await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { readPermission: false } });
  const page = await memory.getMemoryPageData();
  assert.ok(!JSON.stringify(page).includes(data.entry.id));
});

test("Memory preference budget skips unusable current edits before older valid human language", async (t) => {
  const good = await fixture(t, "memory-usable-edits", 2), malformed = await fixture(t, "memory-unusable-edits", 151);
  for (const data of [good, malformed]) for (const row of data.rows) {
    await prisma.observationSession.update({ where: { id: row.observationId }, data: { status: "MODIFIED" } });
    await prisma.humanDecision.create({ data: { observationSessionId: row.observationId, decisionType: "MODIFY",
      editedSuggestion: data === good ? "Quantum -> Starlight" : "A reviewed description without a terminology substitution",
      createdAt: new Date(data === good ? "2040-01-01" : "2050-01-01"),
    } });
  }
  await memory.buildMemoryFromApprovedSession(good.rows[0].observationId);
  const entries = await prisma.memoryEntry.findMany({ where: { searchSources: { some: { connectedLibraryId: { in: [good.root.id, malformed.root.id] } } } } });
  t.after(() => prisma.memoryEntry.deleteMany({ where: { id: { in: entries.map((row) => row.id) } } }));
  assert.ok(entries.some((entry) => entry.memoryType === "PREFERENCE" && entry.title.includes("Starlight") && entry.searchProvenanceComplete));
});

test("Memory corrected authority remains current after a later human note", async (t) => {
  const data = await fixture(t, "memory-note-authority", 2);
  const { saveHumanDecision } = await import("../../src/lib/library/observation-sessions");
  for (const row of data.rows) {
    await saveHumanDecision(row.observationId, { decisionType: "MODIFY", editedSuggestion: "Quantum -> Starlight" });
    await memory.buildMemoryFromApprovedSession(row.observationId);
  }
  const entries = await prisma.memoryEntry.findMany({ where: { searchSources: { some: { connectedLibraryId: data.root.id } } } });
  t.after(() => prisma.memoryEntry.deleteMany({ where: { id: { in: entries.map((row) => row.id) } } }));
  const entry = entries.find((row) => row.memoryType === "PREFERENCE" && row.title.includes("Starlight"));
  assert.ok(entry?.searchProvenanceComplete, "The current human correction must produce complete Memory");
  const search = await import("../../src/lib/library/search");
  await saveHumanDecision(data.rows[0].observationId, { decisionType: "NOTE", note: "Keep this reviewed terminology." });
  assert.ok((await search.searchLibrary("starlight", [data.root.id])).some((row) => row.id === entry.id),
    "A note does not supersede the authoritative MODIFY decision");
  await memory.buildMemoryFromApprovedSession(data.rows[1].observationId);
  const recovered = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { searchSources: true } });
  assert.equal(recovered.searchProvenanceComplete, true);
  assert.equal(recovered.searchSources.length, 2);
  await saveHumanDecision(data.rows[0].observationId, { decisionType: "REJECT" });
  assert.ok(!(await search.searchLibrary("starlight", [data.root.id])).some((row) => row.id === entry.id),
    "A rejection still removes the corrected Memory's authority");
});

test("Recommendation Memory pagination reaches eligible support under a non-UTC database timezone", { timeout: 60_000 }, async (t) => {
  const data = await fixture(t, "recommendation-memory-pagination", 1);
  const ids = Array.from({ length: 420 }, () => crypto.randomUUID());
  t.after(() => prisma.memoryEntry.deleteMany({ where: { id: { in: ids } } }));
  await prisma.memoryEntry.createMany({ data: ids.map((id, i) => ({ id, memoryKey: id, memoryType: "THEME",
    title: i === 419 ? "Eligible Cobalt Garden Memory" : "Unrelated zyxw concepts", description: "Human reviewed theme",
    evidence: [], searchProvenanceComplete: true, searchSourceCount: 1, occurrenceCount: 10,
    lastSeen: new Date(Date.parse("2026-10-01T00:00:00Z") - i * 1000),
  })) });
  await prisma.memorySearchSource.createMany({ data: ids.map((memoryEntryId) => ({ memoryEntryId,
    connectedLibraryId: data.root.id, observationSessionId: data.rows[0].observationId,
  })) });
  const globalState = globalThis as unknown as { prismaClient?: PrismaClient };
  const originalClient = globalState.prismaClient;
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("connection_limit", "1");
  const shiftedClient = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    await shiftedClient.$executeRawUnsafe("SET TIME ZONE 'Pacific/Kiritimati'");
    globalState.prismaClient = shiftedClient;
    await suggestions.generateOrganizationSuggestionsForScannedFileWithText(data.rows[0].id, data.rows[0].text);
    const rows = await shiftedClient.organizationSuggestion.findMany({ where: { scannedFileId: data.rows[0].id, invalidatedAt: null } });
    assert.ok(JSON.stringify(rows).includes("Eligible Cobalt Garden Memory"));
  } finally {
    globalState.prismaClient = originalClient;
    await shiftedClient.$disconnect();
  }
});

test("Checksum bootstrap preserves human review and cannot revive a historical recommendation batch", async (t) => {
  const data = await fixture(t, "checksum-history");
  await prisma.scannedFile.updateMany({ where: { sessionId: data.scan.id }, data: { checksum: "shared-checksum", sizeBytes: 100 } });
  const duplicate = await import("../../src/lib/bridge/checksum-duplicates");
  await duplicate.recordChecksumDuplicateSuggestionsForSession(data.scan.id);
  const row = await prisma.organizationSuggestion.findFirstOrThrow({ where: { scannedFileId: data.rows[0].id, invalidatedAt: null } });
  await suggestions.reviewOrganizationSuggestion(row.id, { scanSessionId: data.scan.id, action: "APPROVE" });
  const reviewed = await prisma.organizationSuggestion.findUniqueOrThrow({ where: { id: row.id } });
  await duplicate.recordChecksumDuplicateSuggestionsForSession(data.scan.id);
  assert.deepEqual(await prisma.organizationSuggestion.findUniqueOrThrow({ where: { id: row.id } }), reviewed);
  await prisma.scannedFile.update({ where: { id: data.rows[1].id }, data: { checksum: "changed-checksum" } });
  await duplicate.recordChecksumDuplicateSuggestionsForSession(data.scan.id);
  const retired = await prisma.organizationSuggestion.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(retired.invalidatedAt);
  assert.equal(retired.status, reviewed.status); assert.equal(retired.suggestionType, reviewed.suggestionType);
  assert.deepEqual(retired.reviewedAt, reviewed.reviewedAt); assert.deepEqual(retired.supportingInformation, reviewed.supportingInformation);
  await prisma.scannedFile.update({ where: { id: data.rows[1].id }, data: { checksum: "shared-checksum" } });
  await duplicate.recordChecksumDuplicateSuggestionsForSession(data.scan.id);
  assert.deepEqual(await prisma.organizationSuggestion.findUniqueOrThrow({ where: { id: row.id } }), retired);
  await suggestions.prepareOrganizationRecommendationRegeneration(data.scan.id, { confirmedReviewedDecisions: true });
  const historical = await prisma.organizationSuggestion.findUniqueOrThrow({ where: { id: row.id } });
  await duplicate.recordChecksumDuplicateSuggestionsForSession(data.scan.id);
  assert.deepEqual(await prisma.organizationSuggestion.findUniqueOrThrow({ where: { id: row.id } }), historical);
  const once = await prisma.organizationSuggestion.count({ where: { scannedFileId: data.rows[0].id, invalidatedAt: null } });
  await duplicate.recordChecksumDuplicateSuggestionsForSession(data.scan.id);
  assert.equal(await prisma.organizationSuggestion.count({ where: { scannedFileId: data.rows[0].id, invalidatedAt: null } }), once);
});

test("Correction authority commits durable Search recovery even when eager hash refresh never runs", async (t) => {
  const data = await fixture(t, "correction-recovery");
  assert.equal(await publication.publishScanDerivedKnowledge(data.scan.id), true);
  const knowledge = await import("../../src/lib/bridge/persistent-knowledge");
  const signals = await prisma.knowledgeDocumentSignal.findMany({ where: { connectedLibraryId: data.root.id,
    kind: { in: ["CLIENT", "UNRESOLVED_CLIENT"] }, status: "ACTIVE", supersededAt: null }, orderBy: { relativePath: "asc" } });
  assert.equal(signals.length, 2);
  const relation = await knowledge.createIdentityCorrection({ sourceSignalId: signals[0].id,
    targetSignalId: signals[1].id, kind: "SAME_CLIENT", note: "Explicit client identity" });
  assert.match((await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } })).searchIndexStatus, /^NOT_ATTEMPTED@/);
  assert.equal((await publication.recoverPendingScanPublications({ sessionId: data.scan.id })).completed, 1);
  await knowledge.reviewPersistentRelationship(relation.id, "SEPARATE", "Split the client identity");
  assert.match((await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } })).searchIndexStatus, /^NOT_ATTEMPTED@/);
  const recovered = await publication.recoverPendingScanPublications({ sessionId: data.scan.id });
  assert.equal(recovered.completed, 1);
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: data.scan.id } })).searchIndexStatus, "COMPLETED");
});

for (const mutation of ["new generation", "revoked root", "human rejection"] as const) {
  test(`Recommendation stale context cannot replace ${mutation}`, { timeout: 60_000 }, async (t) => {
    const reached = barrier(), resume = barrier(); t.after(resume.resolve);
    const data = await fixture(t, mutation, 1);
    const old = suggestions.generateOrganizationSuggestionsForScannedFileWithText(data.rows[0].id, data.rows[0].text,
      { beforePersist: async () => { reached.resolve(); await resume.promise; } });
    const rejected = assert.rejects(old, /source or its review changed/i);
    await reached.promise;
    if (mutation === "new generation") await suggestions.generateOrganizationSuggestionsForScannedFileWithText(data.rows[0].id, data.rows[0].text);
    if (mutation === "revoked root") await prisma.connectedLibrary.update({ where: { id: data.root.id }, data: { readPermission: false } });
    if (mutation === "human rejection") await prisma.observationSession.update({ where: { id: data.rows[0].observationId }, data: { status: "REJECTED" } });
    const winner = await prisma.organizationSuggestion.findMany({ where: { scanSessionId: data.scan.id }, orderBy: { id: "asc" } });
    resume.resolve(); await rejected;
    assert.deepEqual(await prisma.organizationSuggestion.findMany({ where: { scanSessionId: data.scan.id }, orderBy: { id: "asc" } }), winner);
  });
}

for (const operation of ["generation", "selection"] as const) {
  test(`Plan stale ${operation} cannot overwrite a concurrent cancellation`, { timeout: 60_000 }, async (t) => {
    const release = barrier(); t.after(release.resolve);
    const data = await preferenceFixture(t, `plan-${operation}`);
    const planner = await import("../../src/lib/bridge/planner");
    const plan = await planner.generateOrganizationPlanForScanSession(data.scan.id);
    const owner = barrier();
    const winning = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "OrganizationPlan" WHERE id = ${plan.id} FOR UPDATE`);
      owner.resolve(); await release.promise;
      return tx.organizationPlan.update({ where: { id: plan.id }, data: { status: "CANCELLED", history: ["Concurrent cancellation wins"] } });
    }, { timeout: 60_000 });
    await owner.promise;
    const losing = operation === "generation" ? planner.generateOrganizationPlanForScanSession(data.scan.id) : planner.clearOrganizationPlanSelection(plan.id);
    const rejection = assert.rejects(losing);
    // A database row lock is the barrier at the actual production UPDATE.
    let blocked = false;
    const deadline = Date.now() + 20_000;
    while (!blocked && Date.now() < deadline) {
      blocked = (await prisma.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
        SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE ${`%${schema}%OrganizationPlan%`} AND query LIKE 'UPDATE%'
      `)).length > 0;
      if (!blocked) await new Promise((done) => setTimeout(done, 20));
    }
    release.resolve(); const winner = await winning; await rejection;
    assert.equal(blocked, true, "The stale worker reached its real mutation boundary");
    assert.deepEqual(await prisma.organizationPlan.findUniqueOrThrow({ where: { id: plan.id } }), winner);
  });
}
