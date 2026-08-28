import {
  fileMatchesScannedFileFilter,
  type ScannedFileFilter,
} from "@/lib/bridge/scanned-file-filters";
import type {
  BridgeScanSessionStatus,
  BridgeScannedFileSummary,
  ConnectedLibraryPlatform,
  ConnectedLibraryStatus,
} from "@/lib/bridge/types";

export type LibraryExplorerFolderCounts = {
  files: number;
  subfolders: number;
  needsAttention: number;
  possibleDuplicates: number;
};

export type LibraryExplorerFile = {
  file: BridgeScannedFileSummary;
  rootId: string;
  rootName: string;
  scanSessionId: string;
  fileName: string;
  folderPath: string;
  breadcrumbSegments: string[];
};

export type LibraryExplorerFolder = {
  id: string;
  name: string;
  relativePath: string;
  breadcrumbSegments: string[];
  counts: LibraryExplorerFolderCounts;
  folders: LibraryExplorerFolder[];
  files: LibraryExplorerFile[];
};

export type LibraryExplorerScanSession = {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: BridgeScanSessionStatus;
};

export type LibraryExplorerRoot = {
  id: string;
  displayName: string;
  platform: ConnectedLibraryPlatform;
  status: ConnectedLibraryStatus;
  isEnabled: boolean;
  lastScanAt: string | null;
  latestScanSession: LibraryExplorerScanSession | null;
  tree: LibraryExplorerFolder;
};

export type LibraryExplorerRootInput = Omit<
  LibraryExplorerRoot,
  "tree"
> & {
  files: BridgeScannedFileSummary[];
};

export type LibraryExplorerData = {
  roots: LibraryExplorerRoot[];
  totals: LibraryExplorerFolderCounts;
};

export type LibraryExplorerFileFilterOptions = {
  filter?: LibraryExplorerFilter;
  query?: string;
};

export type LibraryExplorerFilter = ScannedFileFilter | "READ" | "WAITING";

type MutableLibraryExplorerFolder = Omit<
  LibraryExplorerFolder,
  "folders"
> & {
  folderMap: Map<string, MutableLibraryExplorerFolder>;
  folders: MutableLibraryExplorerFolder[];
};

function emptyCounts(): LibraryExplorerFolderCounts {
  return {
    files: 0,
    needsAttention: 0,
    possibleDuplicates: 0,
    subfolders: 0,
  };
}

