"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { NsnButton } from "@/components/library/NsnButton";
import type {
  BridgeScannedFileSummary,
  BridgeVideoMetadataMutationResponse,
  BridgeVideoMetadataSummary,
  VideoHumanLabel,
  VideoPrivacyState,
} from "@/lib/bridge/types";

type VideoRecordingReviewControlsProps = {
  file: BridgeScannedFileSummary;
};

const labelOptions: Array<{ label: string; value: VideoHumanLabel }> = [
  { label: "Workshop", value: "WORKSHOP" },
  { label: "Presentation", value: "PRESENTATION" },
  { label: "Website", value: "WEBSITE" },
  { label: "Internal", value: "INTERNAL" },
  { label: "Private", value: "PRIVATE" },
  { label: "Interview", value: "INTERVIEW" },
  { label: "Webinar", value: "WEBINAR" },
  { label: "Training", value: "TRAINING" },
  { label: "Archive", value: "ARCHIVE" },
  { label: "Duplicate Candidate", value: "DUPLICATE_CANDIDATE" },
];

const privacyOptions: Array<{ label: string; value: VideoPrivacyState }> = [
  { label: "Review required", value: "REVIEW_REQUIRED" },
  { label: "Private", value: "PRIVATE" },
  { label: "Internal", value: "INTERNAL" },
  { label: "Website candidate", value: "WEBSITE_CANDIDATE" },
  { label: "Approved for public use", value: "APPROVED_FOR_PUBLIC_USE" },
];

function labelText(value: string) {
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function labelsFrom(metadata: BridgeVideoMetadataSummary | null) {
  return new Set<VideoHumanLabel>(metadata?.humanLabels ?? []);
}

export function VideoRecordingReviewControls({
  file,
}: VideoRecordingReviewControlsProps) {
  const router = useRouter();
  const [videoMetadata, setVideoMetadata] = useState(file.videoMetadata);
  const [selectedLabels, setSelectedLabels] = useState(() =>
    labelsFrom(file.videoMetadata),
  );
  const [privacyState, setPrivacyState] = useState<VideoPrivacyState>(
    file.videoMetadata?.privacyState ?? "REVIEW_REQUIRED",
  );
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sortedLabels = useMemo(
    () => [...selectedLabels].sort((left, right) => left.localeCompare(right)),
    [selectedLabels],
  );

  function toggleLabel(label: VideoHumanLabel) {
    setSelectedLabels((current) => {
      const next = new Set(current);

      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }

      return next;
    });
  }

  async function saveVideoState(nextInput?: {
    labels?: VideoHumanLabel[];
    privacyState?: VideoPrivacyState;
  }) {
    setIsSaving(true);
    setMessage(null);
    setError(null);

    const nextLabels = nextInput?.labels ?? sortedLabels;
    const nextPrivacy = nextInput?.privacyState ?? privacyState;

    try {
      const response = await fetch(
        `/api/bridge/scanned-files/${encodeURIComponent(file.id)}/video`,
        {
          body: JSON.stringify({
            labels: nextLabels,
            privacyState: nextPrivacy,
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "PATCH",
        },
      );
      const payload =
        (await response.json()) as BridgeVideoMetadataMutationResponse;

      if (!payload.ok) {
        setError(payload.error);
        return;
      }

      setVideoMetadata(payload.file.videoMetadata);
      setSelectedLabels(labelsFrom(payload.file.videoMetadata));
      setPrivacyState(
        payload.file.videoMetadata?.privacyState ?? "REVIEW_REQUIRED",
      );
      setMessage("Video review details were saved.");
      router.refresh();
    } catch {
      setError("The Librarian could not save these video details.");
    } finally {
      setIsSaving(false);
    }
  }

  function keepPrivate() {
    const nextLabels = [...new Set([...sortedLabels, "PRIVATE" as const])];

    setSelectedLabels(new Set(nextLabels));
    setPrivacyState("PRIVATE");
    void saveVideoState({
      labels: nextLabels,
      privacyState: "PRIVATE",
    });
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <p className="text-sm font-semibold text-[var(--nsn-navy)]">
          Label Video
        </p>
        <div className="flex min-w-0 flex-wrap gap-2">
          {labelOptions.map((option) => (
            <label
              className={[
                "inline-flex min-h-10 max-w-full cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-semibold transition",
                selectedLabels.has(option.value)
                  ? "border-[var(--nsn-teal)] bg-[var(--nsn-sage-mist)] text-[var(--nsn-teal-dark)]"
                  : "border-[var(--nsn-border)] bg-[var(--nsn-cream)] text-[var(--nsn-navy)]",
              ].join(" ")}
              key={option.value}
            >
              <input
                checked={selectedLabels.has(option.value)}
                className="size-4 shrink-0"
                onChange={() => toggleLabel(option.value)}
                type="checkbox"
              />
              <span className="break-words [overflow-wrap:anywhere]">
                {option.label}
              </span>
            </label>
          ))}
        </div>
      </div>

      <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
        Video privacy
        <select
          className="min-h-11 w-full rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-sm text-[var(--nsn-navy)]"
          onChange={(event) =>
            setPrivacyState(event.target.value as VideoPrivacyState)
          }
          value={privacyState}
        >
          {privacyOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {videoMetadata ? (
        <p className="break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
          Current review state: {labelText(videoMetadata.privacyState)}
          {videoMetadata.humanLabels.length > 0
            ? ` - ${videoMetadata.humanLabels.map(labelText).join(", ")}`
            : ""}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <NsnButton
          disabled={isSaving}
          onClick={() => saveVideoState()}
          type="button"
          variant="primary"
        >
          {isSaving ? "Saving..." : "Save Video Labels"}
        </NsnButton>
        <NsnButton
          disabled={isSaving}
          onClick={keepPrivate}
          type="button"
          variant="secondary"
        >
          Keep Private
        </NsnButton>
      </div>

      {message ? (
        <p className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm leading-6 text-[var(--nsn-teal-dark)]">
          {message}
        </p>
      ) : null}
      {error ? (
        <p
          className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-sand)] p-3 text-sm leading-6 text-[var(--nsn-warning)]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
