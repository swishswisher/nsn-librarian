"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import { NsnSearchField } from "@/components/library/NsnSearchField";
import {
  scannedFileCategoryCounts,
  type ScannedFileCategoryCounts,
} from "@/lib/bridge/scanned-file-filters";
import {
  mediaCategoryForFileType,
  type ScannedFileMediaCategory,
} from "@/lib/bridge/media-kind";
import {
  filterLibraryExplorerFiles,
  flattenLibraryExplorerFiles,
  type LibraryExplorerData,
  type LibraryExplorerFile,
  type LibraryExplorerFilter,
  type LibraryExplorerFolder,
  type LibraryExplorerFolderCounts,
  type LibraryExplorerRoot,
} from "@/lib/library/explorer";
import {
  getScanSessionRoute,
  getScannedFileExamineRoute,
} from "@/lib/library/routes";

type LibraryExplorerProps = {
  data: LibraryExplorerData;
  highlightedFileId?: string | null;
};

type ViewMode = "FOLDERS" | "ALL_FILES";

const libraryFilters: Array<{
  countKey?: keyof ScannedFileCategoryCounts;
  label: string;
  value: LibraryExplorerFilter;
}> = [
  { label: "All", value: "ALL" },
  { countKey: "documents", label: "Documents", value: "DOCUMENTS" },
  { countKey: "images", label: "Images", value: "IMAGES" },
  { countKey: "audio", label: "Audio", value: "AUDIO" },
  { countKey: "video", label: "Video", value: "VIDEO" },
  { label: "Read", value: "READ" },
  { label: "Waiting", value: "WAITING" },
  { label: "Workshops", value: "WORKSHOPS" },
  { label: "Presentations", value: "PRESENTATIONS" },
  { label: "Meetings", value: "MEETINGS" },
  { label: "Website Candidates", value: "WEBSITE_CANDIDATES" },
  { label: "Possible Duplicates", value: "POSSIBLE_DUPLICATES" },
  { label: "Private", value: "PRIVATE" },
  { label: "Being Examined", value: "PROCESSING" },
  { label: "Recommendations Ready", value: "SUGGESTIONS" },
  { label: "Unsupported", value: "UNSUPPORTED" },
  { label: "Needs Attention", value: "FAILED" },
];

const categoryLabels: Record<ScannedFileMediaCategory, string> = {
  AUDIO: "Audio",
  DOCUMENT: "Document",
  IMAGE: "Image",
  UNSUPPORTED: "Unsupported",
  VIDEO: "Video",
};

