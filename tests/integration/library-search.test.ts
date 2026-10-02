import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, mock, test } from "node:test";

import { PrismaClient, type KnowledgeDocumentSignal } from "@prisma/client";
import { documentSignalVersion } from "../../src/lib/bridge/document-signals";
import { runSearchPreparationBatches } from "../../src/lib/library/search-preparation";

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

test("result cutoff is stable for tied paths across roots and retrieval order", () => {
  const tied = Array.from({ length: 25 }, (_, index) => ({
    id: `row-${String(index).padStart(2, "0")}`, kind: "FILE" as const,
    rootName: `Root ${String(index).padStart(2, "0")}`, relativePath: "reports/summary.txt",
    fileType: "TEXT", href: `/file/${index}`, state: "Current", reason: "Metadata match",
    excerpt: null, sourceRange: null, score: 45,
  }));
  const selected = (rows: typeof tied) => rows.sort(search.compareSearchResults).slice(0, 20).map((row) => row.id);
  assert.deepEqual(selected([...tied]), selected([...tied].reverse()));
  assert.deepEqual(selected([...tied]), tied.slice(0, 20).map((row) => row.id));
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

for (const [kind, query] of [["CLIENT", "client alice"], ["PROJECT", "project atlas"]] as const) {
  test(`${kind.toLowerCase()} identity expansion is scoped to each independently matching root`, async () => {
    const firstRoot = await root(`${kind} Seed Root`); const firstSession = await session(firstRoot.id);
    const secondRoot = await root(`${kind} Other Root`); const secondSession = await session(secondRoot.id);
    const phrase = kind === "CLIENT" ? "Client: Alice" : "Project: Atlas";
    const firstSeed = await observedFile({ rootId: firstRoot.id, sessionId: firstSession.id,
      path: `${kind.toLowerCase()}/seed.txt`, evidence: evidence(`${phrase}; authoritative brief`) });
    const firstRelated = await observedFile({ rootId: firstRoot.id, sessionId: firstSession.id,
      path: `${kind.toLowerCase()}/related.txt`, evidence: evidence("Identity-linked notes without query words") });
    const secondUnrelated = await observedFile({ rootId: secondRoot.id, sessionId: secondSession.id,
      path: "unrelated/notes.txt", evidence: evidence(`${kind === "CLIENT" ? "Client" : "Project"} scheduling notes without a name`) });
    const sharedHash = `raw-shared-${kind.toLowerCase()}-${crypto.randomUUID()}`;
    await prisma.knowledgeDocumentSignal.createMany({ data: [
      [firstRoot.id, firstSeed], [firstRoot.id, firstRelated], [secondRoot.id, secondUnrelated],
    ].map(([rootId, item]) => {
      const observed = item as Awaited<ReturnType<typeof observedFile>>;
      return { checksum: observed.file.checksum!, connectedLibraryId: rootId as string,
        fileKey: fileKey.persistentFileKey(rootId as string, observed.file.relativePath),
        generationVersion: documentSignalVersion, identityHash: sharedHash, kind,
        observationSessionId: observed.observation.id, relativePath: observed.file.relativePath,
        signalKey: crypto.randomUUID(), sourceRanges: [] };
    }) });
    await indexFiles(firstSession.id, [firstSeed, firstRelated]);
    await indexFiles(secondSession.id, [secondUnrelated]);

    let results = await search.searchLibrary(query);
    assert.ok(results.some((result) => result.relativePath === firstRelated.file.relativePath));
    assert.ok(!results.some((result) => result.relativePath === secondUnrelated.file.relativePath));

    const secondSeed = await observedFile({ rootId: secondRoot.id, sessionId: secondSession.id,
      path: "matching/seed.txt", evidence: evidence(`${phrase}; independently matching brief`) });
    await prisma.knowledgeDocumentSignal.create({ data: {
      checksum: secondSeed.file.checksum!, connectedLibraryId: secondRoot.id,
      fileKey: fileKey.persistentFileKey(secondRoot.id, secondSeed.file.relativePath),
      generationVersion: documentSignalVersion, identityHash: sharedHash, kind,
      observationSessionId: secondSeed.observation.id, relativePath: secondSeed.file.relativePath,
      signalKey: crypto.randomUUID(), sourceRanges: [],
    } });
    await indexFiles(secondSession.id, [secondUnrelated, secondSeed]);
    results = await search.searchLibrary(query);
    assert.ok(results.some((result) => result.relativePath === secondSeed.file.relativePath));
    assert.ok(results.some((result) => result.relativePath === secondUnrelated.file.relativePath));
  });
}

test("history-aware identity expansion includes retained historical entries only for history queries", async () => {
  const r = await root("Identity History Root"); const oldSession = await session(r.id);
  const oldRelated = await observedFile({ rootId: r.id, sessionId: oldSession.id,
    path: "archive/legacy-record.txt", checksum: "history-old", evidence: evidence("Legacy identity-only material") });
  await prisma.knowledgeDocumentSignal.create({ data: {
    checksum: oldRelated.file.checksum!, connectedLibraryId: r.id,
    fileKey: fileKey.persistentFileKey(r.id, oldRelated.file.relativePath),
    generationVersion: documentSignalVersion, identityHash: "alice-history-identity", kind: "CLIENT",
    observationSessionId: oldRelated.observation.id, relativePath: oldRelated.file.relativePath,
    signalKey: crypto.randomUUID(), sourceRanges: [],
  } });
  await indexFiles(oldSession.id, [oldRelated]);

  const currentSession = await session(r.id);
  const currentSeed = await observedFile({ rootId: r.id, sessionId: currentSession.id,
    path: "current/intake.txt", checksum: "history-current", evidence: evidence("Client: Alice; current intake") });
  await prisma.knowledgeDocumentSignal.create({ data: {
    checksum: currentSeed.file.checksum!, connectedLibraryId: r.id,
    fileKey: fileKey.persistentFileKey(r.id, currentSeed.file.relativePath),
    generationVersion: documentSignalVersion, identityHash: "alice-history-identity", kind: "CLIENT",
    observationSessionId: currentSeed.observation.id, relativePath: currentSeed.file.relativePath,
    signalKey: crypto.randomUUID(), sourceRanges: [],
  } });
  await indexFiles(currentSession.id, [currentSeed]);

  assert.ok(!(await search.searchLibrary("client alice")).some((result) =>
    result.relativePath === oldRelated.file.relativePath));
  const historical = await search.searchLibrary("older files for client alice");
  assert.ok(historical.some((result) => result.relativePath === oldRelated.file.relativePath &&
    result.state === "Historical scan"));
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

test("search indexing deterministically selects same-millisecond observation reviews", async () => {
  const r = await root("Timestamp tie review root"); const s = await session(r.id);
  const rejected = await observedFile({ rootId: r.id, sessionId: s.id, path: "rejected.txt",
    checksum: "tie-rejected", evidence: evidence("Evidence that must not remain approved"), status: "APPROVED" });
  const tiedAt = new Date("2026-01-02T03:04:05.678Z");
  await prisma.observationSession.update({ where: { id: rejected.observation.id },
    data: { id: "tie-observation-a", createdAt: tiedAt } });
  await prisma.observationSession.create({ data: {
    id: "tie-observation-z", createdAt: tiedAt, libraryDocumentId: rejected.observation.libraryDocumentId,
    confidence: 1, explanation: [], interpretations: [], observations: [], observerType: "DETERMINISTIC",
    planSuggestions: [], status: "REJECTED", warnings: [],
  } });
  await indexFiles(s.id, [rejected]);
  const rejectedEntry = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: rejected.file.id } });
  assert.equal(rejectedEntry.knowledgeState, "PROVISIONAL");
  assert.deepEqual(rejectedEntry.sourceExcerpts, []);
  assert.deepEqual(rejectedEntry.sourceTerms, []);

  const modified = await observedFile({ rootId: r.id, sessionId: s.id, path: "modified.txt",
    checksum: "tie-modified", evidence: evidence("Original review wording"), status: "MODIFIED" });
  await prisma.humanDecision.createMany({ data: [
    { id: "tie-decision-a", observationSessionId: modified.observation.id, decisionType: "MODIFY",
      editedSuggestion: "obsolete correction", createdAt: tiedAt },
    { id: "tie-decision-z", observationSessionId: modified.observation.id, decisionType: "MODIFY",
      editedSuggestion: "deterministic latest correction", createdAt: tiedAt },
  ] });
  await indexFiles(s.id, [rejected, modified]);
  const first = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: modified.file.id } });
  assert.ok(first.reviewedTerms.includes("latest"));
  assert.ok(!first.reviewedTerms.includes("obsolete"));
  await indexFiles(s.id, [rejected, modified]);
  const second = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: modified.file.id } });
  assert.equal(second.fingerprint, first.fingerprint);
  assert.deepEqual(second.reviewedTerms, first.reviewedTerms);
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
  assert.equal(first.claimedFiles, 20);
  assert.equal(first.processedFiles, 20);
  assert.equal(first.waitingForClaims, false);
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

test("Prepare Search continues on processed batches and stops normally when complete", async () => {
  const r = await root("Client continuation Root"); const s = await session(r.id);
  await prisma.scannedFile.createMany({ data: Array.from({ length: 43 }, (_, i) => ({
    sessionId: s.id, localPath: `bridge://${r.id}/client-${i}.txt`, relativePath: `client-${i}.txt`,
    fileType: "TEXT", checksum: `synthetic-${i}`, extractionStatus: "COMPLETED", readingStatus: "READ",
  })) });
  const retryFlags: boolean[] = [];
  const remaining: number[] = [];
  const result = await runSearchPreparationBatches(async (retryFailed) => {
    retryFlags.push(retryFailed);
    assert.ok(retryFlags.length <= 3, "Preparation must stop after completion");
    return backfill.prepareSearchBatch(s.id, retryFailed, async () => "INDEXED");
  }, (progress) => remaining.push(progress.remaining));
  assert.deepEqual(retryFlags, [true, false, false]);
  assert.deepEqual(remaining, [23, 3, 0]);
  assert.equal(result.completed, true);
  assert.equal(result.processedFiles, 3);
  assert.equal(await prisma.bridgeCommand.count(), 0);
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
  let requests = 0;
  const tab = () => runSearchPreparationBatches(async (retryFailed) => {
    requests += 1;
    assert.ok(requests <= 2, "Waiting tabs must not hot-loop");
    return backfill.prepareSearchBatch(s.id, retryFailed, async () => {
      processCount += 1;
      return "INDEXED";
    });
  }, () => undefined);
  const [concurrent, otherTab] = await Promise.all([tab(), tab()]);
  assert.equal(requests, 2);
  assert.equal(concurrent.remaining, 1);
  assert.equal(concurrent.claimedFiles, 0);
  assert.equal(concurrent.processedFiles, 0);
  assert.equal(concurrent.waitingForClaims, true);
  assert.equal(otherTab.waitingForClaims, true);
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
  assert.equal(resumed.claimedFiles, 1);
  assert.equal(resumed.processedFiles, 1);
  assert.equal(resumed.waitingForClaims, false);
  assert.equal(resumed.reused, 1);
  assert.equal(processCount, 2);
});

