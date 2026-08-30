import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  buildLibraryExplorerData,
  filterLibraryExplorerFiles,
  flattenLibraryExplorerFiles,
  type LibraryExplorerFolder,
  type LibraryExplorerRootInput,
} from "../../src/lib/library/explorer";
import {
  buildFolderGrouping,
  collectFolderGroupIds,
} from "../../src/lib/library/folder-groups";
import type { BridgeScannedFileSummary } from "../../src/lib/bridge/types";

function suggestionCounts(
  overrides: Partial<
    BridgeScannedFileSummary["organizationSuggestionCounts"]
  > = {},
): BridgeScannedFileSummary["organizationSuggestionCounts"] {
  return {
    approved: 0,
    eligibleForPlanning: 0,
    leftUnchanged: 0,
    modified: 0,
    pending: 0,
    rejected: 0,
    total: 0,
    ...overrides,
  };
}

function scannedFile(
  id: string,
  relativePath: string,
  overrides: Partial<BridgeScannedFileSummary> = {},
): BridgeScannedFileSummary {
  return {
    audioMetadata: null,
    characterCount: null,
    checksum: null,
    extractedAt: null,
    extractionErrorCategory: null,
    extractionStatus: "PENDING",
    fileType: "TEXT",
    hasObservation: false,
    hasPossibleDuplicateSuggestion: false,
    hasReviewedObservation: false,
    id,
    imageMetadata: null,
    lastModified: null,
    organizationSuggestionCounts: suggestionCounts(),
    previewText: null,
    processedAt: null,
    processingErrorCategory: null,
    processingStage: "DISCOVERED",
    readingStatus: "NOT_READ",
    readStatus: "SUPPORTED",
    relativePath,
    scanError: null,
    sizeBytes: null,
    sourceCreatedAt: null,
    sourceUnavailableAt: null,
    sourceUnavailableReason: null,
    videoMetadata: null,
    ...overrides,
  };
}

function imageMetadata(
  overrides: Partial<NonNullable<BridgeScannedFileSummary["imageMetadata"]>> = {},
): NonNullable<BridgeScannedFileSummary["imageMetadata"]> {
  return {
    cameraDevice: null,
    colorProfile: null,
    duplicateConfidence: null,
    duplicateKind: null,
    duplicateOfScannedFileId: null,
    embeddedDate: null,
    format: "jpg",
    height: null,
    humanLabels: [],
    imageFingerprint: null,
    machineLabels: [],
    ocrErrorCategory: null,
    ocrStatus: "NOT_REQUESTED",
    orientation: null,
    previewErrorCategory: null,
    previewStatus: "COMPLETED",
    privacyState: "REVIEW_REQUIRED",
    provisionalQuestions: [],
    provisionalTopics: [],
    relatedSignals: [],
    sourceCreatedAt: null,
    sourceModifiedAt: null,
    summary: null,
    textSnippet: null,
    visualAnalysisErrorCategory: null,
    visualAnalysisStatus: "NOT_REQUESTED",
    width: null,
    ...overrides,
  };
}

function root(
  id: string,
  displayName: string,
  scanSessionId: string,
  files: BridgeScannedFileSummary[],
): LibraryExplorerRootInput {
  return {
    displayName,
    files,
    id,
    isEnabled: true,
    lastScanAt: "2026-08-28T10:00:00.000Z",
    latestScanSession: {
      completedAt: "2026-08-28T10:01:00.000Z",
      id: scanSessionId,
      startedAt: "2026-08-28T10:00:00.000Z",
      status: "COMPLETED",
    },
    platform: "MACOS",
    status: "CONNECTED",
  };
}

function testRoots() {
  return [
    root("root-a", "SCAN_ROOT_A_GENERAL_INBOX", "session-a", [
      scannedFile("a-intake", "Inbox/Intake/overview.txt", {
        hasObservation: true,
        readingStatus: "READ",
      }),
      scannedFile("a-notes", "Projects/Becoming/notes.txt", {
        hasObservation: true,
        readingStatus: "READ",
      }),
      scannedFile("a-hero", "Media/hero.jpg", {
        fileType: "IMAGE_JPG",
        hasObservation: true,
        imageMetadata: imageMetadata({
          height: 900,
          width: 1600,
        }),
        readingStatus: "READ",
      }),
      scannedFile("a-hero-copy", "Media/Duplicates/hero-copy.jpg", {
        fileType: "IMAGE_JPG",
        hasPossibleDuplicateSuggestion: true,
        processingStage: "FAILED",
        readingStatus: "FAILED",
      }),
    ]),
    root("root-b", "SCAN_ROOT_B_WEBSITE_AND_MEDIA", "session-b", [
      scannedFile("b-notes", "Media/notes.txt", {
        hasObservation: true,
        readingStatus: "READ",
      }),
      scannedFile("b-presentation", "Media/Slides/workshop.pdf", {
        fileType: "PDF",
        hasObservation: true,
        readingStatus: "READ",
      }),
      scannedFile("b-private", "Media/Private/private-family-placeholder.png", {
        fileType: "IMAGE_PNG",
        imageMetadata: imageMetadata({
          privacyState: "PRIVATE",
        }),
        processingStage: "RECOMMENDATIONS_READY",
        readingStatus: "READ",
      }),
    ]),
  ];
}

