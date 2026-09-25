import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";

import { PrismaClient } from "@prisma/client";
import { documentSignalVersion } from "../../src/lib/bridge/document-signals";

const schema = `phase_three_${process.pid}_${Date.now()}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalDirectUrl = process.env.DIRECT_URL;
let prisma: PrismaClient;
let search: typeof import("../../src/lib/library/search");
let indexer: typeof import("../../src/lib/library/search-index");
let fileKey: typeof import("../../src/lib/bridge/persistent-knowledge");
let memory: typeof import("../../src/lib/library/memory");
let backfill: typeof import("../../src/lib/library/search-backfill");

function isolatedUrl(value: string | undefined) {
  if (!value) throw new Error("An isolated local test database is required.");
  const url = new URL(value);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/nsn_library_machine_test") {
    throw new Error("Search tests refuse any non-local or non-test database.");
  }
  url.searchParams.set("schema", schema);
  return url.toString();
}

before(async () => {
  process.env.DATABASE_URL = isolatedUrl(originalDatabaseUrl);
  process.env.DIRECT_URL = isolatedUrl(originalDirectUrl ?? originalDatabaseUrl);
  process.env.OPENAI_API_KEY = "";
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], {
    env: process.env, stdio: "pipe",
  });
  prisma = new PrismaClient();
  search = await import("../../src/lib/library/search");
  indexer = await import("../../src/lib/library/search-index");
  fileKey = await import("../../src/lib/bridge/persistent-knowledge");
  memory = await import("../../src/lib/library/memory");
  backfill = await import("../../src/lib/library/search-backfill");
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

async function root(name: string) {
  return prisma.connectedLibrary.create({ data: {
    bridgeRootId: crypto.randomUUID(), displayName: name,
    localPath: `bridge://search-test/${crypto.randomUUID()}`, platform: "MACOS",
  } });
}

async function session(connectedFolderId: string) {
  return prisma.scanSession.create({ data: { connectedFolderId, status: "COMPLETED" } });
}

async function observedFile(input: {
  checksum?: string;
  concepts?: string[];
  evidence?: string;
  fileType?: string;
  path: string;
  rootId: string;
  sessionId: string;
  status?: "AWAITING_REVIEW" | "APPROVED" | "MODIFIED";
}) {
  const batch = await prisma.libraryBatch.create({ data: { name: "Synthetic search test" } });
  const document = await prisma.libraryDocument.create({ data: {
    batchId: batch.id, normalizedFileName: input.path, originalFileName: input.path,
  } });
  const observation = await prisma.observationSession.create({ data: {
    confidence: 0.7, explanation: [], interpretations: [], libraryDocumentId: document.id,
    observations: [], observerType: "OPENAI", planSuggestions: [], warnings: [],
    status: input.status ?? "AWAITING_REVIEW",
  } });
  const file = await prisma.scannedFile.create({ data: {
    checksum: input.checksum ?? crypto.randomUUID(), extractionStatus: "COMPLETED",
    fileType: input.fileType ?? "TEXT", libraryDocumentId: document.id,
    localPath: `bridge://${input.rootId}/${input.path}`, readStatus: "SUPPORTED",
    readingStatus: "READ", relativePath: input.path, sessionId: input.sessionId,
  } });
  return { file, observation, working: {
    approvedMemoryEvidence: [], connectedLibraryId: input.rootId,
    fileName: input.path.split("/").at(-1) ?? input.path,
    fileType: input.fileType ?? "TEXT", id: file.id,
    normalizedIdentity: `${input.rootId}/${input.path}`,
    provisionalWorkingEvidence: [], relativePath: input.path,
    semanticPreview: "", semanticTerms: [],
    sourceEvidenceText: input.evidence ?? "", supportingTopics: input.concepts ?? [],
    trustedObservationEvidence: [],
  } };
}

async function indexFiles(scanSessionId: string, files: Array<Awaited<ReturnType<typeof observedFile>>>) {
  return indexer.indexScanKnowledge({
    clusters: [], files: files.map((item) => item.working), relationships: [], scanSessionId,
  });
}

function evidence(text: string) {
  return `Source characters 0-${text.length}: "${text}"`;
}

test("exact file name ranks over conceptual matches", async () => {
  const r = await root("Exact Root"); const s = await session(r.id);
  const exact = await observedFile({ rootId: r.id, sessionId: s.id, path: "workshop.txt", evidence: evidence("A workshop agenda for participants"), concepts: ["workshops"] });
  const broad = await observedFile({ rootId: r.id, sessionId: s.id, path: "training.txt", evidence: evidence("A workshop training handout"), concepts: ["workshops"] });
  await indexFiles(s.id, [exact, broad]);
  const results = await search.searchLibrary("workshop.txt");
  assert.equal(results[0]?.relativePath, "workshop.txt");
});