test("live search claims do not hide available work past the bounded candidate window", async () => {
  const r = await root("Claim window Root"); const s = await session(r.id);
  await prisma.scannedFile.createMany({ data: Array.from({ length: 61 }, (_, i) => ({
    id: `claim-window-${i.toString().padStart(3, "0")}`, sessionId: s.id,
    localPath: `bridge://${r.id}/file-${i}.txt`, relativePath: `file-${i}.txt`, fileType: "TEXT",
    checksum: `synthetic-${i}`, extractionStatus: "COMPLETED", readingStatus: "READ",
  })) });
  await prisma.librarySearchBackfillFile.createMany({ data: Array.from({ length: 60 }, (_, i) => ({
    scannedFileId: `claim-window-${i.toString().padStart(3, "0")}`, scanSessionId: s.id,
    indexVersion: indexer.librarySearchIndexVersion, status: "PROCESSING",
  })) });
  const result = await backfill.prepareSearchBatch(s.id, false, async () => "INDEXED");
  assert.equal(result.claimedFiles, 1);
  assert.equal(result.processedFiles, 1);
  assert.equal(result.remaining, 60);
  const waiting = await backfill.prepareSearchBatch(s.id);
  assert.equal(waiting.claimedFiles, 0);
  assert.equal(waiting.processedFiles, 0);
  assert.equal(waiting.waitingForClaims, true);
});

test("Prepare Search stops on zero saved progress even if a claim was acquired", async () => {
  let requests = 0;
  const result = await runSearchPreparationBatches(async () => {
    requests += 1;
    assert.equal(requests, 1);
    return { indexed: 0, reused: 0, failed: 0, remaining: 1, completed: false,
      claimedFiles: 1, processedFiles: 0, waitingForClaims: false };
  }, () => undefined);
  assert.equal(result.remaining, 1);
  assert.equal(requests, 1);
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

test("identity decision APIs immediately refresh affected search hashes and preserve idempotent history", async () => {
  const r = await root("Correction API Root"); const s = await session(r.id);
  const a = await observedFile({ rootId: r.id, sessionId: s.id, path: "Alice/intake.txt", evidence: evidence("Client Alice intake") });
  const b = await observedFile({ rootId: r.id, sessionId: s.id, path: "Notes/followup.txt", evidence: evidence("Followup appointments") });
  const unrelated = await observedFile({ rootId: r.id, sessionId: s.id, path: "Other/client.txt", evidence: evidence("Client Alice unrelated") });
  const signals = [];
  for (const [i, item] of [a, b, unrelated].entries()) {
    signals.push(await prisma.knowledgeDocumentSignal.create({ data: {
      checksum: item.file.checksum!, connectedLibraryId: r.id,
      fileKey: fileKey.persistentFileKey(r.id, item.file.relativePath),
      generationVersion: documentSignalVersion, identityHash: `client-${i}`, kind: "CLIENT",
      observationSessionId: item.observation.id, relativePath: item.file.relativePath,
      signalKey: crypto.randomUUID(), sourceRanges: [],
    } }));
  }
  await indexFiles(s.id, [a, b, unrelated]);
  const beforeUnrelated = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: unrelated.file.id } });
  const cache = createRequire(path.resolve("package.json"))("next/cache") as typeof import("next/cache");
  const revalidation = mock.method(cache, "revalidatePath", () => undefined);
  try {
    const correctionRoute = await import("../../src/app/api/library/knowledge/document-relationships/correction/route");
    const decisionRoute = await import("../../src/app/api/library/knowledge/document-relationships/[relationshipId]/decision/route");
    const correction = await correctionRoute.POST(new Request("http://localhost/api/library/knowledge/document-relationships/correction", {
      method: "POST", body: JSON.stringify({ sourceSignalId: signals[1].id, targetSignalId: signals[0].id,
        kind: "SAME_CLIENT", note: "These two documents refer to the same client." }),
    }));
    assert.equal(correction.status, 200);
    const link = await prisma.knowledgeConnection.findFirstOrThrow({ where: {
      generationVersion: fileKey.humanIdentityCorrectionVersion, sourceFileKey: signals[1].fileKey } });
    const hashes = async () => (await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: b.file.id } })).entityHashes;
    const decide = async (action: string) => {
      const response = await decisionRoute.POST(new Request("http://localhost/decision", {
        method: "POST", body: JSON.stringify({ action, note: "Synthetic relationship review" }),
      }), { params: Promise.resolve({ relationshipId: link.id }) });
      assert.equal(response.status, 200);
    };
    assert.deepEqual(await hashes(), ["client-0"]);
    assert.ok((await search.searchLibrary("client alice", [r.id])).some((item) => item.relativePath === b.file.relativePath));
    await decide("SEPARATE");
    assert.deepEqual(await hashes(), ["client-1"]);
    assert.ok(!(await search.searchLibrary("client alice", [r.id])).some((item) => item.relativePath === b.file.relativePath));
    await decide("CONFIRM");
    assert.deepEqual(await hashes(), ["client-0"]);
    await decide("RECONSIDER");
    assert.deepEqual(await hashes(), ["client-1"]);
    await decide("CONFIRM");
    const decisions = await prisma.knowledgeConnectionDecision.count({ where: { knowledgeConnectionId: link.id } });
    await decide("CONFIRM");
    assert.equal(await prisma.knowledgeConnectionDecision.count({ where: { knowledgeConnectionId: link.id } }), decisions);
    assert.deepEqual(await hashes(), ["client-0"]);
    const afterUnrelated = await prisma.librarySearchEntry.findUniqueOrThrow({ where: { id: beforeUnrelated.id } });
    assert.equal(afterUnrelated.indexedAt.getTime(), beforeUnrelated.indexedAt.getTime());
    assert.deepEqual(afterUnrelated.entityHashes, ["client-2"]);
    assert.equal(await prisma.executionRun.count(), 0);
    assert.equal(await prisma.bridgeCommand.count(), 0);
  } finally {
    revalidation.mock.restore();
  }
});

for (const kind of ["CLIENT", "PROJECT"] as const) {
  test(`reconfirming an older ${kind} correction makes Search, QA and Knowledge use that sole correction`, async () => {
    const r = await root(`Reconfirmed ${kind} Root`); const s = await session(r.id);
    const names = kind === "CLIENT" ? ["Alice", "Beatrice"] : ["North Star", "South Moon"];
    const items: Array<Awaited<ReturnType<typeof observedFile>>> = [];
    const signals: KnowledgeDocumentSignal[] = [];
    for (const [i, text] of ["Followup appointments", ...names.map((name) => `${kind}: ${name}`)].entries()) {
      const item = await observedFile({ rootId: r.id, sessionId: s.id, path: `Records/neutral-${i}.txt`, evidence: evidence(text) });
      items.push(item);
      signals.push(await prisma.knowledgeDocumentSignal.create({ data: {
        checksum: item.file.checksum!, connectedLibraryId: r.id,
        fileKey: fileKey.persistentFileKey(r.id, item.file.relativePath),
        generationVersion: documentSignalVersion, identityHash: `reconfirm-${kind}-${i}`, kind,
        observationSessionId: item.observation.id, relativePath: item.file.relativePath,
        signalKey: crypto.randomUUID(), sourceRanges: [],
      } }));
    }
    await indexFiles(s.id, items);
    const cache = createRequire(path.resolve("package.json"))("next/cache") as typeof import("next/cache");
    const revalidation = mock.method(cache, "revalidatePath", () => undefined);
    try {
      const correctionRoute = await import("../../src/app/api/library/knowledge/document-relationships/correction/route");
      const decisionRoute = await import("../../src/app/api/library/knowledge/document-relationships/[relationshipId]/decision/route");
      const createCorrection = async (target: number) => {
        const response = await correctionRoute.POST(new Request("http://localhost/correction", {
          method: "POST", body: JSON.stringify({ sourceSignalId: signals[0].id, targetSignalId: signals[target].id,
            kind: kind === "CLIENT" ? "SAME_CLIENT" : "BELONGS_TO_PROJECT", note: "Synthetic human identity correction" }),
        }));
        assert.equal(response.status, 200);
        return prisma.knowledgeConnection.findFirstOrThrow({ where: {
          generationVersion: fileKey.humanIdentityCorrectionVersion,
          sourceFileKey: signals[0].fileKey, targetFileKey: signals[target].fileKey,
        } });
      };
      const decide = async (id: string, action: string) => {
        const response = await decisionRoute.POST(new Request("http://localhost/decision", {
          method: "POST", body: JSON.stringify({ action, note: "Synthetic reconfirmation" }),
        }), { params: Promise.resolve({ relationshipId: id }) });
        assert.equal(response.status, 200);
      };
      const a = await createCorrection(1);
      const b = await createCorrection(2);
      assert.equal((await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: a.id } })).status, "REJECTED");
      assert.equal(b.status, "CONFIRMED");
      await decide(a.id, "CONFIRM");
      const confirmed = await prisma.knowledgeConnection.findMany({ where: {
        generationVersion: fileKey.humanIdentityCorrectionVersion, sourceFileKey: signals[0].fileKey,
        status: "CONFIRMED", supersededAt: null,
      } });
      assert.deepEqual(confirmed.map((row) => row.id), [a.id]);
      assert.equal((await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: b.id } })).status, "REJECTED");
      const hashes = async () => (await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: items[0].file.id } })).entityHashes;
      assert.deepEqual(await hashes(), [signals[1].identityHash]);
      const sourcePath = items[0].file.relativePath;
      assert.ok((await search.searchLibrary(`${kind} ${names[0]}`, [r.id])).some((row) => row.relativePath === sourcePath));
      assert.ok(!(await search.searchLibrary(`${kind} ${names[1]}`, [r.id])).some((row) => row.relativePath === sourcePath));
      const qa = await import("../../src/lib/library/qa/retrieve");
      const context = await qa.retrieveQuestionContext(`What do we have about ${kind.toLowerCase()} ${names[0]}?`, [r.id]);
      assert.equal(context.ambiguousEntity, false);
      assert.ok(context.sources.some((source) => source.relativePath === sourcePath));
      assert.ok(!(await qa.retrieveQuestionContext(`What do we have about ${kind.toLowerCase()} ${names[1]}?`, [r.id]))
        .sources.some((source) => source.relativePath === sourcePath));
      const group = (await fileKey.getPersistentIdentityGroups()).find((row) => row.libraryName === r.displayName && row.kind === kind &&
        row.members.some((member) => member.fileKey === signals[0].fileKey));
      assert.ok(group?.humanConfirmed);
      assert.deepEqual(new Set(group.members.map((member) => member.fileKey)), new Set([signals[0].fileKey, signals[1].fileKey]));
      const ui = await fileKey.getRecentPersistentFileRelationships();
      assert.equal(ui.find((row) => row.id === a.id)?.status, "CONFIRMED");
      assert.equal(ui.find((row) => row.id === b.id)?.status, "REJECTED");
      const decisions = await prisma.knowledgeConnectionDecision.count({ where: { knowledgeConnectionId: { in: [a.id, b.id] } } });
      await decide(a.id, "CONFIRM");
      assert.equal(await prisma.knowledgeConnectionDecision.count({ where: { knowledgeConnectionId: { in: [a.id, b.id] } } }), decisions);
      assert.deepEqual(await hashes(), [signals[1].identityHash]);
      await createCorrection(2);
      await createCorrection(1);
      assert.deepEqual(await hashes(), [signals[1].identityHash]);
      assert.equal((await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: b.id } })).status, "REJECTED");
      await decide(a.id, "SEPARATE");
      assert.deepEqual(await hashes(), [signals[0].identityHash]);
      await decide(a.id, "CONFIRM");
      await decide(a.id, "RECONSIDER");
      assert.deepEqual(await hashes(), [signals[0].identityHash]);
      const results = await Promise.all([a.id, b.id].map((id) => decisionRoute.POST(new Request("http://localhost/decision", {
        method: "POST", body: JSON.stringify({ action: "CONFIRM" }),
      }), { params: Promise.resolve({ relationshipId: id }) })));
      assert.ok(results.every((response) => [200, 409].includes(response.status)));
      assert.ok(results.some((response) => response.status === 200));
      const winner = await prisma.knowledgeConnection.findMany({ where: {
        generationVersion: fileKey.humanIdentityCorrectionVersion, sourceFileKey: signals[0].fileKey,
        status: "CONFIRMED", supersededAt: null,
      } });
      assert.equal(winner.length, 1);
      assert.deepEqual(await hashes(), [winner[0].id === a.id ? signals[1].identityHash : signals[2].identityHash]);
      assert.equal(await prisma.executionRun.count(), 0);
      assert.equal(await prisma.bridgeCommand.count(), 0);
    } finally {
      revalidation.mock.restore();
    }
  });
}

