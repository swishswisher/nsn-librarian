import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { createBridgeServer } from "../../bridge-app/src/api/server";
import { createFolderSelection } from "../../bridge-app/src/main/registry";
import type { ConnectedLibraryPermissions } from "../../src/lib/bridge/types";

let prisma: PrismaClient;
let bridgeServer: Server;
let tempRoot: string;
let testDatabaseUrl: string;
let testDirectDatabaseUrl: string;
let previousBridgeDataDir: string | undefined;
let previousBridgeUrl: string | undefined;
let previousDatabaseUrl: string | undefined;
let previousDirectDatabaseUrl: string | undefined;
let previousDeveloperFallback: string | undefined;
let previousOpenAIKey: string | undefined;

let connectBridgeLibrary: typeof import("../../src/lib/bridge/connected-libraries").connectBridgeLibrary;
let registerLocalBridgeRoot: typeof import("../../src/lib/bridge/local-bridge-client").registerLocalBridgeRoot;
let scanLocalBridgeRoot: typeof import("../../src/lib/bridge/local-bridge-client").scanLocalBridgeRoot;
let updateLocalBridgeRoot: typeof import("../../src/lib/bridge/local-bridge-client").updateLocalBridgeRoot;
let createBridgeScanSessionFromScan: typeof import("../../src/lib/bridge/scan-sessions").createBridgeScanSessionFromScan;
let generateOrganizationPlanForScanSession: typeof import("../../src/lib/bridge/planner").generateOrganizationPlanForScanSession;
let approveOrganizationPlan: typeof import("../../src/lib/bridge/planner").approveOrganizationPlan;
let saveOrganizationPlanSelection: typeof import("../../src/lib/bridge/planner").saveOrganizationPlanSelection;
let clearOrganizationPlanSelection: typeof import("../../src/lib/bridge/planner").clearOrganizationPlanSelection;
let executeOrganizationPlan: typeof import("../../src/lib/bridge/executor").executeOrganizationPlan;
let previewExecutionUndo: typeof import("../../src/lib/bridge/undo").previewExecutionUndo;
let executeExecutionUndo: typeof import("../../src/lib/bridge/undo").executeExecutionUndo;
let recordChecksumDuplicateSuggestionsForSession: typeof import("../../src/lib/bridge/checksum-duplicates").recordChecksumDuplicateSuggestionsForSession;
let resetOrganizationSuggestionDecision: typeof import("../../src/lib/bridge/organization-suggestions").resetOrganizationSuggestionDecision;
let resetOrganizationSuggestionDecisionsForScanSession: typeof import("../../src/lib/bridge/organization-suggestions").resetOrganizationSuggestionDecisionsForScanSession;

const testSchemaName = `connected_library_execution_${process.pid}_${Date.now()}`;

const executionPermissions: ConnectedLibraryPermissions = {
  createFolderPermission: true,
  moveFilePermission: true,
  organizationPlanPermission: true,
  readPermission: true,
  recommendationPermission: true,
  renameFilePermission: true,
  watchPermission: false,
};

function databaseUrlForSchema(
  schemaName: string,
  databaseUrl = process.env.DATABASE_URL,
) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Connected Library execution tests.");
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

function listen(server: Server) {
  return new Promise<{ port: number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;

      assert.ok(address);
      resolve({ port: address.port });
    });
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function exists(filePath: string) {
  return stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function resetTestData() {
  await prisma.undoAction.deleteMany();
  await prisma.undoRun.deleteMany();
  await prisma.executionAction.deleteMany();
  await prisma.monitoringEvent.deleteMany();
  await prisma.executionRun.deleteMany();
  await prisma.notebookEntryRevision.deleteMany();
  await prisma.notebookEntry.deleteMany();
  await prisma.organizationPlan.deleteMany();
  await prisma.organizationSuggestionRevision.deleteMany();
  await prisma.organizationSuggestion.deleteMany();
  await prisma.scannedFile.deleteMany();
  await prisma.scanSession.deleteMany();
  await prisma.monitoringBatch.deleteMany();
  await prisma.connectedLibrary.deleteMany();
}

async function createConnectedFixture(
  folderName: string,
  files: Record<string, string>,
  permissions: ConnectedLibraryPermissions = executionPermissions,
) {
  const folderPath = path.join(tempRoot, folderName);

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(
      folderPath,
      ...relativePath.split("/").filter(Boolean),
    );

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }

  const selection = await createFolderSelection(folderPath);
  const root = await registerLocalBridgeRoot({
    displayName: folderName,
    permissions,
    selectionToken: selection.selectionToken,
  });
  const connected = await connectBridgeLibrary({
    root,
    updateExistingPermissions: true,
  });
  const scan = await scanLocalBridgeRoot(root.id);
  const session = await createBridgeScanSessionFromScan(scan, {
    allowReusableSession: false,
    connectedLibraryId: connected.library.id,
  });
  const scannedFiles = await prisma.scannedFile.findMany({
    orderBy: {
      relativePath: "asc",
    },
    where: {
      sessionId: session.id,
    },
  });

  return {
    connectedLibrary: connected.library,
    folderPath,
    root,
    scannedFiles,
    session,
  };
}

