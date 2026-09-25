import type { AIObservationResult } from "./types";

const maxSourceCharacters = 2_000_000;
const maxEvidenceCharacters = 240;
const sourceEvidencePattern = /^Source characters (\d+)-(\d+): "([\s\S]+)"$/;

export function sampleDocumentText(text: string, budget: number) {
  const source = text.slice(0, maxSourceCharacters);
  const limit = Math.max(1, Math.floor(budget));

  if (source.length <= limit) {
    return {
      text: source,
      partial: source.length < text.length,
      sourceLength: text.length,
    };
  }

  if (limit < 600) {
    return { text: source.slice(0, limit), partial: true, sourceLength: text.length };
  }

  const sections = 6;
  const sectionLength = Math.floor((limit - sections * 60) / sections);
  const candidates = Array.from(
    { length: Math.ceil(source.length / sectionLength) },
    (_, index) => {
      const start = index * sectionLength;
      const end = Math.min(source.length, start + sectionLength);
      const words = new Set(
        (source.slice(start, end).toLowerCase().match(/[\p{L}]{4,}/gu) ?? [])
          .filter((word) => !["document", "librarian", "review", "content", "notes"].includes(word)),
      );
      return { end, start, words };
    },
  );
  const chosen = new Set([0, candidates.length - 1]);
  const covered = new Set<string>();

  for (const index of chosen) {
    for (const word of candidates[index]?.words ?? []) {
      covered.add(word);
    }
  }

  while (chosen.size < Math.min(sections, candidates.length)) {
    let bestIndex = -1;
    let bestScore = -1;

    for (let index = 0; index < candidates.length; index += 1) {
      if (chosen.has(index)) {
        continue;
      }

      const score = [...candidates[index].words].filter((word) => !covered.has(word)).length;

      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex < 0) {
      break;
    }

    chosen.add(bestIndex);
    for (const word of candidates[bestIndex].words) {
      covered.add(word);
    }
  }

  const selected = [...chosen].sort((a, b) => a - b).map((index) => {
    const { start, end } = candidates[index];
    return `[Source characters ${start}-${end}]\n${source.slice(start, end)}`;
  });

  return {
    text: selected.join("\n\n").slice(0, limit),
    partial: true,
    sourceLength: text.length,
  };
}

export function groundedEvidence(value: string, source: string) {
  const quote = value.trim().replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, "").trim();

  if (quote.length < 6 || quote.length > maxEvidenceCharacters) {
    return null;
  }

  const offset = source.indexOf(quote);

  if (offset < 0) {
    return null;
  }

  const excerpt = source.slice(offset, offset + quote.length);
  return `Source characters ${offset}-${offset + excerpt.length}: "${excerpt}"`;
}

export function verifiedSourceText(value: string) {
  const match = value.match(sourceEvidencePattern);

  return match ? match[3] : null;
}

export function groundObservationResult(
  result: AIObservationResult,
  source: string,
): AIObservationResult {
  let unsupportedEvidence = 0;
  const verify = (evidence: string[]) => {
    const verified = evidence
      .map((quote) => groundedEvidence(quote, source))
      .filter((quote): quote is string => quote !== null)
      .slice(0, 8);
    unsupportedEvidence += evidence.length - verified.length;
    return verified;
  };
  const observations = result.observations
    .map((observation) => ({ ...observation, evidence: verify(observation.evidence) }))
    .filter((observation) => observation.evidence.length > 0);
  const possibleThemes = result.possibleThemes
    .map((theme) => ({ ...theme, evidence: verify(theme.evidence) }))
    .filter((theme) => theme.evidence.length > 0);
  const possibleRelationships = result.possibleRelationships
    .map((relationship) => ({ ...relationship, evidence: verify(relationship.evidence) }))
    .filter((relationship) => relationship.evidence.length > 0);

  return {
    ...result,
    observations,
    possibleThemes,
    possibleRelationships,
    confidence: observations.length > 0 ? result.confidence : 0,
    warnings: unsupportedEvidence > 0
      ? [...result.warnings, "Some proposed evidence could not be matched to the source and was not used."]
      : result.warnings,
  };
}
