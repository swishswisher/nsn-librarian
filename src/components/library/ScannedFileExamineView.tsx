import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";

import { LibraryShell } from "@/components/library/LibraryShell";
import { AudioRecordingReviewControls } from "@/components/library/AudioRecordingReviewControls";
import { ImageAssetReviewControls } from "@/components/library/ImageAssetReviewControls";
import { NsnBadge } from "@/components/library/NsnBadge";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { ObservationDecisionPanel } from "@/components/library/ObservationDecisionPanel";
import { OrganizationSuggestionsReviewPanel } from "@/components/library/OrganizationSuggestionsReviewPanel";
import { VideoRecordingReviewControls } from "@/components/library/VideoRecordingReviewControls";
import { isImageFileType } from "@/lib/bridge/media-kind";
import type { BridgeScannedFileExaminationData } from "@/lib/bridge/types";
import type { ObservationSessionReview } from "@/types/library";

type ScannedFileExamineViewProps = {
  backHref: string;
  backLabel: string;
  data: BridgeScannedFileExaminationData;
  recommendationsHref: string;
};

function fileNameFromPath(relativePath: string) {
  return relativePath.split("/").filter(Boolean).at(-1) ?? relativePath;
}

function formatConfidence(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(seconds: number | null) {
  if (seconds === null) {
    return "not recorded";
  }

  const roundedSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(roundedSeconds / 60);
  const secondsPart = roundedSeconds % 60;

  if (minutes < 60) {
    return `${minutes}:${secondsPart.toString().padStart(2, "0")}`;
  }

  const hours = Math.floor(minutes / 60);
  const minutesPart = minutes % 60;

  return `${hours}:${minutesPart.toString().padStart(2, "0")}:${secondsPart
    .toString()
    .padStart(2, "0")}`;
}

function humanLabel(value: string) {
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function fileStageLabel(stage: string) {
  if (stage === "SUGGESTIONS_GENERATED" || stage === "RECOMMENDATIONS_READY") {
    return "Recommendations ready";
  }

  if (stage === "EXAMINED") {
    return "Examined";
  }

  if (
    stage === "READING" ||
    stage === "READING_IMAGE_METADATA" ||
    stage === "METADATA_READY" ||
    stage === "PREPARING_PREVIEW" ||
    stage === "ANALYZING_IMAGE" ||
    stage === "OCR_PROCESSING" ||
    stage === "OBSERVING" ||
    stage === "EXAMINING"
  ) {
    return "Being examined";
  }

  if (stage === "FAILED") {
    return "Needs attention";
  }

  if (stage === "UNSUPPORTED") {
    return "Unsupported";
  }

  return "Waiting for the Librarian";
}

function AudioWaveformIndicator() {
  const bars = [28, 48, 34, 72, 46, 82, 38, 66, 52, 74, 32, 58];

  return (
    <div
      aria-hidden="true"
      className="flex h-16 items-center gap-1 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] px-3"
    >
      {bars.map((height, index) => (
        <span
          className="w-full rounded-full bg-[var(--nsn-teal)] opacity-80"
          key={`${height}-${index}`}
          style={{ height: `${height}%` }}
        />
      ))}
    </div>
  );
}

function videoMetric(value: number | null, suffix = "") {
  if (value === null) {
    return "not recorded";
  }

  return `${value.toLocaleString()}${suffix}`;
}

function ReviewSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="grid min-w-0 gap-3 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 sm:p-5">
      <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">{title}</h2>
      {children}
    </section>
  );
}

