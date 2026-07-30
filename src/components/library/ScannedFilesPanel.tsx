"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnButton } from "@/components/library/NsnButton";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import {
  getScanSessionRoute,
  getScannedFileExamineRoute,
} from "@/lib/library/routes";
import {
  fileMatchesScannedFileFilter,
  scannedFileCategoryCounts,
  scannedFileFilters,
  type ScannedFileFilter,
} from "@/lib/bridge/scanned-file-filters";
import { isImageFileType } from "@/lib/bridge/media-kind";
import type {
  BridgeObserveScannedFileApiResponse,
  BridgeOrganizationSuggestionGenerationResponse,
  BridgeReadFileApiResponse,
  BridgeReadPreview,
  BridgeScannedFileSummary,
} from "@/lib/bridge/types";

type ScannedFilesPanelProps = {
  files: BridgeScannedFileSummary[];
  scanSessionId: string;
};

type ObserveState = {
  sessionId: string;
  hasReviewableSuggestions: boolean;
  observerType: string;
} | null;

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

function formatDate(value: string | null) {
  if (!value) {
    return "not recorded";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function mediaCategoryLabel(file: BridgeScannedFileSummary) {
  if (isImageFileType(file.fileType)) {
    return "IMAGE";
  }

  if (file.fileType.startsWith("AUDIO_")) {
    return "AUDIO";
  }

  if (file.fileType.startsWith("VIDEO_")) {
    return "VIDEO";
  }

  if (file.fileType === "UNSUPPORTED") {
    return "UNSUPPORTED";
  }

  return "DOCUMENT";
}

function displayFileType(file: BridgeScannedFileSummary) {
  if (isImageFileType(file.fileType)) {
    return file.fileType.replace("IMAGE_", "");
  }

  if (file.fileType.startsWith("AUDIO_")) {
    return file.fileType.replace("AUDIO_", "");
  }

  if (file.fileType.startsWith("VIDEO_")) {
    return file.fileType.replace("VIDEO_", "");
  }

  return file.fileType;
}

function supportLabel(file: BridgeScannedFileSummary) {
  if (file.sourceUnavailableAt) {
    return "Source unavailable";
  }

  if (file.readStatus === "SUPPORTED") {
    return "Supported";
  }

  if (file.readStatus === "UNSUPPORTED") {
    return "Unsupported";
  }

  if (file.readStatus === "FAILED") {
    return "Scan needs attention";
  }

  return "Pending";
}

function supportTone(file: BridgeScannedFileSummary): NsnBadgeTone {
  if (file.sourceUnavailableAt) {
    return "review";
  }

  if (file.readStatus === "SUPPORTED") {
    return "approved";
  }

  if (file.readStatus === "FAILED") {
    return "review";
  }

  if (file.readStatus === "UNSUPPORTED") {
    return "pending";
  }

  return "unknown";
}

function readingLabel(file: BridgeScannedFileSummary) {
  if (file.sourceUnavailableAt) {
    return "Source unavailable";
  }

  if (
    file.processingStage === "SUGGESTIONS_GENERATED" ||
    file.processingStage === "RECOMMENDATIONS_READY" ||
    file.organizationSuggestionCounts.total > 0
  ) {
    return "Recommendations ready";
  }

  if (file.processingStage === "METADATA_READY") {
    return "Image metadata ready";
  }

  if (file.processingStage === "EXAMINED") {
    return "Examined";
  }

  if (
    file.processingStage === "READING_IMAGE_METADATA" ||
    file.processingStage === "PREPARING_PREVIEW" ||
    file.processingStage === "ANALYZING_IMAGE" ||
    file.processingStage === "OCR_PROCESSING" ||
    file.processingStage === "OBSERVING" ||
    file.processingStage === "READING" ||
    file.processingStage === "EXAMINING"
  ) {
    return "Being examined";
  }

  if (file.processingStage === "FAILED") {
    return "Needs attention";
  }

  if (file.readingStatus === "READ") {
    return "Read";
  }

  if (file.readingStatus === "UNSUPPORTED") {
    return "Unsupported for reading";
  }

  if (file.readingStatus === "FAILED") {
    return "Reading failed";
  }

  return file.readStatus === "SUPPORTED"
    ? "Waiting for the Librarian"
    : "Not readable";
}

function readingTone(file: BridgeScannedFileSummary): NsnBadgeTone {
  if (file.sourceUnavailableAt) {
    return "review";
  }

  if (
    file.processingStage === "SUGGESTIONS_GENERATED" ||
    file.processingStage === "RECOMMENDATIONS_READY" ||
    file.organizationSuggestionCounts.total > 0
  ) {
    return "migration";
  }

  if (file.processingStage === "EXAMINED") {
    return "approved";
  }

  if (
    file.processingStage === "READING_IMAGE_METADATA" ||
    file.processingStage === "METADATA_READY" ||
    file.processingStage === "PREPARING_PREVIEW" ||
    file.processingStage === "ANALYZING_IMAGE" ||
    file.processingStage === "OCR_PROCESSING" ||
    file.processingStage === "OBSERVING" ||
    file.processingStage === "READING" ||
    file.processingStage === "EXAMINING"
  ) {
    return "source";
  }

  if (file.processingStage === "FAILED") {
    return "review";
  }

  if (file.readingStatus === "READ") {
    return "approved";
  }

  if (file.readingStatus === "FAILED") {
    return "review";
  }

  if (file.readingStatus === "UNSUPPORTED") {
    return "pending";
  }

  return "source";
}

function fileNameFromPath(relativePath: string) {
  return relativePath.split("/").filter(Boolean).at(-1) ?? relativePath;
}

function observeModeLabel(observerType: string) {
  return observerType === "OPENAI"
    ? "Observed with AI assistance"
    : "Observed with basic observation mode";
}

function suggestionCountText(file: BridgeScannedFileSummary) {
  const counts = file.organizationSuggestionCounts;

  if (counts.total === 0) {
    return null;
  }

  return `${counts.pending} pending, ${counts.approved} approved, ${counts.modified} modified, ${counts.rejected} rejected, ${counts.leftUnchanged} left unchanged`;
}

function canExamineFile(file: BridgeScannedFileSummary) {
  return !file.sourceUnavailableAt && file.readingStatus === "READ" && file.hasObservation;
}

function audioPrivacyLabel(file: BridgeScannedFileSummary) {
  return file.audioMetadata?.privacyState
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function videoPrivacyLabel(file: BridgeScannedFileSummary) {
  return file.videoMetadata?.privacyState
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function videoReviewSummary(file: BridgeScannedFileSummary) {
  if (!file.videoMetadata) {
    return null;
  }

  const duration =
    file.videoMetadata.durationSeconds !== null
      ? `${Math.round(file.videoMetadata.durationSeconds)} seconds`
      : null;
  const resolution =
    file.videoMetadata.width && file.videoMetadata.height
      ? `${file.videoMetadata.width} x ${file.videoMetadata.height}`
      : null;
  const details = [videoPrivacyLabel(file), duration, resolution].filter(
    Boolean,
  );

  return details.join(" - ");
}

function imageReviewSummary(file: BridgeScannedFileSummary) {
  if (!isImageFileType(file.fileType)) {
    return null;
  }

  if (file.imageMetadata) {
    const dimensions =
      file.imageMetadata.width && file.imageMetadata.height
        ? `${file.imageMetadata.width} x ${file.imageMetadata.height} pixels`
        : "Dimensions not recorded";
    const details = [
      file.imageMetadata.format?.toUpperCase() ?? file.fileType.replace("IMAGE_", ""),
      dimensions,
      imagePrivacyLabel(file),
    ];

    return details.join(" - ");
  }

  const dimensions = file.previewText?.match(
    /Dimensions:\s*(.*?)(?:\s+Size:|\s+Path signal:|\s+Summary:|$)/i,
  )?.[1];
  const imageType = file.previewText?.match(
    /Image type:\s*(.*?)(?:\s+Dimensions:|\s+Size:|$)/i,
  )?.[1];
  const privacy = imagePrivacyLabel(file);
  const details = [imageType, dimensions, privacy].filter(Boolean);

  if (details.length > 0) {
    return details.join(" - ");
  }

  return "Image metadata recorded for human review";
}

function imagePrivacyLabel(file: BridgeScannedFileSummary) {
  if (file.imageMetadata?.privacyState === "PRIVATE") {
    return "Private";
  }

  if (file.imageMetadata?.privacyState === "WEBSITE_CANDIDATE") {
    return "Website Candidate";
  }

  const text = `${file.relativePath} ${file.previewText ?? ""}`.toLowerCase();

  if (text.includes("private")) {
    return "Private";
  }

  if (
    text.includes("website") ||
    text.includes("public") ||
    text.includes("hero") ||
    text.includes("banner")
  ) {
    return "Website Candidate";
  }

  if (
    text.includes("duplicate") ||
    text.includes("copy") ||
    text.includes("small") ||
    text.includes("resized")
  ) {
    return "Possible Duplicate";
  }

  return "Image";
}

export function ScannedFilesPanel({
  files,
  scanSessionId,
}: ScannedFilesPanelProps) {
  const router = useRouter();
  const [activeFilter, setActiveFilter] = useState<ScannedFileFilter>("ALL");
  const [fileOverrides, setFileOverrides] = useState<
    Record<string, BridgeScannedFileSummary>
  >({});
  const [loadingFileId, setLoadingFileId] = useState<string | null>(null);
  const [generatingFileId, setGeneratingFileId] = useState<string | null>(null);
  const [observeState, setObserveState] = useState<ObserveState>(null);
  const [preview, setPreview] = useState<BridgeReadPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [suggestionNotice, setSuggestionNotice] = useState<string | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [isExamining, setIsExamining] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileRows = useMemo(
    () => files.map((file) => fileOverrides[file.id] ?? file),
    [fileOverrides, files],
  );
  const categoryCounts = useMemo(
    () => scannedFileCategoryCounts(fileRows),
    [fileRows],
  );
  const filteredFiles = fileRows.filter((file) =>
    fileMatchesScannedFileFilter(file, activeFilter),
  );

  useEffect(() => {
    if (preview || previewError) {
      closeButtonRef.current?.focus();
    }
  }, [preview, previewError]);

  function closePreview() {
    setPreview(null);
    setPreviewError(null);
    setObserveState(null);
    setIsExamining(false);
  }

  function updateFile(nextFile: BridgeScannedFileSummary) {
    setFileOverrides((currentFiles) => ({
      ...currentFiles,
      [nextFile.id]: nextFile,
    }));
  }

  function updateFileById(
    fileId: string,
    updater: (file: BridgeScannedFileSummary) => BridgeScannedFileSummary,
  ) {
    setFileOverrides((currentFiles) => {
      const existing =
        currentFiles[fileId] ?? files.find((file) => file.id === fileId);

      if (!existing) {
        return currentFiles;
      }

      return {
        ...currentFiles,
        [fileId]: updater(existing),
      };
    });
  }

  async function readFile(file: BridgeScannedFileSummary) {
    if (loadingFileId || file.readStatus !== "SUPPORTED") {
      return;
    }

    setLoadingFileId(file.id);
    setPreview(null);
    setPreviewError(null);
    setObserveState(null);

    try {
      const response = await fetch(
        `/api/bridge/scanned-files/${encodeURIComponent(file.id)}/read`,
        {
          method: "POST",
        },
      );
      const payload = (await response.json()) as BridgeReadFileApiResponse;

      if (!payload.ok) {
        setPreviewError(payload.error);
        return;
      }

      updateFile(payload.file);
      setPreview(payload.preview);
      router.refresh();
    } catch {
      setPreviewError("The Librarian could not read this file right now.");
    } finally {
      setLoadingFileId(null);
    }
  }

  async function examineFile() {
    if (!preview || isExamining) {
      return;
    }

    setIsExamining(true);
    setPreviewError(null);
    setObserveState(null);

    try {
      const response = await fetch(
        `/api/bridge/scanned-files/${encodeURIComponent(
          preview.scannedFileId,
        )}/observe`,
        {
          method: "POST",
        },
      );
      const payload =
        (await response.json()) as BridgeObserveScannedFileApiResponse;

      if (!payload.ok) {
        setPreviewError(payload.error);
        return;
      }

      setObserveState({
        hasReviewableSuggestions: payload.hasReviewableSuggestions,
        observerType: payload.observerType,
        sessionId: payload.sessionId,
      });
      updateFileById(preview.scannedFileId, (file) => ({
        ...file,
        hasObservation: true,
      }));
      router.refresh();
    } catch {
      setPreviewError("The Librarian could not examine this file right now.");
    } finally {
      setIsExamining(false);
    }
  }

  async function retryExamineFile(file: BridgeScannedFileSummary) {
    if (loadingFileId || file.readingStatus !== "READ" || file.hasObservation) {
      return;
    }

    setLoadingFileId(file.id);
    setPreviewError(null);
    setObserveState(null);

    try {
      const response = await fetch(
        `/api/bridge/scanned-files/${encodeURIComponent(file.id)}/observe`,
        {
          method: "POST",
        },
      );
      const payload =
        (await response.json()) as BridgeObserveScannedFileApiResponse;

      if (!payload.ok) {
        setPreviewError(payload.error);
        return;
      }

      updateFileById(file.id, (currentFile) => ({
        ...currentFile,
        hasObservation: true,
        processingErrorCategory: null,
        processingStage: "EXAMINED",
      }));
      router.refresh();
    } catch {
      setPreviewError("The Librarian could not examine this file right now.");
    } finally {
      setLoadingFileId(null);
    }
  }

  async function generateSuggestions(file: BridgeScannedFileSummary) {
    if (
      generatingFileId ||
      file.readingStatus !== "READ" ||
      !file.hasObservation
    ) {
      return;
    }

    setGeneratingFileId(file.id);
    setSuggestionNotice(null);
    setSuggestionError(null);

    try {
      const response = await fetch(
        `/api/bridge/scanned-files/${encodeURIComponent(
          file.id,
        )}/organization-suggestions`,
        {
          method: "POST",
        },
      );
      const payload =
        (await response.json()) as BridgeOrganizationSuggestionGenerationResponse;

      if (!payload.ok) {
        setSuggestionError(payload.error);
        return;
      }

      updateFile(payload.file);
      setSuggestionNotice(
        payload.createdCount > 0
          ? `The Librarian prepared ${payload.createdCount} recommendation${
              payload.createdCount === 1 ? "" : "s"
            } for review.`
          : "The Librarian found existing recommendations for this file and did not create duplicates.",
      );
      router.refresh();
    } catch {
      setSuggestionError(
        "The Librarian could not prepare recommendations right now.",
      );
    } finally {
      setGeneratingFileId(null);
    }
  }

  return (
    <section aria-labelledby="scanned-file-list-heading">
      <div className="mb-4 flex min-w-0 flex-col gap-3">
        <div className="min-w-0">
          <h2
            className="nsn-display break-words text-2xl text-[var(--nsn-navy)] [overflow-wrap:anywhere]"
            id="scanned-file-list-heading"
          >
            Scanned Files
          </h2>
          <p className="mt-1 text-sm leading-6 text-[var(--nsn-slate)]">
            Relative paths are shown so the local source location stays on
            Deanne&apos;s computer.
          </p>
        </div>

        <div
          aria-label="Filter scanned files"
          className="flex min-w-0 flex-wrap gap-2"
          role="group"
        >
          {scannedFileFilters.map((filter) => {
            const count =
              filter.countKey === undefined
                ? null
                : categoryCounts[filter.countKey];

            return (
              <button
                aria-pressed={activeFilter === filter.value}
                className={[
                  "inline-flex min-h-10 max-w-full items-center justify-center rounded-md border px-3 text-center text-sm font-semibold transition",
                  activeFilter === filter.value
                    ? "border-[var(--nsn-teal)] bg-[var(--nsn-teal)] text-[var(--nsn-white)]"
                    : "border-[var(--nsn-border)] bg-[var(--nsn-card)] text-[var(--nsn-navy)] hover:bg-[var(--nsn-sage-mist)]",
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

        {suggestionNotice || suggestionError ? (
          <div aria-live="polite" className="grid gap-2">
            {suggestionNotice ? (
              <p className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-teal-dark)]">
                {suggestionNotice}
              </p>
            ) : null}
            {suggestionError ? (
              <p
                className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-warning)]"
                role="alert"
              >
                {suggestionError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {fileRows.length === 0 ? (
        <NsnEmptyState
          description="The folder scan completed without finding visible files to record."
          title="No scanned files"
        />
      ) : null}

      {fileRows.length > 0 && filteredFiles.length === 0 ? (
        <NsnEmptyState
          description="No scanned files match this filter."
          title="Nothing in this view"
        />
      ) : null}

      {filteredFiles.length > 0 ? (
        <div className="grid gap-3">
          {filteredFiles.map((file) => (
            <NsnCard className="min-w-0" key={file.id}>
              <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                <div className="min-w-0">
                  <p className="break-words font-semibold leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                    {file.relativePath}
                  </p>
                  <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                    {mediaCategoryLabel(file)} - {displayFileType(file)} -{" "}
                    {formatFileSize(file.sizeBytes)} - modified{" "}
                    {formatDate(file.lastModified)}
                  </p>
                  {file.audioMetadata ? (
                    <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      Recording review: {audioPrivacyLabel(file)}
                      {file.audioMetadata.durationSeconds !== null
                        ? ` - ${Math.round(file.audioMetadata.durationSeconds)} seconds`
                        : ""}
                    </p>
                  ) : null}
                  {file.videoMetadata ? (
                    <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      Video review: {videoReviewSummary(file)}
                    </p>
                  ) : null}
                  {isImageFileType(file.fileType) ? (
                    <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      Image review: {imageReviewSummary(file)}
                    </p>
                  ) : null}
                  {file.characterCount !== null ? (
                    <p className="mt-1 text-sm leading-6 text-[var(--nsn-slate)]">
                      {file.characterCount.toLocaleString()} characters read
                      {file.extractedAt ? ` on ${formatDate(file.extractedAt)}` : ""}
                    </p>
                  ) : null}
                  {file.previewText ? (
                    <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {file.previewText}
                    </p>
                  ) : null}
                  {file.audioMetadata?.transcriptSnippet ? (
                    <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      Audio snippet: {file.audioMetadata.transcriptSnippet}
                    </p>
                  ) : null}
                  {file.videoMetadata?.transcriptSnippet ? (
                    <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      Video snippet: {file.videoMetadata.transcriptSnippet}
                    </p>
                  ) : null}
                  {suggestionCountText(file) ? (
                    <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      Recommendations: {suggestionCountText(file)}
                    </p>
                  ) : null}
                  {file.sourceUnavailableReason ||
                  file.scanError ||
                  file.extractionErrorCategory ||
                  file.processingErrorCategory ? (
                    <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-warning)] [overflow-wrap:anywhere]">
                      {file.sourceUnavailableReason ??
                        file.scanError ??
                        "The Librarian could not read this file safely."}
                    </p>
                  ) : null}
                </div>

                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap lg:max-w-64 lg:flex-col lg:items-stretch">
                  <NsnBadge tone={supportTone(file)}>
                    {supportLabel(file)}
                  </NsnBadge>
                  <NsnBadge tone={readingTone(file)}>
                    {readingLabel(file)}
                  </NsnBadge>
                  {file.audioMetadata ? (
                    <NsnBadge tone="review">
                      {audioPrivacyLabel(file)}
                    </NsnBadge>
                  ) : null}
                  {file.videoMetadata ? (
                    <NsnBadge tone="review">
                      {videoPrivacyLabel(file)}
                    </NsnBadge>
                  ) : null}
                  {isImageFileType(file.fileType) ? (
                    <NsnBadge tone="review">
                      {imagePrivacyLabel(file)}
                    </NsnBadge>
                  ) : null}

                  {file.processingStage === "FAILED" &&
                  file.readStatus === "SUPPORTED" &&
                  file.readingStatus !== "READ" ? (
                    <NsnButton
                      disabled={loadingFileId === file.id}
                      onClick={() => readFile(file)}
                      type="button"
                      variant="primary"
                    >
                      {loadingFileId === file.id
                        ? "Retrying..."
                        : "Retry Reading"}
                    </NsnButton>
                  ) : file.processingStage === "FAILED" &&
                    file.readingStatus === "READ" &&
                    !file.hasObservation ? (
                    <NsnButton
                      disabled={loadingFileId === file.id}
                      onClick={() => retryExamineFile(file)}
                      type="button"
                      variant="primary"
                    >
                      {loadingFileId === file.id
                        ? "Examining..."
                        : "Retry Examine"}
                    </NsnButton>
                  ) : file.processingStage === "FAILED" &&
                    file.readingStatus === "READ" &&
                    file.hasObservation &&
                    file.organizationSuggestionCounts.total === 0 ? (
                    <NsnButton
                      disabled={generatingFileId === file.id}
                      onClick={() => generateSuggestions(file)}
                      type="button"
                      variant="accent"
                    >
                      {generatingFileId === file.id
                        ? "Preparing..."
                        : "Retry Recommendations"}
                    </NsnButton>
                  ) : canExamineFile(file) ? (
                    <Link
                      className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-3 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)]"
                      href={getScannedFileExamineRoute(scanSessionId, file.id)}
                    >
                      Examine
                    </Link>
                  ) : file.readStatus === "SUPPORTED" ? (
                    <span className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] px-3 text-center text-sm font-semibold text-[var(--nsn-warm-gray)]">
                      Librarian examining
                    </span>
                  ) : (
                    <span className="inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-sand)] px-3 text-center text-sm font-semibold text-[var(--nsn-warm-gray)]">
                      {file.readStatus === "UNSUPPORTED"
                        ? "Unsupported for reading"
                        : "Needs attention"}
                    </span>
                  )}
                </div>
              </div>
            </NsnCard>
          ))}
        </div>
      ) : null}

      {preview || previewError ? (
        <div
          aria-labelledby="bridge-read-preview-heading"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[rgb(31_42_68_/_0.45)] p-2 sm:p-4"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closePreview();
            }
          }}
          role="dialog"
        >
          <div className="flex max-h-[calc(100dvh-1rem)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] shadow-[0_24px_80px_rgb(31_42_68_/_0.25)] sm:max-h-[calc(100dvh-2rem)]">
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--nsn-border)] p-4 sm:p-5">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-warm-gray)]">
                  Read Preview
                </p>
                <h3
                  className="nsn-display mt-2 break-words text-xl leading-7 text-[var(--nsn-navy)] [overflow-wrap:anywhere] sm:text-2xl"
                  id="bridge-read-preview-heading"
                >
                  {preview
                    ? fileNameFromPath(preview.relativePath)
                    : "The Librarian could not read this file"}
                </h3>
              </div>
              <button
                className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] px-3 text-sm font-semibold text-[var(--nsn-navy)] hover:bg-[var(--nsn-sage-mist)]"
                onClick={closePreview}
                ref={closeButtonRef}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
              <div className="grid gap-4">
                {preview ? (
                  <>
                    <div className="grid gap-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3 text-sm leading-6 text-[var(--nsn-slate)]">
                      <p className="break-words [overflow-wrap:anywhere]">
                        {preview.relativePath}
                      </p>
                      <p>
                        {preview.fileType} -{" "}
                        {preview.characterCount.toLocaleString()} characters
                      </p>
                      {preview.warnings.length > 0 ? (
                        <ul className="grid gap-1 pl-4">
                          {preview.warnings.map((warning) => (
                            <li className="list-disc" key={warning}>
                              {warning}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>

                    <pre className="max-h-[45dvh] min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-4 text-sm leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                      {preview.extractedText || "No readable text was found."}
                    </pre>

                    <div className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-navy)]">
                      <p>
                        Examine remains manual. Nothing enters Memory until
                        Deanne reviews and approves the Librarian&apos;s
                        recommendation.
                      </p>
                    </div>
                  </>
                ) : null}

                {previewError ? (
                  <p
                    className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm font-semibold leading-6 text-[var(--nsn-warning)]"
                    role="alert"
                  >
                    {previewError}
                  </p>
                ) : null}

                {observeState ? (
                  <div className="grid gap-3 rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-card)] p-4">
                    <p className="font-semibold text-[var(--nsn-navy)]">
                      The Librarian has finished examining this file.
                    </p>
                    <p className="text-sm leading-6 text-[var(--nsn-slate)]">
                      {observeModeLabel(observeState.observerType)}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Link
                        className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)]"
                        href={
                          observeState.hasReviewableSuggestions
                            ? `/admin/library/review/${encodeURIComponent(
                                observeState.sessionId,
                              )}`
                            : getScanSessionRoute(scanSessionId)
                        }
                      >
                        {observeState.hasReviewableSuggestions
                          ? "Review Recommendations"
                          : "View Examined Items"}
                      </Link>
                      <button
                        className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                        onClick={closePreview}
                        type="button"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                ) : null}

                {preview && !observeState ? (
                  <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                    <NsnButton
                      disabled={isExamining}
                      onClick={examineFile}
                      type="button"
                      variant="primary"
                    >
                      {isExamining ? "Examining..." : "Examine"}
                    </NsnButton>
                    <NsnButton
                      onClick={closePreview}
                      type="button"
                      variant="secondary"
                    >
                      Close
                    </NsnButton>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
