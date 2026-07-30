import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import os from "node:os";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { createBridgeServer } from "../../bridge-app/src/api/server";
import { createFolderSelection } from "../../bridge-app/src/main/registry";
import { defaultBridgePermissions } from "../../bridge-app/src/permissions/defaults";
import {
  duplicateSelectionRootIds,
  folderSelectionOverlaps,
  selectionHasBlockingOverlaps,
} from "../../src/lib/bridge/folder-selection";
import type {
  LocalBridgeFolderSelection,
  LocalBridgeRootSummary,
} from "../../src/lib/bridge/local-bridge-client";
import type { BridgeFolderScanResult } from "../../src/lib/bridge/types";

let prisma: PrismaClient;
let bridgeServer: Server;
let tempRoot: string;
let testDatabaseUrl: string;
let previousBridgeDataDir: string | undefined;
let previousBridgeUrl: string | undefined;
let previousDatabaseUrl: string | undefined;
let previousDeveloperFallback: string | undefined;
let previousOpenAIKey: string | undefined;

let connectBridgeLibrary: typeof import("../../src/lib/bridge/connected-libraries").connectBridgeLibrary;
let requireConnectedLibraryPermission: typeof import("../../src/lib/bridge/connected-libraries").requireConnectedLibraryPermission;
let ConnectedLibraryError: typeof import("../../src/lib/bridge/connected-libraries").ConnectedLibraryError;
let createBridgeScanSessionFromScan: typeof import("../../src/lib/bridge/scan-sessions").createBridgeScanSessionFromScan;
let getOrganizationSuggestionsForConnectedLibraries: typeof import("../../src/lib/bridge/organization-suggestions").getOrganizationSuggestionsForConnectedLibraries;
let generateOrganizationPlanForScanSession: typeof import("../../src/lib/bridge/planner").generateOrganizationPlanForScanSession;
let batchConnectPost: typeof import("../../src/app/api/bridge/connected-libraries/batch/route").POST;

const testSchemaName = `connected_library_batch_${process.pid}_${Date.now()}`;

function databaseUrlForSchema(schemaName: string) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Connected Library batch tests.");
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

async function resetTestData() {
  await prisma.undoAction.deleteMany();
  await prisma.undoRun.deleteMany();
  await prisma.executionAction.deleteMany();
  await prisma.executionRun.deleteMany();
  await prisma.notebookEntryRevision.deleteMany();
  await prisma.notebookEntry.deleteMany();
  await prisma.organizationPlan.deleteMany();
  await prisma.organizationSuggestionRevision.deleteMany();
  await prisma.organizationSuggestion.deleteMany();
  await prisma.scannedFile.deleteMany();
  await prisma.scanSession.deleteMany();
  await prisma.monitoringEvent.deleteMany();
  await prisma.monitoringBatch.deleteMany();
  await prisma.connectedLibrary.deleteMany();
}

function rootSummary(
  id: string,
  overrides: Partial<LocalBridgeRootSummary> = {},
): LocalBridgeRootSummary {
  return {
    connectedAt: "2026-07-22T00:00:00.000Z",
    createFolderPermission: false,
    displayName: "Batch Test Library",
    id,
    lastScanAt: null,
    lastWatchingAt: null,
    moveFilePermission: false,
    organizationPlanPermission: true,
    platform: "WINDOWS",
    readPermission: true,
    recommendationPermission: true,
    renameFilePermission: false,
    safeLocation: "D:\\Batch-Test-Library",
    status: "CONNECTED",
    updatedAt: "2026-07-22T00:00:00.000Z",
    watcherState: "STOPPED",
    watchPermission: false,
    ...overrides,
  };
}

function folderSelection(
  rootId: string,
  ancestorRootIds: string[] = [],
): Pick<
  LocalBridgeFolderSelection,
  "ancestorRootIds" | "rootId" | "safeLocation" | "suggestedDisplayName"
> {
  return {
    ancestorRootIds,
    rootId,
    safeLocation: `Connected through test root ${rootId}`,
    suggestedDisplayName: rootId.replace(/^root_/, ""),
  };
}

