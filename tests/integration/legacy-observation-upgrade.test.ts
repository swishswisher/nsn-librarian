import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { createBridgeKeyPair, createBridgeCommandEnvelope, createBridgeDeviceRequestHeaders, verifyBridgeCommandSignature } from "../../packages/bridge-protocol/src";

const schema = `legacy_observation_${process.pid}_${Date.now()}`;
const migration35 = "20261007120000_system_authority_recovery";
const migration36 = "20261008120000_memory_recovery_scheduler";
const cases = ["active", "expired", "acknowledged", "offline", "revoked", "key", "revision", "physical", "superseded",
  "unavailable", "concurrent", "late", "race", "history", "bounded", "fault", "retired-race", "generation-race", "denied", "queued-pending", "queued-acknowledged", "queued-expired", "queued-modern", "queued-revoked", "queued-generation", "queued-checksum", "queued-race"];
const keys = new Map(cases.map((key) => [key, createBridgeKeyPair()]));
const id = (key: string, kind: string) => kind === "native-root"
  ? `root_${createHash("sha256").update(key).digest("hex").slice(0, 24)}` : `legacy-${key}-${kind}`;
const text = "Synthetic cobalt orchard notes for a fresh authorized observation.";
const checksum = createHash("sha256").update(text).digest("hex");
let prisma: PrismaClient, temporary: string;
let recovery: typeof import("../../src/lib/bridge/observation-recovery");
let poll: typeof import("../../src/lib/bridge/recoverable-commands");
let authority: typeof import("../../src/lib/bridge/observation-authority");
let reports: typeof import("../../src/lib/bridge/cloud-command-results");
let commands: typeof import("../../src/lib/bridge/cloud-coordinator");
let historical: unknown;
let modernQueuedCommandId: string;