function formatCount(value: number, singular: string, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function formatFileSize(value: string | null) {
  if (!value) {
    return "Unknown size";
  }

  const bytes = Number(value);

  if (!Number.isFinite(bytes)) {
    return "Unknown size";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatIsoDate(value: string | null) {
  if (!value) {
    return "No scan recorded";
  }

  const date = value.slice(0, 10);
  const time = value.slice(11, 16);

  return time ? `${date} ${time} UTC` : date;
}

function titleCaseStatus(value: string) {
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function platformLabel(value: string) {
  if (value === "MACOS") {
    return "macOS";
  }

  return titleCaseStatus(value);
}

function statusTone(status: string): NsnBadgeTone {
  if (
    status === "CONNECTED" ||
    status === "COMPLETED" ||
    status === "READ" ||
    status === "RECOMMENDATIONS_READY" ||
    status === "SUGGESTIONS_GENERATED"
  ) {
    return "approved";
  }

  if (
    status === "FAILED" ||
    status === "NEEDS_ATTENTION" ||
    status === "DISCONNECTED"
  ) {
    return "review";
  }

  if (
    status === "PENDING" ||
    status === "SCANNING" ||
    status === "READING" ||
    status === "EXAMINING" ||
    status === "GENERATING_SUGGESTIONS"
  ) {
    return "pending";
  }

  return "source";
}

function fileCategory(file: LibraryExplorerFile) {
  return mediaCategoryForFileType(file.file.fileType);
}

function displayFileType(file: LibraryExplorerFile) {
  if (file.file.fileType.startsWith("IMAGE_")) {
    return file.file.fileType.replace("IMAGE_", "");
  }

  if (file.file.fileType.startsWith("AUDIO_")) {
    return file.file.fileType.replace("AUDIO_", "");
  }

  if (file.file.fileType.startsWith("VIDEO_")) {
    return file.file.fileType.replace("VIDEO_", "");
  }

  return file.file.fileType.replaceAll("_", " ");
}

function readingLabel(file: LibraryExplorerFile) {
  const scannedFile = file.file;

  if (scannedFile.sourceUnavailableAt) {
    return "Source unavailable";
  }

  if (
    scannedFile.processingStage === "SUGGESTIONS_GENERATED" ||
    scannedFile.processingStage === "RECOMMENDATIONS_READY" ||
    scannedFile.organizationSuggestionCounts.total > 0
  ) {
    return "Recommendations ready";
  }

  if (scannedFile.processingStage === "EXAMINED") {
    return "Examined";
  }

  if (
    scannedFile.processingStage === "READING_IMAGE_METADATA" ||
    scannedFile.processingStage === "METADATA_READY" ||
    scannedFile.processingStage === "PREPARING_PREVIEW" ||
    scannedFile.processingStage === "ANALYZING_IMAGE" ||
    scannedFile.processingStage === "OCR_PROCESSING" ||
    scannedFile.processingStage === "OBSERVING" ||
    scannedFile.processingStage === "READING" ||
    scannedFile.processingStage === "EXAMINING"
  ) {
    return "Being examined";
  }

  if (scannedFile.processingStage === "FAILED") {
    return "Needs attention";
  }

  if (scannedFile.readingStatus === "READ") {
    return "Read";
  }

  if (scannedFile.readingStatus === "UNSUPPORTED") {
    return "Unsupported for reading";
  }

  if (scannedFile.readingStatus === "FAILED") {
    return "Reading failed";
  }

  return scannedFile.readStatus === "SUPPORTED"
    ? "Waiting for the Librarian"
    : "Not readable";
}

function readingTone(file: LibraryExplorerFile): NsnBadgeTone {
  const scannedFile = file.file;

  if (
    scannedFile.sourceUnavailableAt ||
    scannedFile.processingStage === "FAILED" ||
    scannedFile.readingStatus === "FAILED"
  ) {
    return "review";
  }

  if (
    scannedFile.processingStage === "SUGGESTIONS_GENERATED" ||
    scannedFile.processingStage === "RECOMMENDATIONS_READY" ||
    scannedFile.organizationSuggestionCounts.total > 0
  ) {
    return "migration";
  }

  if (scannedFile.processingStage === "EXAMINED" || scannedFile.readingStatus === "READ") {
    return "approved";
  }

  if (scannedFile.readingStatus === "UNSUPPORTED") {
    return "pending";
  }

  return "source";
}

function canExamineFile(file: LibraryExplorerFile) {
  return (
    !file.file.sourceUnavailableAt &&
    file.file.readingStatus === "READ" &&
    file.file.hasObservation
  );
}

function recommendationLabel(file: LibraryExplorerFile) {
  const total = file.file.organizationSuggestionCounts.total;

  if (total === 0) {
    return null;
  }

  return `${formatCount(total, "recommendation")}`;
}

function imageDetail(file: LibraryExplorerFile) {
  const metadata = file.file.imageMetadata;

  if (!metadata) {
    return null;
  }

  if (metadata.width && metadata.height) {
    return `${metadata.width} x ${metadata.height}`;
  }

  return "Dimensions not recorded";
}

function privacyLabel(file: LibraryExplorerFile) {
  const privacyState =
    file.file.imageMetadata?.privacyState ??
    file.file.audioMetadata?.privacyState ??
    file.file.videoMetadata?.privacyState;

  if (!privacyState || privacyState === "REVIEW_REQUIRED") {
    return null;
  }

  return titleCaseStatus(privacyState);
}

function Breadcrumbs({ segments }: { segments: string[] }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--nsn-warm-gray)]">
      {segments.map((segment, index) => (
        <span className="contents" key={`${segment}-${index}`}>
          {index > 0 ? (
            <span aria-hidden="true" className="text-[var(--nsn-border)]">
              &rarr;
            </span>
          ) : null}
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
            {segment}
          </span>
        </span>
      ))}
    </span>
  );
}

function CountPills({ counts }: { counts: LibraryExplorerFolderCounts }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-2 text-xs text-[var(--nsn-slate)]">
      <span>{formatCount(counts.files, "file")}</span>
      <span>{formatCount(counts.subfolders, "subfolder")}</span>
      {counts.needsAttention > 0 ? (
        <span className="font-semibold text-[var(--nsn-danger)]">
          {formatCount(counts.needsAttention, "needs attention", "need attention")}
        </span>
      ) : null}
      {counts.possibleDuplicates > 0 ? (
        <span className="font-semibold text-[var(--nsn-teal-dark)]">
          {formatCount(counts.possibleDuplicates, "possible duplicate")}
        </span>
      ) : null}
    </div>
  );
}