test("returned system-archived identities and versions become current and reviewable in Search, QA and Knowledge", async () => {
  const r = await root("Restored relationship Root");
  const snapshot = async (supported: boolean) => {
    const s = await session(r.id);
    const files = [];
    for (const i of [0, 1]) {
      const text = supported || i === 1
        ? `Client ID: C-912; Project ID: P-11; Document ID: D-1; Document Title: Quarterly Review; Version: v${i + 1}`
        : "Unrelated reminders without identity or version evidence.";
      files.push(await observedFile({ rootId: r.id, sessionId: s.id, path: `Reports/quarterly-v${i + 1}.txt`,
        checksum: !supported && i === 0 ? "c".repeat(64) : (i === 0 ? "a" : "b").repeat(64), evidence: evidence(text) }));
    }
    const index = { clusters: [], files: files.map((item) => item.working), relationships: [], scanSessionId: s.id };
    await fileKey.persistScanWorkingKnowledge(index);
    await indexer.indexScanKnowledge(index);
    return { files, index };
  };
  const first = await snapshot(true);
  const originals = await prisma.knowledgeConnection.findMany({ where: {
    generationVersion: documentSignalVersion, sourceEvidence: { path: ["connectedLibraryId"], equals: r.id },
  } });
  assert.deepEqual(new Set(originals.map((row) => row.relationshipKind)), new Set(["SAME_CLIENT", "SAME_PROJECT", "PROBABLE_REVISION"]));
  const initialEntry = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: first.files[0].file.id } });
  await snapshot(false);
  for (const row of originals) {
    const archived = await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(archived.status, "ARCHIVED");
    assert.ok(archived.supersededAt);
    assert.equal((await fileKey.getRecentPersistentFileRelationships()).find((item) => item.id === row.id)?.reviewable, false);
  }
  const restored = await snapshot(true);
  const ui = await fileKey.getRecentPersistentFileRelationships();
  for (const old of originals) {
    const current = await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: old.id } });
    assert.equal(current.status, "NEW");
    assert.equal(current.supersededAt, null);
    assert.equal(current.relationshipKey, old.relationshipKey);
    assert.deepEqual(new Set([current.sourceObservationSessionId, current.targetObservationSessionId]),
      new Set(restored.files.map((item) => item.observation.id)));
    assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKey: old.relationshipKey } }), 1);
    assert.equal(ui.find((item) => item.id === old.id)?.reviewable, true);
    assert.equal(ui.find((item) => item.id === old.id)?.status, "NEW");
  }
  const currentEntry = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: restored.files[0].file.id } });
  assert.equal(currentEntry.id, initialEntry.id);
  assert.deepEqual(currentEntry.entityHashes, initialEntry.entityHashes);
  const groups = await fileKey.getPersistentIdentityGroups();
  assert.ok(groups.some((group) => group.libraryName === r.displayName && group.kind === "CLIENT" && group.members.length === 2));
  assert.ok(groups.some((group) => group.libraryName === r.displayName && group.kind === "DOCUMENT_FAMILY" && group.members.length === 2));
  const qa = await import("../../src/lib/library/qa/retrieve");
  const context = await qa.retrieveQuestionContext("What changed between Quarterly Review versions?", [r.id]);
  assert.equal(context.relationships.length, originals.length);
  assert.ok(context.relationships.every((row) => row.status === "PROVISIONAL"));
  assert.equal(context.versions[0]?.ordering, "ORDERED");
  assert.equal(await prisma.bridgeCommand.count(), 0);
});

test("human-rejected relationships remain rejected when equivalent evidence returns", async () => {
  const r = await root("Rejected returning evidence Root");
  const snapshot = async (supported: boolean) => {
    const s = await session(r.id);
    const files = [];
    for (const i of [0, 1]) files.push(await observedFile({ rootId: r.id, sessionId: s.id, path: `client-${i}.txt`,
      checksum: (i === 0 ? "d" : "e").repeat(64), evidence: evidence(supported ? "Client ID: C-913" : "Unrelated note") }));
    const index = { clusters: [], files: files.map((item) => item.working), relationships: [], scanSessionId: s.id };
    await fileKey.persistScanWorkingKnowledge(index);
    await indexer.indexScanKnowledge(index);
    return files;
  };
  await snapshot(true);
  const original = await prisma.knowledgeConnection.findFirstOrThrow({ where: {
    relationshipKind: "SAME_CLIENT", sourceEvidence: { path: ["connectedLibraryId"], equals: r.id },
  } });
  await fileKey.reviewPersistentRelationship(original.id, "SEPARATE", "Human review: these clients must stay separate.");
  await snapshot(false);
  const restored = await snapshot(true);
  const current = await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: original.id }, include: { decisions: true } });
  assert.equal(current.status, "REJECTED");
  assert.equal(current.decisions.length, 1);
  assert.equal(current.decisions[0].action, "SEPARATE");
  assert.match(current.decisions[0].note!, /must stay separate/);
  assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKey: original.relationshipKey } }), 1);
  assert.deepEqual(new Set([current.sourceObservationSessionId, current.targetObservationSessionId]),
    new Set(restored.map((item) => item.observation.id)));
  assert.equal((await fileKey.getRecentPersistentFileRelationships()).find((item) => item.id === original.id)?.status, "REJECTED");
  assert.ok(!(await fileKey.getPersistentIdentityGroups()).some((group) => group.libraryName === r.displayName && group.kind === "CLIENT" && group.members.length > 1));
  const qa = await import("../../src/lib/library/qa/retrieve");
  assert.deepEqual((await qa.retrieveQuestionContext("Client C-913", [r.id])).relationships, []);
  assert.equal(await prisma.bridgeCommand.count(), 0);
});

async function canonicalMoveFixture(actionType: "MOVE_FILE" | "RENAME_FILE", options: {
  originalPath?: string; destination?: string; fileType?: string;
} = {}) {
  const r = await root(`Canonical ${actionType} Root`); const s = await session(r.id);
  await prisma.scanSession.update({ where: { id: s.id }, data: { searchIndexStatus: "COMPLETED" } });
  const originalPath = options.originalPath ?? "Loose/intake-v1.txt";
  const destination = options.destination ?? (actionType === "MOVE_FILE" ? "Clients/intake-v1.txt" : "Loose/renamed-v1.txt");
  const descriptions = [
    { path: originalPath, checksum: "a".repeat(64), text: "Client ID: C-111; Project ID: P-111; Document ID: D-42; Document Title: Annual Plan; Version: v1" },
    { path: "Versions/annual-v2.txt", checksum: "b".repeat(64), text: "Client ID: C-111; Project ID: P-111; Document ID: D-42; Document Title: Annual Plan; Version: v2" },
    { path: "Alice/profile.txt", checksum: "c".repeat(64), text: "Client: Alice; Client ID: C-222; Project ID: P-222" },
  ];
  const files = [];
  for (const [i, item] of descriptions.entries()) files.push(await observedFile({ rootId: r.id, sessionId: s.id,
    path: item.path, checksum: item.checksum, evidence: evidence(item.text), fileType: i === 0 ? options.fileType : undefined }));
  const index = { clusters: [], files: files.map((item) => item.working), relationships: [], scanSessionId: s.id };
  await fileKey.persistScanWorkingKnowledge(index);
  await indexFiles(s.id, files);
  for (const kind of ["CLIENT", "PROJECT"] as const) {
    const source = await prisma.knowledgeDocumentSignal.findFirstOrThrow({ where: {
      connectedLibraryId: r.id, relativePath: originalPath, kind } });
    const target = await prisma.knowledgeDocumentSignal.findFirstOrThrow({ where: {
      connectedLibraryId: r.id, relativePath: descriptions[2].path, kind } });
    await fileKey.createIdentityCorrection({ sourceSignalId: source.id, targetSignalId: target.id,
      kind: kind === "CLIENT" ? "SAME_CLIENT" : "BELONGS_TO_PROJECT", note: "Synthetic verified human correction" });
  }
  await indexFiles(s.id, files);
  const initialEntry = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: files[0].file.id } });
  const revision = await prisma.knowledgeConnection.findFirstOrThrow({ where: {
    relationshipKind: "PROBABLE_REVISION", sourceFileKey: { in: [initialEntry.fileKey,
      fileKey.persistentFileKey(r.id, descriptions[1].path)] },
  } });
  const plan = await prisma.organizationPlan.create({ data: {
    connectedLibraryId: r.id, scanSessionId: s.id, createdBy: "isolated-test",
    status: "EXECUTED", totalActions: 1, actions: [], warnings: [], skippedItems: [], history: [],
  } });
  const execution = await prisma.executionRun.create({ data: {
    organizationPlanId: plan.id, connectedLibraryId: r.id, status: "COMPLETED",
    completedAt: new Date(), totalActions: 1, completedActions: 1, successfulActions: 1,
    actions: { create: { actionType, sourceRelativePath: originalPath, destinationRelativePath: destination,
      sourceChecksumBefore: descriptions[0].checksum, destinationChecksumAfter: descriptions[0].checksum,
      status: "COMPLETED", sequence: 1, completedAt: new Date() } },
  }, include: { actions: true } });
  return { r, s, files, descriptions, originalPath, destination, initialEntry, execution, revision };
}