function scannedFileByRelativePath(
  files: Awaited<ReturnType<typeof createConnectedFixture>>["scannedFiles"],
  relativePath: string,
) {
  const file = files.find((item) => item.relativePath === relativePath);

  assert.ok(file, `Expected scanned file ${relativePath}`);

  return file;
}

async function createSuggestion(input: {
  currentRelativePath: string;
  proposedFileName?: string | null;
  proposedRelativePath?: string | null;
  scannedFileId: string;
  scanSessionId: string;
  status?: "APPROVED" | "MODIFIED" | "REJECTED" | "LEFT_UNCHANGED" | "PENDING";
  suggestionKey: string;
  suggestionType?:
    | "MOVE_FILE"
    | "RENAME_FILE"
    | "GROUP_WITH_FILES"
    | "POSSIBLE_DUPLICATE"
    | "WEBSITE_CANDIDATE"
    | "KEEP_UNCHANGED";
}) {
  return prisma.organizationSuggestion.create({
    data: {
      confidence: 0.86,
      currentRelativePath: input.currentRelativePath,
      explanation:
        "The Librarian noticed a reviewed organization pattern for this file.",
      proposedFileName: input.proposedFileName ?? null,
      proposedRelativePath: input.proposedRelativePath ?? null,
      reviewedAt:
        input.status === "APPROVED" || input.status === "MODIFIED"
          ? new Date()
          : null,
      scanSessionId: input.scanSessionId,
      scannedFileId: input.scannedFileId,
      status: input.status ?? "APPROVED",
      suggestionKey: `connected-execution:${input.suggestionKey}`,
      suggestionType: input.suggestionType ?? "MOVE_FILE",
      supportingInformation: [
        "Approved Memory used: organize attachment materials together",
      ],
      title: "Organize reviewed file",
      whySuggested: [
        "This matched a reviewed folder preference and related concepts.",
      ],
    },
  });
}

async function approveMoveAndRenamePlan(
  folderName: string,
  sourceRelativePath = "Documents/Notes/Unsorted/session-notes-final-3.txt",
  destinationRelativePath = "Knowledge/Attachment/attachment-session-notes.txt",
) {
  const fixture = await createConnectedFixture(folderName, {
    [sourceRelativePath]: "Attachment workshop notes\n",
  });
  const sourceFile = scannedFileByRelativePath(
    fixture.scannedFiles,
    sourceRelativePath,
  );

  await createSuggestion({
    currentRelativePath: sourceRelativePath,
    proposedRelativePath: destinationRelativePath,
    scannedFileId: sourceFile.id,
    scanSessionId: fixture.session.id,
    suggestionKey: `${folderName}:move-rename`,
  });

  const draftPlan = await generateOrganizationPlanForScanSession(
    fixture.session.id,
  );
  const selectedPlan = await saveOrganizationPlanSelection(
    draftPlan.id,
    draftPlan.actions
      .filter(
        (action) =>
          action.actionType === "MOVE_FILE" ||
          action.actionType === "RENAME_FILE" ||
          action.actionType === "MOVE_AND_RENAME_FILE",
      )
      .map((action) => action.id),
  );
  const plan = await approveOrganizationPlan(selectedPlan.id);

  return {
    ...fixture,
    destinationRelativePath,
    plan,
    sourceFile,
    sourceRelativePath,
  };
}