before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "5432"); assert.equal(url.pathname, "/nsn_library_machine_test");
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  url.searchParams.set("schema", schema); process.env.DATABASE_URL = process.env.DIRECT_URL = url.toString();
  temporary = await mkdtemp(path.join(os.tmpdir(), "nsn-legacy-observation-"));
  await mkdir(path.join(temporary, "prisma/migrations"), { recursive: true });
  await cp("prisma/schema.prisma", path.join(temporary, "prisma/schema.prisma"));
  for (const name of (await readdir("prisma/migrations")).filter((name) => name === "migration_lock.toml" || name < migration35))
    await cp(path.join("prisma/migrations", name), path.join(temporary, "prisma/migrations", name), { recursive: true });
  const deploy = () => execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", path.join(temporary, "prisma/schema.prisma")], { stdio: "pipe" });
  deploy();
  prisma = (await import("../../src/lib/db/prisma")).getPrismaClient();
  const count = async () => Number((await prisma.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) FROM "_prisma_migrations"'))[0].count);
  assert.equal(await count(), 34);
  const columns = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string; udt_name: string; data_type: string }>>(
    "SELECT table_name,column_name,udt_name,data_type FROM information_schema.columns WHERE table_schema=$1", schema);
  assert.ok(!columns.some((column) => column.column_name === "observationRootRevision"));
  async function insert(table: string, data: Record<string, unknown>) {
    if (columns.some((column) => column.table_name === table && column.column_name === "updatedAt")) data.updatedAt = new Date();
    const names = Object.keys(data), values: unknown[] = [];
    const expressions = names.map((name, index) => {
      const column = columns.find((entry) => entry.table_name === table && entry.column_name === name); assert.ok(column);
      assert.match(column.udt_name, /^[A-Za-z_][A-Za-z0-9_]*$/);
      // ISO strings cast to timestamp keep the intended UTC wall-clock value;
      // Date parameters cast from timestamptz otherwise shift with DB TimeZone.
      values.push(data[name] instanceof Date ? data[name].toISOString()
        : column.udt_name === "jsonb" || column.data_type === "ARRAY" ? JSON.stringify(data[name]) : data[name]);
      return column.data_type === "ARRAY" ? `ARRAY(SELECT jsonb_array_elements_text($${index + 1}::jsonb))` : `$${index + 1}::"${column.udt_name}"`;
    });
    await prisma.$executeRawUnsafe(`INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${expressions.join(",")})`, ...values);
  }
  for (const key of cases) {
    await insert("BridgeDevice", { id: id(key, "device-row"), bridgeDeviceId: id(key, "device"), deviceDisplayName: "Synthetic upgrade Bridge",
      publicKey: keys.get(key)!.publicKey, platform: "MACOS", architecture: "arm64", appVersion: "0.1.0", status: key === "offline" ? "OFFLINE" : "ONLINE", pairedAt: new Date(), lastSeenAt: new Date() });
    await insert("ConnectedFolder", { id: id(key, "root"), displayName: key, localPath: `bridge://${key}`, platform: "MACOS", status: "CONNECTED",
      readPermission: true, bridgeDeviceId: id(key, "device"), bridgeRootId: id(key, "native-root") });
    await insert("ScanSession", { id: id(key, "scan"), connectedFolderId: id(key, "root"), status: "READING", filesScanned: key === "bounded" ? 61 : 1,
      supportedFiles: key === "bounded" ? 61 : 1, startedAt: new Date(Date.now() - 60_000) });
    for (let index = 0; index < (key === "bounded" ? 61 : 1); index++) {
      const fileId = id(key, index ? `file-${index}` : "file");
      const queued = key.startsWith("queued-");
      await insert("ScannedFile", { id: fileId, sessionId: id(key, "scan"), relativePath: `${index}.txt`, localPath: `bridge://${key}/${index}.txt`,
        fileType: "TEXT", checksum, readStatus: "SUPPORTED", readingStatus: queued ? "NOT_READ" : "READ", extractionStatus: queued ? "PENDING" : "COMPLETED", processingStage: queued ? "READING" : "OBSERVING",
        observationClaimedAt: queued ? null : new Date(Date.now() - (key === "active" ? 1000 : 20 * 60_000)) });
      const legacyEnvelope = queued ? createBridgeCommandEnvelope({ commandId: id(key, `old-command-${index}`),
        bridgeDeviceId: id(key, "device"), bridgeRootId: id(key, "native-root"), connectedLibraryId: id(key, "root"), commandType: "READ_FILE_TEMPORARILY",
        idempotencyKey: id(key, `old-read-${index}`), authorizationContext: {}, payload: { scannedFileId: fileId, scanSessionId: id(key, "scan"), relativePath: `${index}.txt` },
        issuedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + (key === "queued-expired" ? -1000 : 600_000)),
        signingSecret: process.env.NSN_BRIDGE_COMMAND_SIGNING_SECRET!, }) : null;
      if (key !== "queued-modern") await insert("BridgeCommand", { id: id(key, `command-row-${index}`), commandId: id(key, `old-command-${index}`),
        bridgeDeviceId: id(key, "device"), bridgeRootId: id(key, "native-root"), connectedLibraryId: id(key, "root"), commandType: "READ_FILE_TEMPORARILY",
        idempotencyKey: id(key, `old-read-${index}`), payload: { scannedFileId: fileId, scanSessionId: id(key, "scan"), relativePath: `${index}.txt` },
        authorizationContext: {}, payloadHash: legacyEnvelope?.payloadHash ?? "legacy-synthetic", signature: legacyEnvelope?.signature ?? "legacy-synthetic", issuedAt: legacyEnvelope ? new Date(legacyEnvelope.issuedAt) : new Date(Date.now() - 20 * 60_000),
        expiresAt: legacyEnvelope ? new Date(legacyEnvelope.expiresAt) : new Date(Date.now() + (key === "acknowledged" ? 600_000 : -1000)),
        status: key === "expired" || key === "queued-expired" ? "EXPIRED" : key === "queued-pending" ? "PENDING" : "ACKNOWLEDGED" });
    }
  }
  await insert("LibraryBatch", { id: "legacy-history-batch", name: "Retained synthetic history" });
  await insert("LibraryDocument", { id: "legacy-history-doc", batchId: "legacy-history-batch", originalFileName: "history.txt", normalizedFileName: "history.txt", rawText: text, checksum });
  await insert("ObservationSession", { id: "legacy-history-observation", libraryDocumentId: "legacy-history-doc", observerType: "DETERMINISTIC", status: "APPROVED",
    observations: [], interpretations: [], explanation: [], planSuggestions: [], warnings: [] });
  await insert("HumanDecision", { id: "legacy-history-decision", observationSessionId: "legacy-history-observation", decisionType: "MODIFY", editedSuggestion: "Exact retained human meaning" });
  await insert("MemoryEntry", { id: "legacy-history-memory", memoryKey: "NOTE:legacy-retained", memoryType: "NOTE", title: "Retained note", description: "Human note", evidence: [] });
  await insert("ScanSession", { id: "legacy-history-completed", connectedFolderId: id("history", "root"), status: "COMPLETED", startedAt: new Date(0), completedAt: new Date(1),
    knowledgePersistenceStatus: "COMPLETED", searchIndexStatus: "COMPLETED" });
  await insert("ScannedFile", { id: "legacy-history-completed-file", sessionId: "legacy-history-completed", libraryDocumentId: "legacy-history-doc", relativePath: "history.txt",
    localPath: "bridge://history/history.txt", fileType: "TEXT", checksum, readStatus: "SUPPORTED", readingStatus: "READ", extractionStatus: "COMPLETED", processingStage: "EXAMINED" });
  await prisma.$executeRawUnsafe('UPDATE "ScannedFile" SET "libraryDocumentId"=$1 WHERE id=$2', "legacy-history-doc", id("history", "file"));
  for (const [migration, expected] of [[migration35, 35], [migration36, 36]] as const) {
    await cp(path.join("prisma/migrations", migration), path.join(temporary, "prisma/migrations", migration), { recursive: true }); deploy(); assert.equal(await count(), expected);
  }
  assert.equal(await prisma.scannedFile.count({ where: { observationClaimedAt: { not: null }, observationRootRevision: null, observationDeviceKeyFingerprint: null } }), 79);
  const activeClaim = await prisma.scannedFile.findUniqueOrThrow({ where: { id: id("active", "file") }, select: { observationClaimedAt: true } });
  const expiredClaim = await prisma.scannedFile.findUniqueOrThrow({ where: { id: id("expired", "file") }, select: { observationClaimedAt: true } });
  assert.ok(activeClaim.observationClaimedAt!.getTime() > Date.now() - 10 * 60_000, "The upgraded active owner is actually unexpired");
  assert.ok(expiredClaim.observationClaimedAt!.getTime() < Date.now() - 10 * 60_000, "The upgraded abandoned owner is actually expired");
  assert.ok((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: id("active", "old-command-0") } })).expiresAt.getTime() < Date.now());
  assert.ok((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: id("acknowledged", "old-command-0") } })).expiresAt.getTime() > Date.now());
  console.log(`LEASES verified: active=${activeClaim.observationClaimedAt!.toISOString()}, expired=${expiredClaim.observationClaimedAt!.toISOString()}, now=${new Date().toISOString()}; expired and live acknowledged commands verified.`);
  console.log("UPGRADE: actual 34 populated with 79 active/expired owners; actual 35 and 36 leave authority null.");
  // Keep the exact original 37 checkpoint before the additive queued-read fix.
  // A genuine current read can be queued between migrations 36 and 37 while
  // the FILE observation fields are still null. Capture authority on its NEW
  // signed command using the real producer; never fill the legacy file fields.
  const queuedProducer = await import("../../src/lib/bridge/remote-read-commands");
  modernQueuedCommandId = (await queuedProducer.queueRemoteReadCommand({ bridgeDeviceId: id("queued-modern", "device"), bridgeRootId: id("queued-modern", "native-root"),
    connectedLibraryId: id("queued-modern", "root"), scanSessionId: id("queued-modern", "scan"), scannedFileId: id("queued-modern", "file"),
    relativePath: "0.txt", idempotencyKey: "valid-modern-queued-before-37" })).commandId;
  // On the baseline there are no forward migrations. After the fix this deploy
  // applies only the additive repair admission; 35/36 are already applied.
  await cp("prisma/migrations/20261009180000_legacy_observation_recovery", path.join(temporary, "prisma/migrations/20261009180000_legacy_observation_recovery"), { recursive: true }); deploy(); assert.equal(await count(), 37);
  assert.equal(await prisma.scannedFile.count({ where: { legacyObservationRecoveryPending: true } }), 79);
  assert.equal(await prisma.scannedFile.count({ where: { id: { in: cases.filter((key) => key.startsWith("queued-")).map((key) => id(key, "file")) }, legacyObservationRecoveryPending: true } }), 0);
  console.log("UPGRADE: original migration 37 leaves all eight queued/unclaimed states unmarked.");
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { stdio: "pipe" });
  const applied = await count();
  assert.equal(applied, 38);
  if (applied === 38) {
    assert.equal(await prisma.scannedFile.count({ where: { legacyObservationRecoveryPending: true } }), 86);
    assert.equal((await file("queued-modern")).legacyObservationRecoveryPending, false);
    assert.equal(await prisma.scannedFile.count({ where: { legacyObservationRecoveryPending: true, observationClaimedAt: { not: null } } }), 79);
    assert.equal(await prisma.scannedFile.count({ where: { legacyObservationRecoveryPending: true,
      OR: [{ observationRootRevision: { not: null } }, { observationDeviceKeyFingerprint: { not: null } }] } }), 0);
    assert.equal((await prisma.scannedFile.findUniqueOrThrow({ where: { id: "legacy-history-completed-file" } })).legacyObservationRecoveryPending, false);
  }
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { stdio: "pipe" }); assert.equal(await count(), applied);
  recovery = await import("../../src/lib/bridge/observation-recovery"); poll = await import("../../src/lib/bridge/recoverable-commands");
  authority = await import("../../src/lib/bridge/observation-authority"); reports = await import("../../src/lib/bridge/cloud-command-results"); commands = await import("../../src/lib/bridge/cloud-coordinator");
  historical = await history();
});
after(async () => {
  await prisma?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await prisma?.$disconnect();
  if (temporary) { assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(temporary, { recursive: true, force: true }); }
});