function FileBadges({ item }: { item: LibraryExplorerFile }) {
  const category = fileCategory(item);
  const recommendation = recommendationLabel(item);
  const privacy = privacyLabel(item);
  const dimensions = category === "IMAGE" ? imageDetail(item) : null;

  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      <NsnBadge tone="source">{categoryLabels[category]}</NsnBadge>
      <NsnBadge tone="source">{displayFileType(item)}</NsnBadge>
      <NsnBadge tone={readingTone(item)}>{readingLabel(item)}</NsnBadge>
      {dimensions ? <NsnBadge tone="source">{dimensions}</NsnBadge> : null}
      {privacy ? <NsnBadge tone="gold">{privacy}</NsnBadge> : null}
      {item.file.hasPossibleDuplicateSuggestion ? (
        <NsnBadge tone="migration">Possible duplicate</NsnBadge>
      ) : null}
      {recommendation ? (
        <NsnBadge tone="migration">{recommendation}</NsnBadge>
      ) : null}
    </div>
  );
}

function FileRow({
  highlightedFileId,
  item,
}: {
  highlightedFileId: string | null;
  item: LibraryExplorerFile;
}) {
  const isHighlighted = highlightedFileId === item.file.id;

  return (
    <article
      className={[
        "min-w-0 rounded-lg border bg-[var(--nsn-card)] p-3 shadow-[0_10px_24px_rgb(31_42_68_/_0.04)]",
        isHighlighted
          ? "border-[var(--nsn-teal)] ring-2 ring-[var(--nsn-soft-aqua)]"
          : "border-[var(--nsn-border)]",
      ].join(" ")}
    >
      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="grid min-w-0 gap-2">
          <Breadcrumbs segments={item.breadcrumbSegments} />
          <div className="min-w-0">
            <h4 className="break-words text-base font-semibold leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
              {item.fileName}
            </h4>
            <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              {item.file.relativePath}
            </p>
          </div>
          <FileBadges item={item} />
        </div>

        <div className="flex min-w-0 flex-col gap-2 sm:flex-row lg:flex-col">
          {canExamineFile(item) ? (
            <Link
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)]"
              href={getScannedFileExamineRoute(item.scanSessionId, item.file.id)}
            >
              Examine
            </Link>
          ) : (
            <span className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] px-4 text-center text-sm font-semibold text-[var(--nsn-warm-gray)]">
              {readingLabel(item)}
            </span>
          )}
        </div>
      </div>

      <dl className="mt-3 grid min-w-0 gap-2 text-sm text-[var(--nsn-slate)] sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="font-semibold text-[var(--nsn-navy)]">Size</dt>
          <dd>{formatFileSize(item.file.sizeBytes)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-semibold text-[var(--nsn-navy)]">Modified</dt>
          <dd>{formatIsoDate(item.file.lastModified)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-semibold text-[var(--nsn-navy)]">Characters</dt>
          <dd>
            {item.file.characterCount === null
              ? "Not recorded"
              : item.file.characterCount.toLocaleString("en-US")}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function folderHasVisibleFiles(
  folder: LibraryExplorerFolder,
  visibleFileIds: Set<string>,
): boolean {
  return (
    folder.files.some((file) => visibleFileIds.has(file.file.id)) ||
    folder.folders.some((childFolder) =>
      folderHasVisibleFiles(childFolder, visibleFileIds),
    )
  );
}

function FolderNode({
  activeRefinement,
  depth,
  folder,
  highlightedFileId,
  visibleFileIds,
}: {
  activeRefinement: boolean;
  depth: number;
  folder: LibraryExplorerFolder;
  highlightedFileId: string | null;
  visibleFileIds: Set<string>;
}) {
  if (!folderHasVisibleFiles(folder, visibleFileIds)) {
    return null;
  }

  const visibleFiles = folder.files.filter((file) =>
    visibleFileIds.has(file.file.id),
  );

  return (
    <details
      className="min-w-0 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3"
      open={activeRefinement || depth === 0}
    >
      <summary className="cursor-pointer list-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--nsn-soft-aqua)]">
        <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--nsn-teal)]">
              Folder
            </p>
            <h3 className="mt-1 break-words text-lg font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
              {folder.name}
            </h3>
            <div className="mt-1">
              <Breadcrumbs segments={folder.breadcrumbSegments} />
            </div>
          </div>
          <CountPills counts={folder.counts} />
        </div>
      </summary>

      <div className="mt-4 grid min-w-0 gap-3 border-l border-[var(--nsn-border)] pl-3 sm:pl-4">
        {folder.folders.map((childFolder) => (
          <FolderNode
            activeRefinement={activeRefinement}
            depth={depth + 1}
            folder={childFolder}
            highlightedFileId={highlightedFileId}
            key={childFolder.id}
            visibleFileIds={visibleFileIds}
          />
        ))}
        {visibleFiles.map((file) => (
          <FileRow
            highlightedFileId={highlightedFileId}
            item={file}
            key={file.file.id}
          />
        ))}
      </div>
    </details>
  );
}