async function indexMovedSnapshot(fixture: Awaited<ReturnType<typeof canonicalMoveFixture>>, currentPath: string, includeCopy = false, fileType?: string) {
  const s = await session(fixture.r.id);
  await prisma.scanSession.update({ where: { id: s.id }, data: { searchIndexStatus: "COMPLETED" } });
  const files = [];
  const descriptions = fixture.descriptions.map((item, i) => ({ ...item, path: i === 0 ? currentPath : item.path }));
  if (includeCopy) descriptions.push({ ...fixture.descriptions[0], path: "Copies/intake-copy.txt" });
  for (const [i, item] of descriptions.entries()) files.push(await observedFile({ rootId: fixture.r.id, sessionId: s.id,
    path: item.path, checksum: item.checksum, evidence: evidence(item.text), fileType: i === 0 ? fileType : undefined }));
  const index = { clusters: [], files: files.map((item) => item.working), relationships: [], scanSessionId: s.id };
  await fileKey.persistScanWorkingKnowledge(index);
  const stats = { reused: 0 };
  await indexer.indexScanKnowledge(index, files.map((item) => item.file.id), stats);
  const entry = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: files[0].file.id } });
  return { s, files, index, entry, stats };
}

for (const actionType of ["MOVE_FILE", "RENAME_FILE"] as const) {
  test(`an executed ${actionType} refreshes canonical relationship evidence and keeps review history`, async () => {
    const fixture = await canonicalMoveFixture(actionType);
    await fileKey.reviewPersistentRelationship(fixture.revision.id, "CONFIRM", "Keep this version relationship.");
    const before = await prisma.knowledgeConnection.findMany({ where: {
      OR: [{ sourceFileKey: fixture.initialEntry.fileKey }, { targetFileKey: fixture.initialEntry.fileKey }], supersededAt: null,
    } });
    const next = await indexMovedSnapshot(fixture, fixture.destination);
    const ui = await fileKey.getRecentPersistentFileRelationships();
    for (const old of before) {
      const current = await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: old.id } });
      assert.equal(current.relationshipKey, old.relationshipKey);
      assert.equal(current.status, old.status);
      assert.equal(current.supersededAt, null);
      const refs = current.sourceEvidence as Record<string, unknown>;
      const source = next.files.find((item) => fileKey.persistentFileKey(fixture.r.id,
        item.file.relativePath === fixture.destination ? fixture.originalPath : item.file.relativePath) === current.sourceFileKey);
      const target = next.files.find((item) => fileKey.persistentFileKey(fixture.r.id,
        item.file.relativePath === fixture.destination ? fixture.originalPath : item.file.relativePath) === current.targetFileKey);
      assert.ok(source); assert.ok(target);
      assert.equal(refs.sourceRelativePath, source.file.relativePath);
      assert.equal(refs.targetRelativePath, target.file.relativePath);
      assert.equal(current.sourceObservationSessionId, source.observation.id);
      assert.equal(current.targetObservationSessionId, target.observation.id);
      const history = refs.previousSnapshots as Array<Record<string, unknown>>;
      assert.equal(history.length, 1);
      assert.deepEqual(history[0].evidence, old.sourceEvidence);
      assert.equal(history[0].sourceObservationSessionId, old.sourceObservationSessionId);
      assert.equal(history[0].targetObservationSessionId, old.targetObservationSessionId);
      assert.equal(ui.find((row) => row.id === old.id)?.reviewable, true);
      await fileKey.reviewPersistentRelationship(old.id, "CONFIRM");
      assert.equal(await prisma.knowledgeConnection.count({ where: { relationshipKey: old.relationshipKey } }), 1);
    }
    const decisions = await prisma.knowledgeConnectionDecision.count({ where: { knowledgeConnectionId: fixture.revision.id } });
    assert.equal(decisions, 1);
    await fileKey.persistScanWorkingKnowledge(next.index);
    assert.equal(((await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: fixture.revision.id } })).sourceEvidence as Record<string, unknown>)
      .previousSnapshots instanceof Array, true);
    assert.equal((((await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: fixture.revision.id } })).sourceEvidence as Record<string, unknown>)
      .previousSnapshots as unknown[]).length, 1);
    assert.equal(await prisma.bridgeCommand.count(), 0);
  });

  test(`an executed ${actionType} keeps canonical search identity, human corrections, versions and QA context`, async () => {
    const fixture = await canonicalMoveFixture(actionType);
    assert.equal(fixture.initialEntry.fileKey, fileKey.persistentFileKey(fixture.r.id, fixture.originalPath));
    const next = await indexMovedSnapshot(fixture, fixture.destination);
    assert.equal(next.entry.fileKey, fixture.initialEntry.fileKey);
    assert.equal(next.entry.id, fixture.initialEntry.id);
    assert.equal(next.entry.relativePath, fixture.destination);
    assert.equal(next.entry.fileName, path.posix.basename(fixture.destination));
    assert.deepEqual(next.entry.entityHashes, fixture.initialEntry.entityHashes);
    assert.equal(next.stats.reused, 3);
    const signals = await fileKey.getEffectiveDocumentSignals([fixture.r.id]);
    for (const kind of ["CLIENT", "PROJECT", "DOCUMENT_FAMILY"]) {
      assert.ok(signals.some((signal) => signal.fileKey === next.entry.fileKey && signal.kind === kind));
    }
    assert.equal(await prisma.knowledgeConnection.count({ where: { id: fixture.revision.id, supersededAt: null } }), 1);
    const expanded = await search.searchLibrary("client alice", [fixture.r.id]);
    assert.ok(expanded.some((result) => result.relativePath === fixture.destination));
    const qa = await import("../../src/lib/library/qa/retrieve");
    const client = await qa.retrieveQuestionContext("What do we have about client Alice?", [fixture.r.id]);
    assert.equal(client.ambiguousEntity, false);
    assert.ok(client.sources.some((source) => source.relativePath === fixture.destination));
    const versions = await qa.retrieveQuestionContext("What changed between Annual Plan versions?", [fixture.r.id]);
    assert.equal(versions.versions[0]?.ordering, "ORDERED");
    const latest = versions.sources.find((source) => source.id === versions.versions[0]?.newerSourceId);
    assert.equal(latest?.relativePath, fixture.descriptions[1].path);
    assert.equal(await prisma.bridgeCommand.count(), 0);
  });
}

test("extension-changing NSN renames refresh reused search metadata and type filters without losing identity", async () => {
  const fixture = await canonicalMoveFixture("RENAME_FILE", {
    originalPath: "Loose/intake-v1.docx", destination: "Loose/intake-v1.html", fileType: "DOCX",
  });
  assert.equal(fixture.initialEntry.fileType, "DOCX");
  assert.ok((await search.searchLibrary("client Alice docx", [fixture.r.id])).some((item) => item.id === fixture.initialEntry.id));
  const next = await indexMovedSnapshot(fixture, fixture.destination, false, "HTML");
  assert.equal(next.stats.reused, 3);
  assert.equal(next.entry.id, fixture.initialEntry.id);
  assert.equal(next.entry.fileKey, fixture.initialEntry.fileKey);
  assert.equal(next.entry.checksum, fixture.initialEntry.checksum);
  assert.equal(next.entry.fingerprint, fixture.initialEntry.fingerprint);
  assert.equal(next.entry.relativePath, fixture.destination);
  assert.equal(next.entry.fileName, "intake-v1.html");
  assert.equal(next.entry.fileType, "HTML");
  assert.deepEqual(next.entry.entityHashes, fixture.initialEntry.entityHashes);
  assert.equal(await prisma.librarySearchEntry.count({ where: { fileKey: fixture.initialEntry.fileKey } }), 1);
  assert.ok(!(await search.searchLibrary("client Alice docx", [fixture.r.id])).some((item) => item.id === next.entry.id));
  const result = (await search.searchLibrary("client Alice html", [fixture.r.id])).find((item) => item.id === next.entry.id);
  assert.equal(result?.fileType, "HTML");
  assert.equal(result?.relativePath, fixture.destination);
  assert.equal((await fileKey.getRecentPersistentFileRelationships()).find((row) => row.id === fixture.revision.id)?.reviewable, true);
  const qa = await import("../../src/lib/library/qa/retrieve");
  assert.ok((await qa.retrieveQuestionContext("What do we have about client Alice?", [fixture.r.id]))
    .sources.some((source) => source.relativePath === fixture.destination));
  assert.equal((await qa.retrieveQuestionContext("What changed between Annual Plan versions?", [fixture.r.id])).versions[0]?.ordering, "ORDERED");
  await prisma.librarySearchEntry.update({ where: { id: next.entry.id }, data: { fileType: "DOCX" } });
  const stats = { reused: 0 };
  await indexer.indexScanKnowledge(next.index, [next.files[0].file.id], stats);
  assert.equal(stats.reused, 1);
  assert.equal((await prisma.librarySearchEntry.findUniqueOrThrow({ where: { id: next.entry.id } })).fileType, "HTML");
  assert.equal(await prisma.bridgeCommand.count(), 0);
});

test("targeted reindexing retires a legacy path-key entry without a full-library rebuild", async () => {
  const fixture = await canonicalMoveFixture("MOVE_FILE");
  const moved = await indexMovedSnapshot(fixture, fixture.destination);
  const legacy = await prisma.librarySearchEntry.create({ data: {
    entryKey: crypto.randomUUID(), fileKey: fileKey.persistentFileKey(fixture.r.id, fixture.destination),
    checksum: moved.entry.checksum, connectedLibraryId: fixture.r.id,
    scannedFileId: moved.files[0].file.id, scanSessionId: moved.s.id,
    relativePath: fixture.destination, fileName: path.posix.basename(fixture.destination),
    fileType: "TEXT", indexVersion: indexer.librarySearchIndexVersion, fingerprint: "legacy-path-key",
    knowledgeState: "PROVISIONAL",
    entityHashes: [], concepts: [], reviewedTerms: [], sourceTerms: [], sourceExcerpts: [],
  } });
  const peerBefore = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: moved.files[1].file.id } });
  assert.equal(await indexer.indexScanKnowledge(moved.index, [moved.files[0].file.id]), 1);
  assert.equal((await prisma.librarySearchEntry.findUniqueOrThrow({ where: { id: legacy.id } })).isCurrent, false);
  assert.equal(await prisma.librarySearchEntry.count({ where: { scannedFileId: moved.files[0].file.id, isCurrent: true } }), 1);
  const current = await prisma.librarySearchEntry.findUniqueOrThrow({ where: { id: fixture.initialEntry.id } });
  assert.equal(current.isCurrent, true);
  assert.deepEqual(current.entityHashes, fixture.initialEntry.entityHashes);
  assert.equal((await prisma.librarySearchEntry.findUniqueOrThrow({ where: { id: peerBefore.id } })).indexedAt.getTime(), peerBefore.indexedAt.getTime());
  assert.equal(await prisma.bridgeCommand.count(), 0);
});

