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
import { currentRecommendationGenerationVersion } from "../../src/lib/bridge/recommendation-generation";
import { recommendationSupportFromJson } from "../../src/lib/bridge/recommendation-reconciliation";
import { samePhysicalFilePresentation } from "../../src/lib/bridge/physical-file-identity";
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
let loadScanWorkingKnowledge: typeof import("../../src/lib/bridge/scan-working-knowledge").loadScanWorkingKnowledge;
let readScannedFile: typeof import("../../src/lib/bridge/reader").readScannedFile;
let createObservationSessionForScannedFileReadResult: typeof import("../../src/lib/bridge/scanned-file-observations").createObservationSessionForScannedFileReadResult;
let generateOrganizationSuggestionsForScannedFileWithText: typeof import("../../src/lib/bridge/organization-suggestions").generateOrganizationSuggestionsForScannedFileWithText;
let generateScanRecommendationBatch: typeof import("../../src/lib/bridge/scan-recommendation-batch").generateScanRecommendationBatch;
let reviewOrganizationSuggestion: typeof import("../../src/lib/bridge/organization-suggestions").reviewOrganizationSuggestion;
let generateOrganizationPlanForScanSession: typeof import("../../src/lib/bridge/planner").generateOrganizationPlanForScanSession;
let getOrganizationPlanPageData: typeof import("../../src/lib/bridge/planner").getOrganizationPlanPageData;
let approveOrganizationPlan: typeof import("../../src/lib/bridge/planner").approveOrganizationPlan;
let saveOrganizationPlanSelection: typeof import("../../src/lib/bridge/planner").saveOrganizationPlanSelection;
let clearOrganizationPlanSelection: typeof import("../../src/lib/bridge/planner").clearOrganizationPlanSelection;
let executeOrganizationPlan: typeof import("../../src/lib/bridge/executor").executeOrganizationPlan;
let previewExecutionUndo: typeof import("../../src/lib/bridge/undo").previewExecutionUndo;
let executeExecutionUndo: typeof import("../../src/lib/bridge/undo").executeExecutionUndo;
let findExactChecksumDuplicateForScannedFile: typeof import("../../src/lib/bridge/checksum-duplicates").findExactChecksumDuplicateForScannedFile;
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
      recommendationGenerationId: `test-generation:${input.scanSessionId}`,
      recommendationGenerationVersion: currentRecommendationGenerationVersion,
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