test("conceptual workshop search finds a differently named file", async () => {
  const r = await root("Concept Root"); const s = await session(r.id);
  const item = await observedFile({ rootId: r.id, sessionId: s.id, path: "Program/agenda.txt", evidence: evidence("Facilitation agenda for a group learning session"), concepts: ["workshops"] });
  await indexFiles(s.id, [item]);
  assert.ok((await search.searchLibrary("workshop facilitation")).some((result) => result.relativePath === item.file.relativePath));
});

test("generic lexical overlap ranks below source-supported topic", () => {
  const intent = search.parseSearchIntent("workshop proposal");
  const base = { entityHashes: [], isCurrent: true, knowledgeState: "PROVISIONAL", reviewedTerms: [], sourceExcerpts: [] };
  const strong = search.rankSearchEntry({ ...base, relativePath: "agenda.txt", sourceTerms: ["workshop", "propos"], concepts: ["workshops"] }, intent);
  const weak = search.rankSearchEntry({ ...base, relativePath: "notes.txt", sourceTerms: ["propos"], concepts: [] }, intent);
  assert.ok((strong?.score ?? 0) > (weak?.score ?? 0));
});

test("client identity search expands only shared resolved hashes", async () => {
  const r = await root("Client Root"); const s = await session(r.id);
  const a = await observedFile({ rootId: r.id, sessionId: s.id, path: "Alice/intake.txt", evidence: evidence("Client: Alice; Client ID: C-001") });
  const b = await observedFile({ rootId: r.id, sessionId: s.id, path: "Alice/followup.txt", evidence: evidence("Follow-up for the same client") });
  await prisma.knowledgeDocumentSignal.createMany({ data: [a, b].map((item) => ({
    checksum: item.file.checksum!, connectedLibraryId: r.id,
    fileKey: fileKey.persistentFileKey(r.id, item.file.relativePath),
    generationVersion: documentSignalVersion, identityHash: "alice-identity", kind: "CLIENT",
    observationSessionId: item.observation.id, relativePath: item.file.relativePath,
    signalKey: crypto.randomUUID(), sourceRanges: [],
  })) });
  await indexFiles(s.id, [a, b]);
  const results = await search.searchLibrary("client alice");
  assert.ok(results.some((result) => result.relativePath === b.file.relativePath));
});

test("same-name clients have distinct identity hashes", async () => {
  const r = await root("Same Name Root"); const s = await session(r.id);
  const a = await observedFile({ rootId: r.id, sessionId: s.id, path: "Alice/a.txt", evidence: evidence("Client: Alice; Client ID: C-111") });
  const b = await observedFile({ rootId: r.id, sessionId: s.id, path: "Alice/b.txt", evidence: evidence("Client: Alice; Client ID: C-222") });
  await prisma.knowledgeDocumentSignal.createMany({ data: [a, b].map((item, i) => ({
    checksum: item.file.checksum!, connectedLibraryId: r.id,
    fileKey: fileKey.persistentFileKey(r.id, item.file.relativePath),
    generationVersion: documentSignalVersion, identityHash: `alice-${i}`, kind: "CLIENT",
    observationSessionId: item.observation.id, relativePath: item.file.relativePath,
    signalKey: crypto.randomUUID(), sourceRanges: [],
  })) });
  await indexFiles(s.id, [a, b]);
  const entryA = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: a.file.id } });
  const entryB = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: b.file.id } });
  assert.notDeepEqual(entryA.entityHashes, entryB.entityHashes);
});

test("repeated scan of same checksum updates one current index row", async () => {
  const r = await root("Repeat Root"); const s1 = await session(r.id);
  const first = await observedFile({ rootId: r.id, sessionId: s1.id, path: "repeat.txt", checksum: "sha-repeat", evidence: evidence("A stable source excerpt") });
  await indexFiles(s1.id, [first]);
  const s2 = await session(r.id);
  const second = await observedFile({ rootId: r.id, sessionId: s2.id, path: "repeat.txt", checksum: "sha-repeat", evidence: evidence("A stable source excerpt") });
  await indexFiles(s2.id, [second]);
  assert.equal(await prisma.librarySearchEntry.count({ where: { fileKey: fileKey.persistentFileKey(r.id, "repeat.txt") } }), 1);
  assert.equal((await prisma.librarySearchEntry.findFirstOrThrow({ where: { fileKey: fileKey.persistentFileKey(r.id, "repeat.txt") } })).scannedFileId, second.file.id);
});

test("changed checksum supersedes old searchable evidence", async () => {
  const r = await root("Change Root"); const s1 = await session(r.id);
  await indexFiles(s1.id, [await observedFile({ rootId: r.id, sessionId: s1.id, path: "change.txt", checksum: "old", evidence: evidence("Orchid arrangement") })]);
  const s2 = await session(r.id);
  await indexFiles(s2.id, [await observedFile({ rootId: r.id, sessionId: s2.id, path: "change.txt", checksum: "new", evidence: evidence("Budget planning") })]);
  assert.ok(!(await search.searchLibrary("orchid")).some((result) => result.rootName === r.displayName));
  assert.equal(await prisma.librarySearchEntry.count({ where: { fileKey: fileKey.persistentFileKey(r.id, "change.txt"), isCurrent: true } }), 1);
});