test("Undo restores the original canonical entry without creating a duplicate identity", async () => {
  const fixture = await canonicalMoveFixture("RENAME_FILE");
  await indexMovedSnapshot(fixture, fixture.destination);
  await prisma.undoRun.create({ data: { executionRunId: fixture.execution.id, status: "COMPLETED",
    completedAt: new Date(), totalActions: 1, completedActions: 1,
    actions: { create: { originalExecutionActionId: fixture.execution.actions[0].id,
      actionType: "RESTORE_FILE", sourceRelativePath: fixture.destination,
      destinationRelativePath: fixture.originalPath, sequence: 1, status: "COMPLETED", completedAt: new Date() } },
  } });
  const restored = await indexMovedSnapshot(fixture, fixture.originalPath);
  assert.equal(restored.entry.id, fixture.initialEntry.id);
  assert.equal(restored.entry.fileKey, fixture.initialEntry.fileKey);
  assert.equal(restored.entry.relativePath, fixture.originalPath);
  assert.equal(restored.entry.fileName, path.posix.basename(fixture.originalPath));
  assert.deepEqual(restored.entry.entityHashes, fixture.initialEntry.entityHashes);
  assert.equal(await prisma.librarySearchEntry.count({ where: { fileKey: fixture.initialEntry.fileKey } }), 1);
  const relationships = await fileKey.getRecentPersistentFileRelationships();
  const revision = relationships.find((row) => row.id === fixture.revision.id);
  assert.equal(revision?.reviewable, true);
  assert.ok([revision.sourceRelativePath, revision.targetRelativePath].includes(fixture.originalPath));
  assert.ok(![revision.sourceRelativePath, revision.targetRelativePath].includes(fixture.destination));
  const row = await prisma.knowledgeConnection.findUniqueOrThrow({ where: { id: fixture.revision.id } });
  const snapshots = (row.sourceEvidence as Record<string, unknown>).previousSnapshots as Array<{ evidence: Record<string, unknown> }>;
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots.some((snapshot) => [snapshot.evidence.sourceRelativePath, snapshot.evidence.targetRelativePath].includes(fixture.destination)));
  assert.equal(fileKey.fileKeyAfterKnownMoves(fixture.r.id, fixture.destination,
    fixture.descriptions[0].checksum, await fileKey.knownExecutedMoves(fixture.r.id)),
    fileKey.persistentFileKey(fixture.r.id, fixture.destination));
  assert.equal(await prisma.bridgeCommand.count(), 0);
});

test("exact copies stay distinct and untracked renames cannot inherit canonical human corrections", async () => {
  const fixture = await canonicalMoveFixture("MOVE_FILE");
  const moved = await indexMovedSnapshot(fixture, fixture.destination, true);
  const copy = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: moved.files[3].file.id } });
  assert.equal(copy.checksum, moved.entry.checksum);
  assert.notEqual(copy.fileKey, moved.entry.fileKey);
  assert.notEqual(copy.id, moved.entry.id);
  assert.ok(!(copy.entityHashes as string[]).includes((await prisma.knowledgeDocumentSignal.findFirstOrThrow({
    where: { connectedLibraryId: fixture.r.id, relativePath: fixture.descriptions[2].path, kind: "CLIENT" },
  })).identityHash));
  const external = await indexMovedSnapshot(fixture, "External/untracked-intake.txt");
  assert.equal(external.entry.fileKey, fileKey.persistentFileKey(fixture.r.id, external.entry.relativePath));
  assert.notEqual(external.entry.fileKey, fixture.initialEntry.fileKey);
  const qa = await import("../../src/lib/library/qa/retrieve");
  assert.ok(!(await qa.retrieveQuestionContext("What do we have about client Alice?", [fixture.r.id]))
    .sources.some((source) => source.relativePath === external.entry.relativePath));
  const oldRelationship = (await fileKey.getRecentPersistentFileRelationships()).find((row) => row.id === fixture.revision.id);
  assert.equal(oldRelationship?.reviewable, false);
  assert.equal(oldRelationship?.status, "ARCHIVED");
  assert.equal(await prisma.bridgeCommand.count(), 0);
});

test("executed aliases are root-scoped and revoked or disconnected roots cannot index moved knowledge", async () => {
  const fixture = await canonicalMoveFixture("MOVE_FILE");
  const other = await root("Unrelated alias root"); const s = await session(other.id);
  const sameBytes = await observedFile({ rootId: other.id, sessionId: s.id, path: fixture.destination,
    checksum: fixture.descriptions[0].checksum, evidence: evidence("An independent file") });
  await indexFiles(s.id, [sameBytes]);
  assert.equal((await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: sameBytes.file.id } })).fileKey,
    fileKey.persistentFileKey(other.id, fixture.destination));
  const moved = await indexMovedSnapshot(fixture, fixture.destination);
  for (const data of [{ readPermission: false }, { readPermission: true, status: "DISCONNECTED" as const }]) {
    await prisma.connectedLibrary.update({ where: { id: fixture.r.id }, data });
    assert.equal(await indexer.indexScanKnowledge(moved.index, [moved.files[0].file.id]), 0);
    assert.deepEqual(await search.searchLibrary("client alice", [fixture.r.id]), []);
    const qa = await import("../../src/lib/library/qa/retrieve");
    assert.deepEqual((await qa.retrieveQuestionContext("client Alice", [fixture.r.id])).sources, []);
  }
});

test("multiword client and project parsing preserves phrases and stops at filters", () => {
  for (const [query, expected] of [
    ["client Alice Smith", "alice smith"], ["project North Star", "north star"],
    ["client named Alice Smith with invoices", "alice smith"],
    ["project North Star pdf files", "north star"], ["client Alice", "alice"],
  ]) assert.equal(search.parseSearchIntent(query).entityName, expected);
});

for (const [kind, wanted, other] of [["client", "Alice Smith", "Alice Jones"], ["project", "North Star", "North Wind"]]) {
  test(`full ${kind} phrase does not expand a same-prefix identity`, async () => {
    const r = await root(`Multiword ${kind}`); const s = await session(r.id);
    const items: Array<Awaited<ReturnType<typeof observedFile>>> = [];
    for (const [index, name] of [wanted, other, `${wanted}son`].entries()) {
      const item = await observedFile({ rootId: r.id, sessionId: s.id, path: `neutral-${index}.txt`,
        evidence: evidence(`${kind}: ${name}; ${kind} ID: ID-${index}`) });
      await prisma.knowledgeDocumentSignal.create({ data: {
        checksum: item.file.checksum!, connectedLibraryId: r.id,
        fileKey: fileKey.persistentFileKey(r.id, item.file.relativePath),
        generationVersion: documentSignalVersion, identityHash: `multiword-${kind}-${index}`,
        kind: kind.toUpperCase(), observationSessionId: item.observation.id,
        relativePath: item.file.relativePath, signalKey: crypto.randomUUID(), sourceRanges: [],
      } });
      items.push(item);
    }
    await indexFiles(s.id, items);
    const results = await search.searchLibrary(`${kind} ${wanted}`, [r.id]);
    assert.ok(results.some((result) => result.relativePath === items[0].file.relativePath));
    assert.ok(!results.some((result) => result.relativePath === items[1].file.relativePath));
    assert.ok(!results.some((result) => result.relativePath === items[2].file.relativePath));
  });
}

test("Prepare Search keeps the completed snapshot during incomplete scans and advances only on completion", async () => {
  const headers = createRequire(path.resolve("package.json"))("next/headers");
  const { createHumanSessionToken } = await import("../../src/lib/auth/token");
  const oldSecret = process.env.AUTH_SECRET; const oldUsers = process.env.NSN_AUTH_ALLOWED_USERS_JSON;
  process.env.AUTH_SECRET = "synthetic-search-authorization-secret-12345678";
  const user = { email: "test@example.invalid", name: "Synthetic tester", role: "OWNER" as const, googleSubject: "test-subject" };
  process.env.NSN_AUTH_ALLOWED_USERS_JSON = JSON.stringify([user]);
  const token = createHumanSessionToken(user, { ...user, picture: null });
  const cookieMock = mock.method(headers, "cookies", async () => ({ get: () => ({ value: token }) }));
  try {
    const route = await import("../../src/app/api/library/search/index/route");
    const r = await root("Search preparation snapshots"); const old = await session(r.id);
    const newer = await prisma.scanSession.create({ data: { connectedFolderId: r.id, status: "PENDING",
      startedAt: new Date(old.startedAt.getTime() + 10_000) } });
    const get = (id: string) => route.GET(new Request(`https://example.invalid/api/library/search/index?sessionId=${id}`));
    const post = (id: string) => route.POST(new Request("https://example.invalid/api/library/search/index", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }),
    }));
    for (const status of ["PENDING", "SCANNING", "READING", "EXAMINING", "GENERATING_SUGGESTIONS", "FAILED"] as const) {
      await prisma.scanSession.update({ where: { id: newer.id }, data: { status } });
      assert.equal((await get(old.id)).status, 200);
      assert.equal((await post(old.id)).status, 200);
      assert.equal((await post(newer.id)).status, 404);
    }
    await prisma.scanSession.update({ where: { id: newer.id }, data: { status: "COMPLETED_WITH_ERRORS" } });
    assert.equal((await post(newer.id)).status, 200);
    assert.equal((await get(old.id)).status, 404);
    await prisma.connectedLibrary.update({ where: { id: r.id }, data: { readPermission: false } });
    assert.equal((await post(newer.id)).status, 404);
    assert.equal(await prisma.bridgeCommand.count({ where: { payload: { path: ["scanSessionId"], equals: newer.id } } }), 0);
  } finally {
    cookieMock.mock.restore();
    if (oldSecret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = oldSecret;
    if (oldUsers === undefined) delete process.env.NSN_AUTH_ALLOWED_USERS_JSON; else process.env.NSN_AUTH_ALLOWED_USERS_JSON = oldUsers;
  }
});

