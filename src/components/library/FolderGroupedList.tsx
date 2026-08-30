"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { NsnButton } from "@/components/library/NsnButton";
import {
  buildFolderGrouping,
  collectFolderGroupIds,
  type FolderGroup,
} from "@/lib/library/folder-groups";

type FolderGroupedListProps<T> = {
  activeRefinement?: boolean;
  getId: (item: T) => string;
  getRelativePath: (item: T) => string;
  itemLabel?: string;
  items: T[];
  renderItem: (item: T) => ReactNode;
};

type ViewMode = "FOLDERS" | "ALL_FILES";

function itemCountLabel(count: number, itemLabel: string) {
  return `${count} ${itemLabel}${count === 1 ? "" : "s"}`;
}

function pluralTitle(itemLabel: string) {
  return `${itemLabel}s`
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function FolderNode<T>({
  activeRefinement,
  depth,
  expandedFolders,
  folder,
  getId,
  itemLabel,
  onToggle,
  renderItem,
}: {
  activeRefinement: boolean;
  depth: number;
  expandedFolders: Record<string, boolean>;
  folder: FolderGroup<T>;
  getId: (item: T) => string;
  itemLabel: string;
  onToggle: (folderId: string, defaultExpanded: boolean) => void;
  renderItem: (item: T) => ReactNode;
}) {
  const defaultExpanded = activeRefinement || depth === 0;
  const isExpanded = activeRefinement
    ? true
    : (expandedFolders[folder.id] ?? defaultExpanded);
  const headingId = `folder-group-${encodeURIComponent(folder.id)}`;

  return (
    <section
      aria-labelledby={headingId}
      className="grid min-w-0 gap-3 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3"
    >
      <button
        aria-expanded={isExpanded}
        className="grid min-w-0 gap-2 rounded-md text-left outline-none transition hover:bg-[var(--nsn-sage-mist)] focus-visible:ring-2 focus-visible:ring-[var(--nsn-soft-aqua)] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        onClick={() => onToggle(folder.id, defaultExpanded)}
        type="button"
      >
        <span className="min-w-0 p-2">
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--nsn-teal)]">
            Folder
          </span>
          <span
            className="mt-1 block break-words text-lg font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
            id={headingId}
          >
            {folder.name}
          </span>
          <span className="mt-1 block break-words text-xs leading-5 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            {folder.relativePath}
          </span>
        </span>
        <span className="flex min-w-0 items-center justify-between gap-3 p-2 text-sm font-semibold text-[var(--nsn-teal-dark)] sm:justify-end">
          <span>{itemCountLabel(folder.totalItems, itemLabel)}</span>
          <span>{isExpanded ? "Collapse" : "Expand"}</span>
        </span>
      </button>

      {isExpanded ? (
        <div className="grid min-w-0 gap-3 border-l border-[var(--nsn-border)] pl-3 sm:pl-4">
          {folder.folders.map((childFolder) => (
            <FolderNode
              activeRefinement={activeRefinement}
              depth={depth + 1}
              expandedFolders={expandedFolders}
              folder={childFolder}
              getId={getId}
              itemLabel={itemLabel}
              key={childFolder.id}
              onToggle={onToggle}
              renderItem={renderItem}
            />
          ))}
          {folder.items.map((item) => (
            <div className="min-w-0" key={getId(item)}>
              {renderItem(item)}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function FolderGroupedList<T>({
  activeRefinement = false,
  getId,
  getRelativePath,
  itemLabel = "file",
  items,
  renderItem,
}: FolderGroupedListProps<T>) {
  const [viewMode, setViewMode] = useState<ViewMode>("FOLDERS");
  const [expandedFolders, setExpandedFolders] = useState<
    Record<string, boolean>
  >({});
  const grouping = useMemo(
    () => buildFolderGrouping(items, getRelativePath, getId),
    [getId, getRelativePath, items],
  );
  const folderIds = useMemo(
    () => collectFolderGroupIds(grouping.folders),
    [grouping.folders],
  );

  function toggleFolder(folderId: string, defaultExpanded: boolean) {
    setExpandedFolders((current) => ({
      ...current,
      [folderId]: !(current[folderId] ?? defaultExpanded),
    }));
  }

  function setAllFolders(expanded: boolean) {
    setExpandedFolders(
      Object.fromEntries(folderIds.map((folderId) => [folderId, expanded])),
    );
  }

  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div
          aria-label={`${itemLabel} view`}
          className="flex min-w-0 flex-wrap gap-2"
          role="group"
        >
          <NsnButton
            aria-pressed={viewMode === "FOLDERS"}
            onClick={() => setViewMode("FOLDERS")}
            type="button"
            variant={viewMode === "FOLDERS" ? "primary" : "secondary"}
          >
            Folder View
          </NsnButton>
          <NsnButton
            aria-pressed={viewMode === "ALL_FILES"}
            onClick={() => setViewMode("ALL_FILES")}
            type="button"
            variant={viewMode === "ALL_FILES" ? "primary" : "secondary"}
          >
            All {pluralTitle(itemLabel)}
          </NsnButton>
        </div>

        {viewMode === "FOLDERS" && folderIds.length > 0 ? (
          <div className="flex min-w-0 flex-wrap gap-2">
            <NsnButton
              onClick={() => setAllFolders(true)}
              type="button"
              variant="secondary"
            >
              Expand All Folders
            </NsnButton>
            <NsnButton
              onClick={() => setAllFolders(false)}
              type="button"
              variant="secondary"
            >
              Collapse All Folders
            </NsnButton>
          </div>
        ) : null}
      </div>

      {viewMode === "ALL_FILES" ? (
        <div className="grid min-w-0 gap-3">
          {items.map((item) => (
            <div className="min-w-0" key={getId(item)}>
              {renderItem(item)}
            </div>
          ))}
        </div>
      ) : (
        <div className="grid min-w-0 gap-3">
          {grouping.folders.map((folder) => (
            <FolderNode
              activeRefinement={activeRefinement}
              depth={0}
              expandedFolders={expandedFolders}
              folder={folder}
              getId={getId}
              itemLabel={itemLabel}
              key={folder.id}
              onToggle={toggleFolder}
              renderItem={renderItem}
            />
          ))}

          {grouping.rootItems.length > 0 ? (
            <section className="grid min-w-0 gap-3 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--nsn-teal)]">
                  Folder
                </p>
                <h3 className="mt-1 text-lg font-semibold text-[var(--nsn-navy)]">
                  Root Folder
                </h3>
                <p className="mt-1 text-sm text-[var(--nsn-slate)]">
                  {itemCountLabel(grouping.rootItems.length, itemLabel)}
                </p>
              </div>
              <div className="grid min-w-0 gap-3 border-l border-[var(--nsn-border)] pl-3 sm:pl-4">
                {grouping.rootItems.map((item) => (
                  <div className="min-w-0" key={getId(item)}>
                    {renderItem(item)}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