test("historical query labels an older scan explicitly", async () => {
  const r = await root("History Root"); const s1 = await session(r.id);
  await indexFiles(s1.id, [await observedFile({ rootId: r.id, sessionId: s1.id, path: "draft.txt", checksum: "draft-1", evidence: evidence("Orchid arrangement") })]);
  const s2 = await session(r.id);
  await indexFiles(s2.id, [await observedFile({ rootId: r.id, sessionId: s2.id, path: "draft.txt", checksum: "draft-2", evidence: evidence("Budget planning") })]);
  assert.ok((await search.searchLibrary("older orchid versions")).some((result) => result.state === "Historical scan"));
});

test("human correction changes fingerprint and reviewed terms", async () => {
  const r = await root("Review Root"); const s = await session(r.id);
  const item = await observedFile({ rootId: r.id, sessionId: s.id, path: "review.txt", checksum: "review-1", evidence: evidence("An original passage") });
  await indexFiles(s.id, [item]);
  const before = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: item.file.id } });
  await prisma.humanDecision.create({ data: { observationSessionId: item.observation.id, decisionType: "MODIFY", editedSuggestion: "Becoming rather than recovery" } });
  await prisma.observationSession.update({ data: { status: "MODIFIED" }, where: { id: item.observation.id } });
  await indexer.indexScanKnowledge({ clusters: [], files: [item.working], relationships: [], scanSessionId: s.id }, [item.file.id]);
  const after = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: item.file.id } });
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.ok(after.reviewedTerms.includes("becom"));
  assert.equal(after.knowledgeState, "APPROVED");
});

test("provisional evidence is labeled provisional", async () => {
  const r = await root("Provisional Root"); const s = await session(r.id);
  await indexFiles(s.id, [await observedFile({ rootId: r.id, sessionId: s.id, path: "provisional.txt", evidence: evidence("An unusual provisional term") })]);
  assert.ok((await search.searchLibrary("unusual")).some((result) => result.state === "Provisional source evidence"));
});

test("source ranges retain the verified source span", async () => {
  const r = await root("Ranges Root"); const s = await session(r.id);
  await indexFiles(s.id, [await observedFile({ rootId: r.id, sessionId: s.id, path: "range.txt", evidence: evidence("Workshop planning notes") })]);
  const found = (await search.searchLibrary("planning")).find((result) => result.rootName === r.displayName);
  assert.deepEqual(found?.sourceRange, { start: 0, end: 23 });
});

test("read permission revocation removes results at query time", async () => {
  const r = await root("Private Root"); const s = await session(r.id);
  await indexFiles(s.id, [await observedFile({ rootId: r.id, sessionId: s.id, path: "private.txt", evidence: evidence("Private cobalt subject") })]);
  await prisma.connectedLibrary.update({ data: { readPermission: false }, where: { id: r.id } });
  assert.ok(!(await search.searchLibrary("cobalt")).some((result) => result.rootName === r.displayName));
});

test("disconnected root cannot appear as active or historical search", async () => {
  const r = await root("Disconnected Root"); const s = await session(r.id);
  await indexFiles(s.id, [await observedFile({ rootId: r.id, sessionId: s.id, path: "disconnected.txt", evidence: evidence("Disconnected violet source") })]);
  await prisma.connectedLibrary.update({ data: { status: "DISCONNECTED", disconnectedAt: new Date() }, where: { id: r.id } });
  assert.ok(!(await search.searchLibrary("older violet")).some((result) => result.rootName === r.displayName));
});

test("metadata-only image never claims OCR content", async () => {
  const r = await root("Image Root"); const s = await session(r.id);
  await prisma.scannedFile.create({ data: { sessionId: s.id, localPath: "bridge://image/photo.jpg", relativePath: "photo.jpg", fileType: "IMAGE_JPG", readStatus: "SUPPORTED" } });
  const found = (await search.searchLibrary("photo.jpg")).find((result) => result.rootName === r.displayName);
  assert.match(found?.state ?? "", /Metadata match/);
  assert.equal(found?.excerpt, null);
});

test("metadata-only audio and video never claim transcript content", async () => {
  const r = await root("Media Root"); const s = await session(r.id);
  for (const [name, fileType] of [["voice.mp3", "AUDIO_MP3"], ["clip.mp4", "VIDEO_MP4"]]) {
    await prisma.scannedFile.create({ data: { sessionId: s.id, localPath: `bridge://media/${name}`, relativePath: name, fileType, readStatus: "SUPPORTED" } });
    const found = (await search.searchLibrary(name)).find((result) => result.rootName === r.displayName);
    assert.match(found?.state ?? "", /Metadata match/);
    assert.equal(found?.excerpt, null);
  }
});

test("candidate and final result limits are explicit", () => {
  assert.equal(search.searchCandidateLimit, 120);
  assert.equal(search.searchResultLimit, 20);
  assert.equal(indexer.searchEvidenceLimit, 8);
  assert.equal(indexer.searchExcerptLimit, 240);
});