function scanResult(
  rootId: string,
  folderDisplayName: string,
  relativePath: string,
): BridgeFolderScanResult {
  const startedAt = new Date("2026-07-22T10:00:00.000Z");
  const completedAt = new Date("2026-07-22T10:00:01.000Z");

  return {
    bridgeRootId: rootId,
    completedAt,
    failedFiles: 0,
    files: [
      {
        checksum: `checksum-${rootId}`,
        fileType: "txt",
        lastModified: startedAt,
        localPath: `bridge://${rootId}/${relativePath}`,
        readStatus: "SUPPORTED",
        relativePath,
        sizeBytes: 128n,
      },
    ],
    folderDisplayName,
    rootPath: `bridge://${rootId}`,
    safeLocation: `Connected through test root ${rootId}`,
    startedAt,
    supportedFiles: 1,
    totalFiles: 1,
    unsupportedFiles: 0,
  };
}

async function createConnectedSession(
  rootId: string,
  displayName: string,
  relativePath: string,
) {
  const connected = await connectBridgeLibrary({
    root: rootSummary(rootId, {
      displayName,
      safeLocation: `Connected through ${displayName}`,
    }),
  });
  const session = await createBridgeScanSessionFromScan(
    scanResult(rootId, displayName, relativePath),
    {
      allowReusableSession: false,
      connectedLibraryId: connected.library.id,
    },
  );
  const scannedFile = await prisma.scannedFile.findFirstOrThrow({
    where: {
      sessionId: session.id,
    },
  });

  return {
    connectedLibrary: connected.library,
    scannedFile,
    session,
  };
}

async function createSuggestion(
  sessionId: string,
  scannedFileId: string,
  currentRelativePath: string,
  key: string,
  status: "APPROVED" | "PENDING" = "APPROVED",
) {
  return prisma.organizationSuggestion.create({
    data: {
      confidence: 0.82,
      currentRelativePath,
      explanation:
        "The Librarian noticed a reviewed folder pattern for this file.",
      proposedRelativePath: `Organized/${path.posix.basename(currentRelativePath)}`,
      scanSessionId: sessionId,
      scannedFileId,
      status,
      suggestionKey: `batch-test:${key}`,
      suggestionType: "MOVE_FILE",
      supportingInformation: [
        "Approved Memory used: organize workshop material by topic",
      ],
      title: "Move into an organized folder",
      reviewedAt: status === "APPROVED" ? new Date() : null,
      whySuggested: ["This matched a reviewed organization preference."],
    },
  });
}

async function createBridgeSelection(folderName: string) {
  const folderPath = path.join(tempRoot, folderName);

  await mkdir(folderPath, { recursive: true });
  await writeFile(path.join(folderPath, "note.txt"), folderName);

  return createFolderSelection(folderPath);
}

function batchPayload(
  selection: Awaited<ReturnType<typeof createFolderSelection>>,
  overrides: Partial<typeof defaultBridgePermissions> = {},
) {
  return {
    ancestorRootIds: selection.ancestorRootIds,
    displayName: selection.suggestedDisplayName,
    permissions: {
      ...defaultBridgePermissions,
      ...overrides,
    },
    rootId: selection.rootId,
    safeLocation: selection.safeLocation,
    selectionToken: selection.selectionToken,
    suggestedDisplayName: selection.suggestedDisplayName,
  };
}

before(async () => {
  previousBridgeDataDir = process.env.NSN_BRIDGE_DATA_DIR;
  previousBridgeUrl = process.env.NSN_LOCAL_BRIDGE_URL;
  previousDatabaseUrl = process.env.DATABASE_URL;
  previousDeveloperFallback = process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK;
  previousOpenAIKey = process.env.OPENAI_API_KEY;

  testDatabaseUrl = databaseUrlForSchema(testSchemaName);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "nsn-batch-test-"));
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.NSN_BRIDGE_DATA_DIR = path.join(tempRoot, ".bridge-data");
  process.env.NSN_ENABLE_DEVELOPER_BRIDGE_FALLBACK = "false";
  process.env.OPENAI_API_KEY = "";

  runPrismaDbPush();

  bridgeServer = createBridgeServer();
  const address = await listen(bridgeServer);
  process.env.NSN_LOCAL_BRIDGE_URL = `http://127.0.0.1:${address.port}`;

  const prismaModule = await import("../../src/lib/db/prisma");
  const connectedLibraries = await import("../../src/lib/bridge/connected-libraries");
  const scanSessions = await import("../../src/lib/bridge/scan-sessions");
  const organizationSuggestions = await import("../../src/lib/bridge/organization-suggestions");
  const planner = await import("../../src/lib/bridge/planner");
  const batchRoute = await import("../../src/app/api/bridge/connected-libraries/batch/route");

  prisma = prismaModule.getPrismaClient();
  connectBridgeLibrary = connectedLibraries.connectBridgeLibrary;
  requireConnectedLibraryPermission =
    connectedLibraries.requireConnectedLibraryPermission;
  ConnectedLibraryError = connectedLibraries.ConnectedLibraryError;
  createBridgeScanSessionFromScan = scanSessions.createBridgeScanSessionFromScan;
  getOrganizationSuggestionsForConnectedLibraries =
    organizationSuggestions.getOrganizationSuggestionsForConnectedLibraries;
  generateOrganizationPlanForScanSession =
    planner.generateOrganizationPlanForScanSession;
  batchConnectPost = batchRoute.POST;
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