before(async () => {
  previousBridgeDataDir = process.env.NSN_BRIDGE_DATA_DIR;
  previousBridgeUrl = process.env.NSN_LOCAL_BRIDGE_URL;
  previousDatabaseUrl = process.env.DATABASE_URL;
  previousDirectDatabaseUrl = process.env.DIRECT_URL;
  previousDeveloperFallback = process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK;
  previousOpenAIKey = process.env.OPENAI_API_KEY;

  testDatabaseUrl = databaseUrlForSchema(testSchemaName);
  testDirectDatabaseUrl = databaseUrlForSchema(
    testSchemaName,
    process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  );
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "nsn-execution-test-"));
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.DIRECT_URL = testDirectDatabaseUrl;
  process.env.NSN_BRIDGE_DATA_DIR = path.join(tempRoot, ".bridge-data");
  process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK = "false";
  process.env.OPENAI_API_KEY = "";

  runPrismaDbPush();

  bridgeServer = createBridgeServer();
  const address = await listen(bridgeServer);
  process.env.NSN_LOCAL_BRIDGE_URL = `http://127.0.0.1:${address.port}`;

  const prismaModule = await import("../../src/lib/db/prisma");
  const connectedLibraries = await import("../../src/lib/bridge/connected-libraries");
  const localBridgeClient = await import("../../src/lib/bridge/local-bridge-client");
  const scanSessions = await import("../../src/lib/bridge/scan-sessions");
  const planner = await import("../../src/lib/bridge/planner");
  const executor = await import("../../src/lib/bridge/executor");
  const undo = await import("../../src/lib/bridge/undo");
  const duplicates = await import("../../src/lib/bridge/checksum-duplicates");
  const organizationSuggestions = await import(
    "../../src/lib/bridge/organization-suggestions"
  );

  prisma = prismaModule.getPrismaClient();
  connectBridgeLibrary = connectedLibraries.connectBridgeLibrary;
  registerLocalBridgeRoot = localBridgeClient.registerLocalBridgeRoot;
  scanLocalBridgeRoot = localBridgeClient.scanLocalBridgeRoot;
  updateLocalBridgeRoot = localBridgeClient.updateLocalBridgeRoot;
  createBridgeScanSessionFromScan =
    scanSessions.createBridgeScanSessionFromScan;
  generateOrganizationPlanForScanSession =
    planner.generateOrganizationPlanForScanSession;
  approveOrganizationPlan = planner.approveOrganizationPlan;
  saveOrganizationPlanSelection = planner.saveOrganizationPlanSelection;
  clearOrganizationPlanSelection = planner.clearOrganizationPlanSelection;
  executeOrganizationPlan = executor.executeOrganizationPlan;
  previewExecutionUndo = undo.previewExecutionUndo;
  executeExecutionUndo = undo.executeExecutionUndo;
  recordChecksumDuplicateSuggestionsForSession =
    duplicates.recordChecksumDuplicateSuggestionsForSession;
  resetOrganizationSuggestionDecision =
    organizationSuggestions.resetOrganizationSuggestionDecision;
  resetOrganizationSuggestionDecisionsForScanSession =
    organizationSuggestions.resetOrganizationSuggestionDecisionsForScanSession;
});

beforeEach(async () => {
  await resetTestData();
});

