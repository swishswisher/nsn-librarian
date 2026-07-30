import type {
  Connection,
  Explanation,
  Interpretation,
  MindInput,
  Observation,
} from "./types";

export type ExplainerInput = {
  input: MindInput;
  observations: Observation[];
  interpretations: Interpretation[];
  connections: Connection[];
};

function averageConfidence(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  const total = values.reduce((sum, value) => sum + value, 0);

  return Number((total / values.length).toFixed(2));
}

export function explainMindResult({
  input,
  observations,
  interpretations,
  connections,
}: ExplainerInput): Explanation {
  const hasReadableContent = !observations.some(
    (observation) => observation.label === "MISSING_OR_EMPTY_CONTENT",
  );
  const evidence = observations
    .flatMap((observation) => observation.evidence)
    .slice(0, 8);
  const confidence = averageConfidence([
    ...observations.map((observation) => observation.confidence),
    ...interpretations.map((interpretation) => interpretation.confidence),
  ]);

  if (!hasReadableContent) {
    return {
      summary:
        "I do not have enough readable text to understand this item yet. I can only note its format and ask for human review.",
      evidence,
      uncertainty:
        "The Mind should not infer meaning from an empty or unreadable item.",
      confidence: Math.min(confidence, 0.42),
    };
  }

  return {
    summary: `I observed cautious signals in ${input.title ?? "this item"}. They may help future review, but they are not decisions.`,
    evidence,
    uncertainty:
      connections.length > 0
        ? "Connections are suggestions only and still require human review."
        : "No related items were searched yet, and all interpretations are based only on the observed text.",
    confidence,
  };
}
