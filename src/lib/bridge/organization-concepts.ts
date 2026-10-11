const conceptEvidenceLabel = "Content concepts: ";
const historicalConceptEvidenceLabel = "Specific shared concepts: ";

export function formatOrganizationConcepts(concepts: readonly string[]) {
  return `${conceptEvidenceLabel}${concepts.join(", ")}`;
}

export function organizationConceptsFromEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entry = value.find((item): item is string => typeof item === "string" &&
    [conceptEvidenceLabel, historicalConceptEvidenceLabel].some((label) => item.startsWith(label)));
  if (!entry) return [];
  const label = entry.startsWith(conceptEvidenceLabel) ? conceptEvidenceLabel : historicalConceptEvidenceLabel;
  return [...new Set(entry.slice(label.length).split(",")
    .map((term) => term.trim().toLowerCase()).filter((term) => term.length >= 4))].slice(0, 8);
}