test("corrected Memory retires obsolete contributions immediately while preserving audit and unrelated Memory", async () => {
  const r = await root("Corrected Memory"); const s = await session(r.id);
  const item = await observedFile({ rootId: r.id, sessionId: s.id, path: "corrected.txt", status: "APPROVED" });
  const unrelated = await observedFile({ rootId: r.id, sessionId: s.id, path: "unrelated.txt", status: "APPROVED" });
  const { saveHumanDecision } = await import("../../src/lib/library/observation-sessions");
  const qa = await import("../../src/lib/library/qa/retrieve");
  await prisma.libraryDocument.update({ where: { id: item.file.libraryDocumentId! },
    data: { previewText: "attachment attachment regulation regulation" } });
  await prisma.libraryDocument.update({ where: { id: unrelated.file.libraryDocumentId! },
    data: { previewText: "clinical clinical therapy therapy" } });
  await saveHumanDecision(item.observation.id, { decisionType: "ACCEPT" });
  await memory.buildMemoryFromApprovedSession(item.observation.id);
  await memory.buildMemoryFromApprovedSession(unrelated.observation.id);
  const old = await prisma.memoryEntry.findUniqueOrThrow({ where: { memoryKey: "THEME:attachment-regulation" } });
  const untouched = await prisma.memoryEntry.findUniqueOrThrow({ where: { memoryKey: "THEME:clinical-practice" } });
  assert.ok((await search.searchLibrary("attachment", [r.id])).some((row) => row.kind === "MEMORY"));
  const input = { decisionType: "MODIFY" as const, editedSuggestion: "workshop workshop teaching teaching" };
  const correction = await saveHumanDecision(item.observation.id, input);
  assert.ok(!(await search.searchLibrary("attachment", [r.id])).some((row) => row.kind === "MEMORY"));
  assert.ok(!(await qa.retrieveQuestionContext("attachment", [r.id])).sources.some((source) => source.sourceType === "APPROVED_MEMORY"));
  await memory.buildMemoryFromApprovedSession(item.observation.id);
  const archived = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: old.id } });
  assert.equal(archived.status, "ARCHIVED");
  assert.deepEqual((archived.evidence as unknown[]).filter((value) => typeof value === "string"), old.evidence);
  assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { memoryKey: "THEME:teaching-material" } })).status, "ACTIVE");
  assert.deepEqual(await prisma.memoryEntry.findUniqueOrThrow({ where: { id: untouched.id } }), untouched);
  assert.ok((await search.searchLibrary("teaching", [r.id])).some((row) => row.kind === "MEMORY"));
  const count = await prisma.memoryEntry.count();
  assert.equal((await saveHumanDecision(item.observation.id, input)).decisionId, correction.decisionId);
  await memory.buildMemoryFromApprovedSession(item.observation.id);
  assert.deepEqual(await prisma.memoryEntry.findUniqueOrThrow({ where: { id: old.id } }), archived);
  assert.equal(await prisma.memoryEntry.count(), count);
  assert.equal(await prisma.humanDecision.count({ where: { observationSessionId: item.observation.id } }), 2);
  await saveHumanDecision(item.observation.id, { decisionType: "MODIFY", editedSuggestion: "attachment regulation" });
  await memory.buildMemoryFromApprovedSession(item.observation.id);
  const restored = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: old.id } });
  assert.equal(restored.status, "ACTIVE");
  assert.ok(restored.searchProvenanceComplete);
  assert.ok((restored.evidence as unknown[]).some((value) => typeof value === "object"));
  assert.ok((await search.searchLibrary("attachment", [r.id])).some((row) => row.kind === "MEMORY"));
  assert.equal(await prisma.bridgeCommand.count(), 0);
});

test("a correction removes only its contribution to shared Memory supported by another session", async () => {
  const r = await root("Shared Memory"); const s = await session(r.id);
  const items = [];
  for (const name of ["shared-a.txt", "shared-b.txt"]) {
    const item = await observedFile({ rootId: r.id, sessionId: s.id, path: name, status: "APPROVED" });
    await prisma.libraryDocument.update({ where: { id: item.file.libraryDocumentId! },
      data: { previewText: "clinical clinical therapy therapy" } });
    await memory.buildMemoryFromApprovedSession(item.observation.id);
    items.push(item);
  }
  const { saveHumanDecision } = await import("../../src/lib/library/observation-sessions");
  await saveHumanDecision(items[0].observation.id, { decisionType: "MODIFY", editedSuggestion: "workshop teaching" });
  await memory.buildMemoryFromApprovedSession(items[0].observation.id);
  const entry = await prisma.memoryEntry.findUniqueOrThrow({ where: { memoryKey: "THEME:clinical-practice" }, include: { searchSources: true } });
  assert.equal(entry.status, "ACTIVE");
  assert.equal(entry.searchProvenanceComplete, true);
  assert.equal(entry.searchSources.filter((row) => row.connectedLibraryId === r.id).length, 1);
  assert.equal(entry.searchSources.find((row) => row.connectedLibraryId === r.id)?.observationSessionId, items[1].observation.id);
  assert.ok(!JSON.stringify(entry.evidence).includes(items[0].file.relativePath));
});

test("obsolete MODIFY decisions cannot keep an old terminology preference active", async () => {
  const r = await root("Corrected preference"); const s = await session(r.id);
  const { saveHumanDecision } = await import("../../src/lib/library/observation-sessions");
  const items: Array<Awaited<ReturnType<typeof observedFile>>> = [];
  for (const name of ["preference-a.txt", "preference-b.txt"]) {
    const item = await observedFile({ rootId: r.id, sessionId: s.id, path: name });
    await saveHumanDecision(item.observation.id, { decisionType: "MODIFY", editedSuggestion: "Recovery -> Becoming" });
    await memory.buildMemoryFromApprovedSession(item.observation.id);
    items.push(item);
  }
  const old = await prisma.memoryEntry.findUniqueOrThrow({ where: { memoryKey: "PREFERENCE:prefer-becoming-over-recovery" } });
  assert.equal(old.status, "ACTIVE");
  const input = { decisionType: "MODIFY" as const, editedSuggestion: "Recovery -> Flourishing" };
  await saveHumanDecision(items[0].observation.id, input);
  await memory.buildMemoryFromApprovedSession(items[0].observation.id);
  assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: old.id } })).status, "ARCHIVED");
  assert.equal(await prisma.humanDecision.count({ where: { observationSessionId: items[0].observation.id } }), 2);
  assert.ok(!(await search.searchLibrary("becoming", [r.id])).some((row) => row.kind === "MEMORY"));
});

test("encoded source quotations reach Search, QA, document signals and persistent ranges without changing the quotation", async () => {
  const r = await root("Quoted evidence"); const s = await session(r.id);
  const { groundedEvidence } = await import("../../src/lib/ai/source-evidence");
  const quote = 'Client: Alice Smith\nClient ID: C-quoted\nWorkshop: "Orchid" training';
  const source = `Introduction. ${quote}`;
  const item = await observedFile({ rootId: r.id, sessionId: s.id, path: "quoted.txt", evidence: groundedEvidence(quote, source)! });
  const other = await observedFile({ rootId: r.id, sessionId: s.id, path: "support.txt", evidence: groundedEvidence(quote, source)! });
  await fileKey.persistScanWorkingKnowledge({ clusters: [], files: [item.working, other.working], scanSessionId: s.id,
    relationships: [{ leftFileId: item.file.id, rightFileId: other.file.id, confidence: 0.8,
      sharedTerms: ["orchid", "training"], supportingTopics: ["workshops"], sharedTopics: ["workshops"],
      supportingTopicConfidence: { workshops: 0.8 }, evidenceKinds: ["CONTENT"] }] });
  await indexFiles(s.id, [item, other]);
  const result = (await search.searchLibrary("orchid", [r.id])).find((row) => row.relativePath === item.file.relativePath)!;
  assert.equal(result.excerpt, quote);
  assert.deepEqual(result.sourceRange, { start: 14, end: 14 + quote.length });
  assert.equal(source.slice(result.sourceRange!.start, result.sourceRange!.end), quote);
  assert.ok((await fileKey.getEffectiveDocumentSignals([r.id])).some((signal) => signal.kind === "CLIENT"));
  const qa = await import("../../src/lib/library/qa/retrieve");
  const context = await qa.retrieveQuestionContext("orchid", [r.id]);
  assert.ok(context.sources.some((row) => row.text === quote && row.sourceRange?.start === 14));
  const itemKey = fileKey.persistentFileKey(r.id, item.file.relativePath);
  const otherKey = fileKey.persistentFileKey(r.id, other.file.relativePath);
  const connection = await prisma.knowledgeConnection.findFirstOrThrow({ where: { relationshipKind: "RELATED_SUBJECT", OR: [
    { sourceFileKey: itemKey, targetFileKey: otherKey }, { sourceFileKey: otherKey, targetFileKey: itemKey },
  ] } });
  const evidence = connection.sourceEvidence as { sourceRanges: unknown; targetRanges: unknown };
  assert.deepEqual(connection.sourceFileKey === itemKey ? evidence.sourceRanges : evidence.targetRanges, [{ start: 14, end: 14 + quote.length }]);
  assert.equal(await prisma.bridgeCommand.count(), 0);
});

async function inPlaceRevisions(withOrder = true) {
  const r = await root("Historical lineage Root");
  const items = [];
  for (const i of [1, 2]) {
    const s = await session(r.id);
    await prisma.scanSession.update({ where: { id: s.id }, data: {
      searchIndexStatus: "COMPLETED", startedAt: new Date(2026, 0, i),
    } });
    const text = `Project ID: P-lineage; Document ID: D-lineage; Document Title: Orchid Review${withOrder ? `; Version: v${i}` : ""}`;
    const item = await observedFile({ rootId: r.id, sessionId: s.id, path: "Reports/orchid.txt",
      checksum: String(i).repeat(64), evidence: evidence(text) });
    await fileKey.persistScanWorkingKnowledge({ clusters: [], files: [item.working], relationships: [], scanSessionId: s.id });
    await indexFiles(s.id, [item]);
    items.push(item);
  }
  const signals = await prisma.knowledgeDocumentSignal.findMany({ where: {
    connectedLibraryId: r.id, kind: "DOCUMENT_FAMILY",
  }, orderBy: { checksum: "asc" } });
  return { r, items, signals };
}

test("historical same-path revisions retain checksum-bound lineage in Search and QA", async () => {
  const { r, items, signals } = await inPlaceRevisions();
  assert.deepEqual(signals.map((row) => row.status), ["SUPERSEDED", "ACTIVE"]);
  assert.ok(signals[0].supersededAt);
  const entries = await prisma.librarySearchEntry.findMany({ where: { connectedLibraryId: r.id } });
  assert.equal(entries.length, 2);
  assert.equal(entries.find((row) => row.checksum === items[0].file.checksum)?.isCurrent, false);
  assert.equal(entries.find((row) => row.checksum === items[1].file.checksum)?.isCurrent, true);
  const found = await search.searchLibrary("older Orchid Review versions", [r.id]);
  assert.equal(found.filter((row) => row.kind === "FILE").length, 2);
  assert.equal(found.filter((row) => row.state === "Historical scan").length, 1);
  const qa = await import("../../src/lib/library/qa/retrieve");
  const context = await qa.retrieveQuestionContext("What changed between Orchid Review versions?", [r.id]);
  assert.equal(context.sources.length, 2);
  assert.equal(context.versions.length, 1);
  assert.equal(context.versions[0].ordering, "ORDERED");
  assert.equal(context.sources.find((source) => source.id === context.versions[0].newerSourceId)?.timeState, "Current scan");
  const current = await qa.retrieveQuestionContext("Orchid Review", [r.id]);
  assert.equal(current.sources.length, 1);
  assert.equal(current.versions.length, 0);
  assert.equal(await prisma.bridgeCommand.count(), 0);
});

