import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { documentSignalVersion } from "../../src/lib/bridge/document-signals";
import { knowledgeScaleFixture } from "./knowledge-scale-fixtures";

const schema = `eligible_caps_${process.pid}_${Date.now()}`;
let prisma: PrismaClient;
let persistent: typeof import("../../src/lib/bridge/persistent-knowledge");
before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "5432");
  assert.equal(url.pathname, "/nsn_library_machine_test");
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = process.env.DIRECT_URL = url.toString();
  delete process.env.OPENAI_API_KEY;
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { stdio: "pipe" });
  prisma = new PrismaClient();
  persistent = await import("../../src/lib/bridge/persistent-knowledge");
});
after(async () => {
  await prisma?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await prisma?.$disconnect();
});

test("earlier relationship context applies root authority before its bounded context window", async (t) => {
  const valid = await knowledgeScaleFixture(prisma, "Earlier current root", 2, () => "Evidence");
  const noise = await knowledgeScaleFixture(prisma, "Earlier revoked root", 2, () => "Evidence");
  t.after(valid.dispose); t.after(noise.dispose);
  await prisma.connectedLibrary.update({ where: { id: noise.root.id }, data: { readPermission: false } });
  const connection = { generationVersion: persistent.relationshipGenerationVersion, relationshipKind: "RELATED_SUBJECT",
    sourceFileKey: valid.rows[0].fileKey, targetFileKey: valid.rows[1].fileKey,
    sourceChecksum: valid.rows[0].checksum, targetChecksum: valid.rows[1].checksum,
    sourceObservationSessionId: valid.rows[0].observationId, targetObservationSessionId: valid.rows[1].observationId,
    sharedTerms: [], reasoning: "Earlier scoped evidence" };
  await prisma.knowledgeConnection.createMany({ data: Array.from({ length: 40 }, (_, i) => ({ ...connection,
    id: `z-private-context-${i}`, createdAt: new Date("2026-09-02"), sourceEvidence: { connectedLibraryId: noise.root.id,
      sourceRelativePath: valid.rows[0].relativePath, targetRelativePath: "private.txt", supportingTopics: ["private"] } })) });
  await prisma.knowledgeConnection.create({ data: { ...connection, createdAt: new Date("2026-09-01"),
    sourceEvidence: { connectedLibraryId: valid.root.id, sourceRelativePath: valid.rows[0].relativePath,
      targetRelativePath: valid.rows[1].relativePath, supportingTopics: ["finance"] } } });
  const input = { checksum: valid.rows[0].checksum, connectedLibraryId: valid.root.id,
    relativePath: valid.rows[0].relativePath, scanStartedAt: new Date("2026-10-01") };
  assert.deepEqual(await persistent.earlierRelationshipContext(input), [{ relationshipKind: "RELATED_SUBJECT",
    relativePath: valid.rows[1].relativePath, supportingTopics: ["finance"] }]);
  await prisma.connectedLibrary.update({ where: { id: valid.root.id }, data: { readPermission: false } });
  assert.deepEqual(await persistent.earlierRelationshipContext(input), []);
});

for (const scenario of ["revoked", "stale", "mixed", "cap", "timestamp", "empty", "file-key"] as const) {
  test(`eligible relationship review cap: ${scenario}`, async (t) => {
    const valid = await knowledgeScaleFixture(prisma, `Valid ${scenario}`, 2, () => "Client ID: VALID");
    const noise = await knowledgeScaleFixture(prisma, `Noise ${scenario}`, 2, () => "Client ID: VALID");
    t.after(valid.dispose); t.after(noise.dispose);
    const stamp = new Date("2026-10-01T00:00:00Z");
    const row = (fixture: typeof valid, index: number, prefix: string, invalid = false) => ({
      id: `${prefix}-${String(index).padStart(4, "0")}-${scenario}`,
      relationshipKey: crypto.randomUUID(), generationVersion: documentSignalVersion,
      relationshipKind: "SAME_CLIENT", sourceFileKey: fixture.rows[0].fileKey, targetFileKey: fixture.rows[1].fileKey,
      sourceChecksum: invalid ? "obsolete" : fixture.rows[0].checksum, targetChecksum: fixture.rows[1].checksum,
      sourceObservationSessionId: fixture.rows[0].observationId, targetObservationSessionId: fixture.rows[1].observationId,
      sourceEvidence: { connectedLibraryId: fixture.root.id, sourceRelativePath: fixture.rows[0].relativePath,
        targetRelativePath: fixture.rows[1].relativePath }, sharedTerms: [], reasoning: "Current evidence",
      lastSeenAt: stamp, createdAt: stamp,
    });
    const wanted = scenario === "empty" ? [] : Array.from({ length: scenario === "revoked" || scenario === "stale" ? 1 : 45 },
      (_, i) => row(valid, i, "a-valid"));
    const invalid = Array.from({ length: 125 }, (_, i) => ({ ...row(noise, i, "z-invalid", !["revoked", "file-key"].includes(scenario)),
      ...(scenario === "file-key" ? { sourceFileKey: "wrong-root-file-key" } : {}),
      lastSeenAt: new Date(stamp.getTime() + 10_000),
      ...(scenario === "mixed" && i % 3 === 0 ? { supersededAt: stamp } : {}),
      ...(scenario === "mixed" && i % 3 === 1 ? { status: "ARCHIVED" as const } : {}),
    }));
    if (scenario === "revoked") await prisma.connectedLibrary.update({ where: { id: noise.root.id }, data: { readPermission: false } });
    await prisma.knowledgeConnection.createMany({ data: [...invalid, ...wanted] });
    const result = await persistent.getRecentPersistentFileRelationships();
    const expected = wanted.map((item) => item.id).sort().reverse().slice(0, 30);
    assert.deepEqual(result.map((item) => item.id), expected);
    assert.equal(result.length, Math.min(30, wanted.length));
    assert.ok(result.every((item) => item.reviewable));
    assert.deepEqual((await persistent.getRecentPersistentFileRelationships()).map((item) => item.id), expected);
    t.diagnostic(`${invalid.length} ineligible rows; ${wanted.length} eligible; returned ${result.length} in canonical order`);
  });
}