const file = (key: string) => prisma.scannedFile.findUniqueOrThrow({ where: { id: id(key, "file") } });
const fetch = (key: string, publicKey = keys.get(key)!.publicKey) => poll.fetchRecoverableBridgeCommands(id(key, "device"), publicKey);
async function history() {
  return { decision: await prisma.humanDecision.findUniqueOrThrow({ where: { id: "legacy-history-decision" } }),
    observation: await prisma.observationSession.findUniqueOrThrow({ where: { id: "legacy-history-observation" } }),
    memory: await prisma.memoryEntry.findUniqueOrThrow({ where: { id: "legacy-history-memory" } }),
    scan: await prisma.scanSession.findUniqueOrThrow({ where: { id: "legacy-history-completed" } }),
    file: await prisma.scannedFile.findUniqueOrThrow({ where: { id: "legacy-history-completed-file" } }) };
}
async function complete(key: string) {
  const queued = await fetch(key); assert.equal(queued.length, 1, "Ordinary authorized polling must queue a fresh read");
  const command = queued[0]; assert.notEqual(command.commandId, id(key, "old-command-0"));
  const before = await file(key); assert.equal(before.observationClaimedAt, null);
  assert.equal(before.observationRootRevision, null); assert.equal(before.observationDeviceKeyFingerprint, null, "Repair never invents captured authority");
  await commands.acknowledgeBridgeCloudCommand(id(key, "device"), command.commandId);
  const report = await reports.prepareBridgeCommandReportForPersistence(id(key, "device"), { commandId: command.commandId, status: "COMPLETED", result: {
    characterCount: text.length, extractedText: text, fileName: "0.txt", fileType: "TEXT", relativePath: "0.txt", sourceChecksum: checksum, warnings: [],
  } });
  await commands.completeBridgeCloudCommand(id(key, "device"), report);
  const fresh = await file(key); assert.equal(fresh.readingStatus, "READ"); assert.equal(fresh.extractionStatus, "COMPLETED");
  assert.ok(["EXAMINED", "SUGGESTIONS_GENERATED", "RECOMMENDATIONS_READY"].includes(fresh.processingStage));
  assert.equal(fresh.observationClaimedAt, null); assert.ok(fresh.libraryDocumentId);
  assert.equal((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: command.commandId } })).status, "COMPLETED");
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: id(key, "scan") } })).status, "COMPLETED");
  return command;
}