test("historical lineage excludes wrong checksums, unrelated superseded signals and unauthorized roots", async () => {
  const { r, items, signals } = await inPlaceRevisions();
  const qa = await import("../../src/lib/library/qa/retrieve");
  await prisma.knowledgeDocumentSignal.update({ where: { id: signals[0].id }, data: { checksum: "wrong-revision" } });
  const other = await root("Unauthorized lineage Root"); const scan = await session(other.id);
  const unrelated = await observedFile({ rootId: other.id, sessionId: scan.id, path: "unrelated.txt" });
  await prisma.knowledgeDocumentSignal.create({ data: {
    checksum: items[0].file.checksum!, connectedLibraryId: other.id,
    fileKey: signals[0].fileKey, generationVersion: documentSignalVersion,
    identityHash: signals[1].identityHash, kind: "DOCUMENT_FAMILY", status: "SUPERSEDED",
    supersededAt: new Date(), observationSessionId: unrelated.observation.id,
    relativePath: unrelated.file.relativePath, signalKey: crypto.randomUUID(), sourceRanges: [], revisionNumber: "1",
  } });
  let context = await qa.retrieveQuestionContext("Orchid Review versions", [r.id]);
  assert.equal(context.sources.length, 2);
  assert.equal(context.versions.length, 0);
  assert.ok(context.sources.every((source) => source.rootName === r.displayName));
  const entries = await prisma.librarySearchEntry.findMany({ where: { connectedLibraryId: r.id } });
  assert.deepEqual((await fileKey.getDocumentVersionSignals(entries, true)).map((row) => row.id), [signals[1].id]);
  await prisma.knowledgeDocumentSignal.update({ where: { id: signals[0].id }, data: { checksum: items[0].file.checksum! } });
  context = await qa.retrieveQuestionContext("Orchid Review versions", [r.id]);
  assert.equal(context.versions.length, 1);
  await prisma.connectedLibrary.update({ where: { id: r.id }, data: { readPermission: false } });
  assert.equal((await qa.retrieveQuestionContext("Orchid Review versions", [r.id])).sources.length, 0);
});

test("historical revisions with no ordering stay ambiguous and exact copies are not revisions", async () => {
  const { r, items } = await inPlaceRevisions(false);
  const qa = await import("../../src/lib/library/qa/retrieve");
  const context = await qa.retrieveQuestionContext("Orchid Review versions", [r.id]);
  assert.equal(context.versions[0]?.ordering, "AMBIGUOUS");
  assert.equal(context.versions[0]?.newerSourceId, null);
  const copy = await observedFile({ rootId: r.id, sessionId: items[1].file.sessionId,
    path: "Reports/orchid-copy.txt", checksum: items[1].file.checksum!,
    evidence: items[1].working.sourceEvidenceText });
  await indexFiles(items[1].file.sessionId, [copy]);
  assert.equal((await qa.retrieveQuestionContext("Orchid Review versions", [r.id])).sources.length, 2);
});

test("historical version retrieval cannot revive rejected or superseded human-corrected family claims", async () => {
  for (const decisionType of ["REJECT", "MODIFY"] as const) {
    const { r, items } = await inPlaceRevisions();
    const { saveHumanDecision } = await import("../../src/lib/library/observation-sessions");
    await saveHumanDecision(items[0].observation.id, { decisionType,
      ...(decisionType === "MODIFY" ? { editedSuggestion: "This is an unrelated reminder, not an Orchid Review revision." } : {}) });
    const qa = await import("../../src/lib/library/qa/retrieve");
    assert.equal((await qa.retrieveQuestionContext("Orchid Review versions", [r.id])).versions.length, 0);
  }
});

test("rejection immediately retires sole-source Memory through the decision API and preserves audit, unrelated Memory and reapproval", async () => {
  const beforeRuns = await prisma.executionRun.count();
  const r = await root("Rejected Memory Root"); const s = await session(r.id);
  const item = await observedFile({ rootId: r.id, sessionId: s.id, path: "rejected-memory.txt" });
  const unrelated = await observedFile({ rootId: r.id, sessionId: s.id, path: "untouched-memory.txt", status: "APPROVED" });
  for (const [source, word] of [[item, "rejectionquartz"], [unrelated, "untouchedquartz"]] as const) {
    await prisma.libraryDocument.update({ where: { id: source.file.libraryDocumentId! }, data: { previewText: `${word} ${word}` } });
  }
  await memory.buildMemoryFromApprovedSession(unrelated.observation.id);
  const untouched = await prisma.memoryEntry.findUniqueOrThrow({ where: { memoryKey: "TERM:untouchedquartz" } });
  const cache = createRequire(path.resolve("package.json"))("next/cache") as typeof import("next/cache");
  const revalidation = mock.method(cache, "revalidatePath", () => undefined);
  try {
    const route = await import("../../src/app/api/library/observation-sessions/[sessionId]/decision/route");
    const decide = async (decisionType: string) => {
      const response = await route.POST(new Request("http://localhost/decision", { method: "POST",
        body: JSON.stringify({ decisionType }) }), { params: Promise.resolve({ sessionId: item.observation.id }) });
      assert.equal(response.status, 200);
      return response.json();
    };
    await decide("ACCEPT");
    const entry = await prisma.memoryEntry.findUniqueOrThrow({ where: { memoryKey: "TERM:rejectionquartz" } });
    const qa = await import("../../src/lib/library/qa/retrieve");
    assert.ok((await search.searchLibrary("rejectionquartz", [r.id])).some((row) => row.id === entry.id));
    assert.ok((await qa.retrieveQuestionContext("rejectionquartz", [r.id])).sources.some((row) => row.sourceType === "APPROVED_MEMORY"));
    const rejected = await decide("REJECT");
    const archived = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: entry.id } });
    assert.equal(archived.status, "ARCHIVED");
    assert.equal(archived.searchProvenanceComplete, false);
    assert.ok(JSON.stringify(archived.evidence).includes("HUMAN_CORRECTION_ARCHIVE"));
    assert.equal(await prisma.memorySearchSource.count({ where: { memoryEntryId: entry.id } }), 1);
    assert.ok(!(await search.searchLibrary("rejectionquartz", [r.id])).some((row) => row.kind === "MEMORY"));
    assert.ok(!(await qa.retrieveQuestionContext("rejectionquartz", [r.id])).sources.some((row) => row.sourceType === "APPROVED_MEMORY"));
    assert.deepEqual(await prisma.memoryEntry.findUniqueOrThrow({ where: { id: untouched.id } }), untouched);
    assert.equal((await decide("REJECT")).decisionId, rejected.decisionId);
    assert.deepEqual(await prisma.memoryEntry.findUniqueOrThrow({ where: { id: entry.id } }), archived);
    assert.equal(await prisma.humanDecision.count({ where: { observationSessionId: item.observation.id } }), 2);
    await decide("ACCEPT");
    const restored = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: entry.id } });
    assert.equal(restored.status, "ACTIVE");
    assert.equal(restored.searchProvenanceComplete, true);
    assert.ok(JSON.stringify(restored.evidence).includes("HUMAN_CORRECTION_ARCHIVE"));
    assert.ok((await search.searchLibrary("rejectionquartz", [r.id])).some((row) => row.id === entry.id));
    assert.equal(await prisma.bridgeCommand.count(), 0);
    assert.equal(await prisma.executionRun.count(), beforeRuns);
  } finally {
    revalidation.mock.restore();
  }
});

test("rejection retains independently approved shared Memory and removes only the rejected contribution", async () => {
  const r = await root("Shared rejection Root"); const s = await session(r.id);
  const items = [];
  for (const name of ["shared-reject-a.txt", "shared-reject-b.txt"]) {
    const item = await observedFile({ rootId: r.id, sessionId: s.id, path: name, status: "APPROVED" });
    await prisma.libraryDocument.update({ where: { id: item.file.libraryDocumentId! }, data: { previewText: "sharedquartz sharedquartz" } });
    await memory.buildMemoryFromApprovedSession(item.observation.id);
    items.push(item);
  }
  const { saveHumanDecision } = await import("../../src/lib/library/observation-sessions");
  await saveHumanDecision(items[0].observation.id, { decisionType: "REJECT" });
  const entry = await prisma.memoryEntry.findUniqueOrThrow({ where: { memoryKey: "TERM:sharedquartz" }, include: { searchSources: true } });
  assert.equal(entry.status, "ACTIVE");
  assert.equal(entry.searchProvenanceComplete, true);
  assert.equal(entry.searchSourceCount, 1);
  assert.deepEqual(entry.searchSources.map((row) => row.observationSessionId), [items[1].observation.id]);
  assert.ok(!JSON.stringify(entry.evidence).includes(items[0].file.relativePath));
  assert.ok((await search.searchLibrary("sharedquartz", [r.id])).some((row) => row.id === entry.id));
  const qa = await import("../../src/lib/library/qa/retrieve");
  assert.ok((await qa.retrieveQuestionContext("sharedquartz", [r.id])).sources.some((row) => row.sourceType === "APPROVED_MEMORY"));
  await saveHumanDecision(items[0].observation.id, { decisionType: "REJECT" });
  assert.deepEqual(await prisma.memoryEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { searchSources: true } }), entry);
});

test("rejecting a modified source reconciles its learned terminology preference", async () => {
  const r = await root("Rejected preference Root"); const s = await session(r.id);
  const { saveHumanDecision } = await import("../../src/lib/library/observation-sessions");
  const items = [];
  for (const name of ["rejected-pref-a.txt", "rejected-pref-b.txt"]) {
    const item = await observedFile({ rootId: r.id, sessionId: s.id, path: name });
    await saveHumanDecision(item.observation.id, { decisionType: "MODIFY", editedSuggestion: "oldquartz -> newquartz" });
    await memory.buildMemoryFromApprovedSession(item.observation.id);
    items.push(item);
  }
  const entry = await prisma.memoryEntry.findUniqueOrThrow({ where: { memoryKey: "PREFERENCE:prefer-newquartz-over-oldquartz" } });
  assert.equal(entry.status, "ACTIVE");
  await saveHumanDecision(items[0].observation.id, { decisionType: "REJECT" });
  assert.equal((await prisma.memoryEntry.findUniqueOrThrow({ where: { id: entry.id } })).status, "ARCHIVED");
  assert.equal(await prisma.humanDecision.count({ where: { observationSessionId: items[0].observation.id } }), 2);
});