test("multi-folder selection detects duplicate and overlapping roots deterministically", () => {
  const parent = folderSelection("root_parent");
  const child = folderSelection("root_child", ["root_parent"]);

  assert.deepEqual(
    duplicateSelectionRootIds([parent, child, parent]),
    ["root_parent"],
  );

  const overlaps = folderSelectionOverlaps([parent, child]);

  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0]?.parentRootId, "root_parent");
  assert.equal(overlaps[0]?.childRootId, "root_child");
  assert.equal(selectionHasBlockingOverlaps([parent, child], new Set()), true);
  assert.equal(
    selectionHasBlockingOverlaps(
      [parent, child],
      new Set(["root_parent", "root_child"]),
    ),
    false,
  );
});

test("existing connected parent roots are considered overlap conflicts", async () => {
  const parent = await connectBridgeLibrary({
    root: rootSummary("root_existing_parent", {
      displayName: "Existing Parent",
    }),
  });
  const child = folderSelection("root_existing_child", [
    "root_existing_parent",
  ]);
  const overlaps = folderSelectionOverlaps([child], [parent.library]);

  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0]?.source, "existing-library");
  assert.equal(overlaps[0]?.parentLabel, "Existing Parent");
});

test("batch connection route isolates stale selections from valid folders", async () => {
  const validSelection = await createBridgeSelection("Valid Batch Folder");
  const response = await batchConnectPost(
    new Request("http://test.local/api/bridge/connected-libraries/batch", {
      body: JSON.stringify({
        selections: [
          batchPayload(validSelection),
          {
            ancestorRootIds: [],
            displayName: "Stale Folder",
            permissions: defaultBridgePermissions,
            rootId: "root_stale_selection",
            safeLocation: "Unavailable test folder",
            selectionToken: "missing-selection-token",
            suggestedDisplayName: "Stale Folder",
          },
        ],
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  );
  const payload = await response.json();
  const connectedLibraries = await prisma.connectedLibrary.findMany();

  assert.equal(response.ok, true);
  assert.equal(payload.ok, true);
  assert.equal(payload.connectedCount, 1);
  assert.equal(payload.needsAttentionCount, 1);
  assert.equal(connectedLibraries.length, 1);
});

test("batch operation idempotency reuses already connected roots", async () => {
  const firstSelection = await createBridgeSelection("Idempotent Folder");
  const firstResponse = await batchConnectPost(
    new Request("http://test.local/api/bridge/connected-libraries/batch", {
      body: JSON.stringify({
        selections: [batchPayload(firstSelection)],
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  );
  const firstPayload = await firstResponse.json();
  const secondSelection = await createBridgeSelection("Idempotent Folder");
  const secondResponse = await batchConnectPost(
    new Request("http://test.local/api/bridge/connected-libraries/batch", {
      body: JSON.stringify({
        selections: [
          batchPayload(secondSelection, { recommendationPermission: false }),
        ],
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  );
  const secondPayload = await secondResponse.json();
  const connectedLibraries = await prisma.connectedLibrary.findMany();

  assert.equal(firstPayload.ok, true);
  assert.equal(secondPayload.ok, true);
  assert.equal(secondPayload.alreadyConnectedCount, 1);
  assert.equal(connectedLibraries.length, 1);
  assert.equal(connectedLibraries[0]?.recommendationPermission, false);
});

test("independent ConnectedLibrary records keep independent permissions and monitoring state", async () => {
  const workshops = await connectBridgeLibrary({
    root: rootSummary("root_workshops", {
      displayName: "Workshops",
      watchPermission: true,
      watcherState: "WATCHING",
    }),
  });
  const research = await connectBridgeLibrary({
    root: rootSummary("root_research", {
      displayName: "Research",
      recommendationPermission: false,
    }),
  });
  const website = await connectBridgeLibrary({
    root: rootSummary("root_website", {
      displayName: "Website",
      organizationPlanPermission: false,
    }),
  });

  assert.notEqual(workshops.library.id, research.library.id);
  assert.notEqual(research.library.id, website.library.id);
  assert.equal(workshops.library.watchPermission, true);
  assert.equal(workshops.library.monitoringState, "WATCHING");
  assert.equal(research.library.recommendationPermission, false);
  assert.equal(website.library.organizationPlanPermission, false);
});

test("per-folder permissions are enforced independently", async () => {
  const readable = await connectBridgeLibrary({
    root: rootSummary("root_readable", {
      readPermission: true,
    }),
  });
  const blocked = await connectBridgeLibrary({
    root: rootSummary("root_blocked", {
      readPermission: false,
    }),
  });

  await assert.doesNotReject(() =>
    requireConnectedLibraryPermission(
      readable.library.id,
      "readPermission",
      "read files",
    ),
  );
  await assert.rejects(
    () =>
      requireConnectedLibraryPermission(
        blocked.library.id,
        "readPermission",
        "read files",
      ),
    (error) =>
      error instanceof ConnectedLibraryError &&
      error.message.includes("permission"),
  );
});

test("batch scans create separate Scan Sessions for each connected library", async () => {
  const workshops = await createConnectedSession(
    "root_scan_workshops",
    "Workshops",
    "workshop.txt",
  );
  const research = await createConnectedSession(
    "root_scan_research",
    "Research",
    "research.txt",
  );
  const sessions = await prisma.scanSession.findMany({
    orderBy: {
      connectedFolderId: "asc",
    },
  });

  assert.equal(sessions.length, 2);
  assert.equal(workshops.session.connectedLibraryId, workshops.connectedLibrary.id);
  assert.equal(research.session.connectedLibraryId, research.connectedLibrary.id);
  assert.notEqual(sessions[0]?.connectedFolderId, sessions[1]?.connectedFolderId);
});

test("recommendation review data preserves originating connected library", async () => {
  const workshops = await createConnectedSession(
    "root_recommend_workshops",
    "Workshops",
    "workshop.txt",
  );
  const photos = await createConnectedSession(
    "root_recommend_photos",
    "Photos",
    "photo.txt",
  );
  const workshopSuggestion = await createSuggestion(
    workshops.session.id,
    workshops.scannedFile.id,
    workshops.scannedFile.relativePath,
    "workshops",
    "PENDING",
  );
  const photoSuggestion = await createSuggestion(
    photos.session.id,
    photos.scannedFile.id,
    photos.scannedFile.relativePath,
    "photos",
    "PENDING",
  );
  const data = await getOrganizationSuggestionsForConnectedLibraries();

  assert.equal(
    data.libraryIdBySuggestionId[workshopSuggestion.id],
    workshops.connectedLibrary.id,
  );
  assert.equal(
    data.libraryNameBySuggestionId[photoSuggestion.id],
    "Photos",
  );
  assert.ok(data.libraries.some((library) => library.label === "Workshops"));
  assert.ok(data.libraries.some((library) => library.label === "Photos"));
});

test("Organization Plans remain specific to one connected library", async () => {
  const workshops = await createConnectedSession(
    "root_plan_workshops",
    "Workshops",
    "workshop.txt",
  );
  const research = await createConnectedSession(
    "root_plan_research",
    "Research",
    "research.txt",
  );
  const workshopSuggestion = await createSuggestion(
    workshops.session.id,
    workshops.scannedFile.id,
    workshops.scannedFile.relativePath,
    "plan-workshops",
  );
  const researchSuggestion = await createSuggestion(
    research.session.id,
    research.scannedFile.id,
    research.scannedFile.relativePath,
    "plan-research",
  );

  const plan = await generateOrganizationPlanForScanSession(workshops.session.id);

  assert.equal(plan.scanSessionId, workshops.session.id);
  assert.equal(plan.connectedLibraryId, workshops.connectedLibrary.id);
  assert.equal(plan.totalActions, 2);
  assert.equal(
    plan.actions.filter((action) => action.actionType === "CREATE_FOLDER")
      .length,
    1,
  );
  assert.ok(
    plan.actions.some((action) => action.suggestionId === workshopSuggestion.id),
  );
  assert.ok(
    !plan.actions.some((action) => action.suggestionId === researchSuggestion.id),
  );
});