for (const scenario of ["types", "disconnected", "stale", "project", "anchor", "cap", "timestamp", "cross-root", "ambiguous", "file-key"] as const) {
  test(`eligible correction candidate caps: ${scenario}`, async (t) => {
    const count = ["cap", "timestamp"].includes(scenario) ? 225 : 2;
    const valid = await knowledgeScaleFixture(prisma, `Valid ${scenario}`, count, () => "Evidence");
    const noise = await knowledgeScaleFixture(prisma, `Noise ${scenario}`, 225, () => "Evidence");
    t.after(valid.dispose); t.after(noise.dispose);
    const stamp = new Date("2026-10-01T00:00:00Z");
    const signals = (fixture: typeof valid, kinds: string[], prefix: string, invalid: boolean) => fixture.rows.flatMap((row, i) =>
      kinds.map((kind) => ({ id: `${prefix}-${String(i).padStart(4, "0")}-${kind}-${scenario}`,
        signalKey: crypto.randomUUID(), connectedLibraryId: fixture.root.id,
        checksum: invalid ? "obsolete" : row.checksum, fileKey: row.fileKey,
        relativePath: row.relativePath, kind, identityHash: `${kind}:${i}`,
        sourceRanges: [], observationSessionId: row.observationId, generationVersion: documentSignalVersion,
        lastSeenAt: stamp, createdAt: stamp,
      })));
    const wanted = signals(valid, ["CLIENT", "PROJECT", "FILE_ANCHOR"], "a-valid", false);
    const kinds = scenario === "types" ? ["PERSON", "VERSION", "UNRESOLVED_PROJECT"] : ["CLIENT", "PROJECT", "FILE_ANCHOR"];
    const invalid = signals(noise, kinds, "z-noise", ["stale", "project", "anchor", "cap", "timestamp"].includes(scenario))
      .map((row) => ({ ...row, lastSeenAt: scenario === "file-key" ? stamp : new Date(stamp.getTime() + 10_000),
        ...(scenario === "file-key" ? { fileKey: `wrong-root-file-key:${row.id}` } : {}) }));
    if (["disconnected", "cross-root"].includes(scenario)) await prisma.connectedLibrary.update({
      where: { id: noise.root.id }, data: scenario === "disconnected" ? { status: "DISCONNECTED", disconnectedAt: stamp } : { readPermission: false },
    });
    for (let i = 0; i < invalid.length; i += 500) await prisma.knowledgeDocumentSignal.createMany({ data: invalid.slice(i, i + 500) });
    if (scenario === "ambiguous") await prisma.knowledgeDocumentSignal.createMany({ data: invalid.filter((row) => row.kind !== "FILE_ANCHOR")
      .map((row) => ({ ...row, id: `duplicate-${row.id}`, signalKey: crypto.randomUUID(), identityHash: `other:${row.identityHash}` })) });
    await prisma.knowledgeDocumentSignal.createMany({ data: wanted });
    // Duplicate equivalent rows cannot occupy an additional semantic file slot.
    await prisma.knowledgeDocumentSignal.createMany({ data: wanted.slice(0, 3).map((row) => ({ ...row,
      id: `0-duplicate-${row.id}`, signalKey: crypto.randomUUID() })) });
    const result = await persistent.getIdentityCorrectionCandidates();
    for (const kind of ["CLIENT", "PROJECT", "FILE_ANCHOR"]) {
      const actual = result.filter((row) => row.kind === kind && row.connectedLibraryId === valid.root.id);
      const expected = wanted.filter((row) => row.kind === kind).map((row) => row.id).sort().reverse().slice(0, 200);
      assert.deepEqual(actual.map((row) => row.id), expected);
      assert.equal(actual.length, Math.min(200, count));
    }
    assert.ok(result.every((row) => ["CLIENT", "UNRESOLVED_CLIENT", "PROJECT", "FILE_ANCHOR"].includes(row.kind)));
    if (scenario !== "types") assert.ok(result.every((row) => row.connectedLibraryId === valid.root.id));
    assert.deepEqual(await persistent.getIdentityCorrectionCandidates(), result);
    if (count === 2) {
      const [source, target] = wanted.filter((row) => row.kind === "CLIENT");
      const correction = await persistent.createIdentityCorrection({ sourceSignalId: source.id, targetSignalId: target.id,
        kind: "SAME_CLIENT", note: "These are the same client." });
      assert.equal(correction.status, "CONFIRMED");
      const anchor = wanted.find((row) => row.kind === "FILE_ANCHOR")!;
      const project = wanted.filter((row) => row.kind === "PROJECT")[1];
      assert.equal((await persistent.createIdentityCorrection({ sourceSignalId: anchor.id, targetSignalId: project.id,
        kind: "BELONGS_TO_PROJECT", note: "This document belongs to this project." })).status, "CONFIRMED");
    }
    t.diagnostic(`${invalid.length} irrelevant/ineligible signals; ${Math.min(200, count)} eligible files per category`);
  });
}
