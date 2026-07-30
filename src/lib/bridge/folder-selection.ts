import type { ConnectedLibrarySummary } from "./types";
import type { LocalBridgeFolderSelection } from "./local-bridge-client";

export type FolderSelectionLike = Pick<
  LocalBridgeFolderSelection,
  "ancestorRootIds" | "rootId" | "safeLocation" | "suggestedDisplayName"
>;

export type FolderSelectionOverlap = {
  childLabel: string;
  childRootId: string;
  parentLabel: string;
  parentRootId: string;
  source: "selection" | "existing-library";
};

function labelForSelection(selection: FolderSelectionLike) {
  return selection.suggestedDisplayName || selection.safeLocation;
}

function labelForLibrary(library: ConnectedLibrarySummary) {
  return library.displayName || library.safeLocalLocation;
}

export function duplicateSelectionRootIds(selections: FolderSelectionLike[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const selection of selections) {
    if (seen.has(selection.rootId)) {
      duplicates.add(selection.rootId);
    }

    seen.add(selection.rootId);
  }

  return [...duplicates];
}

export function folderSelectionOverlaps(
  selections: FolderSelectionLike[],
  existingLibraries: ConnectedLibrarySummary[] = [],
) {
  const overlaps: FolderSelectionOverlap[] = [];

  for (let index = 0; index < selections.length; index += 1) {
    const left = selections[index];

    if (!left) {
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < selections.length; nextIndex += 1) {
      const right = selections[nextIndex];

      if (!right) {
        continue;
      }

      if (right.ancestorRootIds.includes(left.rootId)) {
        overlaps.push({
          childLabel: labelForSelection(right),
          childRootId: right.rootId,
          parentLabel: labelForSelection(left),
          parentRootId: left.rootId,
          source: "selection",
        });
      } else if (left.ancestorRootIds.includes(right.rootId)) {
        overlaps.push({
          childLabel: labelForSelection(left),
          childRootId: left.rootId,
          parentLabel: labelForSelection(right),
          parentRootId: right.rootId,
          source: "selection",
        });
      }
    }

    for (const library of existingLibraries) {
      if (!library.bridgeRootId) {
        continue;
      }

      if (left.ancestorRootIds.includes(library.bridgeRootId)) {
        overlaps.push({
          childLabel: labelForSelection(left),
          childRootId: left.rootId,
          parentLabel: labelForLibrary(library),
          parentRootId: library.bridgeRootId,
          source: "existing-library",
        });
      }
    }
  }

  return overlaps;
}

export function selectionHasBlockingOverlaps(
  selections: FolderSelectionLike[],
  confirmedOverlapRootIds: Set<string>,
  existingLibraries: ConnectedLibrarySummary[] = [],
) {
  return folderSelectionOverlaps(selections, existingLibraries).some(
    (overlap) =>
      !confirmedOverlapRootIds.has(overlap.parentRootId) ||
      !confirmedOverlapRootIds.has(overlap.childRootId),
  );
}