test("LEGACY-1 pre-35 active claim rejects publication, then ordinary Bridge recovery/read admission completes", async () => {
  const old = await file("active");
  await assert.rejects(authority.withOwnedObservationLease(old.id, old.observationClaimedAt, async () => undefined), /no longer authorizes/);
  const recovered = await recovery.recoverAbandonedObservationFilesForDevice(id("active", "device"));
  const queued = await (await import("../../src/lib/bridge/remote-scan-queue")).queueRemoteReads({ bridgeDeviceId: id("active", "device"), bridgeRootId: id("active", "native-root"),
    connectedLibraryId: id("active", "root"), scanSessionId: id("active", "scan") });
  console.log(`BASELINE/REPAIR: active claim recovery=${recovered}, read admission=${queued}, stage=${(await file("active")).processingStage}`);
  const expired = await recovery.recoverAbandonedObservationFilesForDevice(id("expired", "device"));
  const expiredPoll = await fetch("expired");
  const expiry = await (await import("../../src/lib/bridge/remote-read-commands")).expireRemoteReadCommandsForSession(id("active", "scan"));
  console.log(`BASELINE/REPAIR: expired claim recovery=${expired}, poll reads=${expiredPoll.length}, stage=${(await file("expired")).processingStage}; old active command expiry=${expiry}`);
  assert.equal(recovered, 1, "The legacy owner must be durably invalidated without waiting for its old lease"); assert.equal(queued, 1);
  await complete("active");
});
test("LEGACY-2 pre-35 expired lease and terminal expired command finish through fresh polling", async () => { await complete("expired"); });
test("LEGACY-3 unexpired acknowledged obsolete read is invalidated rather than blocking fresh admission", async () => {
  await complete("acknowledged");
  assert.equal((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: id("acknowledged", "old-command-0") } })).status, "EXPIRED");
});
test("LEGACY-4 no Bridge initially: durable work survives until ordinary reconnection polling finishes", async () => {
  const initial = await file("offline");
  assert.equal((await prisma.bridgeDevice.findUniqueOrThrow({ where: { id: id("offline", "device-row") } })).status, "OFFLINE");
  assert.equal(await prisma.bridgeCommand.count({ where: { bridgeDeviceId: id("offline", "device"), status: "PENDING" } }), 0);
  assert.deepEqual(await file("offline"), initial);
  await complete("offline"); assert.equal((await file("offline")).observationRootRevision, 0);
});
test("LEGACY-5 revoked device cannot repair or dispatch legacy work", async () => {
  await commands.revokeBridgeDevice(id("revoked", "device"));
  const initial = await file("revoked"); assert.equal(await recovery.recoverAbandonedObservationFilesForDevice(id("revoked", "device")), 0);
  await assert.rejects(fetch("revoked")); assert.deepEqual(await file("revoked"), initial);
});
for (const key of ["key", "revision"] as const) test(`LEGACY-6 production ${key} change retires legacy work and late reports cannot resume it`, async () => {
  const old = await file(key);
  await assert.rejects(reports.prepareBridgeCommandReportForPersistence(id(key, "device"), { commandId: id(key, "old-command-0"), status: "FAILED", safeErrorCategory: "FILE_NOT_FOUND" }));
  if (key === "key") {
    const replacement = createBridgeKeyPair(), pairing = await commands.createBridgePairingCode();
    await commands.pairBridgeDevice({ bridgeDeviceId: id(key, "device"), deviceDisplayName: "Synthetic replacement", publicKey: replacement.publicKey,
      pairingCode: pairing.code, architecture: "arm64", platform: "MACOS", appVersion: "0.1.0" });
    await assert.rejects(fetch(key)); keys.set(key, { ...replacement, publicKey: replacement.publicKey.trim() });
  } else {
    const sync = await import("../../src/lib/bridge/device-root-sync");
    await sync.syncBridgeDeviceRoots(id(key, "device"), [{ id: id(key, "native-root"), displayName: key, safeLocation: "Synthetic upgrade root", platform: "MACOS",
      status: "CONNECTED", watcherState: "STOPPED", connectionRevision: 1, connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), readPermission: true }], keys.get(key)!.publicKey);
  }
  assert.equal(await recovery.recoverAbandonedObservationFilesForDevice(id(key, "device")), 0); assert.equal((await fetch(key)).length, 0);
  const late = await reports.prepareBridgeCommandReportForPersistence(id(key, "device"), { commandId: id(key, "old-command-0"), status: "FAILED", safeErrorCategory: "FILE_NOT_FOUND" });
  await commands.completeBridgeCloudCommand(id(key, "device"), late);
  assert.deepEqual(await file(key), old);
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: id(key, "scan") } })).status, "FAILED");
});
test("LEGACY-7 changed physical generation and superseded scans cannot resume", async () => {
  await prisma.connectedLibrary.update({ where: { id: id("physical", "root") }, data: { physicalInventoryGeneration: 1 } });
  await prisma.scanSession.update({ where: { id: id("superseded", "scan") }, data: { status: "FAILED" } });
  for (const key of ["physical", "superseded"]) {
    const initial = await file(key); assert.equal(await recovery.recoverAbandonedObservationFilesForDevice(id(key, "device")), 0);
    assert.deepEqual(await file(key), initial);
    if (key === "physical") await assert.rejects(fetch(key), /Inventory discovery preceded an authorized filesystem outcome/);
    else assert.equal((await fetch(key)).filter((command) => command.commandId !== id(key, "old-command-0")).length, 0);
    assert.deepEqual(await file(key), initial, "Even expired command settlement cannot resume changed-generation work");
  }
});
test("LEGACY-8 unavailable source is never admitted", async () => {
  await prisma.scannedFile.update({ where: { id: id("unavailable", "file") }, data: { sourceUnavailableAt: new Date(), sourceUnavailableReason: "Synthetic missing source" } });
  const initial = await file("unavailable"); assert.equal(await recovery.recoverAbandonedObservationFilesForDevice(id("unavailable", "device")), 0);
  assert.deepEqual(await file("unavailable"), initial);
});
test("LEGACY-9 concurrent recovery workers invalidate one owner once; repeated upgrade/recovery is idempotent", async () => {
  const results = await Promise.all(Array.from({ length: 4 }, () => recovery.recoverAbandonedObservationFilesForDevice(id("concurrent", "device"))));
  assert.equal(results.reduce((sum, value) => sum + value, 0), 1);
  const initial = await file("concurrent"); assert.equal(await recovery.recoverAbandonedObservationFilesForDevice(id("concurrent", "device")), 0);
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { stdio: "pipe" }); assert.deepEqual(await file("concurrent"), initial);
  await complete("concurrent");
});
test("LEGACY-10 late legacy report cannot alter a fresh owned generation or publish old bytes", async () => {
  const old = await file("late"); const queued = await fetch("late"); assert.equal(queued.length, 1);
  const freshOwner = await authority.claimObservationLease(old.id);
  const fresh = await file("late");
  await assert.rejects(authority.withOwnedObservationLease(old.id, old.observationClaimedAt, async (tx) => {
    await tx.scannedFile.update({ where: { id: old.id }, data: { processingStage: "EXAMINED" } });
  }), /ownership/);
  const report = { commandId: id("late", "old-command-0"), status: "COMPLETED" as const, result: { extractedText: "Obsolete private text" } };
  const prepared = await reports.prepareBridgeCommandReportForPersistence(id("late", "device"), report);
  await commands.completeBridgeCloudCommand(id("late", "device"), prepared);
  assert.deepEqual(await file("late"), fresh); assert.equal(fresh.observationClaimedAt?.getTime(), freshOwner.getTime());
  const obsolete = await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: report.commandId } });
  assert.equal(obsolete.status, "EXPIRED"); assert.equal(obsolete.result, null);
  assert.equal(await prisma.libraryDocument.count({ where: { rawText: "Obsolete private text" } }), 0);
});
test("LEGACY-11 current modern owner established while repair waits wins unchanged", async () => {
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>((resolve) => { ready = resolve; }), done = new Promise<void>((resolve) => { release = resolve; });
  const newer = new Date();
  const lock = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${id("race", "root")} FOR UPDATE`; ready(); await done;
    await tx.scannedFile.update({ where: { id: id("race", "file") }, data: { observationClaimedAt: newer, observationRootRevision: 0,
      observationDeviceKeyFingerprint: authority.deviceKeyFingerprint(keys.get("race")!.publicKey) } });
  }, { timeout: 30_000 });
  await held;
  const pending = recovery.recoverAbandonedObservationFilesForDevice(id("race", "device"));
  try {
    const deadline = Date.now() + 10_000; let waiting = false;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type='Lock' AND query LIKE '%ConnectedFolder%SHARE%'`);
      if (Number(rows[0].count)) { waiting = true; break; } await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(waiting, "Repair reached the actual root lock before the modern owner commits");
  } finally { release(); await lock; }
  assert.equal(await pending, 0); assert.equal((await file("race")).observationClaimedAt?.getTime(), newer.getTime());
});
test("LEGACY-12 completed history, human meaning and Memory survive; no physical operations or decisions admitted", async () => {
  await complete("history");
  // Ordinary polling legitimately consumes migration 35's Memory obligation;
  // retained history and meaning, rather than that progress marker, are fixed.
  const actual = await history(), expected = historical as Awaited<ReturnType<typeof history>>;
  assert.deepEqual(actual.decision, expected.decision); assert.deepEqual(actual.memory, expected.memory); assert.deepEqual(actual.scan, expected.scan); assert.deepEqual(actual.file, expected.file);
  assert.equal(actual.observation.status, "MODIFIED"); assert.deepEqual(actual.observation.observations, expected.observation.observations);
  assert.equal((await file("history")).libraryDocumentId, "legacy-history-doc", "Fresh verified reading retains existing human-reviewed source binding");
  assert.equal(await prisma.humanDecision.count(), 1); assert.equal(await prisma.executionRun.count(), 0); assert.equal(await prisma.undoRun.count(), 0);
  assert.equal(await prisma.bridgeCommand.count({ where: { commandType: { in: ["EXECUTE_PLAN", "EXECUTE_UNDO"] } } }), 0);
});
test("LEGACY-13 bounded eligible windows drain every legacy owner without fabricating observations", async () => {
  const observations = await prisma.observationSession.count();
  const modern = await prisma.scannedFile.create({ data: { id: "legacy-bounded-modern-control", sessionId: id("bounded", "scan"),
    relativePath: "modern.txt", localPath: "bridge://bounded/modern.txt", fileType: "TEXT", checksum, readStatus: "SUPPORTED", processingStage: "READING" } });
  await authority.claimObservationLease(modern.id);
  const current = await prisma.scannedFile.findUniqueOrThrow({ where: { id: modern.id } });
  assert.equal(await recovery.recoverAbandonedObservationFilesForDevice(id("bounded", "device")), 50);
  assert.equal(await recovery.recoverAbandonedObservationFilesForDevice(id("bounded", "device")), 11);
  assert.equal(await recovery.recoverAbandonedObservationFilesForDevice(id("bounded", "device")), 0);
  assert.equal(await prisma.scannedFile.count({ where: { sessionId: id("bounded", "scan"), id: { not: modern.id }, observationClaimedAt: { not: null } } }), 0);
  assert.equal(await prisma.scannedFile.count({ where: { sessionId: id("bounded", "scan"), processingStage: "DISCOVERED", readingStatus: "NOT_READ" } }), 61);
  assert.deepEqual(await prisma.scannedFile.findUniqueOrThrow({ where: { id: modern.id } }), current);
  assert.equal(await prisma.observationSession.count(), observations);
});

