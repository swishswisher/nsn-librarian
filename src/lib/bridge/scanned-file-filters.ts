import type { BridgeScannedFileSummary } from "./types";
import {
  mediaCategoryForFileType,
  type ScannedFileMediaCategory,
} from "./media-kind";

export type ScannedFileFilter =
  | "ALL"
  | "DOCUMENTS"
  | "IMAGES"
  | "AUDIO"
  | "VIDEO"
  | "WORKSHOPS"
  | "PRESENTATIONS"
  | "MEETINGS"
  | "WEBSITE_CANDIDATES"
  | "POSSIBLE_DUPLICATES"
  | "PRIVATE"
  | "PROCESSING"
  | "SUGGESTIONS"
  | "UNSUPPORTED"
  | "FAILED";

export type ScannedFileCategoryCounts = {
  documents: number;
  images: number;
  audio: number;
  video: number;
  unsupported: number;
};

export const scannedFileFilters: Array<{
  countKey?: keyof ScannedFileCategoryCounts;
  label: string;
  value: ScannedFileFilter;
}> = [
  { label: "All", value: "ALL" },
  { countKey: "documents", label: "Documents", value: "DOCUMENTS" },
  { countKey: "images", label: "Images", value: "IMAGES" },
  { countKey: "audio", label: "Audio", value: "AUDIO" },
  { countKey: "video", label: "Video", value: "VIDEO" },
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

function lowerText(parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function mediaFilterText(file: BridgeScannedFileSummary) {
  return lowerText([
    file.relativePath,
    file.fileType,
    file.previewText,
    file.scanError,
    file.extractionErrorCategory,
    file.processingErrorCategory,
    ...(file.audioMetadata?.humanLabels ?? []),
    ...(file.audioMetadata?.machineLabels ?? []),
    ...(file.audioMetadata?.provisionalTopics ?? []),
    file.audioMetadata?.summary,
    file.audioMetadata?.transcriptSnippet,
    ...(file.imageMetadata?.humanLabels ?? []),
    ...(file.imageMetadata?.machineLabels ?? []),
    ...(file.imageMetadata?.provisionalTopics ?? []),
    ...(file.imageMetadata?.relatedSignals ?? []),
    file.imageMetadata?.summary,
    file.imageMetadata?.textSnippet,
    ...(file.videoMetadata?.humanLabels ?? []),
    ...(file.videoMetadata?.machineLabels ?? []),
    ...(file.videoMetadata?.provisionalTopics ?? []),
    ...(file.videoMetadata?.provisionalPeople ?? []),
    ...(file.videoMetadata?.provisionalProjects ?? []),
    ...(file.videoMetadata?.relatedSignals ?? []),
    file.videoMetadata?.summary,
    file.videoMetadata?.transcriptSnippet,
    file.videoMetadata?.selectedFrameDescriptions
      .map((frame) => `${frame.label} ${frame.description}`)
      .join(" "),
    file.videoMetadata?.chapterSuggestions.map((chapter) => chapter.title).join(" "),
  ]);
}

function mediaCategory(file: BridgeScannedFileSummary): ScannedFileMediaCategory {
  return mediaCategoryForFileType(file.fileType);
}

function hasPrivateSignal(file: BridgeScannedFileSummary) {
  const text = mediaFilterText(file);

  return (
    file.audioMetadata?.privacyState === "PRIVATE" ||
    file.audioMetadata?.humanLabels.includes("PRIVATE") === true ||
    file.imageMetadata?.privacyState === "PRIVATE" ||
    file.imageMetadata?.humanLabels.includes("PRIVATE") === true ||
    file.videoMetadata?.privacyState === "PRIVATE" ||
    file.videoMetadata?.humanLabels.includes("PRIVATE") === true ||
    /\bprivate\b/.test(text)
  );
}

function hasWebsiteCandidateSignal(file: BridgeScannedFileSummary) {
  const text = mediaFilterText(file);

  if (hasPrivateSignal(file)) {
    return false;
  }

  return (
    file.audioMetadata?.privacyState === "WEBSITE_CANDIDATE" ||
    file.imageMetadata?.privacyState === "WEBSITE_CANDIDATE" ||
    file.imageMetadata?.humanLabels.includes("WEBSITE") === true ||
    file.videoMetadata?.privacyState === "WEBSITE_CANDIDATE" ||
    /\b(website|public|hero|banner|landing|blog|article)\b/.test(text)
  );
}

function hasPossibleDuplicateSignal(file: BridgeScannedFileSummary) {
  const text = mediaFilterText(file);

  return Boolean(
    file.audioMetadata?.duplicateKind ||
      file.imageMetadata?.duplicateKind ||
      file.imageMetadata?.humanLabels.includes("DUPLICATE_CANDIDATE") ||
      file.videoMetadata?.duplicateKind ||
      file.videoMetadata?.humanLabels.includes("DUPLICATE_CANDIDATE") ||
      /\b(duplicate|duplicates|copy|resized|small|thumbnail)\b/.test(text),
  );
}

export function scannedFileCategoryCounts(
  files: BridgeScannedFileSummary[],
): ScannedFileCategoryCounts {
  const counts = {
    audio: 0,
    documents: 0,
    images: 0,
    unsupported: 0,
    video: 0,
  };

  for (const file of files) {
    const category = mediaCategory(file);

    if (category === "DOCUMENT") {
      counts.documents += 1;
    } else if (category === "IMAGE") {
      counts.images += 1;
    } else if (category === "AUDIO") {
      counts.audio += 1;
    } else if (category === "VIDEO") {
      counts.video += 1;
    } else {
      counts.unsupported += 1;
    }
  }

  return counts;
}

export function fileMatchesScannedFileFilter(
  file: BridgeScannedFileSummary,
  filter: ScannedFileFilter,
) {
  if (filter === "ALL") {
    return true;
  }

  const category = mediaCategory(file);

  if (filter === "DOCUMENTS") {
    return category === "DOCUMENT";
  }

  if (filter === "IMAGES") {
    return category === "IMAGE";
  }

  if (filter === "AUDIO") {
    return category === "AUDIO";
  }

  if (filter === "VIDEO") {
    return category === "VIDEO";
  }

  if (filter === "WORKSHOPS") {
    return mediaFilterText(file).includes("workshop");
  }

  if (filter === "PRESENTATIONS") {
    const text = mediaFilterText(file);

    return (
      text.includes("presentation") ||
      text.includes("slide") ||
      text.includes("webinar")
    );
  }

  if (filter === "MEETINGS") {
    return mediaFilterText(file).includes("meeting");
  }

  if (filter === "WEBSITE_CANDIDATES") {
    return hasWebsiteCandidateSignal(file);
  }

  if (filter === "POSSIBLE_DUPLICATES") {
    return hasPossibleDuplicateSignal(file);
  }

  if (filter === "PRIVATE") {
    return hasPrivateSignal(file);
  }

  if (filter === "PROCESSING") {
    return (
      file.processingStage === "DISCOVERED" ||
      file.processingStage === "READING_IMAGE_METADATA" ||
      file.processingStage === "METADATA_READY" ||
      file.processingStage === "PREPARING_PREVIEW" ||
      file.processingStage === "ANALYZING_IMAGE" ||
      file.processingStage === "OCR_PROCESSING" ||
      file.processingStage === "OBSERVING" ||
      file.processingStage === "READING" ||
      file.processingStage === "READ" ||
      file.processingStage === "EXAMINING" ||
      file.processingStage === "EXAMINED"
    );
  }

  if (filter === "SUGGESTIONS") {
    return file.organizationSuggestionCounts.total > 0;
  }

  if (filter === "UNSUPPORTED") {
    return (
      category === "UNSUPPORTED" &&
      (file.readStatus === "UNSUPPORTED" || file.readingStatus === "UNSUPPORTED")
    );
  }

  return (
    Boolean(file.sourceUnavailableAt) ||
    file.processingStage === "FAILED" ||
    file.readStatus === "FAILED" ||
    file.readingStatus === "FAILED" ||
    file.extractionStatus === "FAILED"
  );
}

export function filterScannedFiles(
  files: BridgeScannedFileSummary[],
  filter: ScannedFileFilter,
) {
  return files.filter((file) => fileMatchesScannedFileFilter(file, filter));
}