test("invalid source ranges are not persisted as verified excerpts", () => {
  assert.deepEqual(indexer.boundedSourceExcerpts('Source characters 0-99: "short"'), []);
});

test("an incomplete unindexed file remains findable by exact metadata", async () => {
  const r = await root("Fallback Root"); const s = await session(r.id);
  await prisma.scannedFile.create({ data: { sessionId: s.id, localPath: "bridge://fallback/unindexed.txt", relativePath: "unindexed.txt", fileType: "TEXT" } });
  assert.ok((await search.searchLibrary("unindexed.txt")).some((result) => result.state === "Not indexed; metadata match only"));
});

test("search parser remains deterministic without an AI request", () => {
  assert.deepEqual(search.parseSearchIntent("older workshop versions"), search.parseSearchIntent("older workshop versions"));
  assert.equal(search.parseSearchIntent("older workshop versions").wantsHistory, true);
});

test("indexing does not queue filesystem execution commands", async () => {
  const r = await root("Safety Root"); const s = await session(r.id);
  await indexFiles(s.id, [await observedFile({ rootId: r.id, sessionId: s.id, path: "safe.txt", evidence: evidence("Safe workshop agenda") })]);
  assert.equal(await prisma.executionRun.count(), 0);
  assert.equal(await prisma.bridgeCommand.count({ where: { commandType: "EXECUTE_PLAN" } }), 0);
});

test("project query does not pull in a distinct project", async () => {
  const r = await root("Project Root"); const s = await session(r.id);
  const atlas = await observedFile({ rootId: r.id, sessionId: s.id, path: "Projects/atlas.txt", evidence: evidence("Project: Atlas; Project ID: P-100") });
  const beacon = await observedFile({ rootId: r.id, sessionId: s.id, path: "Projects/beacon.txt", evidence: evidence("Project: Beacon; Project ID: P-200") });
  await prisma.knowledgeDocumentSignal.createMany({ data: [atlas, beacon].map((item, i) => ({
    checksum: item.file.checksum!, connectedLibraryId: r.id,
    fileKey: fileKey.persistentFileKey(r.id, item.file.relativePath),
    generationVersion: documentSignalVersion, identityHash: `project-${i}`, kind: "PROJECT",
    observationSessionId: item.observation.id, relativePath: item.file.relativePath,
    signalKey: crypto.randomUUID(), sourceRanges: [],
  })) });
  await indexFiles(s.id, [atlas, beacon]);
  const results = await search.searchLibrary("project atlas");
  assert.ok(results.some((result) => result.relativePath === atlas.file.relativePath));
  assert.ok(!results.some((result) => result.relativePath === beacon.file.relativePath));
});

test("version family marks an earlier revision within the current scan", async () => {
  const r = await root("Versions Root"); const s = await session(r.id);
  const old = await observedFile({ rootId: r.id, sessionId: s.id, path: "Workshops/outline-v1.txt", evidence: evidence("Workshop outline revision one") });
  const latest = await observedFile({ rootId: r.id, sessionId: s.id, path: "Workshops/outline-v2.txt", evidence: evidence("Workshop outline revision two") });
  await prisma.knowledgeDocumentSignal.createMany({ data: [old, latest].map((item, i) => ({
    checksum: item.file.checksum!, connectedLibraryId: r.id,
    fileKey: fileKey.persistentFileKey(r.id, item.file.relativePath),
    generationVersion: documentSignalVersion, identityHash: "outline-family", kind: "DOCUMENT_FAMILY",
    observationSessionId: item.observation.id, relativePath: item.file.relativePath,
    revisionNumber: `${i + 1}`, signalKey: crypto.randomUUID(), sourceRanges: [],
  })) });
  await indexFiles(s.id, [old, latest]);
  const results = await search.searchLibrary("older versions of workshop outline");
  assert.ok(results.some((result) => result.relativePath === old.file.relativePath && result.state === "Earlier document version"));
  assert.ok(results.some((result) => result.relativePath === latest.file.relativePath));
});

test("bounded index holds no full source body", () => {
  const source = Array.from({ length: 20 }, (_, i) => {
    const text = `Section ${i} ${"x".repeat(190)}`;
    return `Source characters ${i * 200}-${i * 200 + text.length}: "${text}"`;
  }).join(" ");
  const excerpts = indexer.boundedSourceExcerpts(source);
  assert.equal(excerpts.length, 8);
  assert.ok(excerpts.every((item) => item.text.length <= 240));
});

test("repeating a search returns stable ranking", async () => {
  const first = await search.searchLibrary("workshop");
  const second = await search.searchLibrary("workshop");
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
});

test("search uses only active readable roots before candidate retrieval", async () => {
  const active = await root("Scoped Active"); const allowedScan = await session(active.id);
  const blocked = await root("Scoped Blocked"); const blockedScan = await session(blocked.id);
  const a = await observedFile({ rootId: active.id, sessionId: allowedScan.id, path: "allowed.txt", evidence: evidence("Unique amber subject") });
  const b = await observedFile({ rootId: blocked.id, sessionId: blockedScan.id, path: "blocked.txt", evidence: evidence("Unique amber subject") });
  await indexFiles(allowedScan.id, [a]); await indexFiles(blockedScan.id, [b]);
  await prisma.connectedLibrary.update({ data: { readPermission: false }, where: { id: blocked.id } });
  const results = await search.searchLibrary("amber");
  assert.ok(results.some((item) => item.rootName === active.displayName));
  assert.ok(!results.some((item) => item.rootName === blocked.displayName));
});