test("failed retry passes rotate across 45 files despite 20 persistent failures without retrying successes", async () => {
  const r = await root("Fair retry Root"); const s = await session(r.id);
  const ids = Array.from({ length: 45 }, (_, i) => `${s.id}-${i.toString().padStart(2, "0")}`);
  await prisma.scannedFile.createMany({ data: ids.map((id, i) => ({ id, sessionId: s.id,
    localPath: `bridge://${r.id}/retry-${i}.txt`, relativePath: `retry-${i}.txt`, fileType: "TEXT",
    checksum: `synthetic-${i}`, extractionStatus: "COMPLETED", readingStatus: "READ", readStatus: "SUPPORTED",
  })) });
  await prisma.librarySearchBackfillFile.createMany({ data: ids.map((id) => ({
    scannedFileId: id, scanSessionId: s.id, indexVersion: indexer.librarySearchIndexVersion,
    status: "FAILED", updatedAt: new Date(2020, 0, 1),
  })) });
  const passes: string[][] = [];
  const retry = async () => {
    const attempted: string[] = []; passes.push(attempted);
    const progress = await runSearchPreparationBatches((retryFailed) => backfill.prepareSearchBatch(s.id, retryFailed,
      async (_scan, id) => {
        attempted.push(id);
        if (ids.indexOf(id) < 20) throw new Error("Persistent synthetic failure");
        return "INDEXED";
      }), () => undefined);
    assert.ok(attempted.length <= 20);
    assert.equal(progress.remaining, 0);
    assert.equal(progress.completed, false);
    return progress;
  };
  assert.equal((await retry()).failed, 45);
  assert.deepEqual(passes[0], ids.slice(0, 20));
  const second = await retry();
  assert.deepEqual(passes[1], ids.slice(20, 40));
  assert.equal(second.indexed, 20);
  assert.equal(second.failed, 25);
  const third = await retry();
  assert.deepEqual(passes[2].slice(0, 5), ids.slice(40));
  assert.equal(third.indexed, 25);
  assert.equal(third.failed, 20);
  assert.equal(new Set(passes.flat()).size, 45);
  await retry();
  assert.ok(passes[3].every((id) => ids.indexOf(id) < 20));
  assert.equal((await backfill.prepareSearchBatch(s.id, false, async () => assert.fail("Failed files require explicit retry"))).processedFiles, 0);
  const recovered = await backfill.prepareSearchBatch(s.id, true, async () => "REUSED");
  assert.equal(recovered.completed, true);
  assert.equal(recovered.reused, 20);
  assert.equal(recovered.indexed, 25);
  assert.equal(await prisma.bridgeCommand.count(), 0);
});

test("concurrent failed-row retries retain single-owner claims and recover stale attempts", async () => {
  const r = await root("Concurrent retry Root"); const s = await session(r.id);
  const item = await observedFile({ rootId: r.id, sessionId: s.id, path: "retry-claim.txt" });
  await backfill.prepareSearchBatch(s.id, false, async () => { throw new Error("Synthetic failure"); });
  let release!: () => void; let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let attempts = 0;
  const first = backfill.prepareSearchBatch(s.id, true, async () => {
    attempts += 1; started(); await held; return "INDEXED";
  });
  await ready;
  const second = await backfill.prepareSearchBatch(s.id, true, async () => {
    attempts += 1; return "INDEXED";
  });
  assert.equal(second.claimedFiles, 0);
  assert.equal(second.waitingForClaims, true);
  assert.equal(attempts, 1);
  await prisma.librarySearchBackfillFile.updateMany({ where: { scannedFileId: item.file.id }, data: {
    updatedAt: new Date(Date.now() - 6 * 60_000),
  } });
  const resumed = await backfill.prepareSearchBatch(s.id, true, async () => "REUSED");
  assert.equal(resumed.reused, 1);
  release();
  assert.equal((await first).processedFiles, 0, "Expired claim must not overwrite the new owner");
  assert.equal((await backfill.getSearchBackfillProgress(s.id)).reused, 1);
});

test("observation decisions refresh the latest completed snapshot through pending, failed and newer completed scans", async () => {
  const r = await root("Targeted completed snapshot Root"); const a = await session(r.id);
  await prisma.scanSession.update({ where: { id: a.id }, data: { searchIndexStatus: "COMPLETED" } });
  const item = await observedFile({ rootId: r.id, sessionId: a.id, path: "Notes/outline.txt",
    checksum: "a".repeat(64), evidence: evidence("Workshop outline for the new term") });
  const peer = await observedFile({ rootId: r.id, sessionId: a.id, path: "Notes/peer.txt",
    evidence: evidence("Unrelated peer evidence") });
  await indexFiles(a.id, [item, peer]);
  const original = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: item.file.id } });
  const peerBefore = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: peer.file.id } });
  const scannedCopy = async (sessionId: string, checksum: string) => prisma.scannedFile.create({ data: {
    sessionId, libraryDocumentId: item.observation.libraryDocumentId,
    localPath: `bridge://${r.id}/Notes/outline.txt`, relativePath: item.file.relativePath,
    checksum, fileType: "TEXT", readStatus: "SUPPORTED", readingStatus: "READ",
    extractionStatus: "COMPLETED",
  } });
  const b = await prisma.scanSession.create({ data: { connectedFolderId: r.id, status: "PENDING",
    startedAt: new Date(a.startedAt.getTime() + 60_000) } });
  const pending = await scannedCopy(b.id, item.file.checksum!);
  const cache = createRequire(path.resolve("package.json"))("next/cache") as typeof import("next/cache");
  const revalidation = mock.method(cache, "revalidatePath", () => undefined);
  try {
    const route = await import("../../src/app/api/library/observation-sessions/[sessionId]/decision/route");
    const decide = async (decisionType: string, editedSuggestion?: string) => {
      const response = await route.POST(new Request("http://localhost/decision", { method: "POST",
        body: JSON.stringify({ decisionType, editedSuggestion }) }),
      { params: Promise.resolve({ sessionId: item.observation.id }) });
      assert.equal(response.status, 200);
    };
    await decide("MODIFY", "Becoming belongs in the workshop outline");
    let current = await prisma.librarySearchEntry.findUniqueOrThrow({ where: { id: original.id } });
    assert.equal(current.scannedFileId, item.file.id);
    assert.equal(current.scanSessionId, a.id);
    assert.equal(current.knowledgeState, "APPROVED");
    assert.ok(current.reviewedTerms.includes("becom"));
    assert.ok((await search.searchLibrary("becoming", [r.id])).some((row) => row.id === original.id));
    assert.equal(await prisma.librarySearchEntry.count({ where: { scannedFileId: pending.id } }), 0);
    await prisma.scanSession.update({ where: { id: b.id }, data: { status: "SCANNING" } });
    await decide("NOTE");
    assert.equal((await prisma.librarySearchEntry.findUniqueOrThrow({ where: { id: original.id } })).scannedFileId, item.file.id);
    await prisma.scanSession.update({ where: { id: b.id }, data: { status: "FAILED" } });
    await decide("REJECT");
    current = await prisma.librarySearchEntry.findUniqueOrThrow({ where: { id: original.id } });
    assert.equal(current.scannedFileId, item.file.id);
    assert.equal(current.knowledgeState, "PROVISIONAL");
    assert.deepEqual(current.reviewedTerms, []);
    const qa = await import("../../src/lib/library/qa/retrieve");
    assert.ok((await qa.retrieveQuestionContext("outline", [r.id])).sources.some((row) => row.href.includes(a.id)));

    const c = await prisma.scanSession.create({ data: { connectedFolderId: r.id,
      startedAt: new Date(b.startedAt.getTime() + 60_000), status: "COMPLETED_WITH_ERRORS",
      searchIndexStatus: "COMPLETED" } });
    const completed = await scannedCopy(c.id, item.file.checksum!);
    await decide("ACCEPT");
    current = await prisma.librarySearchEntry.findUniqueOrThrow({ where: { id: original.id } });
    assert.equal(current.scannedFileId, completed.id);
    assert.equal(current.scanSessionId, c.id);
    assert.equal(current.knowledgeState, "APPROVED");
    assert.deepEqual(current.reviewedTerms, []);
    assert.equal(await prisma.librarySearchEntry.count({ where: { fileKey: original.fileKey } }), 1);
    assert.ok((await search.searchLibrary("outline", [r.id])).some((row) => row.href.includes(c.id)));
    assert.ok((await qa.retrieveQuestionContext("outline", [r.id])).sources.some((row) => row.href.includes(c.id)));

    const d = await prisma.scanSession.create({ data: { connectedFolderId: r.id,
      startedAt: new Date(c.startedAt.getTime() + 60_000), status: "PENDING" } });
    await scannedCopy(d.id, "d".repeat(64));
    await decide("MODIFY", "Updated outline for Becoming");
    assert.equal((await prisma.librarySearchEntry.findUniqueOrThrow({ where: { id: original.id } })).scannedFileId, completed.id);
    await prisma.scanSession.update({ where: { id: d.id }, data: { status: "COMPLETED",
      searchIndexStatus: "COMPLETED" } });
    await decide("ACCEPT");
    const latest = await prisma.librarySearchEntry.findFirstOrThrow({ where: { scannedFileId: {
      in: (await prisma.scannedFile.findMany({ where: { sessionId: d.id }, select: { id: true } })).map((row) => row.id),
    } } });
    assert.equal(latest.isCurrent, true);
    assert.equal(latest.scanSessionId, d.id);
    assert.equal((await prisma.librarySearchEntry.findUniqueOrThrow({ where: { id: original.id } })).isCurrent, false);
    assert.equal(await prisma.librarySearchEntry.count({ where: { fileKey: original.fileKey, isCurrent: true } }), 1);
    assert.equal(await prisma.librarySearchEntry.count({ where: { fileKey: original.fileKey } }), 2);
    assert.ok((await search.searchLibrary("older outline", [r.id])).some((row) => row.state === "Historical scan"));
    assert.equal((await prisma.librarySearchEntry.findUniqueOrThrow({ where: { id: peerBefore.id } })).indexedAt.getTime(),
      peerBefore.indexedAt.getTime(), "Targeted refresh must not rebuild unrelated files");
    assert.equal(await prisma.bridgeCommand.count(), 0);
  } finally {
    revalidation.mock.restore();
  }
});

for (const actionType of ["MOVE_FILE", "RENAME_FILE"] as const) {
  test(`targeted observation refresh preserves canonical ${actionType} identity while a newer scan is incomplete`, async () => {
    const fixture = await canonicalMoveFixture(actionType);
    const moved = await indexMovedSnapshot(fixture, fixture.destination);
    const pending = await prisma.scanSession.create({ data: { connectedFolderId: fixture.r.id,
      status: "SCANNING", startedAt: new Date(moved.s.startedAt.getTime() + 60_000) } });
    const newer = await prisma.scannedFile.create({ data: { sessionId: pending.id,
      libraryDocumentId: moved.files[0].observation.libraryDocumentId,
      localPath: `bridge://${fixture.r.id}/${fixture.destination}`, relativePath: fixture.destination,
      fileType: "TEXT", checksum: moved.files[0].file.checksum, readStatus: "SUPPORTED",
      readingStatus: "READ", extractionStatus: "COMPLETED",
    } });
    const { saveHumanDecision } = await import("../../src/lib/library/observation-sessions");
    await saveHumanDecision(moved.files[0].observation.id, { decisionType: "ACCEPT" });
    await indexer.refreshSearchForObservation(moved.files[0].observation.id);
    const current = await prisma.librarySearchEntry.findUniqueOrThrow({ where: { id: fixture.initialEntry.id } });
    assert.equal(current.id, moved.entry.id);
    assert.equal(current.fileKey, fixture.initialEntry.fileKey);
    assert.equal(current.relativePath, fixture.destination);
    assert.equal(current.scannedFileId, moved.files[0].file.id);
    assert.equal(current.knowledgeState, "APPROVED");
    assert.deepEqual(current.entityHashes, moved.entry.entityHashes);
    assert.equal(await prisma.librarySearchEntry.count({ where: { scannedFileId: newer.id } }), 0);
    assert.equal(await prisma.librarySearchEntry.count({ where: { fileKey: current.fileKey } }), 1);
    assert.equal(await prisma.bridgeCommand.count(), 0);
  });
}

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
