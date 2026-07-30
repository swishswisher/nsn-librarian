"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { NsnButton } from "@/components/library/NsnButton";
import type { HumanDecisionType, ObservationSessionStatus } from "@/types/library";

type ObservationDecisionPanelProps = {
  sessionId: string;
  currentStatus: ObservationSessionStatus;
};

type DecisionResponse =
  | {
      ok: true;
      status: ObservationSessionStatus;
    }
  | {
      ok: false;
      error: string;
    };

const reviewActions: {
  value: HumanDecisionType;
  label: string;
  helper: string;
}[] = [
  {
    value: "ACCEPT",
    label: "Approve",
    helper: "Approve this observation for Memory.",
  },
  {
    value: "MODIFY",
    label: "Revise Observation",
    helper: "Save Deanne's corrected observation or wording.",
  },
  {
    value: "REJECT",
    label: "Reject",
    helper: "Mark this observation as not right.",
  },
  {
    value: "NOTE",
    label: "Leave Unchanged",
    helper: "Add context without approving or rejecting.",
  },
];

function statusLabel(status: ObservationSessionStatus) {
  if (status === "AWAITING_REVIEW") {
    return "Needs review";
  }

  if (status === "IN_REVIEW") {
    return "In review";
  }

  return status.replaceAll("_", " ").toLowerCase();
}

export function ObservationDecisionPanel({
  sessionId,
  currentStatus,
}: ObservationDecisionPanelProps) {
  const router = useRouter();
  const [decisionType, setDecisionType] = useState<HumanDecisionType>("ACCEPT");
  const [note, setNote] = useState("");
  const [editedSuggestion, setEditedSuggestion] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedStatus, setSavedStatus] =
    useState<ObservationSessionStatus>(currentStatus);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  async function saveDecision() {
    if (isSaving) {
      return;
    }

    setIsSaving(true);
    setError(null);
    setSavedMessage(null);

    try {
      const response = await fetch(
        `/api/library/observation-sessions/${sessionId}/decision`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            decisionType,
            note,
            editedSuggestion:
              decisionType === "MODIFY" ? editedSuggestion : undefined,
          }),
        },
      );
      const payload = (await response.json()) as DecisionResponse;

      if (!payload.ok) {
        setError(payload.error);
        return;
      }

      setSavedStatus(payload.status);
      setSavedMessage("Decision saved.");
      setNote("");
      setEditedSuggestion("");
      router.refresh();
    } catch {
      setError("The review decision could not be saved right now.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section
      aria-labelledby="human-decision-heading"
      className="grid gap-4 rounded-lg border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 sm:p-5"
    >
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--nsn-teal)]">
          Human Review
        </p>
        <h2
          className="nsn-display mt-2 text-2xl text-[var(--nsn-navy)]"
          id="human-decision-heading"
        >
          Deanne decides
        </h2>
        <p className="mt-2 text-sm leading-6 text-[var(--nsn-slate)]">
          The machine suggests. Deanne decides. This saves the review decision
          only; it does not move or rename any file.
        </p>
        <p className="mt-2 text-sm font-semibold text-[var(--nsn-navy)]">
          Current review state: {statusLabel(savedStatus)}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {reviewActions.map((action) => {
          const isSelected = decisionType === action.value;

          return (
            <button
              aria-pressed={isSelected}
              className={[
                "min-h-24 rounded-md border p-3 text-left transition",
                isSelected
                  ? "border-[var(--nsn-teal)] bg-[var(--nsn-sage-mist)]"
                  : "border-[var(--nsn-border)] bg-[var(--nsn-card)] hover:bg-[var(--nsn-cream)]",
              ].join(" ")}
              key={action.value}
              onClick={() => setDecisionType(action.value)}
              type="button"
            >
              <span className="block text-sm font-semibold text-[var(--nsn-navy)]">
                {action.label}
              </span>
              <span className="mt-2 block text-xs leading-5 text-[var(--nsn-slate)]">
                {action.helper}
              </span>
            </button>
          );
        })}
      </div>

      {decisionType === "MODIFY" ? (
        <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
          Revised observation or wording
          <textarea
            className="min-h-28 w-full resize-y rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3 text-sm font-normal leading-6 text-[var(--nsn-slate)] outline-none focus:border-[var(--nsn-teal)]"
            onChange={(event) => setEditedSuggestion(event.target.value)}
            placeholder="Write the corrected observation or wording here."
            value={editedSuggestion}
          />
        </label>
      ) : null}

      <label className="grid gap-2 text-sm font-semibold text-[var(--nsn-navy)]">
        Add context
        <textarea
          className="min-h-28 w-full resize-y rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-cream)] p-3 text-sm font-normal leading-6 text-[var(--nsn-slate)] outline-none focus:border-[var(--nsn-teal)]"
          onChange={(event) => setNote(event.target.value)}
          placeholder="Add context for this decision."
          value={note}
        />
      </label>

      {error ? (
        <p className="rounded-md border border-[var(--nsn-warm-beige)] bg-[var(--nsn-warm-beige)] p-3 text-sm font-semibold leading-6 text-[var(--nsn-danger)]">
          {error}
        </p>
      ) : null}

      {savedMessage ? (
        <p className="rounded-md border border-[var(--nsn-soft-aqua)] bg-[var(--nsn-sage-mist)] p-3 text-sm font-semibold leading-6 text-[var(--nsn-teal-dark)]">
          {savedMessage}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-6 text-[var(--nsn-slate)]">
          Nothing moves without approval.
        </p>
        <NsnButton
          className="w-full sm:w-auto"
          disabled={isSaving}
          onClick={saveDecision}
          type="button"
          variant="primary"
        >
          {isSaving ? "Saving" : "Save decision"}
        </NsnButton>
      </div>
    </section>
  );
}