test("editing an old observation cannot reactivate its superseded scan entry", async () => {
  const r = await root("Old Edit Root"); const oldScan = await session(r.id);
  const old = await observedFile({ rootId: r.id, sessionId: oldScan.id,
    path: "memo.txt", checksum: "old-edit-1", evidence: evidence("Earlier orchard notes") });
  await indexFiles(oldScan.id, [old]);
  const newScan = await session(r.id);
  const current = await observedFile({ rootId: r.id, sessionId: newScan.id,
    path: "memo.txt", checksum: "old-edit-2", evidence: evidence("Current budget notes") });
  await indexFiles(newScan.id, [current]);
  await indexer.indexScanKnowledge({ clusters: [], files: [old.working], relationships: [],
    scanSessionId: oldScan.id }, [old.file.id]);
  const entries = await prisma.librarySearchEntry.findMany({ where: {
    fileKey: fileKey.persistentFileKey(r.id, "memo.txt"),
  } });
  assert.equal(entries.filter((entry) => entry.isCurrent).length, 1);
  assert.equal(entries.find((entry) => entry.isCurrent)?.checksum, current.file.checksum);
});

test("new approved Memory carries source provenance and is labeled separately", async () => {
  const r = await root("Memory Source Root"); const s = await session(r.id);
  const item = await observedFile({ rootId: r.id, sessionId: s.id,
    path: "unique-memory-source.txt", status: "APPROVED" });
  await prisma.libraryDocument.update({ where: { id: item.observation.libraryDocumentId },
    data: { previewText: "cobaltium cobaltium" } });
  await memory.buildMemoryFromApprovedSession(item.observation.id);
  const entry = await prisma.memoryEntry.findUniqueOrThrow({ where: { memoryKey: "TERM:cobaltium" },
    include: { searchSources: true } });
  assert.equal(entry.searchProvenanceComplete, true);
  assert.equal(entry.searchSources[0]?.connectedLibraryId, r.id);
  const found = (await search.searchLibrary("cobaltium")).find((result) => result.id === entry.id);
  assert.equal(found?.kind, "MEMORY");
  assert.equal(found?.state, "Human-approved Memory");
  assert.equal(found?.excerpt, null);
  assert.equal(found?.sourceRange, null);
});

test("approved Memory never crosses requested root scope or revoked read permission", async () => {
  const r = await root("Memory Scope Root"); const s = await session(r.id);
  const other = await root("Other Scope Root"); await session(other.id);
  const item = await observedFile({ rootId: r.id, sessionId: s.id, path: "scoped-memory.txt", status: "APPROVED" });
  const entry = await prisma.memoryEntry.create({ data: { memoryType: "NOTE", memoryKey: crypto.randomUUID(),
    title: "quartzium scoped note", description: "A reviewed note", evidence: [],
    searchProvenanceComplete: true, searchSourceCount: 1, searchSources: { create: {
      connectedLibraryId: r.id, observationSessionId: item.observation.id,
    } },
  } });
  assert.ok(!(await search.searchLibrary("quartzium", [other.id])).some((result) => result.id === entry.id));
  await prisma.connectedLibrary.update({ where: { id: r.id }, data: { readPermission: false } });
  assert.ok(!(await search.searchLibrary("quartzium")).some((result) => result.id === entry.id));
});

test("multi-root Memory requires all source roots to remain authorized", async () => {
  const a = await root("Multi Memory A"); const sa = await session(a.id);
  const b = await root("Multi Memory B"); const sb = await session(b.id);
  const left = await observedFile({ rootId: a.id, sessionId: sa.id, path: "left-memory.txt", status: "APPROVED" });
  const right = await observedFile({ rootId: b.id, sessionId: sb.id, path: "right-memory.txt", status: "APPROVED" });
  const entry = await prisma.memoryEntry.create({ data: { memoryType: "NOTE", memoryKey: crypto.randomUUID(),
    title: "multiquartz shared insight", description: "Reviewed across both roots", evidence: [],
    searchProvenanceComplete: true, searchSourceCount: 2, searchSources: { create: [
      { connectedLibraryId: a.id, observationSessionId: left.observation.id },
      { connectedLibraryId: b.id, observationSessionId: right.observation.id },
    ] },
  } });
  assert.ok((await search.searchLibrary("multiquartz")).some((result) => result.id === entry.id));
  assert.ok(!(await search.searchLibrary("multiquartz", [a.id])).some((result) => result.id === entry.id));
  await prisma.connectedLibrary.update({ where: { id: b.id }, data: { readPermission: false } });
  assert.ok(!(await search.searchLibrary("multiquartz")).some((result) => result.id === entry.id));
});

