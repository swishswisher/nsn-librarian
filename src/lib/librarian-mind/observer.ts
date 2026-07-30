import type { MindInput, Observation, ObserverResult } from "./types";

type PurposeSignal = {
  name: string;
  description: string;
  terms: string[];
};

const stopWords = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "before",
  "being",
  "between",
  "could",
  "does",
  "each",
  "from",
  "have",
  "into",
  "more",
  "most",
  "only",
  "other",
  "over",
  "should",
  "some",
  "such",
  "than",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "through",
  "under",
  "very",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
]);

const purposeSignals: PurposeSignal[] = [
  {
    name: "reflective",
    description: "reflective or meaning-making",
    terms: ["reflection", "reflect", "meaning", "memory", "journal", "felt"],
  },
  {
    name: "educational",
    description: "educational or teaching",
    terms: ["teach", "lesson", "workshop", "guide", "learn", "explain"],
  },
  {
    name: "administrative",
    description: "administrative or operational",
    terms: ["invoice", "schedule", "agenda", "policy", "budget", "meeting"],
  },
  {
    name: "clinical",
    description: "clinical or care-related",
    terms: [
      "assessment",
      "client",
      "clinical",
      "intake",
      "regulation",
      "session",
      "therapy",
      "worksheet",
    ],
  },
  {
    name: "technical",
    description: "technical or system-building",
    terms: ["api", "architecture", "component", "database", "migration", "schema"],
  },
  {
    name: "personal",
    description: "personal or autobiographical",
    terms: ["diary", "family", "home", "letter", "personal", "story"],
  },
];

function normalizeText(value: string | null) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function subjectFor(input: MindInput) {
  return input.itemKind === "DOCUMENT" ? "document" : "item";
}

function tokenize(value: string) {
  return (
    value
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9'-]{2,}/g)
      ?.filter((word) => !stopWords.has(word) && word.length > 3) ?? []
  );
}

function topRepeatedWords(text: string) {
  const counts = new Map<string, number>();

  for (const word of tokenize(text)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .slice(0, 8)
    .map(([word, count]) => `${word} (${count})`);
}

function findPurposeMatches(text: string) {
  const lowerText = text.toLowerCase();

  return purposeSignals
    .map((signal) => {
      const matches = signal.terms.filter((term) => lowerText.includes(term));

      return {
        ...signal,
        matches,
      };
    })
    .filter((signal) => signal.matches.length > 0)
    .sort((first, second) => second.matches.length - first.matches.length);
}

function confidenceFromEvidence(count: number) {
  return Math.min(0.72, 0.42 + count * 0.05);
}

export function observeKnowledgeItem(input: MindInput): ObserverResult {
  const observedText = normalizeText(input.contentText || input.previewText);
  const observations: Observation[] = [
    {
      id: "observation-item-kind",
      label: "ITEM_KIND_CONTEXT",
      description: `This knowledge item is recorded as ${input.itemKind}. Format is context, not meaning.`,
      evidence: [`itemKind: ${input.itemKind}`, `source: ${input.source}`],
      confidence: 0.78,
      uncertainty:
        "The item kind describes the file format only. It does not determine importance or meaning.",
    },
  ];
  const warnings: string[] = [];

  if (!observedText) {
    warnings.push(
      "The Mind did not receive readable text, so observation is limited.",
    );
    observations.push({
      id: "observation-empty-content",
      label: "MISSING_OR_EMPTY_CONTENT",
      description: `The ${subjectFor(input)} does not contain readable text for the Mind to observe yet.`,
      evidence: ["contentText is empty", "previewText is empty"],
      confidence: 0.88,
      uncertainty:
        "I am not certain what this item means because there is no observed text.",
    });

    return {
      observations,
      warnings,
    };
  }

  const repeatedWords = topRepeatedWords(observedText);
  if (repeatedWords.length > 0) {
    observations.push({
      id: "observation-repeated-terms",
      label: "REPEATED_TERMS",
      description: `The text repeatedly mentions ${repeatedWords.slice(0, 5).join(", ")}.`,
      evidence: repeatedWords,
      confidence: confidenceFromEvidence(repeatedWords.length),
      uncertainty:
        "Repeated words may come from formatting, headings, or copied source material, so they are only weak signals.",
    });

    observations.push({
      id: "observation-major-recurring-words",
      label: "MAJOR_RECURRING_WORDS",
      description: `Major recurring words include ${repeatedWords.slice(0, 3).join(", ")}.`,
      evidence: repeatedWords.slice(0, 5),
      confidence: 0.58,
      uncertainty:
        "Recurring words can suggest emphasis, but they do not prove the purpose of the item.",
    });
  }

  const purposeMatches = findPurposeMatches(observedText);
  if (purposeMatches.length > 0) {
    const strongestMatches = purposeMatches.slice(0, 2);
    const descriptions = strongestMatches.map((match) => match.description);
    const evidence = strongestMatches.flatMap((match) =>
      match.matches.map((term) => `${match.name}: ${term}`),
    );

    observations.push({
      id: "observation-possible-purpose",
      label: "POSSIBLE_PURPOSE",
      description: `The ${subjectFor(input)} appears to include ${descriptions.join(" and ")} language.`,
      evidence,
      confidence: confidenceFromEvidence(evidence.length),
      uncertainty:
        "This is a cautious keyword observation, not a final classification or clinical conclusion.",
    });
  }

  return {
    observations,
    warnings,
  };
}
