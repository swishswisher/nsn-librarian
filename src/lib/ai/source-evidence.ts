import type { AIObservationResult } from "./types";

const maxSourceCharacters = 2_000_000;
const maxEvidenceCharacters = 240;

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
  return `Source characters ${offset}-${offset + excerpt.length}: ${JSON.stringify(excerpt)}`;
}

export function verifiedSourceExcerpts(value: string) {
  const excerpts: Array<{ start: number; end: number; text: string }> = [];
  const markers = /Source characters (\d+)-(\d+): /g;
  let match: RegExpExecArray | null;
  while ((match = markers.exec(value))) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    const length = end - start;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 ||
        length < 1 || length > maxEvidenceCharacters) continue;
    const tail = value.slice(markers.lastIndex);
    if (!tail.startsWith('"')) continue;
    let text: string | null = null;
    let consumed = 0;
    const encoded = /^"(?:\\.|[^"\\])*"/.exec(tail)?.[0];
    if (encoded) {
      try {
        const decoded: unknown = JSON.parse(encoded);
        if (typeof decoded === "string" && decoded.length === length) {
          text = decoded;
          consumed = encoded.length;
        }
      } catch { /* Older excerpts stored literal newlines rather than JSON escapes. */ }
    }
    // Legacy quotations are bounded by their verified source length, not a quote regex.
    if (text === null && tail[length + 1] === '"') {
      text = tail.slice(1, length + 1);
      consumed = length + 2;
    }
    if (text === null) continue;
    excerpts.push({ start, end, text });
    markers.lastIndex += consumed;
  }
  return excerpts;
}

export function verifiedSourceText(value: string) {
  if (!/^Source characters \d+-\d+: "/.test(value) || !value.endsWith('"')) return null;
  const excerpts = verifiedSourceExcerpts(value);
  if (excerpts.length !== 1) return null;
  const excerpt = excerpts[0];
  const prefix = `Source characters ${excerpt.start}-${excerpt.end}: `;
  return value === prefix + JSON.stringify(excerpt.text) || value === `${prefix}"${excerpt.text}"`
    ? excerpt.text : null;
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