function normalizeRelativePath(value: string) {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

function sortByName<T extends { name: string }>(items: T[]) {
  return [...items].sort((first, second) => {
    const firstKey = first.name.toLowerCase();
    const secondKey = second.name.toLowerCase();

    if (firstKey === secondKey) {
      return first.name < second.name ? -1 : first.name > second.name ? 1 : 0;
    }

    return firstKey < secondKey ? -1 : 1;
  });
}

function sortExplorerFiles(files: LibraryExplorerFile[]) {
  return [...files].sort((first, second) => {
    const firstPath = first.file.relativePath.toLowerCase();
    const secondPath = second.file.relativePath.toLowerCase();

    if (firstPath === secondPath) {
      return first.file.id < second.file.id
        ? -1
        : first.file.id > second.file.id
          ? 1
          : 0;
    }

    return firstPath < secondPath ? -1 : 1;
  });
}

function createMutableFolder(
  rootName: string,
  name: string,
  relativePath: string,
): MutableLibraryExplorerFolder {
  const pathSegments = relativePath ? relativePath.split("/") : [];

  return {
    breadcrumbSegments: [rootName, ...pathSegments],
    counts: emptyCounts(),
    files: [],
    folderMap: new Map(),
    folders: [],
    id: `${rootName}:${relativePath || "/"}`,
    name,
    relativePath,
  };
}

function addFileCounts(
  folder: MutableLibraryExplorerFolder,
  file: BridgeScannedFileSummary,
) {
  folder.counts.files += 1;

  if (fileMatchesScannedFileFilter(file, "FAILED")) {
    folder.counts.needsAttention += 1;
  }

  if (fileMatchesScannedFileFilter(file, "POSSIBLE_DUPLICATES")) {
    folder.counts.possibleDuplicates += 1;
  }
}

function getOrCreateFolder(
  parent: MutableLibraryExplorerFolder,
  rootName: string,
  name: string,
  relativePath: string,
) {
  const existing = parent.folderMap.get(name);

  if (existing) {
    return existing;
  }

  const folder = createMutableFolder(rootName, name, relativePath);
  parent.folderMap.set(name, folder);
  parent.folders.push(folder);
  parent.counts.subfolders = parent.folderMap.size;

  return folder;
}

function toPublicFolder(
  folder: MutableLibraryExplorerFolder,
): LibraryExplorerFolder {
  return {
    breadcrumbSegments: folder.breadcrumbSegments,
    counts: folder.counts,
    files: sortExplorerFiles(folder.files),
    folders: sortByName(folder.folders).map(toPublicFolder),
    id: folder.id,
    name: folder.name,
    relativePath: folder.relativePath,
  };
}

function buildRootTree(root: LibraryExplorerRootInput) {
  const rootFolder = createMutableFolder(
    root.displayName,
    root.displayName,
    "",
  );

  if (!root.latestScanSession) {
    return toPublicFolder(rootFolder);
  }

  for (const file of root.files) {
    const normalizedPath = normalizeRelativePath(file.relativePath);
    const pathSegments = normalizedPath.split("/").filter(Boolean);
    const fileName = pathSegments.at(-1) ?? file.relativePath;
    const folderSegments = pathSegments.slice(0, -1);
    const folderPath = folderSegments.join("/");
    let currentFolder = rootFolder;

    addFileCounts(rootFolder, file);

    for (let index = 0; index < folderSegments.length; index += 1) {
      const segment = folderSegments[index];
      const relativePath = folderSegments.slice(0, index + 1).join("/");

      currentFolder = getOrCreateFolder(
        currentFolder,
        root.displayName,
        segment,
        relativePath,
      );
      addFileCounts(currentFolder, file);
    }

    currentFolder.files.push({
      breadcrumbSegments: [root.displayName, ...folderSegments],
      file,
      fileName,
      folderPath,
      rootId: root.id,
      rootName: root.displayName,
      scanSessionId: root.latestScanSession.id,
    });
  }

  return toPublicFolder(rootFolder);
}

export function buildLibraryExplorerData(
  roots: LibraryExplorerRootInput[],
): LibraryExplorerData {
  const explorerRoots = roots.map((root) => ({
    id: root.id,
    displayName: root.displayName,
    isEnabled: root.isEnabled,
    lastScanAt: root.lastScanAt,
    latestScanSession: root.latestScanSession,
    platform: root.platform,
    status: root.status,
    tree: buildRootTree(root),
  }));

  const totals = explorerRoots.reduce((counts, root) => {
    counts.files += root.tree.counts.files;
    counts.needsAttention += root.tree.counts.needsAttention;
    counts.possibleDuplicates += root.tree.counts.possibleDuplicates;
    counts.subfolders += root.tree.counts.subfolders;

    return counts;
  }, emptyCounts());

  return {
    roots: explorerRoots,
    totals,
  };
}

export function flattenLibraryExplorerFiles(
  roots: LibraryExplorerRoot[],
): LibraryExplorerFile[] {
  const files: LibraryExplorerFile[] = [];

  function collect(folder: LibraryExplorerFolder) {
    files.push(...folder.files);

    for (const childFolder of folder.folders) {
      collect(childFolder);
    }
  }

  for (const root of roots) {
    collect(root.tree);
  }

  return files;
}

export function libraryExplorerFileMatches(
  file: LibraryExplorerFile,
  { filter = "ALL", query = "" }: LibraryExplorerFileFilterOptions = {},
) {
  const normalizedQuery = query.trim().toLowerCase();

  if (filter === "READ" && file.file.readingStatus !== "READ") {
    return false;
  }

  if (
    filter === "WAITING" &&
    (file.file.readingStatus !== "NOT_READ" ||
      file.file.processingStage === "FAILED")
  ) {
    return false;
  }

  if (
    filter !== "READ" &&
    filter !== "WAITING" &&
    !fileMatchesScannedFileFilter(file.file, filter)
  ) {
    return false;
  }

  if (!normalizedQuery) {
    return true;
  }

  const haystack = [
    file.rootName,
    file.folderPath,
    file.fileName,
    file.file.relativePath,
    file.file.fileType,
    file.file.previewText,
    file.file.scanError,
    file.file.extractionErrorCategory,
    file.file.processingErrorCategory,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return normalizedQuery
    .split(/\s+/)
    .every((queryPart) => haystack.includes(queryPart));
}

export function filterLibraryExplorerFiles(
  files: LibraryExplorerFile[],
  options: LibraryExplorerFileFilterOptions = {},
) {
  return files.filter((file) => libraryExplorerFileMatches(file, options));
}