async function readAndApproveScannedFile(scannedFileId: string) {
  const readResult = await readScannedFile(scannedFileId);
  const observation = await createObservationSessionForScannedFileReadResult(
    scannedFileId,
    readResult,
  );

  await prisma.observationSession.update({
    data: {
      status: "APPROVED",
    },
    where: {
      id: observation.sessionId,
    },
  });

  return readResult.preview.extractedText;
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
  const scanWorkingKnowledge = await import(
    "../../src/lib/bridge/scan-working-knowledge"
  );
  const reader = await import("../../src/lib/bridge/reader");
  const scannedFileObservations = await import(
    "../../src/lib/bridge/scanned-file-observations"
  );
  const planner = await import("../../src/lib/bridge/planner");
  const executor = await import("../../src/lib/bridge/executor");
  const undo = await import("../../src/lib/bridge/undo");
  const duplicates = await import("../../src/lib/bridge/checksum-duplicates");
  const organizationSuggestions = await import(
    "../../src/lib/bridge/organization-suggestions"
  );
  const recommendationBatch = await import(
    "../../src/lib/bridge/scan-recommendation-batch"
  );

  prisma = prismaModule.getPrismaClient();
  connectBridgeLibrary = connectedLibraries.connectBridgeLibrary;
  registerLocalBridgeRoot = localBridgeClient.registerLocalBridgeRoot;
  scanLocalBridgeRoot = localBridgeClient.scanLocalBridgeRoot;
  updateLocalBridgeRoot = localBridgeClient.updateLocalBridgeRoot;
  createBridgeScanSessionFromScan =
    scanSessions.createBridgeScanSessionFromScan;
  loadScanWorkingKnowledge = scanWorkingKnowledge.loadScanWorkingKnowledge;
  readScannedFile = reader.readScannedFile;
  createObservationSessionForScannedFileReadResult =
    scannedFileObservations.createObservationSessionForScannedFileReadResult;
  generateOrganizationSuggestionsForScannedFileWithText =
    organizationSuggestions.generateOrganizationSuggestionsForScannedFileWithText;
  generateScanRecommendationBatch =
    recommendationBatch.generateScanRecommendationBatch;
  reviewOrganizationSuggestion =
    organizationSuggestions.reviewOrganizationSuggestion;
  generateOrganizationPlanForScanSession =
    planner.generateOrganizationPlanForScanSession;
  getOrganizationPlanPageData = planner.getOrganizationPlanPageData;
  approveOrganizationPlan = planner.approveOrganizationPlan;
  saveOrganizationPlanSelection = planner.saveOrganizationPlanSelection;
  clearOrganizationPlanSelection = planner.clearOrganizationPlanSelection;
  executeOrganizationPlan = executor.executeOrganizationPlan;
  previewExecutionUndo = undo.previewExecutionUndo;
  executeExecutionUndo = undo.executeExecutionUndo;
  recordChecksumDuplicateSuggestionsForSession =
    duplicates.recordChecksumDuplicateSuggestionsForSession;
  findExactChecksumDuplicateForScannedFile =
    duplicates.findExactChecksumDuplicateForScannedFile;
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

  assert.equal(draftPlan.summary.estimatedOperations, 4);
  assert.equal(draftPlan.summary.selectedFileActions, 2);
  assert.equal(
    draftPlan.actions.filter(
      (action) => action.selectableForExecution && action.selectedForExecution,
    ).length,
    2,
  );
  assert.deepEqual(
    draftPlan.actions
      .filter(
        (action) => action.selectableForExecution && action.selectedForExecution,
      )
      .map((action) => action.plannedRelativePath)
      .sort(),
    [
      "Knowledge/Attachment/attachment-session-notes.txt",
      "Knowledge/Attachment/becoming-note.txt",
    ],
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

test("five approved moves enter the draft with their destinations already included", async () => {
  const sources = [
    "Loose/finance-one.pdf",
    "Loose/finance-two.pdf",
    "Loose/workshop-one.pdf",
    "Loose/workshop-two.pdf",
    "Loose/workshop-three.pdf",
  ];
  const fixture = await createConnectedFixture(
    "approved-plan-defaults",
    Object.fromEntries(sources.map((source) => [source, "reviewed content\n"])),
  );

  for (const [index, source] of sources.entries()) {
    const file = scannedFileByRelativePath(fixture.scannedFiles, source);
    const destinationFolder = index < 2 ? "Finance" : "Workshops";

    await createSuggestion({
      currentRelativePath: source,
      proposedRelativePath: `${destinationFolder}/${path.basename(source)}`,
      scannedFileId: file.id,
      scanSessionId: fixture.session.id,
      suggestionKey: `approved-${index}`,
    });
  }

  const draftPlan = await generateOrganizationPlanForScanSession(
    fixture.session.id,
  );
  const selectedFileActions = draftPlan.actions.filter(
    (action) => action.selectableForExecution && action.selectedForExecution,
  );

  assert.equal(selectedFileActions.length, 5);
  assert.equal(draftPlan.summary.selectedFileActions, 5);
  assert.equal(draftPlan.summary.estimatedOperations, 7);
  assert.deepEqual(
    selectedFileActions
      .map((action) => action.plannedRelativePath)
      .sort(),
    [
      "Finance/finance-one.pdf",
      "Finance/finance-two.pdf",
      "Workshops/workshop-one.pdf",
      "Workshops/workshop-three.pdf",
      "Workshops/workshop-two.pdf",
    ],
  );
  assert.deepEqual(
    draftPlan.actions
      .filter((action) => action.actionType === "CREATE_FOLDER")
      .map((action) => action.plannedFolderPath)
      .sort(),
    ["Finance", "Workshops"],
  );
  assert.equal(
    draftPlan.actions.some(
      (action) =>
        action.selectableForExecution &&
        action.plannedRelativePath === "Loose/finance-one.pdf",
    ),
    false,
  );
  assert.equal(
    await exists(path.join(fixture.folderPath, "Loose", "finance-one.pdf")),
    true,
  );
  assert.equal(
    await exists(path.join(fixture.folderPath, "Finance", "finance-one.pdf")),
    false,
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
  assert.equal(
    await findExactChecksumDuplicateForScannedFile(
      scannedFileByRelativePath(
        await prisma.scannedFile.findMany({
          where: { sessionId: secondSession.id },
        }),
        "Documents/Same-File.txt",
      ).id,
    ),
    null,
  );
});

test("Bridge root aliases and hidden superseded roots cannot duplicate the same physical path", async () => {
  const bridgeRootId = "root_historical_alias_identity";
  const supersededRootId = "root_superseded_history_identity";
  const relativePath = "Clients/Loose/Alice_Client_Intake.docx";
  const checksum = "same-physical-file-checksum";
  const canonicalLibrary = await prisma.connectedLibrary.create({
    data: {
      bridgeRootId,
      displayName: "SCAN_ROOT_A_GENERAL_INBOX",
      localPath: `bridge://${bridgeRootId}`,
      platform: "MACOS",
      status: "CONNECTED",
    },
  });
  const historicalAlias = await prisma.connectedLibrary.create({
    data: {
      displayName: "SCAN_ROOT_A_GENERAL_INBOX",
      folderFingerprint: bridgeRootId,
      localPath: `bridge://${bridgeRootId}/historical-record`,
      platform: "MACOS",
      status: "CONNECTED",
    },
  });
  const supersededLibrary = await prisma.connectedLibrary.create({
    data: {
      bridgeRootId: supersededRootId,
      displayName: "SCAN_ROOT_A_GENERAL_INBOX",
      folderFingerprint: supersededRootId,
      hiddenFromActiveListAt: new Date("2026-08-15T00:00:00.000Z"),
      isEnabled: false,
      localPath: `bridge://${supersededRootId}`,
      platform: "MACOS",
      status: "HIDDEN_FROM_ACTIVE_LIST",
    },
  });
  const historicalSession = await prisma.scanSession.create({
    data: {
      completedAt: new Date("2026-08-01T00:10:00.000Z"),
      connectedFolderId: historicalAlias.id,
      filesScanned: 1,
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      status: "COMPLETED",
    },
  });
  const currentSession = await prisma.scanSession.create({
    data: {
      completedAt: new Date("2026-09-01T00:10:00.000Z"),
      connectedFolderId: canonicalLibrary.id,
      filesScanned: 1,
      startedAt: new Date("2026-09-01T00:00:00.000Z"),
      status: "COMPLETED",
    },
  });
  const supersededSession = await prisma.scanSession.create({
    data: {
      completedAt: new Date("2026-08-15T00:10:00.000Z"),
      connectedFolderId: supersededLibrary.id,
      filesScanned: 1,
      startedAt: new Date("2026-08-15T00:00:00.000Z"),
      status: "COMPLETED_WITH_ERRORS",
    },
  });

  await prisma.scannedFile.create({
    data: {
      checksum,
      fileType: "DOCX",
      localPath: `bridge://${bridgeRootId}/clients\\loose\\ALICE_CLIENT_INTAKE.docx`,
      relativePath: "clients\\loose\\ALICE_CLIENT_INTAKE.docx",
      sessionId: historicalSession.id,
      sizeBytes: BigInt(512),
    },
  });
  await prisma.scannedFile.create({
    data: {
      checksum,
      fileType: "DOCX",
      localPath: `bridge://${supersededRootId}/${relativePath}`,
      relativePath,
      sessionId: supersededSession.id,
      sizeBytes: BigInt(512),
    },
  });
  const currentFile = await prisma.scannedFile.create({
    data: {
      checksum,
      fileType: "DOCX",
      localPath: `bridge://${bridgeRootId}/${relativePath}`,
      relativePath,
      sessionId: currentSession.id,
      sizeBytes: BigInt(512),
    },
  });
  const staleSuggestion = await prisma.organizationSuggestion.create({
    data: {
      confidence: 0.98,
      currentRelativePath: relativePath,
      explanation: "Historical false self-duplicate fixture.",
      recommendationGenerationId: `checksum-duplicates-${currentSession.id}`,
      recommendationGenerationVersion: currentRecommendationGenerationVersion,
      scannedFileId: currentFile.id,
      scanSessionId: currentSession.id,
      suggestionKey: "historical-alias-false-self-duplicate",
      suggestionType: "POSSIBLE_DUPLICATE",
      supportingInformation: [],
      title: "Review as a possible duplicate",
      whySuggested: [],
    },
  });

  const result = await recordChecksumDuplicateSuggestionsForSession(
    currentSession.id,
  );
  const reconciledSuggestion =
    await prisma.organizationSuggestion.findUniqueOrThrow({
      where: { id: staleSuggestion.id },
    });

  assert.equal(result.duplicateFiles, 0);
  assert.equal(result.duplicateGroups, 0);
  assert.equal(
    await findExactChecksumDuplicateForScannedFile(currentFile.id),
    null,
  );
  assert.ok(reconciledSuggestion.invalidatedAt);
  assert.equal(reconciledSuggestion.suggestionType, "KEEP_UNCHANGED");
  assert.equal(
    await prisma.organizationSuggestion.count({
      where: {
        confidence: { gte: 0.98 },
        invalidatedAt: null,
        scannedFileId: currentFile.id,
        suggestionType: "POSSIBLE_DUPLICATE",
      },
    }),
    0,
  );
});

test("stale media metadata cannot turn historical file aliases into self-duplicates", async () => {
  const currentRootId = "root-production-media-identity";
  const staleRootId = "root-stale-media-history";
  const currentLibrary = await prisma.connectedLibrary.create({
    data: {
      bridgeRootId: currentRootId,
      displayName: "SCAN_ROOT_A_GENERAL_INBOX",
      folderFingerprint: currentRootId,
      localPath: `bridge://${currentRootId}`,
      platform: "MACOS",
      status: "CONNECTED",
    },
  });
  const staleLibrary = await prisma.connectedLibrary.create({
    data: {
      bridgeRootId: staleRootId,
      displayName: "SCAN_ROOT_A_GENERAL_INBOX",
      folderFingerprint: staleRootId,
      localPath: `bridge://${staleRootId}`,
      platform: "MACOS",
      status: "CONNECTED",
    },
  });
  const historicalSession = await prisma.scanSession.create({
    data: {
      completedAt: new Date("2026-08-01T00:10:00.000Z"),
      connectedFolderId: staleLibrary.id,
      filesScanned: 3,
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      status: "COMPLETED",
    },
  });
  const currentSession = await prisma.scanSession.create({
    data: {
      completedAt: new Date("2026-09-01T00:10:00.000Z"),
      connectedFolderId: currentLibrary.id,
      filesScanned: 5,
      startedAt: new Date("2026-09-01T00:00:00.000Z"),
      status: "COMPLETED",
    },
  });
  const mediaFiles = [
    ["broken-video-checksum", "VIDEO_MP4", "Damaged/broken-video.mp4"],
    ["broken-audio-checksum", "AUDIO_MP3", "Damaged/broken-audio.mp3"],
    [
      "workshop-voice-checksum",
      "AUDIO_M4A",
      "Workshops_Unsorted/Workshop_Voice_Memo.m4a",
    ],
  ] as const;
  const currentMediaIds: Array<{ id: string; relativePath: string }> = [];

  for (const [checksum, fileType, relativePath] of mediaFiles) {
    const historical = await prisma.scannedFile.create({
      data: {
        checksum,
        fileType,
        localPath: `bridge://${staleRootId}/${relativePath}`,
        relativePath,
        sessionId: historicalSession.id,
        sizeBytes: BigInt(2048),
      },
    });
    const current = await prisma.scannedFile.create({
      data: {
        checksum,
        fileType,
        localPath: `bridge://${currentRootId}/${relativePath}`,
        relativePath,
        sessionId: currentSession.id,
        sizeBytes: BigInt(2048),
      },
    });
    currentMediaIds.push({ id: current.id, relativePath });

    if (fileType.startsWith("AUDIO_")) {
      await prisma.audioRecordingMetadata.create({
        data: {
          duplicateConfidence: 0.98,
          duplicateKind: "EXACT_DUPLICATE",
          duplicateOfScannedFileId: historical.id,
          humanLabels: [],
          machineLabels: [],
          provisionalActionItems: [],
          provisionalPeople: [],
          provisionalProjects: [],
          provisionalQuestions: [],
          provisionalTopics: [],
          scannedFileId: current.id,
        },
      });
    } else {
      await prisma.videoRecordingMetadata.create({
        data: {
          chapterSuggestions: [],
          duplicateConfidence: 0.98,
          duplicateKind: "EXACT_DUPLICATE",
          duplicateOfScannedFileId: historical.id,
          humanLabels: [],
          machineLabels: [],
          provisionalPeople: [],
          provisionalProjects: [],
          provisionalQuestions: [],
          provisionalTopics: [],
          relatedSignals: [],
          scannedFileId: current.id,
          selectedFrameDescriptions: [],
        },
      });
    }
  }

  const batch = await prisma.libraryBatch.create({
    data: { name: "Production stale media identity" },
  });

  for (const mediaFile of currentMediaIds) {
    const document = await prisma.libraryDocument.create({
      data: {
        batchId: batch.id,
        extractionStatus: "COMPLETED",
        itemKind: mediaFile.relativePath.endsWith(".mp4") ? "VIDEO" : "AUDIO",
        normalizedFileName: path.posix.basename(mediaFile.relativePath),
        originalFileName: path.posix.basename(mediaFile.relativePath),
        previewText: "Damaged media fixture requiring review.",
      },
    });
    await prisma.observationSession.create({
      data: {
        confidence: 0.35,
        explanation: { summary: "The media needs human review." },
        interpretations: [],
        libraryDocumentId: document.id,
        observations: [
          {
            description: "The file could not provide useful media content.",
            evidence: ["Damaged media fixture requiring review."],
          },
        ],
        observerType: "DETERMINISTIC",
        planSuggestions: [],
        warnings: ["The media was damaged."],
      },
    });
    await prisma.scannedFile.update({
      data: {
        extractionStatus: "COMPLETED",
        libraryDocumentId: document.id,
        readingStatus: "READ",
        readStatus: "SUPPORTED",
      },
      where: { id: mediaFile.id },
    });
    const generated = await generateOrganizationSuggestionsForScannedFileWithText(
      mediaFile.id,
      "Damaged media fixture requiring review.",
      { replaceChecksumBootstrap: true },
    );

    assert.equal(
      generated.suggestions.some(
        (suggestion) => suggestion.suggestionType === "POSSIBLE_DUPLICATE",
      ),
      false,
      mediaFile.relativePath,
    );
  }

  for (const relativePath of [
    "Mixed_Loose/same-content-copy-1.txt",
    "Mixed_Loose/same-content-copy-2.txt",
  ]) {
    await prisma.scannedFile.create({
      data: {
        checksum: "legitimate-copy-checksum",
        fileType: "TXT",
        localPath: `bridge://${currentRootId}/${relativePath}`,
        relativePath,
        sessionId: currentSession.id,
        sizeBytes: BigInt(512),
      },
    });
  }

  const result = await recordChecksumDuplicateSuggestionsForSession(
    currentSession.id,
  );
  const activeDuplicates = await prisma.organizationSuggestion.findMany({
    orderBy: { currentRelativePath: "asc" },
    where: {
      confidence: { gte: 0.98 },
      invalidatedAt: null,
      scanSessionId: currentSession.id,
      suggestionType: "POSSIBLE_DUPLICATE",
    },
  });
  const currentMedia = await prisma.scannedFile.findMany({
    include: { audioMetadata: true, videoMetadata: true },
    where: {
      relativePath: { in: mediaFiles.map((media) => media[2]) },
      sessionId: currentSession.id,
    },
  });

  assert.equal(result.duplicateFiles, 2);
  assert.equal(result.duplicateGroups, 1);
  assert.deepEqual(
    activeDuplicates.map((suggestion) => suggestion.currentRelativePath),
    [
      "Mixed_Loose/same-content-copy-1.txt",
      "Mixed_Loose/same-content-copy-2.txt",
    ],
  );
  assert.ok(
    activeDuplicates.every((suggestion) =>
      recommendationSupportFromJson(suggestion.supportingInformation)
        .duplicateEvidence.every(
          (match) =>
            !samePhysicalFilePresentation(
              {
                connectedLibraryName: currentLibrary.displayName,
                relativePath: suggestion.currentRelativePath,
              },
              match,
            ),
        ),
    ),
  );
  assert.ok(
    currentMedia.every(
      (file) =>
        (file.audioMetadata?.duplicateOfScannedFileId ??
          file.videoMetadata?.duplicateOfScannedFileId ??
          null) === null,
    ),
  );
});

test("non-empty checksum duplicates remain detectable within and across roots", async () => {
  const rootA = await createConnectedFixture("duplicate-root-a", {
    "Mixed_Loose/same-content-copy-1.txt": "duplicate body\n",
    "Mixed_Loose/same-content-copy-2.txt": "duplicate body\n",
  });
  const firstPath = "Mixed_Loose/same-content-copy-1.txt";
  const secondPath = "Mixed_Loose/same-content-copy-2.txt";
  const firstAbsolutePath = path.join(rootA.folderPath, ...firstPath.split("/"));
  const secondAbsolutePath = path.join(rootA.folderPath, ...secondPath.split("/"));
  const before = await Promise.all([
    readFile(firstAbsolutePath, "utf8"),
    readFile(secondAbsolutePath, "utf8"),
  ]);

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
  assert.ok(
    sameRootDuplicates.every(
      (suggestion) => suggestion.confidence === 0.98,
    ),
  );
  assert.deepEqual(
    sameRootDuplicates
      .map((suggestion) => suggestion.currentRelativePath)
      .sort(),
    [firstPath, secondPath],
  );
  assert.ok(
    sameRootDuplicates.every((suggestion) => {
      const evidence = recommendationSupportFromJson(
        suggestion.supportingInformation,
      ).duplicateEvidence;

      return (
        evidence.length === 1 &&
        evidence[0]!.relativePath.length > 0 &&
        evidence[0]!.signals.some((signal) => /same checksum/i.test(signal))
      );
    }),
  );

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
  assert.deepEqual(
    await Promise.all([
      readFile(firstAbsolutePath, "utf8"),
      readFile(secondAbsolutePath, "utf8"),
    ]),
    before,
  );
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

test("regenerating recommendations invalidates stale approvals instead of reusing them", async () => {
  const source = "Loose/attachment-notes.txt";
  const fixture = await createConnectedFixture("recommendation-regeneration", {
    [source]:
      "Attachment regulation nervous system safety practice for client work.\n",
  });
  const file = scannedFileByRelativePath(fixture.scannedFiles, source);
  const contentText = await readAndApproveScannedFile(file.id);
  const firstGeneration =
    await generateOrganizationSuggestionsForScannedFileWithText(
      file.id,
      contentText,
    );
  const firstSuggestionIds = firstGeneration.suggestions.map(
    (suggestion) => suggestion.id,
  );
  const firstGenerationIds = new Set(
    firstGeneration.suggestions.map(
      (suggestion) => suggestion.recommendationGenerationId,
    ),
  );

  assert.ok(firstSuggestionIds.length > 0);

  await prisma.organizationSuggestion.updateMany({
    data: {
      reviewedAt: new Date(),
      status: "APPROVED",
    },
    where: {
      id: {
        in: firstSuggestionIds,
      },
    },
  });

  const secondGeneration =
    await generateOrganizationSuggestionsForScannedFileWithText(
      file.id,
      contentText,
    );
  const staleRows = await prisma.organizationSuggestion.findMany({
    where: {
      id: {
        in: firstSuggestionIds,
      },
    },
  });

  assert.ok(secondGeneration.suggestions.length > 0);
  assert.ok(
    secondGeneration.suggestions.every(
      (suggestion) =>
        suggestion.status === "PENDING" &&
        !firstGenerationIds.has(suggestion.recommendationGenerationId),
    ),
  );
  assert.ok(
    staleRows.every(
      (suggestion) =>
        suggestion.invalidatedAt &&
        suggestion.reviewedAt !== null &&
        suggestion.status === "APPROVED",
    ),
  );
  await assert.rejects(
    () => generateOrganizationPlanForScanSession(fixture.session.id),
    /No reviewed recommendations/,
  );
});

test("weak lexical, filename, and extension evidence stays explicitly uncertain", async () => {
  const longFileName = `${"carefully-described-".repeat(7)}archive-item.txt`;
  const relativePaths = [
    "Loose/same-content-copy-2.txt",
    "Loose/Quarterly Roadmap.txt",
    "Loose/UPPERCASE.markdown",
    "Loose/Résumé - Café Notes.txt",
    `Loose/${longFileName}`,
  ];
  const fixture = await createConnectedFixture("generic-recommendations", {
    "Archive/Quarterly Roadmap Reference.txt":
      "A separate account of harbor maintenance schedules.\n",
    "Content/reference-content.txt":
      "A glossary entry that happens to mention content.\n",
    "Extension/markdown-extension-reference.markdown":
      "A short note that happens to mention extension.\n",
    "Filename/reference-filename.txt":
      "A short note that happens to mention filename.\n",
    [relativePaths[0] as string]:
      "Orchard inventory distinguishes cedar baskets from woven trays.\n",
    [relativePaths[1] as string]:
      "Tidal measurements were recorded beside the western pier.\n",
    [relativePaths[2] as string]:
      "Volcanic minerals cooled beneath an ancient island ridge.\n",
    [relativePaths[3] as string]:
      "Hospitality profiles describe regional menus and dining customs.\n",
    [relativePaths[4] as string]:
      "Ceramic restoration records kiln temperature and glaze condition.\n",
  });

  for (const relativePath of relativePaths) {
    const file = scannedFileByRelativePath(fixture.scannedFiles, relativePath);
    const contentText = await readAndApproveScannedFile(file.id);
    const result = await generateOrganizationSuggestionsForScannedFileWithText(
      file.id,
      contentText,
    );
    assert.deepEqual(
      result.suggestions.map((suggestion) => suggestion.suggestionType),
      ["INSUFFICIENT_EVIDENCE"],
    );
    assert.equal(result.suggestions[0]?.evidenceStrength, "LIMITED");
    assert.ok((result.suggestions[0]?.confidence ?? 1) < 0.5);
    assert.match(
      result.suggestions[0]?.explanation ?? "",
      /does not have enough evidence to recommend a change yet/i,
    );
  }
});

test("a stable batch uses provisional scan-wide understanding without trusting it as Memory", async () => {
  const sourceFiles = {
    "Operations_Mess/a.txt": "Invoice reference for the office.",
    "Operations_Mess/b.txt": "Payment note for supplies.",
    "Operations_Mess/c.txt": "Monthly expense record.",
    "Operations_Mess/damaged.txt": "Unreadable fixture.",
  };
  const fixture = await createConnectedFixture(
    "provisional-working-intelligence",
    sourceFiles,
  );
  const before = await Promise.all(
    Object.keys(sourceFiles).map((relativePath) =>
      readFile(path.join(fixture.folderPath, ...relativePath.split("/")), "utf8"),
    ),
  );

  for (const relativePath of Object.keys(sourceFiles).filter(
    (item) => !item.endsWith("damaged.txt"),
  )) {
    const scannedFile = scannedFileByRelativePath(
      fixture.scannedFiles,
      relativePath,
    );
    const readResult = await readScannedFile(scannedFile.id);
    const observation = await createObservationSessionForScannedFileReadResult(
      scannedFile.id,
      readResult,
    );

    await prisma.observationSession.update({
      data: {
        explanation: {
          summary:
            relativePath.endsWith("a.txt")
              ? "This appears to concern invoice administration and office billing."
              : relativePath.endsWith("b.txt")
                ? "This appears to concern payment transactions and office billing."
                : "This appears to concern monthly expenses and office budgeting.",
        },
        interpretations: [
          {
            description:
              relativePath.endsWith("a.txt")
                ? "Invoice administration may be part of office finance."
                : relativePath.endsWith("b.txt")
                  ? "Payment transactions may be part of office finance."
                  : "Monthly expenses may be part of office finance.",
          },
        ],
        observations: [
          {
            description:
              relativePath.endsWith("a.txt")
                ? "The material discusses invoice records."
                : relativePath.endsWith("b.txt")
                  ? "The material discusses payment records."
                  : "The material discusses expense records.",
            evidence: ["office finance"],
          },
        ],
        status: "AWAITING_REVIEW",
      },
      where: { id: observation.sessionId },
    });
  }

  const damaged = scannedFileByRelativePath(
    fixture.scannedFiles,
    "Operations_Mess/damaged.txt",
  );
  await prisma.scannedFile.update({
    data: {
      extractionStatus: "FAILED",
      processingStage: "FAILED",
      readingStatus: "FAILED",
    },
    where: { id: damaged.id },
  });

  const result = await generateScanRecommendationBatch(fixture.session.id, {
    recordNotebook: false,
  });
  const suggestions = await prisma.organizationSuggestion.findMany({
    orderBy: { currentRelativePath: "asc" },
    where: {
      invalidatedAt: null,
      recommendationGenerationVersion: currentRecommendationGenerationVersion,
      scanSessionId: fixture.session.id,
    },
  });
  const storedDocuments = await prisma.libraryDocument.findMany({
    where: { scannedFiles: { some: { sessionId: fixture.session.id } } },
  });
  const after = await Promise.all(
    Object.keys(sourceFiles).map((relativePath) =>
      readFile(path.join(fixture.folderPath, ...relativePath.split("/")), "utf8"),
    ),
  );

  assert.equal(result.processedFileCount, 3);
  assert.equal(result.failedCount, 0);
  assert.equal(result.workingKnowledge.clusters.length, 1);
  assert.equal(await prisma.memoryEntry.count(), 0);
  assert.ok(
    suggestions.every(
      (suggestion) =>
        suggestion.suggestionType === "MOVE_FILE" ||
        suggestion.suggestionType === "GROUP_WITH_FILES",
    ),
  );
  assert.ok(
    suggestions.every((suggestion) =>
      JSON.stringify(suggestion.supportingInformation).includes(
        "Working understanding",
      ),
    ),
  );
  assert.ok(
    suggestions.every((suggestion) =>
      JSON.stringify(suggestion.supportingInformation).includes("Related file:"),
    ),
  );
  assert.ok(
    suggestions.every(
      (suggestion) =>
        suggestion.recommendationGenerationVersion ===
        currentRecommendationGenerationVersion,
    ),
  );
  assert.ok(storedDocuments.every((document) => document.rawText === null));
  assert.deepEqual(after, before);
  assert.equal(
    await prisma.organizationSuggestion.count({
      where: { scannedFileId: damaged.id },
    }),
    0,
  );
});

test("strong content and an established Clients folder pattern can produce one grouping without changing source files", async () => {
  const source = "Clients/Loose/Alice_Client_Intake.txt";
  const originalContent =
    "Alice client intake appointment history and contact preferences.\n";
  const fixture = await createConnectedFixture("recommendation-quality", {
    "Alice/Alice_Appointment_History.txt":
      "Historical appointment information for Alice.\n",
    "Alice/Alice_Client_Intake_Reference.txt":
      "Reference details for Alice client intake.\n",
    [source]: originalContent,
  });
  const file = scannedFileByRelativePath(fixture.scannedFiles, source);
  const absoluteSourcePath = path.join(
    fixture.folderPath,
    ...source.split("/"),
  );
  const before = await readFile(absoluteSourcePath, "utf8");
  const contentText = await readAndApproveScannedFile(file.id);
  const result = await generateOrganizationSuggestionsForScannedFileWithText(
    file.id,
    contentText,
  );
  const after = await readFile(absoluteSourcePath, "utf8");
  const locationSuggestions = result.suggestions.filter((suggestion) =>
    ["MOVE_FILE", "GROUP_WITH_FILES"].includes(suggestion.suggestionType),
  );

  assert.equal(before, originalContent);
  assert.equal(after, originalContent);
  assert.equal(locationSuggestions.length, 1);
  assert.equal(locationSuggestions[0]?.suggestionType, "GROUP_WITH_FILES");
  assert.equal(
    locationSuggestions[0]?.proposedRelativePath,
    "Alice/Alice_Client_Intake.txt",
  );
  assert.equal(locationSuggestions[0]?.evidenceStrength, "STRONG");
  assert.match(
    locationSuggestions[0]?.explanation ?? "",
    /existing files under Alice/i,
  );
  assert.equal(
    result.suggestions.some(
      (suggestion) => suggestion.suggestionType === "CREATE_FOLDER",
    ),
    false,
  );
});

test("an established current folder can produce an affirmative keep recommendation", async () => {
  const source = "Recovery/recovery-notes.txt";
  const fixture = await createConnectedFixture("affirmative-keep", {
    "Recovery/earlier-healing-notes.txt":
      "Earlier recovery and healing notes.\n",
    "Recovery/recovery-plan.txt":
      "A recovery plan for repair and resilience.\n",
    [source]: "Recovery healing repair and resilience notes.\n",
  });
  const file = scannedFileByRelativePath(fixture.scannedFiles, source);
  const contentText = await readAndApproveScannedFile(file.id);
  const result = await generateOrganizationSuggestionsForScannedFileWithText(
    file.id,
    contentText,
  );

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0]?.suggestionType, "KEEP_UNCHANGED");
  assert.match(
    result.suggestions[0]?.explanation ?? "",
    /affirmative evidence/i,
  );
});

test("insufficient evidence cannot be approved as an organization action", async () => {
  const source = "Loose/unclear-note.txt";
  const fixture = await createConnectedFixture("uncertain-recommendation", {
    [source]: "A brief note about a quiet afternoon.\n",
  });
  const file = scannedFileByRelativePath(fixture.scannedFiles, source);
  const contentText = await readAndApproveScannedFile(file.id);
  const result = await generateOrganizationSuggestionsForScannedFileWithText(
    file.id,
    contentText,
  );
  const suggestion = result.suggestions[0];

  assert.ok(suggestion);
  assert.equal(suggestion.suggestionType, "INSUFFICIENT_EVIDENCE");
  await assert.rejects(
    () =>
      reviewOrganizationSuggestion(suggestion.id, {
        action: "APPROVE",
        scanSessionId: fixture.session.id,
      }),
    /does not have enough evidence|needs more evidence/i,
  );
  const after = await prisma.organizationSuggestion.findUnique({
    select: { status: true },
    where: { id: suggestion.id },
  });

  assert.equal(after?.status, "PENDING");
});

test("strong operations and workshop meaning uses established folder patterns", async () => {
  const fixture = await createConnectedFixture("operations-and-workshops", {
    "Finance/invoice-template.txt": "invoice payment expense accounting notes.\n",
    "Finance/payment-record.txt": "payment invoice expense budget accounting.\n",
    "Operations_Mess/August_Office_Expenses.txt":
      "August office expenses, invoice payment and budget review.\n",
    "Workshops/workshop-overview.txt":
      "Workshop orientation and facilitation overview.\n",
    "Workshops/facilitation-guide.txt":
      "Workshop training facilitation and orientation guide.\n",
    "Workshops_Unsorted/Boundaries_Workshop_Outline.txt":
      "Boundaries workshop facilitation orientation and training outline.\n",
  });

  const operationsFile = scannedFileByRelativePath(
    fixture.scannedFiles,
    "Operations_Mess/August_Office_Expenses.txt",
  );
  const workshopFile = scannedFileByRelativePath(
    fixture.scannedFiles,
    "Workshops_Unsorted/Boundaries_Workshop_Outline.txt",
  );
  const operationsText = await readAndApproveScannedFile(operationsFile.id);
  const workshopText = await readAndApproveScannedFile(workshopFile.id);
  const operationsResult =
    await generateOrganizationSuggestionsForScannedFileWithText(
      operationsFile.id,
      operationsText,
    );
  const workshopResult =
    await generateOrganizationSuggestionsForScannedFileWithText(
      workshopFile.id,
      workshopText,
    );

  assert.ok(
    operationsResult.suggestions.some(
      (suggestion) =>
        ["MOVE_FILE", "GROUP_WITH_FILES"].includes(suggestion.suggestionType) &&
        suggestion.evidenceStrength === "STRONG",
    ),
  );
  assert.ok(
    workshopResult.suggestions.some(
      (suggestion) =>
        ["MOVE_FILE", "GROUP_WITH_FILES"].includes(suggestion.suggestionType) &&
        suggestion.evidenceStrength === "STRONG",
    ),
  );
});

test("destination-specific cluster provenance excludes broad boundary relationships", async () => {
  const fixture = await createConnectedFixture("destination-cluster-provenance", {
    "Workshops_Unsorted/Workshop_Proposal.txt":
      "Workshop proposal for boundaries and communication facilitation.\n",
    "Workshops_Unsorted/Boundaries_Workshop_Outline.txt":
      "Boundaries workshop facilitation orientation and training outline.\n",
    "Clients/Loose/client-intake.txt":
      "Client intake information about personal boundaries and appointments.\n",
    "Mixed/boundary-notes.txt":
      "General notes about boundaries and personal reflections.\n",
    "Mixed_Loose/large-notes-200kb.txt":
      "Generic notes about website planning, workshop materials, office administration, and follow-up tasks.\n",
    "Mixed_Loose/Résumé - Café Notes.txt":
      "Notes from a café meeting discussing website copy and workshop planning.\n",
    "Mixed_Loose/WATCH_CREATED_AFTER_CONNECT.txt":
      "A watcher fixture about website follow-up and workshop scheduling.\n",
  });
  const file = scannedFileByRelativePath(
    fixture.scannedFiles,
    "Workshops_Unsorted/Workshop_Proposal.txt",
  );
  const protectedPaths = [
    "Workshops_Unsorted/Workshop_Proposal.txt",
    "Workshops_Unsorted/Boundaries_Workshop_Outline.txt",
    "Mixed_Loose/large-notes-200kb.txt",
  ].map((relativePath) =>
    path.join(fixture.folderPath, ...relativePath.split("/")),
  );
  const fileContentsBefore = await Promise.all(
    protectedPaths.map((filePath) => readFile(filePath, "utf8")),
  );
  const memoryCountBefore = await prisma.memoryEntry.count();
  const contentText = await readAndApproveScannedFile(file.id);
  const contaminatedPaths = [
    "Mixed_Loose/large-notes-200kb.txt",
    "Mixed_Loose/Résumé - Café Notes.txt",
    "Mixed_Loose/WATCH_CREATED_AFTER_CONNECT.txt",
  ];
  for (const relatedFile of fixture.scannedFiles) {
    if (relatedFile.id !== file.id) {
      if (contaminatedPaths.includes(relatedFile.relativePath)) {
        const readResult = await readScannedFile(relatedFile.id);
        await createObservationSessionForScannedFileReadResult(
          relatedFile.id,
          readResult,
        );
      } else {
        await readAndApproveScannedFile(relatedFile.id);
      }
    }
  }
  const contaminatedFiles = await prisma.scannedFile.findMany({
    select: { libraryDocumentId: true },
    where: {
      relativePath: { in: contaminatedPaths },
      sessionId: fixture.session.id,
    },
  });

  for (const contaminatedFile of contaminatedFiles) {
    assert.ok(contaminatedFile.libraryDocumentId);
    await prisma.observationSession.create({
      data: {
        confidence: 0.51,
        explanation: {
          summary:
            "AI assistance suggests comparing this with workshop material during review.",
        },
        interpretations: [
          {
            description:
              "This may have a workshop or facilitation connection, but no file-specific evidence was observed.",
          },
        ],
        libraryDocumentId: contaminatedFile.libraryDocumentId,
        observations: [
          {
            description:
              "Generic provisional workshop language without supporting source content.",
            evidence: [
              "The source content contains no workshop-specific evidence.",
            ],
          },
        ],
        observerType: "OPENAI",
        planSuggestions: [],
        status: "AWAITING_REVIEW",
        warnings: ["Human review is required."],
      },
    });
  }
  const workingKnowledge = await loadScanWorkingKnowledge(fixture.session.id);
  const result = await generateOrganizationSuggestionsForScannedFileWithText(
    file.id,
    contentText,
    { workingKnowledge },
  );
  const actionableEvidence = JSON.stringify(
    result.suggestions.filter((suggestion) =>
      ["MOVE_FILE", "CREATE_FOLDER"].includes(suggestion.suggestionType),
    ),
  );

  assert.match(
    actionableEvidence,
    /Related file: Workshops_Unsorted\/Boundaries_Workshop_Outline\.txt/,
  );
  assert.doesNotMatch(
    actionableEvidence,
    /Clients\/Loose|Mixed\/boundary-notes|large-notes-200kb|Résumé - Café Notes|WATCH_CREATED_AFTER_CONNECT/,
  );
  assert.deepEqual(
    await Promise.all(protectedPaths.map((filePath) => readFile(filePath, "utf8"))),
    fileContentsBefore,
  );
  assert.equal(await prisma.memoryEntry.count(), memoryCountBefore);
});

test("legacy and invalidated recommendations cannot enter selected or approved plans", async () => {
  const source = "Loose/current.txt";
  const fixture = await createConnectedFixture("stale-plan-protection", {
    [source]: "current plan source\n",
  });
  const file = scannedFileByRelativePath(fixture.scannedFiles, source);

  const legacy = await prisma.organizationSuggestion.create({
    data: {
      confidence: 0.81,
      currentRelativePath: source,
      explanation: "Legacy recommendation from an earlier pass.",
      proposedRelativePath: "Legacy/current.txt",
      scanSessionId: fixture.session.id,
      scannedFileId: file.id,
      status: "APPROVED",
      suggestionKey: "connected-execution:legacy-recommendation",
      suggestionType: "MOVE_FILE",
      supportingInformation: [],
      title: "Legacy recommendation",
      whySuggested: [],
    },
  });
  await assert.rejects(
    () => generateOrganizationPlanForScanSession(fixture.session.id),
    /No reviewed recommendations/,
  );

  const currentSuggestion = await createSuggestion({
    currentRelativePath: source,
    proposedRelativePath: "Current/current.txt",
    scannedFileId: file.id,
    scanSessionId: fixture.session.id,
    suggestionKey: "current-recommendation",
  });
  const draftPlan = await generateOrganizationPlanForScanSession(
    fixture.session.id,
  );
  const fileAction = draftPlan.actions.find(
    (action) =>
      action.suggestionId === currentSuggestion.id &&
      action.selectableForExecution === true,
  );

  assert.ok(fileAction);
  assert.equal(
    draftPlan.skippedItems.some((item) => item.suggestionId === legacy.id),
    false,
  );

  await prisma.organizationPlan.update({
    data: {
      skippedItems: [
        {
          currentRelativePath: source,
          id: "historical-skipped-item",
          reason: "This recommendation was replaced by a newer recommendation generation.",
          status: "APPROVED",
          suggestionId: legacy.id,
          title: "Legacy recommendation",
        },
      ],
    },
    where: {
      id: draftPlan.id,
    },
  });
  const pageData = await getOrganizationPlanPageData(fixture.session.id);

  assert.ok(pageData?.plan);
  assert.equal(
    pageData.plan.skippedItems.some((item) => item.suggestionId === legacy.id),
    false,
  );

  await prisma.organizationSuggestion.update({
    data: {
      invalidatedAt: new Date(),
      invalidatedReason: "Test invalidation.",
    },
    where: {
      id: currentSuggestion.id,
    },
  });

  await assert.rejects(
    () => saveOrganizationPlanSelection(draftPlan.id, [fileAction.id]),
    /Regenerate recommendations/,
  );

  await prisma.organizationPlan.update({
    data: {
      actions: [
        {
          ...fileAction,
          selectedForExecution: true,
        },
      ],
      warnings: [],
    },
    where: {
      id: draftPlan.id,
    },
  });

  await assert.rejects(
    () => approveOrganizationPlan(draftPlan.id),
    /Regenerate recommendations|source recommendation/,
  );
});

test("approved plan actions start included, derive folder dependencies, and exclude review-only notes", async () => {
  const source = "Loose/Alice_Client_Intake.docx";
  const websiteNote = "Website/becoming-hero.jpg";
  const fixture = await createConnectedFixture("plan-selection", {
    [source]: "Alice intake\n",
    [websiteNote]: "image placeholder\n",
  });
  const sourceFile = scannedFileByRelativePath(fixture.scannedFiles, source);
  const websiteFile = scannedFileByRelativePath(fixture.scannedFiles, websiteNote);
  const sourcePath = path.join(fixture.folderPath, ...source.split("/"));
  const destinationPath = path.join(
    fixture.folderPath,
    "Clients",
    "Alice",
    "Alice_Client_Intake.docx",
  );

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
  assert.equal(draftPlan.summary.selectedFileActions, 1);
  assert.equal(draftPlan.summary.estimatedOperations, 3);
  await assert.rejects(
    () => saveOrganizationPlanSelection(draftPlan.id, []),
    /Select at least one file action/,
  );

  assert.equal(await exists(sourcePath), true);
  assert.equal(await exists(destinationPath), false);

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
  assert.equal(await exists(sourcePath), true);
  assert.equal(await exists(destinationPath), false);

  const clearedPlan = await clearOrganizationPlanSelection(selectedPlan.id);

  assert.equal(clearedPlan.summary.selectedFileActions, 0);
  assert.equal(clearedPlan.summary.estimatedOperations, 0);
  assert.equal(await exists(sourcePath), true);
  assert.equal(await exists(destinationPath), false);
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

test("resetting recommendation decisions clears stale approvals and unfinished plans without touching files", async () => {
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

  const secondMove = await createSuggestion({
    currentRelativePath: "Loose/a.txt",
    proposedRelativePath: "Organized/a-2.txt",
    scannedFileId: fileA.id,
    scanSessionId: sessionA.session.id,
    suggestionKey: "reset-a-second",
  });
  const staleReviewOnly = await createSuggestion({
    currentRelativePath: "Loose/a.txt",
    proposedRelativePath: "Website Candidates/a.txt",
    scannedFileId: fileA.id,
    scanSessionId: sessionA.session.id,
    suggestionKey: "reset-a-old-review-note",
    suggestionType: "WEBSITE_CANDIDATE",
  });
  const activePlan = await generateOrganizationPlanForScanSession(
    sessionA.session.id,
  );

  assert.equal(
    activePlan.actions.some(
      (action) => action.suggestionId === staleReviewOnly.id,
    ),
    true,
  );

  const resetBulk = await resetOrganizationSuggestionDecisionsForScanSession(
    sessionA.session.id,
  );
  const cancelledPlan = await prisma.organizationPlan.findUniqueOrThrow({
    where: {
      id: activePlan.id,
    },
  });
  const sessionAReviewed = await prisma.organizationSuggestion.count({
    where: {
      scanSessionId: sessionA.session.id,
      status: {
        in: ["APPROVED", "MODIFIED"],
      },
    },
  });
  const sessionBReviewed = await prisma.organizationSuggestion.count({
    where: {
      scanSessionId: sessionB.session.id,
      status: "APPROVED",
    },
  });

  assert.ok(resetBulk.resetCount >= 1);
  assert.equal(resetBulk.cancelledPlanCount, 1);
  assert.equal(cancelledPlan.status, "CANCELLED");
  assert.equal(sessionAReviewed, 0);
  assert.equal(sessionBReviewed, 1);
  assert.equal(await exists(originalPath), true);

  await createSuggestion({
    currentRelativePath: "Loose/a.txt",
    proposedRelativePath: "Current/a.txt",
    scannedFileId: fileA.id,
    scanSessionId: sessionA.session.id,
    suggestionKey: "reset-a-current-recommendation",
  });
  const regeneratedPlan = await generateOrganizationPlanForScanSession(
    sessionA.session.id,
  );

  assert.equal(regeneratedPlan.summary.reviewOnlyNotes, 0);
  assert.equal(
    regeneratedPlan.actions.some(
      (action) =>
        action.suggestionId === staleReviewOnly.id ||
        action.suggestionId === secondMove.id,
    ),
    false,
  );
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