test("unknown historical Memory remains excluded and is not assigned from a filename guess", async () => {
  const r = await root("Unknown Memory Root"); await session(r.id);
  const entry = await prisma.memoryEntry.create({ data: { memoryType: "NOTE", memoryKey: crypto.randomUUID(),
    title: "unknownprovenance insight", description: "No audited source", evidence: ["Approved item: same.txt"],
  } });
  const outcome = await memory.backfillHistoricalMemorySearchSources();
  assert.ok(outcome.checked >= 1);
  assert.ok(!(await search.searchLibrary("unknownprovenance")).some((result) => result.id === entry.id));
  assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: entry.id } })).searchProvenanceComplete, false);
});

test("strict single-source historical term provenance is reconstructed", async () => {
  const r = await root("Historical Memory Root"); const s = await session(r.id);
  const item = await observedFile({ rootId: r.id, sessionId: s.id,
    path: "distinct-historical-memory.txt", status: "APPROVED" });
  await prisma.libraryDocument.update({ where: { id: item.observation.libraryDocumentId },
    data: { previewText: "orchidarium orchidarium" } });
  const entry = await prisma.memoryEntry.create({ data: { memoryType: "TERM", memoryKey: "TERM:orchidarium",
    title: "orchidarium", description: "Human corrected historical wording", occurrenceCount: 1,
    evidence: ["Approved item: distinct-historical-memory.txt", "Recurring term: orchidarium"],
  } });
  await memory.backfillHistoricalMemorySearchSources();
  const updated = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: entry.id },
    include: { searchSources: true } });
  assert.equal(updated.searchProvenanceComplete, true);
  assert.equal(updated.searchSources[0]?.connectedLibraryId, r.id);
  assert.equal(updated.description, "Human corrected historical wording");
});

test("historical backfill reuses a matching partial source without duplicating it", async () => {
  const r = await root("Partial Memory Root"); const s = await session(r.id);
  const item = await observedFile({ rootId: r.id, sessionId: s.id,
    path: "unique-partial-source.txt", status: "APPROVED" });
  await prisma.libraryDocument.update({ where: { id: item.observation.libraryDocumentId },
    data: { previewText: "verdantium verdantium" } });
  const entry = await prisma.memoryEntry.create({ data: { memoryType: "TERM", memoryKey: "TERM:verdantium",
    title: "verdantium", description: "Old approved term", occurrenceCount: 1,
    evidence: ["Approved item: unique-partial-source.txt", "Recurring term: verdantium"],
    searchSources: { create: { connectedLibraryId: r.id, observationSessionId: item.observation.id } },
  } });
  await memory.backfillHistoricalMemorySearchSources();
  assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: entry.id } })).searchProvenanceComplete, true);
  assert.equal(await prisma.memorySearchSource.count({ where: { memoryEntryId: entry.id } }), 1);
});

test("same historical filename in two roots never creates guessed provenance", async () => {
  const a = await root("Ambiguous History A"); const sa = await session(a.id);
  const b = await root("Ambiguous History B"); const sb = await session(b.id);
  const left = await observedFile({ rootId: a.id, sessionId: sa.id,
    path: "ambiguous-history.txt", status: "APPROVED" });
  const right = await observedFile({ rootId: b.id, sessionId: sb.id,
    path: "ambiguous-history.txt", status: "APPROVED" });
  await prisma.libraryDocument.updateMany({
    where: { id: { in: [left.observation.libraryDocumentId, right.observation.libraryDocumentId] } },
    data: { previewText: "duplihistory duplihistory" },
  });
  const entry = await prisma.memoryEntry.create({ data: { memoryType: "TERM", memoryKey: "TERM:duplihistory",
    title: "duplihistory", description: "Old term", occurrenceCount: 1,
    evidence: ["Approved item: ambiguous-history.txt", "Recurring term: duplihistory"],
  } });
  await memory.backfillHistoricalMemorySearchSources();
  assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: entry.id } })).searchProvenanceComplete, false);
  assert.equal(await prisma.memorySearchSource.count({ where: { memoryEntryId: entry.id } }), 0);
});

test("archived and revoked-source Memory are not active search results", async () => {
  const r = await root("Archive Memory Root"); const s = await session(r.id);
  const item = await observedFile({ rootId: r.id, sessionId: s.id, path: "archive-memory.txt", status: "APPROVED" });
  const entry = await prisma.memoryEntry.create({ data: { memoryType: "NOTE", memoryKey: crypto.randomUUID(),
    title: "archivium observation", description: "Reviewed", evidence: [], searchProvenanceComplete: true, searchSourceCount: 1,
    searchSources: { create: { connectedLibraryId: r.id, observationSessionId: item.observation.id } },
  } });
  await prisma.memoryEntry.update({ where: { id: entry.id }, data: { status: "ARCHIVED" } });
  assert.ok(!(await search.searchLibrary("archivium")).some((result) => result.id === entry.id));
  await prisma.memoryEntry.update({ where: { id: entry.id }, data: { status: "ACTIVE" } });
  await prisma.observationSession.update({ where: { id: item.observation.id }, data: { status: "REJECTED" } });
  assert.ok(!(await search.searchLibrary("archivium")).some((result) => result.id === entry.id));
});

