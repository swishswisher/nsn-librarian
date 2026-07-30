import type { Interpretation, MindInput, Observation } from "./types";

function findObservation(
  observations: Observation[],
  label: Observation["label"],
) {
  return observations.find((observation) => observation.label === label);
}

export function reasonAboutObservations(
  input: MindInput,
  observations: Observation[],
): Interpretation[] {
  const emptyContent = findObservation(observations, "MISSING_OR_EMPTY_CONTENT");

  if (emptyContent) {
    return [
      {
        id: "interpretation-insufficient-readable-content",
        label: "INSUFFICIENT_EVIDENCE",
        description:
          "No reliable interpretation should be made until readable content has been observed.",
        basedOnObservationIds: [emptyContent.id],
        confidence: 0.82,
        uncertainty:
          "The item may still matter, but the Mind has not observed enough content to understand it.",
      },
    ];
  }

  const interpretations: Interpretation[] = [];
  const purpose = findObservation(observations, "POSSIBLE_PURPOSE");
  const repeatedTerms = findObservation(observations, "REPEATED_TERMS");

  if (purpose) {
    interpretations.push({
      id: "interpretation-possible-library-placement",
      label: "POSSIBLE_LIBRARY_PLACEMENT",
      description: `This ${input.itemKind.toLowerCase()} may belong near materials with similar purpose, but human review is needed before deciding.`,
      basedOnObservationIds: [purpose.id],
      confidence: Math.min(0.64, purpose.confidence),
      uncertainty:
        "Purpose was inferred from simple local terms, so it should not be treated as a decision.",
    });
  }

  if (repeatedTerms) {
    interpretations.push({
      id: "interpretation-possible-topic-signal",
      label: "POSSIBLE_TOPIC_SIGNAL",
      description:
        "The repeated terms may be useful as topic signals for later organization or search.",
      basedOnObservationIds: [repeatedTerms.id],
      confidence: Math.min(0.6, repeatedTerms.confidence),
      uncertainty:
        "Repeated language can reflect templates or source formatting, so the signal needs human review.",
    });
  }

  if (interpretations.length === 0) {
    interpretations.push({
      id: "interpretation-human-review-needed",
      label: "HUMAN_REVIEW_NEEDED",
      description:
        "The current observations are too limited for a meaningful interpretation.",
      basedOnObservationIds: observations.map((observation) => observation.id),
      confidence: 0.48,
      uncertainty:
        "The Mind may need better extracted text, more context, or human guidance.",
    });
  }

  return interpretations;
}