test("LEGACY-14 interrupted repair rolls back command settlement and durable admission, then ordinary polling completes", async (t) => {
  const initial = await file("fault"), command = await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: id("fault", "old-command-0") } });
  await prisma.$executeRawUnsafe(`CREATE FUNCTION legacy_repair_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${id("fault", "file")}' THEN RAISE EXCEPTION 'injected legacy repair failure'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe('CREATE TRIGGER legacy_repair_fault BEFORE UPDATE ON "ScannedFile" FOR EACH ROW EXECUTE FUNCTION legacy_repair_fault()');
  t.after(async () => { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS legacy_repair_fault ON "ScannedFile"'); });
  await assert.rejects(recovery.recoverAbandonedObservationFilesForDevice(id("fault", "device")), /injected legacy repair failure/);
  assert.deepEqual(await file("fault"), initial);
  assert.deepEqual(await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: command.commandId } }), command);
  await prisma.$executeRawUnsafe('DROP TRIGGER legacy_repair_fault ON "ScannedFile"'); await complete("fault");
});
for (const key of ["retired-race", "generation-race"] as const) test(`LEGACY-15 fresh ${key} authority after selection blocks stale repair`, async () => {
  const initial = await file(key);
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>((resolve) => { ready = resolve; }), done = new Promise<void>((resolve) => { release = resolve; });
  const lock = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${id(key, "root")} FOR UPDATE`; ready(); await done;
    if (key === "retired-race") await tx.scanSession.update({ where: { id: id(key, "scan") }, data: { status: "FAILED" } });
    else await tx.connectedLibrary.update({ where: { id: id(key, "root") }, data: { physicalInventoryGeneration: 1 } });
  }, { timeout: 30_000 });
  await held;
  const pending = recovery.recoverAbandonedObservationFilesForDevice(id(key, "device"));
  try {
    const deadline = Date.now() + 10_000; let waiting = false;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type='Lock' AND query LIKE '%ConnectedFolder%SHARE%'`);
      if (Number(rows[0].count)) { waiting = true; break; } await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(waiting);
  } finally { release(); await lock; }
  assert.equal(await pending, 0); assert.deepEqual(await file(key), initial);
});

test("LEGACY-16 each canonical denial and changed connection revision retain repair admission without resuming reads", async () => {
  const root = await prisma.connectedLibrary.findUniqueOrThrow({ where: { id: id("denied", "root") } }), initial = await file("denied");
  const states = [{ isEnabled: false }, { readPermission: false }, { status: "DISCONNECTED" as const }, { disconnectedAt: new Date() },
    { hiddenFromActiveListAt: new Date() }, { mergedAt: new Date() }, { canonicalConnectedLibraryId: id("history", "root") }, { nativeConnectionRevision: 1 }];
  for (const data of states) {
    await prisma.connectedLibrary.update({ where: { id: root.id }, data });
    assert.equal(await recovery.recoverAbandonedObservationFilesForDevice(id("denied", "device")), 0); assert.deepEqual(await file("denied"), initial);
    await prisma.connectedLibrary.update({ where: { id: root.id }, data: { isEnabled: true, readPermission: true, status: "CONNECTED", disconnectedAt: null,
      hiddenFromActiveListAt: null, mergedAt: null, canonicalConnectedLibraryId: null, nativeConnectionRevision: 0 } });
  }
  await complete("denied");
});

type SignedReply = { ok: boolean; code?: string; error?: string; commands?: import("../../packages/bridge-protocol/src").BridgeCommandEnvelope[];
  command?: { commandId: string; status: string } };
async function signedQueuedRequest(key: string, action: "poll" | "acknowledge" | "complete", commandId?: string, body?: object) {
  const deviceId = id(key, "device"), method = action === "poll" ? "GET" : "POST";
  const pathname = `/api/bridge/cloud/devices/${deviceId}/commands${action === "poll" ? "" : `/${commandId}/${action}`}`;
  const bodyText = method === "GET" ? "" : JSON.stringify(body ?? {});
  const request = new Request(`http://127.0.0.1${pathname}`, { method,
    headers: createBridgeDeviceRequestHeaders({ bridgeDeviceId: deviceId, method, pathname, bodyText, privateKey: keys.get(key)!.privateKey }),
    ...(method === "POST" ? { body: bodyText } : {}) });
  const context = { params: Promise.resolve({ deviceId, commandId: commandId ?? "" }) };
  const response = action === "poll" ? await (await import("../../src/app/api/bridge/cloud/devices/[deviceId]/commands/route")).GET(request, context)
    : action === "acknowledge" ? await (await import("../../src/app/api/bridge/cloud/devices/[deviceId]/commands/[commandId]/acknowledge/route")).POST(request, context)
    : await (await import("../../src/app/api/bridge/cloud/devices/[deviceId]/commands/[commandId]/complete/route")).POST(request, context);
  return { status: response.status, body: await response.json() as SignedReply };
}
const queuedReadResult = (sourceChecksum = checksum) => ({ characterCount: text.length, extractedText: text, fileName: "0.txt", fileType: "TEXT",
  relativePath: "0.txt", sourceChecksum, warnings: [] });