test("human-corrected Memory wording updates search without losing provenance", async () => {
  const r = await root("Corrected Memory Root"); const s = await session(r.id);
  const item = await observedFile({ rootId: r.id, sessionId: s.id, path: "corrected-memory.txt", status: "APPROVED" });
  const entry = await prisma.memoryEntry.create({ data: { memoryType: "NOTE", memoryKey: crypto.randomUUID(),
    title: "oldphrase memory", description: "Reviewed", evidence: [], searchProvenanceComplete: true, searchSourceCount: 1,
    searchSources: { create: { connectedLibraryId: r.id, observationSessionId: item.observation.id } },
  } });
  await prisma.memoryEntry.update({ where: { id: entry.id }, data: { title: "newphrase memory" } });
  assert.ok((await search.searchLibrary("newphrase")).some((result) => result.id === entry.id));
  assert.ok(!(await search.searchLibrary("oldphrase")).some((result) => result.id === entry.id));
});

test("a removed source record cannot make multi-root Memory appear single-root", async () => {
  const a = await root("Removed Source A"); const sa = await session(a.id);
  const b = await root("Removed Source B"); const sb = await session(b.id);
  const left = await observedFile({ rootId: a.id, sessionId: sa.id, path: "left-source.txt", status: "APPROVED" });
  const right = await observedFile({ rootId: b.id, sessionId: sb.id, path: "right-source.txt", status: "APPROVED" });
  const entry = await prisma.memoryEntry.create({ data: { memoryType: "NOTE", memoryKey: crypto.randomUUID(),
    title: "deletedrootword memory", description: "Both roots contributed", evidence: [],
    searchProvenanceComplete: true, searchSourceCount: 2, searchSources: { create: [
      { connectedLibraryId: a.id, observationSessionId: left.observation.id },
      { connectedLibraryId: b.id, observationSessionId: right.observation.id },
    ] },
  } });
  await prisma.memorySearchSource.deleteMany({ where: { memoryEntryId: entry.id, connectedLibraryId: b.id } });
  assert.ok(!(await search.searchLibrary("deletedrootword")).some((result) => result.id === entry.id));
});

test("scan working knowledge uses only Memory with complete readable provenance", async () => {
  const allowed = await root("Working Allowed Root"); const sa = await session(allowed.id);
  const blocked = await root("Working Blocked Root"); const sb = await session(blocked.id);
  const target = await observedFile({ rootId: allowed.id, sessionId: sa.id, path: "target.txt" });
  const source = await observedFile({ rootId: blocked.id, sessionId: sb.id,
    path: "memory-source.txt", status: "APPROVED" });
  await prisma.scannedFile.update({ where: { id: target.file.id },
    data: { previewText: "Orchidquartz workshop material" } });
  await prisma.memoryEntry.create({ data: { memoryType: "NOTE", memoryKey: crypto.randomUUID(),
    title: "Orchidquartz preference", description: "Orchidquartz workshop preference",
    evidence: [], searchProvenanceComplete: true, searchSourceCount: 1,
    searchSources: { create: { connectedLibraryId: blocked.id, observationSessionId: source.observation.id } },
  } });
  const working = await import("../../src/lib/bridge/scan-working-knowledge");
  await prisma.connectedLibrary.update({ where: { id: blocked.id }, data: { readPermission: false } });
  assert.deepEqual((await working.loadScanWorkingKnowledge(sa.id)).files[0].approvedMemoryEvidence, []);
  await prisma.connectedLibrary.update({ where: { id: blocked.id }, data: { readPermission: true } });
  assert.equal((await working.loadScanWorkingKnowledge(sa.id)).files[0].approvedMemoryEvidence.length, 1);
  await prisma.connectedLibrary.update({ where: { id: blocked.id },
    data: { status: "DISCONNECTED", disconnectedAt: new Date() } });
  assert.deepEqual((await working.loadScanWorkingKnowledge(sa.id)).files[0].approvedMemoryEvidence, []);
  await prisma.connectedLibrary.update({ where: { id: allowed.id }, data: { readPermission: false } });
  await assert.rejects(working.loadScanWorkingKnowledge(sa.id), /not available for reading/);
});

