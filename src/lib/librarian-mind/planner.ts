import type {
  Connection,
  Interpretation,
  Observation,
  PlanSuggestion,
} from "./types";

export type PlannerInput = {
  observations: Observation[];
  interpretations: Interpretation[];
  connections: Connection[];
};

function hasObservation(
  observations: Observation[],
  label: Observation["label"],
) {
  return observations.some((observation) => observation.label === label);
}

export function planHumanReviewSuggestions({
  observations,
  interpretations,
  connections,
}: PlannerInput): PlanSuggestion[] {
  const suggestions: PlanSuggestion[] = [];

  if (hasObservation(observations, "MISSING_OR_EMPTY_CONTENT")) {
    suggestions.push({
      id: "plan-needs-human-review",
      actionType: "NEEDS_HUMAN_REVIEW",
      label: "Needs human review",
      description:
        "Ask a human to decide whether this item should be revisited, left alone, or read another way later.",
      reason:
        "The Mind did not receive enough readable text to make even a cautious suggestion.",
      confidence: 0.82,
      requiresHumanApproval: true,
    });

    suggestions.push({
      id: "plan-leave-unchanged",
      actionType: "LEAVE_UNCHANGED",
      label: "Leave unchanged",
      description:
        "Do not move, rename, delete, or reorganize this item from Mind output.",
      reason: "Nothing moves without approval, and there is not enough evidence.",
      confidence: 0.88,
      requiresHumanApproval: true,
    });

    return suggestions;
  }

  if (hasObservation(observations, "POSSIBLE_PURPOSE")) {
    suggestions.push({
      id: "plan-consider-category",
      actionType: "CONSIDER_CATEGORY",
      label: "Consider category",
      description:
        "Invite a human to consider whether the observed purpose signals fit an existing library category.",
      reason:
        "The Observer found possible purpose language, but it is not a classification decision.",
      confidence: 0.58,
      requiresHumanApproval: true,
    });
  }

  if (connections.length > 0) {
    suggestions.push({
      id: "plan-connect-with-related",
      actionType: "CONNECT_WITH_RELATED",
      label: "Review related items",
      description:
        "Invite a human to review possible relationships before any relationship is remembered as useful.",
      reason: "Connections are only suggestions until approved.",
      confidence: 0.52,
      requiresHumanApproval: true,
    });
  }

  if (suggestions.length === 0 || interpretations.length > 0) {
    suggestions.push({
      id: "plan-review-later",
      actionType: "REVIEW_LATER",
      label: "Review later",
      description:
        "Keep the item available for later human review without changing the file.",
      reason:
        "The Mind can suggest attention, but it must not execute organization.",
      confidence: 0.62,
      requiresHumanApproval: true,
    });
  }

  return suggestions;
}