async function finishSignedQueuedRead(key: string, commandId: string) {
  assert.equal((await signedQueuedRequest(key, "acknowledge", commandId)).status, 200);
  const completed = await signedQueuedRequest(key, "complete", commandId, { status: "COMPLETED", result: queuedReadResult() });
  assert.equal(completed.status, 200); assert.equal(completed.body.ok, true); assert.equal(completed.body.command?.commandId, commandId);
  assert.equal((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId } })).status, "COMPLETED");
  const result = await file(key); assert.equal(result.readingStatus, "READ"); assert.equal(result.extractionStatus, "COMPLETED");
  assert.ok(["EXAMINED", "SUGGESTIONS_GENERATED", "RECOMMENDATIONS_READY"].includes(result.processingStage));
  assert.equal(result.observationClaimedAt, null); assert.equal(result.observationRootRevision, 0);
  assert.equal(result.observationDeviceKeyFingerprint, authority.deviceKeyFingerprint(keys.get(key)!.publicKey));
  assert.equal((await prisma.scanSession.findUniqueOrThrow({ where: { id: id(key, "scan") } })).status, "COMPLETED");
}
for (const key of ["queued-pending", "queued-acknowledged", "queued-expired"] as const) test(`LEGACY-17 ${key} unclaimed upgrade read automatically completes through signed polling after old report/expiry`, async () => {
  const initial = await file(key), oldCommandId = id(key, "old-command-0");
  assert.equal(initial.processingStage, "READING"); assert.equal(initial.readingStatus, "NOT_READ"); assert.equal(initial.extractionStatus, "PENDING");
  assert.equal(initial.observationClaimedAt, null); assert.equal(initial.observationRootRevision, null); assert.equal(initial.observationDeviceKeyFingerprint, null);
  const old = await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: oldCommandId } });
  assert.deepEqual(old.authorizationContext, {});
  if (old.status === "PENDING") assert.equal((await signedQueuedRequest(key, "acknowledge", oldCommandId)).status, 200);
  const rejected = await signedQueuedRequest(key, "complete", oldCommandId, { status: "COMPLETED", result: queuedReadResult() });
  assert.equal(rejected.status, key === "queued-expired" ? 200 : 409);
  if (key !== "queued-expired") assert.equal(rejected.body.code, "LEGACY_OBSERVATION_REQUEUE_REQUIRED");
  assert.deepEqual(await file(key), initial, "Rejected or terminal legacy replies cannot acquire a fresh owner");
  const first = await signedQueuedRequest(key, "poll"); assert.equal(first.status, 200);
  const initiallyFresh = first.body.commands!.filter((command) => command.commandId !== oldCommandId);
  // Simulate only the old command's deadline passing; never issue a human retry
  // or change primary file state. Ordinary polling must remain the consumer.
  await prisma.bridgeCommand.update({ where: { commandId: oldCommandId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const subsequent = await signedQueuedRequest(key, "poll"); assert.equal(subsequent.status, 200);
  const current = await file(key), oldAfter = await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: oldCommandId } });
  const fresh = subsequent.body.commands!.filter((command) => command.commandId !== oldCommandId);
  const expiry = await (await import("../../src/lib/bridge/remote-read-commands")).expireRemoteReadCommandsForSession(id(key, "scan"));
  console.log(`QUEUED TRACE ${key}: pre37=READING/NOT_READ/null; admitted=${initial.legacyObservationRecoveryPending}; oldReport=${rejected.status}; firstFresh=${initiallyFresh.length}; oldAfter=${oldAfter.status}; expiry=${expiry}; afterPoll=${current.processingStage}/${current.readingStatus}; fresh=${fresh.length}`);
  assert.equal(fresh.length, 1, "A queued legacy read must get a fresh authorized command, not become a terminal failed file");
  assert.equal(initial.legacyObservationRecoveryPending, true); assert.equal(initiallyFresh.length, 1);
  assert.equal(oldAfter.status, "EXPIRED");
  if (key !== "queued-expired") assert.ok(oldAfter.completedAt && oldAfter.completedAt.getTime() <= Date.now() && oldAfter.completedAt > old.issuedAt, "Legacy invalidation records the actual UTC settlement time");
  assert.equal(current.processingStage, "READING"); assert.equal(current.readingStatus, "NOT_READ");
  assert.equal(current.observationRootRevision, null); assert.equal(current.observationDeviceKeyFingerprint, null);
  assert.equal(verifyBridgeCommandSignature(fresh[0], process.env.NSN_BRIDGE_COMMAND_SIGNING_SECRET!), true);
  assert.equal((fresh[0].authorizationContext as { rootConnectionRevision: number }).rootConnectionRevision, 0);
  const beforeLate = await file(key);
  assert.equal((await signedQueuedRequest(key, "complete", oldCommandId, { status: "COMPLETED", result: queuedReadResult() })).status, 200);
  assert.deepEqual(await file(key), beforeLate, "Late obsolete reports cannot alter modern queued ownership");
  await finishSignedQueuedRead(key, fresh[0].commandId);
  assert.equal(await recovery.recoverAbandonedObservationFilesForDevice(id(key, "device")), 0);
});
test("LEGACY-18 genuine modern queued read captured between 36 and 37 keeps its command and completes", async () => {
  const initial = await file("queued-modern"); assert.equal(initial.legacyObservationRecoveryPending, false);
  assert.equal(initial.processingStage, "READING"); assert.equal(initial.observationClaimedAt, null);
  assert.equal(initial.observationRootRevision, null); assert.equal(initial.observationDeviceKeyFingerprint, null);
  const original = await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: modernQueuedCommandId } });
  assert.equal(await recovery.recoverAbandonedObservationFilesForDevice(id("queued-modern", "device")), 0);
  const polled = await signedQueuedRequest("queued-modern", "poll"); assert.equal(polled.status, 200);
  assert.deepEqual(polled.body.commands!.map((command) => command.commandId), [modernQueuedCommandId]);
  assert.deepEqual(await file("queued-modern"), initial);
  assert.deepEqual(await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: modernQueuedCommandId } }), original);
  assert.equal(verifyBridgeCommandSignature(polled.body.commands![0], process.env.NSN_BRIDGE_COMMAND_SIGNING_SECRET!), true);
  console.log("QUEUED TRACE modern: marker=false; same signed command delivered; file and command unchanged before completion");
  await finishSignedQueuedRead("queued-modern", modernQueuedCommandId);
});
for (const key of ["queued-revoked", "queued-generation"] as const) test(`LEGACY-19 ${key} cannot resume unclaimed legacy work under denied root or generation`, async () => {
  assert.equal((await file(key)).legacyObservationRecoveryPending, true);
  if (key === "queued-revoked") await commands.revokeBridgeDevice(id(key, "device"));
  else await prisma.connectedLibrary.update({ where: { id: id(key, "root") }, data: { physicalInventoryGeneration: 1 } });
  const initial = await file(key);
  assert.equal(await recovery.recoverAbandonedObservationFilesForDevice(id(key, "device")), 0);
  const denied = await signedQueuedRequest(key, "poll");
  if (key === "queued-revoked") { assert.equal(denied.status, 401); assert.equal(denied.body.ok, false); }
  else {
    assert.equal(denied.status, 200);
    assert.deepEqual(denied.body.commands!.map((command) => command.commandId), [id(key, "old-command-0")], "No fresh authorized read resumes an obsolete physical generation");
    await assert.rejects(prisma.$transaction(async (tx) => {
      await (await import("../../src/lib/bridge/execution-reconciliation")).assertInventoryAfterPhysicalOutcomes(tx, id(key, "root"), 0);
    }), /Inventory discovery preceded/);
  }
  const late = await signedQueuedRequest(key, "complete", id(key, "old-command-0"), { status: "COMPLETED", result: queuedReadResult() });
  assert.equal(late.status, key === "queued-generation" ? 409 : 200);
  assert.deepEqual(await file(key), initial); assert.equal(await prisma.bridgeCommand.count({ where: { bridgeDeviceId: id(key, "device"), status: "PENDING" } }), 0);
});
test("LEGACY-20 fresh queued replacement still rejects a source checksum mismatch without observation success", async () => {
  const key = "queued-checksum", polled = await signedQueuedRequest(key, "poll"); assert.equal(polled.status, 200);
  const command = polled.body.commands![0]; assert.notEqual(command.commandId, id(key, "old-command-0"));
  assert.equal((await signedQueuedRequest(key, "acknowledge", command.commandId)).status, 200);
  const reported = await signedQueuedRequest(key, "complete", command.commandId, { status: "COMPLETED", result: queuedReadResult("f".repeat(64)) });
  assert.equal(reported.status, 200);
  const failed = await file(key); assert.equal(failed.processingStage, "FAILED"); assert.equal(failed.readingStatus, "FAILED");
  assert.equal(failed.processingErrorCategory, "FILE_CHANGED_SINCE_SCAN"); assert.equal(failed.libraryDocumentId, null);
  assert.equal(failed.observationClaimedAt, null); assert.equal(failed.checksum, checksum);
});
test("LEGACY-21 modern queued command established while repair waits wins without a file observation lease", async () => {
  const key = "queued-race", initial = await file(key); assert.equal(initial.legacyObservationRecoveryPending, true);
  let release!: () => void, ready!: () => void, commandId!: string;
  const held = new Promise<void>((resolve) => { ready = resolve; }), done = new Promise<void>((resolve) => { release = resolve; });
  const lock = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${id(key, "device")} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${id(key, "root")} FOR UPDATE`; ready(); await done;
    await tx.bridgeCommand.update({ where: { commandId: id(key, "old-command-0") }, data: { status: "EXPIRED", completedAt: new Date() } });
    commandId = (await (await import("../../src/lib/bridge/remote-read-commands")).queueRemoteReadCommand({ bridgeDeviceId: id(key, "device"),
      bridgeRootId: id(key, "native-root"), connectedLibraryId: id(key, "root"), scanSessionId: id(key, "scan"), scannedFileId: id(key, "file"),
      relativePath: "0.txt", idempotencyKey: "modern-queued-race" }, tx)).commandId;
  }, { timeout: 30_000 });
  await held;
  const pending = recovery.recoverAbandonedObservationFilesForDevice(id(key, "device"));
  try {
    const deadline = Date.now() + 10_000; let waiting = false;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%ConnectedFolder%SHARE%'`);
      if (Number(rows[0].count)) { waiting = true; break; } await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(waiting, "Legacy selection reached the root lock before modern queued ownership commits");
  } finally { release(); await lock; }
  assert.equal(await pending, 0); assert.deepEqual(await file(key), initial);
  assert.equal((await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId } })).status, "PENDING");
  const polled = await signedQueuedRequest(key, "poll"); assert.equal(polled.status, 200);
  assert.deepEqual(polled.body.commands!.map((command) => command.commandId), [commandId]);
  await finishSignedQueuedRead(key, commandId);
});