function RootSection({
  activeRefinement,
  highlightedFileId,
  root,
  visibleFileIds,
}: {
  activeRefinement: boolean;
  highlightedFileId: string | null;
  root: LibraryExplorerRoot;
  visibleFileIds: Set<string>;
}) {
  const visibleRootFiles = root.tree.files.filter((file) =>
    visibleFileIds.has(file.file.id),
  );
  const visibleFolderCount = root.tree.folders.filter((folder) =>
    folderHasVisibleFiles(folder, visibleFileIds),
  ).length;
  const hasVisibleContent =
    visibleRootFiles.length > 0 ||
    visibleFolderCount > 0 ||
    (!activeRefinement && root.tree.counts.files === 0);

  if (!hasVisibleContent) {
    return null;
  }

  return (
    <section
      aria-labelledby={`library-root-${root.id}`}
      className="min-w-0 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 shadow-[0_16px_36px_rgb(31_42_68_/_0.06)]"
    >
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-teal)]">
            Connected Library
          </p>
          <h2
            className="mt-1 break-words text-2xl font-semibold leading-8 text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
            id={`library-root-${root.id}`}
          >
            {root.displayName}
          </h2>
          <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            Latest scan:{" "}
            {root.latestScanSession
              ? formatIsoDate(root.latestScanSession.startedAt)
              : "No scan session yet"}
          </p>
        </div>

        <div className="flex min-w-0 flex-wrap gap-2 lg:justify-end">
          <NsnBadge tone={statusTone(root.status)}>
            {titleCaseStatus(root.status)}
          </NsnBadge>
          <NsnBadge tone="source">{platformLabel(root.platform)}</NsnBadge>
          {root.latestScanSession ? (
            <NsnBadge tone={statusTone(root.latestScanSession.status)}>
              {titleCaseStatus(root.latestScanSession.status)}
            </NsnBadge>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CountPills counts={root.tree.counts} />
        {root.latestScanSession ? (
          <Link
            className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
            href={getScanSessionRoute(root.latestScanSession.id)}
          >
            Open Scan Session
          </Link>
        ) : null}
      </div>

      {root.tree.counts.files === 0 ? (
        <p className="mt-5 rounded-lg border border-dashed border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-4 text-sm text-[var(--nsn-slate)]">
          This connected library has no scanned files in its latest session yet.
        </p>
      ) : (
        <div className="mt-5 grid min-w-0 gap-3">
          {root.tree.folders.map((folder) => (
            <FolderNode
              activeRefinement={activeRefinement}
              depth={0}
              folder={folder}
              highlightedFileId={highlightedFileId}
              key={folder.id}
              visibleFileIds={visibleFileIds}
            />
          ))}
          {visibleRootFiles.map((file) => (
            <FileRow
              highlightedFileId={highlightedFileId}
              item={file}
              key={file.file.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyFilteredState() {
  return (
    <NsnEmptyState
      description="Try a different file name, root, folder, file type, or status filter."
      title="No library files match this view"
    />
  );
}

export function LibraryExplorer({
  data,
  highlightedFileId = null,
}: LibraryExplorerProps) {
  const [activeFilter, setActiveFilter] =
    useState<LibraryExplorerFilter>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("FOLDERS");
  const allFiles = useMemo(
    () => flattenLibraryExplorerFiles(data.roots),
    [data.roots],
  );
  const categoryCounts = useMemo(
    () => scannedFileCategoryCounts(allFiles.map((item) => item.file)),
    [allFiles],
  );
  const visibleFiles = useMemo(
    () =>
      filterLibraryExplorerFiles(allFiles, {
        filter: activeFilter,
        query: searchQuery,
      }),
    [activeFilter, allFiles, searchQuery],
  );
  const visibleFileIds = useMemo(
    () => new Set(visibleFiles.map((item) => item.file.id)),
    [visibleFiles],
  );
  const activeRefinement =
    activeFilter !== "ALL" || searchQuery.trim().length > 0;
  const hasFiles = allFiles.length > 0;
  const showEmptyFilteredState = visibleFiles.length === 0 && hasFiles;
  const showFolderView =
    viewMode === "FOLDERS" &&
    (visibleFiles.length > 0 || (!activeRefinement && !hasFiles));

  if (data.roots.length === 0) {
    return (
      <NsnEmptyState
        description="Connect a folder from Connected Libraries, then scan it to let the Librarian build this view."
        title="No connected libraries yet"
      />
    );
  }

  return (
    <section aria-labelledby="library-explorer-heading" className="min-w-0">
      <div className="grid min-w-0 gap-4">
        <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h2
              className="nsn-display text-2xl text-[var(--nsn-navy)]"
              id="library-explorer-heading"
            >
              Folder Explorer
            </h2>
            <p className="mt-1 max-w-3xl break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              Browse each connected root in its own folder structure. Search
              and filters keep the root and folder context visible.
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            <NsnBadge tone="source">
              {formatCount(data.roots.length, "root")}
            </NsnBadge>
            <NsnBadge tone="source">
              {formatCount(data.totals.files, "file")}
            </NsnBadge>
            {data.totals.needsAttention > 0 ? (
              <NsnBadge tone="review">
                {formatCount(
                  data.totals.needsAttention,
                  "needs attention",
                  "need attention",
                )}
              </NsnBadge>
            ) : null}
          </div>
        </div>

        <div className="grid min-w-0 gap-4 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4">
          <div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <NsnSearchField
              label="Search Library"
              onChange={setSearchQuery}
              placeholder="Search by file, folder, root, type, or status"
              resultCount={visibleFiles.length}
              value={searchQuery}
            />

            <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label="Library view">
              <button
                aria-pressed={viewMode === "FOLDERS"}
                className={[
                  "inline-flex min-h-11 max-w-full items-center justify-center rounded-md border px-4 text-center text-sm font-semibold transition",
                  viewMode === "FOLDERS"
                    ? "border-[var(--nsn-teal)] bg-[var(--nsn-teal)] text-[var(--nsn-white)]"
                    : "border-[var(--nsn-border)] bg-[var(--nsn-cream)] text-[var(--nsn-navy)] hover:bg-[var(--nsn-sage-mist)]",
                ].join(" ")}
                onClick={() => setViewMode("FOLDERS")}
                type="button"
              >
                Folder View
              </button>
              <button
                aria-pressed={viewMode === "ALL_FILES"}
                className={[
                  "inline-flex min-h-11 max-w-full items-center justify-center rounded-md border px-4 text-center text-sm font-semibold transition",
                  viewMode === "ALL_FILES"
                    ? "border-[var(--nsn-teal)] bg-[var(--nsn-teal)] text-[var(--nsn-white)]"
                    : "border-[var(--nsn-border)] bg-[var(--nsn-cream)] text-[var(--nsn-navy)] hover:bg-[var(--nsn-sage-mist)]",
                ].join(" ")}
                onClick={() => setViewMode("ALL_FILES")}
                type="button"
              >
                All Files
              </button>
            </div>
          </div>

          <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label="Library filters">
            {libraryFilters.map((filter) => {
              const count =
                filter.countKey === undefined
                  ? null
                  : categoryCounts[filter.countKey];

              return (
                <button
                  aria-pressed={activeFilter === filter.value}
                  className={[
                    "inline-flex min-h-10 max-w-full items-center justify-center rounded-md border px-3 text-center text-sm font-semibold transition [overflow-wrap:anywhere]",
                    activeFilter === filter.value
                      ? "border-[var(--nsn-teal)] bg-[var(--nsn-soft-aqua)] text-[var(--nsn-teal-dark)]"
                      : "border-[var(--nsn-border)] bg-[var(--nsn-cream)] text-[var(--nsn-navy)] hover:bg-[var(--nsn-sage-mist)]",
                  ].join(" ")}
                  key={filter.value}
                  onClick={() => setActiveFilter(filter.value)}
                  type="button"
                >
                  {count === null ? filter.label : `${filter.label} ${count}`}
                </button>
              );
            })}
          </div>
        </div>

        {showEmptyFilteredState ? <EmptyFilteredState /> : null}

        {showFolderView ? (
          <div className="grid min-w-0 gap-5">
            {data.roots.map((root) => (
              <RootSection
                activeRefinement={activeRefinement}
                highlightedFileId={highlightedFileId}
                key={root.id}
                root={root}
                visibleFileIds={visibleFileIds}
              />
            ))}
          </div>
        ) : null}

        {viewMode === "ALL_FILES" && visibleFiles.length > 0 ? (
          <div className="grid min-w-0 gap-3">
            {visibleFiles.map((file) => (
              <FileRow
                highlightedFileId={highlightedFileId}
                item={file}
                key={file.file.id}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
