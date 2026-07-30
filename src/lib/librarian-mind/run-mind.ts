import { connectKnowledgeItems } from "./connector";
import { explainMindResult } from "./explainer";
import { observeKnowledgeItem } from "./observer";
import { planHumanReviewSuggestions } from "./planner";
import { reasonAboutObservations } from "./reasoner";
import type { MindInput, MindResult } from "./types";

function averageConfidence(values: number[]) {
  const usableValues = values.filter((value) => Number.isFinite(value));

  if (usableValues.length === 0) {
    return 0;
  }

  const total = usableValues.reduce((sum, value) => sum + value, 0);

  return Number((total / usableValues.length).toFixed(2));
}

export async function runLibrarianMind(input: MindInput): Promise<MindResult> {
  const observerResult = observeKnowledgeItem(input);
  const interpretations = reasonAboutObservations(
    input,
    observerResult.observations,
  );
  const connections = connectKnowledgeItems({
    input,
    observations: observerResult.observations,
    interpretations,
  });
  const explanation = explainMindResult({
    input,
    observations: observerResult.observations,
    interpretations,
    connections,
  });
  const planSuggestions = planHumanReviewSuggestions({
    observations: observerResult.observations,
    interpretations,
    connections,
  });

  return {
    observations: observerResult.observations,
    interpretations,
    connections,
    explanation,
    planSuggestions,
    overallConfidence: averageConfidence([
      ...observerResult.observations.map((observation) => observation.confidence),
      ...interpretations.map((interpretation) => interpretation.confidence),
      explanation.confidence,
      ...planSuggestions.map((suggestion) => suggestion.confidence),
    ]),
    warnings: observerResult.warnings,
  };
}