function ObservationSummary({
  review,
}: {
  review: ObservationSessionReview;
}) {
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <NsnBadge tone="review">
          {review.status === "AWAITING_REVIEW"
            ? "Needs review"
            : review.status.replaceAll("_", " ").toLowerCase()}
        </NsnBadge>
        <NsnBadge tone="source">
          Confidence {formatConfidence(review.confidence)}
        </NsnBadge>
      </div>

      <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
        {review.explanation.summary}
      </p>

      {review.observations.length > 0 ? (
        <div className="grid gap-3">
          {review.observations.map((observation) => (
            <article
              className="min-w-0 border-l-2 border-[var(--nsn-teal)] pl-3"
              key={observation.id}
            >
              <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                {observation.description}
              </p>
              {observation.evidence.length > 0 ? (
                <details className="mt-2 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                  <summary className="cursor-pointer text-sm font-semibold text-[var(--nsn-teal-dark)]">
                    Show why the Librarian noticed this
                  </summary>
                  <ul className="mt-2 grid gap-1 pl-4 text-xs leading-5 text-[var(--nsn-warm-gray)]">
                    {observation.evidence.slice(0, 5).map((evidence) => (
                      <li
                        className="list-disc break-words [overflow-wrap:anywhere]"
                        key={evidence}
                      >
                        {evidence}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="text-sm leading-6 text-[var(--nsn-slate)]">
          The Librarian did not record a specific observation for this file.
        </p>
      )}
    </div>
  );
}

export function ScannedFileExamineView({
  backHref,
  backLabel,
  data,
  recommendationsHref,
}: ScannedFileExamineViewProps) {
  const fileName = fileNameFromPath(data.file.relativePath);
  const shownText = data.preview?.extractedText ?? data.file.previewText ?? "";
  const audioMetadata = data.file.audioMetadata;
  const imageMetadata = data.file.imageMetadata;
  const videoMetadata = data.file.videoMetadata;
  const isAudio = Boolean(audioMetadata);
  const isImage = isImageFileType(data.file.fileType);
  const isVideo = Boolean(videoMetadata);
  const imageDimensions =
    imageMetadata?.width && imageMetadata.height
      ? `${imageMetadata.width} x ${imageMetadata.height} pixels`
      : "not recorded";
  const imageType =
    imageMetadata?.format?.toUpperCase() ??
    data.file.fileType.replace("IMAGE_", "");

  return (
    <LibraryShell active="documents">
      <div className="grid gap-8">
        <NsnPageHeader
          description={
            isVideo
              ? "Help Deanne review what the video may contain before approving any label or organization change."
              : isAudio
                ? "Help Deanne review what the recording may contain before approving any label or organization change."
                : isImage
                  ? "Help Deanne review image metadata and organization recommendations before approving any change."
                  : "Help Deanne confirm what the file contains before approving any organization change."
          }
          eyebrow="Examine"
          subtitle={data.session.folderDisplayName}
          title={fileName}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Link
              className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)] sm:w-auto"
              href={backHref}
            >
              {backLabel}
            </Link>
            <Link
              className="inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)] sm:w-auto"
              href={recommendationsHref}
            >
              Back to Recommendations
            </Link>
          </div>
        </NsnPageHeader>

        <NsnCard tone="aqua">
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
            <div className="min-w-0">
              <div className="flex flex-wrap gap-2">
                <NsnBadge tone="source">{data.file.fileType}</NsnBadge>
                <NsnBadge tone="approved">
                  {fileStageLabel(data.file.processingStage)}
                </NsnBadge>
              </div>
              <p className="mt-4 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                Current location: {data.file.relativePath}
              </p>
              {data.file.characterCount !== null ? (
                <p className="mt-1 text-sm leading-6 text-[var(--nsn-slate)]">
                  {data.file.characterCount.toLocaleString()} characters read.
                </p>
              ) : null}
            </div>
            <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              Nothing moves, renames, copies, or executes from this screen.
            </p>
          </div>
        </NsnCard>

        {videoMetadata ? (
          <ReviewSection title="Video review">
            <div className="grid gap-5">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.45fr)]">
                <div className="grid min-w-0 gap-3">
                  <div className="overflow-hidden rounded-md border border-[var(--nsn-border)] bg-black">
                    <video
                      aria-label={`Preview video for ${fileName}`}
                      className="aspect-video w-full bg-black"
                      controls
                      preload="metadata"
                      src={`/api/bridge/scanned-files/${encodeURIComponent(
                        data.file.id,
                      )}/video/stream`}
                    >
                      <track kind="captions" label="Captions unavailable" />
                    </video>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <NsnBadge tone="review">
                      {humanLabel(videoMetadata.privacyState)}
                    </NsnBadge>
                    {videoMetadata.humanLabels.map((label) => (
                      <NsnBadge key={label} tone="source">
                        {humanLabel(label)}
                      </NsnBadge>
                    ))}
                    {videoMetadata.machineLabels.slice(0, 5).map((label) => (
                      <NsnBadge key={label} tone="pending">
                        {humanLabel(label)}
                      </NsnBadge>
                    ))}
                  </div>

                  {videoMetadata.summary ? (
                    <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {videoMetadata.summary}
                    </p>
                  ) : (
                    <p className="text-sm leading-6 text-[var(--nsn-slate)]">
                      The Librarian recorded metadata for this video and still
                      needs Deanne&apos;s review before trusting any label.
                    </p>
                  )}

                  {videoMetadata.transcriptSnippet ? (
                    <div className="rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--nsn-warm-gray)]">
                        Transcript snippet
                      </p>
                      <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                        {videoMetadata.transcriptSnippet}
                      </p>
                    </div>
                  ) : (
                    <p className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-warning)]">
                      No transcript snippet is saved. The source video remains
                      in the connected folder.
                    </p>
                  )}
                </div>

                <div className="grid min-w-0 gap-3">
                  <dl className="grid grid-cols-1 gap-2 text-sm leading-6 text-[var(--nsn-slate)] sm:grid-cols-2 lg:grid-cols-1">
                    <div className="min-w-0">
                      <dt className="font-semibold text-[var(--nsn-navy)]">
                        Duration
                      </dt>
                      <dd>{formatDuration(videoMetadata.durationSeconds)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-semibold text-[var(--nsn-navy)]">
                        Resolution
                      </dt>
                      <dd>
                        {videoMetadata.width && videoMetadata.height
                          ? `${videoMetadata.width} x ${videoMetadata.height}`
                          : "not recorded"}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-semibold text-[var(--nsn-navy)]">
                        Frame rate
                      </dt>
                      <dd>
                        {videoMetadata.frameRate
                          ? `${videoMetadata.frameRate.toFixed(2)} fps`
                          : "not recorded"}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-semibold text-[var(--nsn-navy)]">
                        Codec
                      </dt>
                      <dd className="break-words [overflow-wrap:anywhere]">
                        {videoMetadata.codec ?? "not recorded"}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-semibold text-[var(--nsn-navy)]">
                        Bitrate
                      </dt>
                      <dd>{videoMetric(videoMetadata.bitrateKbps, " kbps")}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-semibold text-[var(--nsn-navy)]">
                        Audio track
                      </dt>
                      <dd>
                        {videoMetadata.hasAudioTrack === null
                          ? "not recorded"
                          : videoMetadata.hasAudioTrack
                            ? "present"
                            : "not detected"}
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                  <p className="text-sm font-semibold text-[var(--nsn-navy)]">
                    Chapter suggestions
                  </p>
                  {videoMetadata.chapterSuggestions.length > 0 ? (
                    <ol className="mt-2 grid gap-2 text-sm leading-6 text-[var(--nsn-slate)]">
                      {videoMetadata.chapterSuggestions.map((chapter) => (
                        <li
                          className="break-words [overflow-wrap:anywhere]"
                          key={`${chapter.timestampSeconds}-${chapter.title}`}
                        >
                          <span className="font-semibold text-[var(--nsn-navy)]">
                            {formatDuration(chapter.timestampSeconds)}
                          </span>{" "}
                          {chapter.title}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-2 text-sm leading-6 text-[var(--nsn-slate)]">
                      No chapter suggestions have been trusted yet.
                    </p>
                  )}
                </div>

                <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                  <p className="text-sm font-semibold text-[var(--nsn-navy)]">
                    Key scenes
                  </p>
                  {videoMetadata.selectedFrameDescriptions.length > 0 ? (
                    <ul className="mt-2 grid gap-2 text-sm leading-6 text-[var(--nsn-slate)]">
                      {videoMetadata.selectedFrameDescriptions.map((frame) => (
                        <li
                          className="break-words [overflow-wrap:anywhere]"
                          key={`${frame.timestampSeconds}-${frame.label}`}
                        >
                          <span className="font-semibold text-[var(--nsn-navy)]">
                            {formatDuration(frame.timestampSeconds)}
                          </span>{" "}
                          {frame.label}: {frame.description}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm leading-6 text-[var(--nsn-slate)]">
                      No temporary frame notes were saved for review.
                    </p>
                  )}
                </div>

                <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                  <p className="text-sm font-semibold text-[var(--nsn-navy)]">
                    Related topics
                  </p>
                  {videoMetadata.provisionalTopics.length > 0 ? (
                    <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {videoMetadata.provisionalTopics.join(", ")}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm leading-6 text-[var(--nsn-slate)]">
                      No topics have been trusted yet.
                    </p>
                  )}
                </div>

                <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                  <p className="text-sm font-semibold text-[var(--nsn-navy)]">
                    Provenance
                  </p>
                  <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                    Source remains in the connected folder. The Librarian saved
                    metadata, a summary, a short snippet, chapter notes, and
                    frame notes only.
                  </p>
                  {videoMetadata.duplicateKind ? (
                    <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      Possible duplicate signal:{" "}
                      {humanLabel(videoMetadata.duplicateKind)}
                    </p>
                  ) : null}
                </div>
              </div>

              <VideoRecordingReviewControls file={data.file} />
            </div>
          </ReviewSection>
        ) : null}

        {audioMetadata ? (
          <ReviewSection title="Recording review">
            <div className="grid gap-5">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.45fr)]">
                <div className="grid min-w-0 gap-3">
                  <div className="flex flex-wrap gap-2">
                    <NsnBadge tone="review">
                      {humanLabel(audioMetadata.privacyState)}
                    </NsnBadge>
                    {audioMetadata.humanLabels.map((label) => (
                      <NsnBadge key={label} tone="source">
                        {humanLabel(label)}
                      </NsnBadge>
                    ))}
                    {audioMetadata.machineLabels.slice(0, 4).map((label) => (
                      <NsnBadge key={label} tone="pending">
                        {humanLabel(label)}
                      </NsnBadge>
                    ))}
                  </div>

                  {audioMetadata.summary ? (
                    <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {audioMetadata.summary}
                    </p>
                  ) : (
                    <p className="text-sm leading-6 text-[var(--nsn-slate)]">
                      The Librarian recorded metadata for this audio file and
                      still needs Deanne&apos;s review before trusting any
                      label.
                    </p>
                  )}

                  {audioMetadata.transcriptSnippet ? (
                    <div className="rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--nsn-warm-gray)]">
                        Transcript snippet
                      </p>
                      <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                        {audioMetadata.transcriptSnippet}
                      </p>
                    </div>
                  ) : (
                    <p className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-warning)]">
                      No transcript snippet is saved. The source recording
                      remains in the connected folder.
                    </p>
                  )}
                </div>

                <div className="grid min-w-0 gap-3">
                  <AudioWaveformIndicator />
                  <dl className="grid grid-cols-1 gap-2 text-sm leading-6 text-[var(--nsn-slate)] sm:grid-cols-2 lg:grid-cols-1">
                    <div className="min-w-0">
                      <dt className="font-semibold text-[var(--nsn-navy)]">
                        Duration
                      </dt>
                      <dd>{formatDuration(audioMetadata.durationSeconds)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-semibold text-[var(--nsn-navy)]">
                        Sample rate
                      </dt>
                      <dd>
                        {audioMetadata.sampleRateHz
                          ? `${audioMetadata.sampleRateHz.toLocaleString()} Hz`
                          : "not recorded"}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-semibold text-[var(--nsn-navy)]">
                        Channels
                      </dt>
                      <dd>{audioMetadata.channels ?? "not recorded"}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-semibold text-[var(--nsn-navy)]">
                        Bitrate
                      </dt>
                      <dd>
                        {audioMetadata.bitrateKbps
                          ? `${audioMetadata.bitrateKbps} kbps`
                          : "not recorded"}
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                  <p className="text-sm font-semibold text-[var(--nsn-navy)]">
                    Related topics
                  </p>
                  {audioMetadata.provisionalTopics.length > 0 ? (
                    <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {audioMetadata.provisionalTopics.join(", ")}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm leading-6 text-[var(--nsn-slate)]">
                      No topics have been trusted yet.
                    </p>
                  )}
                </div>

                <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                  <p className="text-sm font-semibold text-[var(--nsn-navy)]">
                    Provenance
                  </p>
                  <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                    Source remains in the connected folder. The Librarian saved
                    metadata, a summary, and a short snippet only.
                  </p>
                  {audioMetadata.duplicateKind ? (
                    <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      Possible duplicate signal:{" "}
                      {humanLabel(audioMetadata.duplicateKind)}
                    </p>
                  ) : null}
                </div>
              </div>

              <AudioRecordingReviewControls file={data.file} />
            </div>
          </ReviewSection>
        ) : null}

        {isImage ? (
          <ReviewSection title="Image review">
            <div className="grid gap-5">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.45fr)]">
                <div className="grid min-w-0 gap-3">
                  {data.file.readingStatus === "READ" ? (
                    <div className="overflow-hidden rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)]">
                      <Image
                        alt={`Preview of ${fileName}`}
                        className="max-h-[55dvh] w-full object-contain"
                        height={imageMetadata?.height ?? 900}
                        src={`/api/bridge/scanned-files/${encodeURIComponent(
                          data.file.id,
                        )}/image`}
                        unoptimized
                        width={imageMetadata?.width ?? 1600}
                      />
                    </div>
                  ) : (
                    <p className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-warning)]">
                      Image preview is unavailable because this file still
                      needs attention.
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <NsnBadge tone="review">
                      {humanLabel(
                        imageMetadata?.privacyState ?? "REVIEW_REQUIRED",
                      )}
                    </NsnBadge>
                    {imageMetadata?.humanLabels.map((label) => (
                      <NsnBadge key={label} tone="source">
                        {humanLabel(label)}
                      </NsnBadge>
                    ))}
                    {imageMetadata?.machineLabels.slice(0, 5).map((label) => (
                      <NsnBadge key={label} tone="pending">
                        {humanLabel(label)}
                      </NsnBadge>
                    ))}
                  </div>

                  {imageMetadata?.summary ? (
                    <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {imageMetadata.summary}
                    </p>
                  ) : (
                    <p className="text-sm leading-6 text-[var(--nsn-slate)]">
                      The source image remains in the connected folder. The
                      Librarian saves metadata and provisional labels for human
                      review, not full image contents.
                    </p>
                  )}
                </div>

                <dl className="grid min-w-0 grid-cols-1 gap-2 text-sm leading-6 text-[var(--nsn-slate)] sm:grid-cols-2 lg:grid-cols-1">
                  <div className="min-w-0">
                    <dt className="font-semibold text-[var(--nsn-navy)]">
                      Image type
                    </dt>
                    <dd className="break-words [overflow-wrap:anywhere]">
                      {imageType}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="font-semibold text-[var(--nsn-navy)]">
                      Dimensions
                    </dt>
                    <dd>{imageDimensions}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="font-semibold text-[var(--nsn-navy)]">
                      Preview
                    </dt>
                    <dd>{humanLabel(imageMetadata?.previewStatus ?? "NOT_REQUESTED")}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="font-semibold text-[var(--nsn-navy)]">
                      Visual review
                    </dt>
                    <dd>
                      {humanLabel(
                        imageMetadata?.visualAnalysisStatus ?? "NOT_REQUESTED",
                      )}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="font-semibold text-[var(--nsn-navy)]">
                      OCR
                    </dt>
                    <dd>{humanLabel(imageMetadata?.ocrStatus ?? "NOT_REQUESTED")}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="font-semibold text-[var(--nsn-navy)]">
                      Source date
                    </dt>
                    <dd>
                      {imageMetadata?.sourceModifiedAt
                        ? new Date(
                            imageMetadata.sourceModifiedAt,
                          ).toLocaleString()
                        : "not recorded"}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                  <p className="text-sm font-semibold text-[var(--nsn-navy)]">
                    Related topics
                  </p>
                  {imageMetadata?.provisionalTopics.length ? (
                    <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      {imageMetadata.provisionalTopics.join(", ")}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm leading-6 text-[var(--nsn-slate)]">
                      No image topics have been trusted yet.
                    </p>
                  )}
                </div>

                <div className="min-w-0 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3">
                  <p className="text-sm font-semibold text-[var(--nsn-navy)]">
                    Provenance
                  </p>
                  <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                    Source remains in the connected folder. The Librarian saved
                    metadata, a short review summary, and provisional labels
                    only.
                  </p>
                  {imageMetadata?.duplicateKind ? (
                    <p className="mt-2 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                      Possible duplicate signal:{" "}
                      {humanLabel(imageMetadata.duplicateKind)}
                    </p>
                  ) : null}
                </div>
              </div>

              <ImageAssetReviewControls file={data.file} />
            </div>
          </ReviewSection>
        ) : null}

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <ReviewSection
            title={
              isVideo
                ? "Temporary video transcript review"
                : isAudio
                  ? "Temporary transcript review"
                  : isImage
                    ? "Temporary image review text"
                    : "Readable content preview"
            }
          >
            {shownText ? (
              <div className="grid gap-3">
                <p className="text-sm leading-6 text-[var(--nsn-slate)]">
                  {isVideo
                    ? "A full transcript is not stored. This review uses the saved summary and snippet unless the Bridge can temporarily reopen the local video."
                    : isAudio
                      ? "A full transcript is shown only when the Bridge can temporarily transcribe the local recording. Otherwise the saved summary and snippet are shown."
                      : isImage
                        ? "Image review text is rebuilt from safe metadata when the Bridge can temporarily reopen the local image. Otherwise the saved preview is shown."
                        : "Full extracted text is shown when the Bridge can temporarily reopen the local file. Otherwise the saved preview is shown."}
                </p>
                {data.previewError ? (
                  <p className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-warning)]">
                    {data.previewError}
                  </p>
                ) : null}
                <pre className="max-h-[48dvh] min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-4 text-sm leading-6 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                  {shownText}
                </pre>
              </div>
            ) : (
              <NsnEmptyState
                description="The Librarian does not have readable text available for this file."
                title="No text available"
              />
            )}
          </ReviewSection>

          <ReviewSection title="Memory the Librarian used">
            {data.approvedMemoryUsed.length > 0 ? (
              <div className="grid gap-3">
                <ul className="grid gap-2 pl-4 text-sm leading-6 text-[var(--nsn-slate)]">
                  {data.approvedMemoryUsed.slice(0, 5).map((memory) => (
                    <li
                      className="list-disc break-words [overflow-wrap:anywhere]"
                      key={memory}
                    >
                      {memory}
                    </li>
                  ))}
                </ul>
                {data.approvedMemoryUsed.length > 5 ? (
                  <p className="text-sm leading-6 text-[var(--nsn-slate)]">
                    {data.approvedMemoryUsed.length - 5} more approved memory
                    notes are available in Memory.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm leading-6 text-[var(--nsn-slate)]">
                No approved Memory was used for these recommendations.
              </p>
            )}
          </ReviewSection>
        </div>

        {data.observationReview ? (
          <div className="grid gap-5">
            <ReviewSection title="Librarian observation">
              <ObservationSummary review={data.observationReview} />
            </ReviewSection>

            <ObservationDecisionPanel
              currentStatus={data.observationReview.status}
              sessionId={data.observationReview.id}
            />
          </div>
        ) : (
          <NsnEmptyState
            description="The Librarian has not produced a provisional observation for this file yet."
            title="No observation ready"
          />
        )}

        <div className="grid gap-4">
          <NsnCard tone="sand">
            <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              Recommendation decisions saved here are review decisions only.
              They do not move, rename, create, delete, publish, or execute
              anything.
            </p>
          </NsnCard>
          <OrganizationSuggestionsReviewPanel
            scanSessionId={data.session.id}
            showExamineLink={false}
            suggestions={data.suggestions}
          />
        </div>
      </div>
    </LibraryShell>
  );
}