test("bounded backfill resumes, reuses current rows and has no filesystem commands", async () => {
  const r = await root("Large Backfill Root"); const s = await session(r.id);
  await prisma.scannedFile.createMany({ data: Array.from({ length: 43 }, (_, i) => ({
    sessionId: s.id, localPath: `bridge://${r.id}/large-${i}.txt`,
    relativePath: `large-${i}.txt`, fileType: "TEXT", checksum: `synthetic-${i}`,
    extractionStatus: "COMPLETED" as const, readingStatus: "READ" as const,
    readStatus: "SUPPORTED" as const, previewText: "A synthetic fixture",
  })) });
  const beforeCommands = await prisma.bridgeCommand.count();
  const first = await backfill.prepareSearchBatch(s.id);
  assert.equal(first.indexed + first.reused, 20);
  assert.equal(first.completedFiles, 20);
  assert.equal(first.remaining, 23);
  const second = await backfill.prepareSearchBatch(s.id);
  assert.equal(second.indexed + second.reused, 40);
  assert.equal(second.completedFiles, 40);
  assert.equal(second.remaining, 3);
  const last = await backfill.prepareSearchBatch(s.id);
  assert.equal(last.completed, true);
  assert.equal(last.indexed + last.reused, 43);
  assert.equal((await backfill.prepareSearchBatch(s.id)).indexed + last.reused, 43);
  assert.equal(await prisma.librarySearchBackfillFile.count({ where: { scanSessionId: s.id } }), 43);
  assert.equal(await prisma.bridgeCommand.count(), beforeCommands);
});

test("failed backfill file is isolated, reported and retryable", async () => {
  const r = await root("Failed Backfill Root"); const s = await session(r.id);
  const files = await Promise.all(["bad.txt", "good.txt"].map((name) => observedFile({
    rootId: r.id, sessionId: s.id, path: name,
  })));
  const failedId = files[0].file.id;
  const first = await backfill.prepareSearchBatch(s.id, false, async (_sessionId, fileId) => {
    if (fileId === failedId) throw new Error("Synthetic failure");
    return "INDEXED";
  });
  assert.equal(first.failed, 1);
  assert.equal(first.indexed, 1);
  assert.equal(first.completedFiles, 2);
  assert.equal(first.remaining, 0);
  assert.equal(first.completed, false);
  const retry = await backfill.prepareSearchBatch(s.id, true, async () => "REUSED");
  assert.equal(retry.failed, 0);
  assert.equal(retry.reused, 1);
  assert.equal(retry.indexed, 1);
  assert.equal(retry.completed, true);
});

test("concurrent search preparation claims a file once and recovers an interrupted claim", async () => {
  const r = await root("Claimed Backfill Root"); const s = await session(r.id);
  const item = await observedFile({ rootId: r.id, sessionId: s.id, path: "claim.txt" });
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let processCount = 0;
  const first = backfill.prepareSearchBatch(s.id, false, async () => {
    processCount += 1;
    signalStarted();
    await held;
    return "INDEXED";
  });
  await started;
  const concurrent = await backfill.prepareSearchBatch(s.id, false, async () => {
    processCount += 1;
    return "INDEXED";
  });
  assert.equal(concurrent.remaining, 1);
  assert.equal(processCount, 1);
  release();
  assert.equal((await first).completed, true);
  assert.equal(await prisma.librarySearchBackfillFile.count({ where: {
    scanSessionId: s.id, scannedFileId: item.file.id } }), 1);

  await prisma.librarySearchBackfillFile.updateMany({
    where: { scanSessionId: s.id, scannedFileId: item.file.id },
    data: { status: "PROCESSING", updatedAt: new Date(Date.now() - 6 * 60_000) },
  });
  const resumed = await backfill.prepareSearchBatch(s.id, false, async () => {
    processCount += 1;
    return "REUSED";
  });
  assert.equal(resumed.completed, true);
  assert.equal(resumed.reused, 1);
  assert.equal(processCount, 2);
});

test("supported synonym and source subject outrank a generic partial filename", async () => {
  const r = await root("Semantic Synonym Root"); const s = await session(r.id);
  const strong = await observedFile({ rootId: r.id, sessionId: s.id, path: "Education/agenda.txt" });
  const decoy = await observedFile({ rootId: r.id, sessionId: s.id, path: "Notes/seminar-reminder.txt" });
  await prisma.scannedFile.update({ where: { id: strong.file.id },
    data: { previewText: "Facilitation curriculum for participant training" } });
  await prisma.scannedFile.update({ where: { id: decoy.file.id },
    data: { previewText: "A short unrelated reminder" } });
  const working = await (await import("../../src/lib/bridge/scan-working-knowledge"))
    .loadScanWorkingKnowledge(s.id);
  assert.ok(working.files.find((file) => file.id === strong.file.id)?.supportingTopics.includes("workshops"));
  await indexer.indexScanKnowledge(working);
  const results = await search.searchLibrary("seminar", [r.id]);
  assert.equal(results[0]?.relativePath, strong.file.relativePath);
  assert.ok(results.some((result) => result.relativePath === decoy.file.relativePath));
});

test("metadata search remains available if the derived index is unavailable", async () => {
  const r = await root("No Index Root"); const s = await session(r.id);
  await prisma.scannedFile.create({ data: {
    sessionId: s.id, localPath: "bridge://no-index/known-file.txt",
    relativePath: "known-file.txt", fileType: "TEXT",
  } });
  await prisma.$executeRawUnsafe('DROP TABLE "LibrarySearchEntry"');
  const results = await search.searchLibrary("known-file.txt");
  assert.ok(results.some((result) => result.rootName === r.displayName &&
    result.state === "Not indexed; metadata match only"));
});