function findFolder(folder: LibraryExplorerFolder, name: string) {
  const directFolder = folder.folders.find((child) => child.name === name);

  if (directFolder) {
    return directFolder;
  }

  for (const child of folder.folders) {
    const nestedFolder = findFolder(child, name);

    if (nestedFolder) {
      return nestedFolder;
    }
  }

  return null;
}

describe("Library folder explorer", () => {
  it("keeps connected roots separate and builds nested breadcrumbs", () => {
    const data = buildLibraryExplorerData(testRoots());

    assert.deepEqual(
      data.roots.map((item) => item.displayName),
      ["SCAN_ROOT_A_GENERAL_INBOX", "SCAN_ROOT_B_WEBSITE_AND_MEDIA"],
    );

    const rootB = data.roots[1];
    const media = findFolder(rootB.tree, "Media");
    const slides = media ? findFolder(media, "Slides") : null;

    assert.ok(media);
    assert.ok(slides);
    assert.deepEqual(media.breadcrumbSegments, [
      "SCAN_ROOT_B_WEBSITE_AND_MEDIA",
      "Media",
    ]);
    assert.deepEqual(slides.breadcrumbSegments, [
      "SCAN_ROOT_B_WEBSITE_AND_MEDIA",
      "Media",
      "Slides",
    ]);
  });

  it("keeps duplicate filenames in different folders and roots distinct", () => {
    const files = flattenLibraryExplorerFiles(
      buildLibraryExplorerData(testRoots()).roots,
    );
    const notes = filterLibraryExplorerFiles(files, { query: "notes" });

    assert.equal(notes.length, 2);
    assert.deepEqual(
      notes.map((item) => ({
        id: item.file.id,
        path: item.file.relativePath,
        root: item.rootName,
      })),
      [
        {
          id: "a-notes",
          path: "Projects/Becoming/notes.txt",
          root: "SCAN_ROOT_A_GENERAL_INBOX",
        },
        {
          id: "b-notes",
          path: "Media/notes.txt",
          root: "SCAN_ROOT_B_WEBSITE_AND_MEDIA",
        },
      ],
    );
  });

  it("returns search matches with full root and folder context", () => {
    const files = flattenLibraryExplorerFiles(
      buildLibraryExplorerData(testRoots()).roots,
    );
    const matches = filterLibraryExplorerFiles(files, {
      query: "website media",
    });

    assert.equal(matches.length, 3);
    assert.ok(
      matches.every((item) =>
        item.breadcrumbSegments.includes("SCAN_ROOT_B_WEBSITE_AND_MEDIA"),
      ),
    );
    assert.ok(matches.every((item) => item.breadcrumbSegments.includes("Media")));
  });

  it("calculates folder counts for files, direct subfolders, attention, and duplicates", () => {
    const data = buildLibraryExplorerData(testRoots());
    const rootA = data.roots[0];
    const media = findFolder(rootA.tree, "Media");

    assert.ok(media);
    assert.deepEqual(media.counts, {
      files: 2,
      needsAttention: 1,
      possibleDuplicates: 1,
      subfolders: 1,
    });
    assert.equal(data.totals.files, 7);
    assert.equal(data.totals.needsAttention, 1);
    assert.equal(data.totals.possibleDuplicates, 1);
  });

  it("keeps All files view data complete after building the folder tree", () => {
    const files = flattenLibraryExplorerFiles(
      buildLibraryExplorerData(testRoots()).roots,
    );

    assert.equal(files.length, 7);
    assert.deepEqual(
      files.map((item) => item.scanSessionId),
      [
        "session-a",
        "session-a",
        "session-a",
        "session-a",
        "session-b",
        "session-b",
        "session-b",
      ],
    );
  });

  it("does not invent global relationship counts for scanned files", () => {
    const files = flattenLibraryExplorerFiles(
      buildLibraryExplorerData(testRoots()).roots,
    );

    assert.equal("relatedItemCount" in files[0], false);
    assert.equal(JSON.stringify(files).includes("Related items"), false);
  });

  it("wires the visible page to one Library heading and the folder explorer", () => {
    const pageSource = readFileSync(
      "src/app/admin/library/documents/page.tsx",
      "utf8",
    );
    const explorerSource = readFileSync(
      "src/components/library/LibraryExplorer.tsx",
      "utf8",
    );

    assert.match(pageSource, /title="My Library"/);
    assert.doesNotMatch(pageSource, /DocumentTable/);
    assert.doesNotMatch(explorerSource, />\s*My Library\s*</);
  });

  it("keeps Library browsing read-only and long-path responsive", () => {
    const source = [
      readFileSync("src/lib/library/explorer.ts", "utf8"),
      readFileSync("src/components/library/LibraryExplorer.tsx", "utf8"),
      readFileSync("src/app/admin/library/documents/page.tsx", "utf8"),
    ].join("\n");

    assert.doesNotMatch(source, /\b(unlink|rename|writeFile|mkdir|rm)\s*\(/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.match(source, /\[overflow-wrap:anywhere\]/);
    assert.match(source, /min-w-0/);
    assert.match(source, /flex-wrap/);
  });
});

describe("shared folder-grouped file views", () => {
  const items = [
    { id: "root", path: "root-note.txt" },
    { id: "alice-intake", path: "Clients/Loose/Alice_Client_Intake.docx" },
    { id: "alice-notes", path: "Clients/Loose/Alice_Session_Notes.txt" },
    { id: "workshop", path: "Workshops\\Drafts\\Workshop_Flyer.webp" },
    { id: "other-notes", path: "Archive/Notes/Alice_Session_Notes.txt" },
  ];

  it("groups scan results into their nested source folders", () => {
    const grouping = buildFolderGrouping(
      items,
      (item) => item.path,
      (item) => item.id,
    );

    assert.equal(grouping.totalItems, 5);
    assert.deepEqual(
      grouping.folders.map((folder) => folder.name),
      ["Archive", "Clients", "Workshops"],
    );
    assert.deepEqual(grouping.rootItems.map((item) => item.id), ["root"]);

    const clients = grouping.folders.find((folder) => folder.name === "Clients");
    const loose = clients?.folders.find((folder) => folder.name === "Loose");

    assert.ok(clients);
    assert.ok(loose);
    assert.equal(clients.totalItems, 2);
    assert.equal(loose.totalItems, 2);
    assert.deepEqual(
      loose.items.map((item) => item.id),
      ["alice-intake", "alice-notes"],
    );
  });

  it("keeps duplicate filenames in separate source folders", () => {
    const grouping = buildFolderGrouping(
      items,
      (item) => item.path,
      (item) => item.id,
    );
    const clients = grouping.folders.find((folder) => folder.name === "Clients");
    const archive = grouping.folders.find((folder) => folder.name === "Archive");

    assert.equal(clients?.folders[0]?.items[1]?.id, "alice-notes");
    assert.equal(archive?.folders[0]?.items[0]?.id, "other-notes");
  });

  it("provides every nested folder for expand and collapse controls", () => {
    const grouping = buildFolderGrouping(
      items,
      (item) => item.path,
      (item) => item.id,
    );

    assert.deepEqual(collectFolderGroupIds(grouping.folders), [
      "Archive",
      "Archive/Notes",
      "Clients",
      "Clients/Loose",
      "Workshops",
      "Workshops/Drafts",
    ]);
  });

  it("wires scan sessions, recommendations, and plans to folder-first views", () => {
    const scannedFilesSource = readFileSync(
      "src/components/library/ScannedFilesPanel.tsx",
      "utf8",
    );
    const recommendationsSource = readFileSync(
      "src/components/library/OrganizationSuggestionsReviewPanel.tsx",
      "utf8",
    );
    const planSource = readFileSync(
      "src/components/library/OrganizationPlanReviewPanel.tsx",
      "utf8",
    );

    assert.match(scannedFilesSource, /FolderGroupedList/);
    assert.match(scannedFilesSource, /getRelativePath=\{\(file\) => file\.relativePath\}/);
    assert.match(recommendationsSource, /pathFolder\(suggestion\.currentRelativePath\)/);
    assert.match(recommendationsSource, /in this source folder/);
    assert.match(planSource, /FolderGroupedList/);
    assert.match(planSource, /action\.sourceRelativePath/);
  });

  it("keeps folder grouping presentational and filesystem read-only", () => {
    const source = [
      readFileSync("src/lib/library/folder-groups.ts", "utf8"),
      readFileSync("src/components/library/FolderGroupedList.tsx", "utf8"),
    ].join("\n");

    assert.doesNotMatch(source, /\b(unlink|rename|writeFile|mkdir|rm)\s*\(/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.match(source, /Folder View/);
    assert.match(source, /All \{pluralTitle\(itemLabel\)\}/);
  });
});