after(async () => {
  await prisma?.$disconnect();
  await closeServer(bridgeServer);
  await rm(tempRoot, { force: true, recursive: true });

  const cleanupPrisma = new PrismaClient();

  await cleanupPrisma.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`,
  );
  await cleanupPrisma.$disconnect();

  if (previousBridgeDataDir === undefined) {
    delete process.env.NSN_BRIDGE_DATA_DIR;
  } else {
    process.env.NSN_BRIDGE_DATA_DIR = previousBridgeDataDir;
  }

  if (previousBridgeUrl === undefined) {
    delete process.env.NSN_LOCAL_BRIDGE_URL;
  } else {
    process.env.NSN_LOCAL_BRIDGE_URL = previousBridgeUrl;
  }

  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }

  if (previousDirectDatabaseUrl === undefined) {
    delete process.env.DIRECT_URL;
  } else {
    process.env.DIRECT_URL = previousDirectDatabaseUrl;
  }

  if (previousDeveloperFallback === undefined) {
    delete process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK;
  } else {
    process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK =
      previousDeveloperFallback;
  }

  if (previousOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousOpenAIKey;
  }
});

test("reviewed recommendations produce one folder-specific plan with deduped folder actions", async () => {
  const sourceA = "Documents/Notes/Unsorted/session-notes-final-3.txt";
  const sourceB = "Documents/Notes/Unsorted/recovery-note.txt";
  const sourceC = "Documents/Notes/Unsorted/rejected-note.txt";
  const fixture = await createConnectedFixture("plan-conversion", {
    [sourceA]: "Attachment notes",
    [sourceB]: "Recovery notes",
    [sourceC]: "Rejected notes",
  });
  const fileA = scannedFileByRelativePath(fixture.scannedFiles, sourceA);
  const fileB = scannedFileByRelativePath(fixture.scannedFiles, sourceB);
  const fileC = scannedFileByRelativePath(fixture.scannedFiles, sourceC);
  const modified = await createSuggestion({
    currentRelativePath: sourceB,
    proposedRelativePath: "Knowledge/Attachment/recovery-note.txt",
    scannedFileId: fileB.id,
    scanSessionId: fixture.session.id,
    status: "MODIFIED",
    suggestionKey: "modified",
  });

  await prisma.organizationSuggestionRevision.create({
    data: {
      context: "Deanne preferred Becoming language for this file.",
      revisedRelativePath: "Knowledge/Attachment/becoming-note.txt",
      suggestionId: modified.id,
    },
  });

  await createSuggestion({
    currentRelativePath: sourceA,
    proposedRelativePath: "Knowledge/Attachment/attachment-session-notes.txt",
    scannedFileId: fileA.id,
    scanSessionId: fixture.session.id,
    suggestionKey: "approved",
  });
  await createSuggestion({
    currentRelativePath: sourceC,
    proposedRelativePath: "Knowledge/Attachment/rejected-note.txt",
    scannedFileId: fileC.id,
    scanSessionId: fixture.session.id,
    status: "REJECTED",
    suggestionKey: "rejected",
  });
  await createSuggestion({
    currentRelativePath: sourceC,
    proposedRelativePath: sourceC,
    scannedFileId: fileC.id,
    scanSessionId: fixture.session.id,
    status: "LEFT_UNCHANGED",
    suggestionKey: "unchanged",
    suggestionType: "KEEP_UNCHANGED",
  });

  const draftPlan = await generateOrganizationPlanForScanSession(fixture.session.id);
  const draftFileActions = draftPlan.actions.filter(
    (action) => action.selectableForExecution,
  );

  assert.equal(draftPlan.summary.estimatedOperations, 0);
  assert.equal(draftPlan.summary.selectedFileActions, 0);
  assert.equal(
    draftPlan.actions.some((action) => action.selectedForExecution),
    false,
  );

  const plan = await saveOrganizationPlanSelection(
    draftPlan.id,
    draftFileActions.map((action) => action.id),
  );
  const folderActions = plan.actions.filter(
    (action) => action.actionType === "CREATE_FOLDER",
  );
  const fileActions = plan.actions.filter(
    (action) => action.actionType === "MOVE_AND_RENAME_FILE",
  );

  assert.equal(plan.connectedLibraryId, fixture.connectedLibrary.id);
  assert.equal(plan.approvedActions, 1);
  assert.equal(plan.modifiedActions, 1);
  assert.equal(plan.rejectedActions, 1);
  assert.equal(plan.unchangedActions, 1);
  assert.deepEqual(
    folderActions.map((action) => action.plannedFolderPath).sort(),
    ["Knowledge", "Knowledge/Attachment"],
  );
  assert.equal(fileActions.length, 2);
  assert.ok(
    fileActions.some(
      (action) =>
        action.plannedRelativePath ===
        "Knowledge/Attachment/becoming-note.txt",
    ),
  );
  assert.ok(
    !plan.actions.some(
      (action) => action.plannedRelativePath === "Knowledge/Attachment/rejected-note.txt",
    ),
  );
});

test("historical scans do not mark the same physical path as its own duplicate", async () => {
  const fixture = await createConnectedFixture("historical-identity", {
    "Documents/Same-File.txt": "same physical file\n",
  });

  const rescan = await scanLocalBridgeRoot(fixture.root.id);
  const secondSession = await createBridgeScanSessionFromScan(rescan, {
    allowReusableSession: false,
    connectedLibraryId: fixture.connectedLibrary.id,
  });

  const result = await recordChecksumDuplicateSuggestionsForSession(secondSession.id);
  const duplicateSuggestions = await prisma.organizationSuggestion.findMany({
    where: {
      scanSessionId: secondSession.id,
      suggestionType: "POSSIBLE_DUPLICATE",
      confidence: {
        gte: 0.98,
      },
    },
  });

  assert.equal(result.duplicateFiles, 0);
  assert.equal(duplicateSuggestions.length, 0);
});

test("non-empty checksum duplicates remain detectable within and across roots", async () => {
  const rootA = await createConnectedFixture("duplicate-root-a", {
    "A/original.txt": "duplicate body\n",
    "B/copy.txt": "duplicate body\n",
  });

  await recordChecksumDuplicateSuggestionsForSession(rootA.session.id);

  let sameRootDuplicates = await prisma.organizationSuggestion.findMany({
    where: {
      scanSessionId: rootA.session.id,
      suggestionType: "POSSIBLE_DUPLICATE",
      confidence: {
        gte: 0.98,
      },
    },
  });

  assert.equal(sameRootDuplicates.length, 2);

  const rootB = await createConnectedFixture("duplicate-root-b", {
    "Archive/cross-root-copy.txt": "duplicate body\n",
  });

  await recordChecksumDuplicateSuggestionsForSession(rootA.session.id);
  await recordChecksumDuplicateSuggestionsForSession(rootB.session.id);

  sameRootDuplicates = await prisma.organizationSuggestion.findMany({
    where: {
      scanSessionId: rootA.session.id,
      suggestionType: "POSSIBLE_DUPLICATE",
      confidence: {
        gte: 0.98,
      },
    },
  });
  const crossRootDuplicates = await prisma.organizationSuggestion.findMany({
    where: {
      scanSessionId: rootB.session.id,
      suggestionType: "POSSIBLE_DUPLICATE",
      confidence: {
        gte: 0.98,
      },
    },
  });

  assert.equal(sameRootDuplicates.length, 2);
  assert.equal(crossRootDuplicates.length, 1);
});

test("zero-byte files do not create exact duplicates but media checksum duplicates do", async () => {
  const audioBytes = "\u0000\u0001not-a-transcribed-audio-fixture";
  const fixture = await createConnectedFixture("zero-byte-duplicates", {
    "Empty/one.txt": "",
    "Empty/two.txt": "",
    "Media/meeting-a.mp3": audioBytes,
    "Media/meeting-b.mp3": audioBytes,
    "Documents/unrelated.txt": "not a duplicate\n",
  });

  await recordChecksumDuplicateSuggestionsForSession(fixture.session.id);

  const suggestions = await prisma.organizationSuggestion.findMany({
    orderBy: {
      currentRelativePath: "asc",
    },
    where: {
      scanSessionId: fixture.session.id,
      suggestionType: "POSSIBLE_DUPLICATE",
      confidence: {
        gte: 0.98,
      },
    },
  });

  assert.deepEqual(
    suggestions.map((suggestion) => suggestion.currentRelativePath),
    ["Media/meeting-a.mp3", "Media/meeting-b.mp3"],
  );
});

test("plan selection starts empty, derives folder dependencies, and excludes review-only notes", async () => {
  const source = "Loose/Alice_Client_Intake.docx";
  const websiteNote = "Website/becoming-hero.jpg";
  const fixture = await createConnectedFixture("plan-selection", {
    [source]: "Alice intake\n",
    [websiteNote]: "image placeholder\n",
  });
  const sourceFile = scannedFileByRelativePath(fixture.scannedFiles, source);
  const websiteFile = scannedFileByRelativePath(fixture.scannedFiles, websiteNote);

  await createSuggestion({
    currentRelativePath: source,
    proposedRelativePath: "Clients/Alice/Alice_Client_Intake.docx",
    scannedFileId: sourceFile.id,
    scanSessionId: fixture.session.id,
    suggestionKey: "selectable-move",
  });
  await createSuggestion({
    currentRelativePath: websiteNote,
    proposedRelativePath: websiteNote,
    scannedFileId: websiteFile.id,
    scanSessionId: fixture.session.id,
    suggestionKey: "website-note",
    suggestionType: "WEBSITE_CANDIDATE",
  });

  const draftPlan = await generateOrganizationPlanForScanSession(fixture.session.id);
  const fileAction = draftPlan.actions.find((action) => action.selectableForExecution);
  const reviewOnly = draftPlan.actions.find(
    (action) => action.actionType === "WEBSITE_ACTION",
  );

  assert.ok(fileAction);
  assert.ok(reviewOnly);
  assert.equal(draftPlan.summary.selectedFileActions, 0);
  assert.equal(draftPlan.summary.estimatedOperations, 0);
  await assert.rejects(
    () => approveOrganizationPlan(draftPlan.id),
    /Select and save at least one file action/,
  );

  const selectedPlan = await saveOrganizationPlanSelection(draftPlan.id, [
    fileAction.id,
  ]);

  assert.equal(selectedPlan.summary.selectedFileActions, 1);
  assert.equal(selectedPlan.summary.reviewOnlyNotes, 1);
  assert.deepEqual(
    selectedPlan.actions
      .filter((action) => action.requiredForSelectedActions)
      .map((action) => action.plannedFolderPath)
      .sort(),
    ["Clients", "Clients/Alice"],
  );
  assert.equal(
    selectedPlan.actions.some(
      (action) =>
        action.actionType === "WEBSITE_ACTION" &&
        action.selectedForExecution === true,
    ),
    false,
  );

  const clearedPlan = await clearOrganizationPlanSelection(selectedPlan.id);

  assert.equal(clearedPlan.summary.selectedFileActions, 0);
  assert.equal(clearedPlan.summary.estimatedOperations, 0);
});

test("conflicting source destinations block selected draft actions server-side", async () => {
  const source = "Clients/Loose/Alice_Client_Intake.docx";
  const fixture = await createConnectedFixture("plan-source-conflict", {
    [source]: "Alice intake\n",
  });
  const sourceFile = scannedFileByRelativePath(fixture.scannedFiles, source);

  await createSuggestion({
    currentRelativePath: source,
    proposedRelativePath: "Alice/Alice_Client_Intake.docx",
    scannedFileId: sourceFile.id,
    scanSessionId: fixture.session.id,
    suggestionKey: "alice-destination",
  });
  await createSuggestion({
    currentRelativePath: source,
    proposedRelativePath: "Clinical Tools/Alice_Client_Intake.docx",
    scannedFileId: sourceFile.id,
    scanSessionId: fixture.session.id,
    suggestionKey: "clinical-tools-destination",
  });

  const draftPlan = await generateOrganizationPlanForScanSession(fixture.session.id);
  const fileActionIds = draftPlan.actions
    .filter((action) => action.selectableForExecution)
    .map((action) => action.id);

  assert.equal(
    draftPlan.warnings.some(
      (warning) => warning.warningType === "DUPLICATE_SOURCE",
    ),
    true,
  );
  await assert.rejects(
    () => saveOrganizationPlanSelection(draftPlan.id, fileActionIds),
    /more than one destination/,
  );

  const selectedPlan = await saveOrganizationPlanSelection(draftPlan.id, [
    fileActionIds[0] as string,
  ]);

  assert.equal(selectedPlan.summary.selectedFileActions, 1);
  assert.equal(selectedPlan.summary.blockingWarnings, 0);
});

test("malformed plan selection rejects unknown review-only and duplicate destination actions", async () => {
  const sourceA = "Loose/a.txt";
  const sourceB = "Loose/b.txt";
  const sourceC = "Web/hero.jpg";
  const fixture = await createConnectedFixture("malformed-selection", {
    [sourceA]: "a\n",
    [sourceB]: "b\n",
    [sourceC]: "c\n",
  });
  const fileA = scannedFileByRelativePath(fixture.scannedFiles, sourceA);
  const fileB = scannedFileByRelativePath(fixture.scannedFiles, sourceB);
  const fileC = scannedFileByRelativePath(fixture.scannedFiles, sourceC);

  await createSuggestion({
    currentRelativePath: sourceA,
    proposedRelativePath: "Organized/shared.txt",
    scannedFileId: fileA.id,
    scanSessionId: fixture.session.id,
    suggestionKey: "destination-a",
  });
  await createSuggestion({
    currentRelativePath: sourceB,
    proposedRelativePath: "Organized/shared.txt",
    scannedFileId: fileB.id,
    scanSessionId: fixture.session.id,
    suggestionKey: "destination-b",
  });
  await createSuggestion({
    currentRelativePath: sourceC,
    proposedRelativePath: sourceC,
    scannedFileId: fileC.id,
    scanSessionId: fixture.session.id,
    suggestionKey: "review-only",
    suggestionType: "WEBSITE_CANDIDATE",
  });

  const draftPlan = await generateOrganizationPlanForScanSession(fixture.session.id);
  const fileActionIds = draftPlan.actions
    .filter((action) => action.selectableForExecution)
    .map((action) => action.id);
  const reviewOnlyAction = draftPlan.actions.find(
    (action) => action.actionType === "WEBSITE_ACTION",
  );

  assert.ok(reviewOnlyAction);
  await assert.rejects(
    () => saveOrganizationPlanSelection(draftPlan.id, []),
    /Select at least one file action/,
  );
  await assert.rejects(
    () => saveOrganizationPlanSelection(draftPlan.id, ["missing-action"]),
    /could not verify/,
  );
  await assert.rejects(
    () => saveOrganizationPlanSelection(draftPlan.id, [reviewOnlyAction.id]),
    /Only move and rename file recommendations/,
  );
  await assert.rejects(
    () => saveOrganizationPlanSelection(draftPlan.id, fileActionIds),
    /proposed by more than one action/,
  );

  await prisma.organizationPlan.update({
    data: {
      actions: [
        {
          ...(draftPlan.actions.find((action) => action.selectableForExecution) ?? {}),
          id: "unsafe-direct-action",
          plannedRelativePath: "../outside.txt",
          selectedForExecution: true,
        },
      ],
    },
    where: {
      id: draftPlan.id,
    },
  });

  await assert.rejects(
    () => approveOrganizationPlan(draftPlan.id),
    /safety issues|outside|path/,
  );
});

test("resetting recommendation decisions is session-scoped and blocked by active plans", async () => {
  const sessionA = await createConnectedFixture("reset-session-a", {
    "Loose/a.txt": "a\n",
  });
  const sessionB = await createConnectedFixture("reset-session-b", {
    "Loose/b.txt": "b\n",
  });
  const fileA = scannedFileByRelativePath(sessionA.scannedFiles, "Loose/a.txt");
  const fileB = scannedFileByRelativePath(sessionB.scannedFiles, "Loose/b.txt");
  const suggestionA = await createSuggestion({
    currentRelativePath: "Loose/a.txt",
    proposedRelativePath: "Organized/a.txt",
    scannedFileId: fileA.id,
    scanSessionId: sessionA.session.id,
    suggestionKey: "reset-a",
  });
  await createSuggestion({
    currentRelativePath: "Loose/b.txt",
    proposedRelativePath: "Organized/b.txt",
    scannedFileId: fileB.id,
    scanSessionId: sessionB.session.id,
    suggestionKey: "reset-b",
  });
  const originalPath = path.join(sessionA.folderPath, "Loose", "a.txt");

  const resetSingle = await resetOrganizationSuggestionDecision(
    suggestionA.id,
    sessionA.session.id,
  );

  assert.equal(resetSingle.status, "PENDING");
  assert.equal(await exists(originalPath), true);

  await createSuggestion({
    currentRelativePath: "Loose/a.txt",
    proposedRelativePath: "Organized/a-2.txt",
    scannedFileId: fileA.id,
    scanSessionId: sessionA.session.id,
    suggestionKey: "reset-a-second",
  });
  const activePlan = await generateOrganizationPlanForScanSession(
    sessionA.session.id,
  );

  await assert.rejects(
    () => resetOrganizationSuggestionDecisionsForScanSession(sessionA.session.id),
    /Cancel the active Organization Plan/,
  );

  await prisma.organizationPlan.update({
    data: {
      status: "CANCELLED",
    },
    where: {
      id: activePlan.id,
    },
  });

  const resetBulk = await resetOrganizationSuggestionDecisionsForScanSession(
    sessionA.session.id,
  );
  const sessionBReviewed = await prisma.organizationSuggestion.count({
    where: {
      scanSessionId: sessionB.session.id,
      status: "APPROVED",
    },
  });

  assert.ok(resetBulk.resetCount >= 1);
  assert.equal(sessionBReviewed, 1);
  assert.equal(await exists(originalPath), true);
});

test("approved plan executes through the Bridge and refuses repeated execution", async () => {
  const fixture = await approveMoveAndRenamePlan("bridge-execution");
  const originalPath = path.join(
    fixture.folderPath,
    ...fixture.sourceRelativePath.split("/"),
  );
  const destinationPath = path.join(
    fixture.folderPath,
    ...fixture.destinationRelativePath.split("/"),
  );

  const result = await executeOrganizationPlan(fixture.plan.id, "EXECUTE");

  assert.equal(await exists(originalPath), false);
  assert.equal(await exists(destinationPath), true);
  assert.equal(await readFile(destinationPath, "utf8"), "Attachment workshop notes\n");
  assert.equal(result.run.status, "COMPLETED");
  assert.equal(result.run.connectedLibraryId, fixture.connectedLibrary.id);
  assert.equal(result.run.bridgeRootId, fixture.root.id);
  assert.equal(result.run.reconciliationStatus, "COMPLETED");
  assert.ok(result.run.permissionSnapshot);
  assert.ok(
    result.run.actions.some(
      (action) =>
        action.actionType === "MOVE_AND_RENAME_FILE" &&
        action.sourceChecksumBefore &&
        action.destinationChecksumAfter,
    ),
  );

  await assert.rejects(
    () => executeOrganizationPlan(fixture.plan.id, "EXECUTE"),
    /safety issues/,
  );
});

test("destination conflicts block execution before any filesystem change", async () => {
  const fixture = await approveMoveAndRenamePlan("overwrite-block");
  const originalPath = path.join(
    fixture.folderPath,
    ...fixture.sourceRelativePath.split("/"),
  );
  const destinationPath = path.join(
    fixture.folderPath,
    ...fixture.destinationRelativePath.split("/"),
  );

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, "existing destination\n");

  await assert.rejects(
    () => executeOrganizationPlan(fixture.plan.id, "EXECUTE"),
    /safety issues/,
  );

  const blockedRun = await prisma.executionRun.findFirstOrThrow({
    orderBy: {
      startedAt: "desc",
    },
    where: {
      organizationPlanId: fixture.plan.id,
    },
  });

  assert.equal(blockedRun.status, "BLOCKED");
  assert.equal(await exists(originalPath), true);
  assert.equal(await readFile(destinationPath, "utf8"), "existing destination\n");
});

test("changed source files are blocked by Bridge source integrity validation", async () => {
  const fixture = await approveMoveAndRenamePlan("changed-source");
  const originalPath = path.join(
    fixture.folderPath,
    ...fixture.sourceRelativePath.split("/"),
  );

  await writeFile(originalPath, "changed after approval\n");

  await assert.rejects(
    () => executeOrganizationPlan(fixture.plan.id, "EXECUTE"),
    /safety issues/,
  );

  const blockedRun = await prisma.executionRun.findFirstOrThrow({
    orderBy: {
      startedAt: "desc",
    },
    where: {
      organizationPlanId: fixture.plan.id,
    },
  });

  assert.equal(blockedRun.status, "BLOCKED");
  assert.equal(blockedRun.safeErrorCategory, "CHANGED_SOURCE");
  assert.equal(await exists(originalPath), true);
});

test("revoked Act permissions block an approved plan", async () => {
  const fixture = await approveMoveAndRenamePlan("permission-revoked");

  await updateLocalBridgeRoot(fixture.root.id, {
    moveFilePermission: false,
  });
  await prisma.connectedLibrary.update({
    data: {
      moveFilePermission: false,
    },
    where: {
      id: fixture.connectedLibrary.id,
    },
  });

  await assert.rejects(
    () => executeOrganizationPlan(fixture.plan.id, "EXECUTE"),
    /safety issues/,
  );

  const blockedRun = await prisma.executionRun.findFirstOrThrow({
    orderBy: {
      startedAt: "desc",
    },
    where: {
      organizationPlanId: fixture.plan.id,
    },
  });

  assert.equal(blockedRun.status, "BLOCKED");
  assert.equal(blockedRun.safeErrorCategory, "PERMISSION_DENIED");
});

test("completed move-and-rename actions generate undo and restore the file", async () => {
  const fixture = await approveMoveAndRenamePlan("undo-move-rename");
  const originalPath = path.join(
    fixture.folderPath,
    ...fixture.sourceRelativePath.split("/"),
  );
  const destinationPath = path.join(
    fixture.folderPath,
    ...fixture.destinationRelativePath.split("/"),
  );

  const execution = await executeOrganizationPlan(fixture.plan.id, "EXECUTE");
  const undoPreview = await previewExecutionUndo(execution.run.id);

  assert.equal(undoPreview.canUndo, true);
  assert.ok(
    undoPreview.actions.some(
      (action) =>
        action.sourceRelativePath === fixture.destinationRelativePath &&
        action.destinationRelativePath === fixture.sourceRelativePath,
    ),
  );

  const undo = await executeExecutionUndo(execution.run.id, "UNDO");

  assert.equal(undo.run.status, "COMPLETED");
  assert.equal(await exists(originalPath), true);
  assert.equal(await exists(destinationPath), false);
  assert.equal(await readFile(originalPath, "utf8"), "Attachment workshop notes\n");
});
