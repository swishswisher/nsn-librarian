import type { MemoryEntry, Prisma } from "@prisma/client";

import type {
  NotebookEntry,
  NotebookEntryType,
  NotebookEvidence,
} from "@/types/library";

export type ReflectionMemoryEntry = Pick<
  MemoryEntry,
  | "id"
  | "memoryType"
  | "title"
  | "description"
  | "confidence"
  | "evidence"
  | "firstSeen"
  | "lastSeen"
  | "status"
  | "updatedAt"
  | "occurrenceCount"
>;

export type ReflectionResult = {
  mostImportantObservation: NotebookEntry | null;
  otherObservations: NotebookEntry[];
  questions: NotebookEntry[];
  learningUpdates: NotebookEntry[];
  archiveEntries: NotebookEntry[];
};

type ReflectionGroup = {
  id: string;
  type: NotebookEntryType;
  title: string;
  entries: ReflectionMemoryEntry[];
  basePriority: number;
};

function asStringArray(value: Prisma.JsonValue) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function slug(value: string) {
  return normalizeText(value).replace(/\s+/g, "-") || "untitled";
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
  }).format(value);
}

function uniqueList(values: string[], limit = 12) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(
    0,
    limit,
  );
}

function splitEvidenceList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function valuesAfterEvidenceLabel(evidence: string[], labels: string[]) {
  const normalizedLabels = labels.map((label) => label.toLowerCase());
  const values: string[] = [];

  for (const item of evidence) {
    const lowerItem = item.toLowerCase();
    const hasLabel = normalizedLabels.some((label) =>
      lowerItem.startsWith(`${label}:`),
    );

    if (!hasLabel) {
      continue;
    }

    const colonIndex = item.indexOf(":");
    const rawValue = colonIndex >= 0 ? item.slice(colonIndex + 1) : "";

    values.push(...splitEvidenceList(rawValue));
  }

  return uniqueList(values);
}

function rawEvidenceFor(entries: ReflectionMemoryEntry[]) {
  return entries.flatMap((entry) => asStringArray(entry.evidence));
}

function supportingMaterialFor(entries: ReflectionMemoryEntry[]) {
  return valuesAfterEvidenceLabel(rawEvidenceFor(entries), [
    "Approved item",
    "Approved items",
    "Related item",
    "Modified review edits",
    "Approved review notes",
  ]);
}

function conceptsFor(entries: ReflectionMemoryEntry[]) {
  const evidenceConcepts = valuesAfterEvidenceLabel(rawEvidenceFor(entries), [
    "Repeated concepts",
    "Recurring term",
    "Shared concepts",
  ]);
  const termTitles = entries
    .filter((entry) => entry.memoryType === "TERM")
    .map((entry) => entry.title);
  const themeTerms = entries
    .filter((entry) => entry.memoryType === "THEME")
    .flatMap((entry) => normalizeText(entry.title).split(/\s+/))
    .filter((term) => term.length >= 4);

  return uniqueList([...evidenceConcepts, ...termTitles, ...themeTerms], 10);
}

function reviewDecisionsFor(entries: ReflectionMemoryEntry[]) {
  return uniqueList(
    rawEvidenceFor(entries)
      .filter((item) => /review|modified|approved|rejected/i.test(item))
      .map((item) => {
        const colonIndex = item.indexOf(":");
        const value = colonIndex >= 0 ? item.slice(colonIndex + 1).trim() : item;

        if (/modified review edits/i.test(item)) {
          return `Deanne changed wording in ${value}.`;
        }

        if (/approved item/i.test(item) || /approved items/i.test(item)) {
          return `Deanne approved material including ${value}.`;
        }

        if (/rejected review/i.test(item)) {
          return `Deanne rejected review language in ${value}.`;
        }

        return item;
      }),
    8,
  );
}

function hasDuplicateSignal(entry: ReflectionMemoryEntry) {
  const haystack = normalizeText(
    [entry.title, entry.description, ...asStringArray(entry.evidence)].join(" "),
  );

  return haystack.includes("duplicate") || haystack.includes("same file");
}

function extractPreferenceTerms(title: string) {
  const match = title.match(/^Prefer "(.+)" over "(.+)"$/);

  if (!match) {
    return null;
  }

  return {
    preferred: match[1] ?? "",
    previous: match[2] ?? "",
  };
}

function maxDate(entries: ReflectionMemoryEntry[], field: "lastSeen" | "updatedAt") {
  return entries.reduce((latest, entry) => {
    const value = entry[field];

    return value > latest ? value : latest;
  }, entries[0]?.[field] ?? new Date(0));
}

function minDate(entries: ReflectionMemoryEntry[], field: "firstSeen" | "lastSeen") {
  return entries.reduce((earliest, entry) => {
    const value = entry[field];

    return value < earliest ? value : earliest;
  }, entries[0]?.[field] ?? new Date(0));
}

function totalOccurrences(entries: ReflectionMemoryEntry[]) {
  return entries.reduce((total, entry) => total + entry.occurrenceCount, 0);
}

function overlapScore(
  left: ReflectionMemoryEntry,
  right: ReflectionMemoryEntry,
) {
  const leftConcepts = new Set(conceptsFor([left]).map(normalizeText));
  const rightConcepts = new Set(conceptsFor([right]).map(normalizeText));
  const leftDocuments = new Set(supportingMaterialFor([left]).map(normalizeText));
  const rightDocuments = new Set(supportingMaterialFor([right]).map(normalizeText));
  const conceptOverlap = [...leftConcepts].filter((concept) =>
    rightConcepts.has(concept),
  ).length;
  const documentOverlap = [...leftDocuments].filter((document) =>
    rightDocuments.has(document),
  ).length;

  return conceptOverlap * 2 + documentOverlap;
}

function sortedByStrength(entries: ReflectionMemoryEntry[]) {
  return [...entries].sort(
    (left, right) =>
      right.occurrenceCount - left.occurrenceCount ||
      right.lastSeen.getTime() - left.lastSeen.getTime() ||
      left.title.localeCompare(right.title),
  );
}

function buildThemeGroups(entries: ReflectionMemoryEntry[]) {
  const themes = sortedByStrength(
    entries.filter((entry) => entry.memoryType === "THEME"),
  ).slice(0, 3);
  const terms = entries.filter((entry) => entry.memoryType === "TERM");
  const relationships = entries.filter(
    (entry) => entry.memoryType === "RELATIONSHIP" && !hasDuplicateSignal(entry),
  );

  return themes.map((theme) => {
    const relatedTerms = sortedByStrength(terms)
      .filter((term) => overlapScore(theme, term) > 0)
      .slice(0, 6);
    const relatedRelationships = sortedByStrength(relationships)
      .filter((relationship) => overlapScore(theme, relationship) > 0)
      .slice(0, 3);
    const groupEntries = uniqueEntries([theme, ...relatedTerms, ...relatedRelationships]);

    return {
      id: `reflection-theme-${slug(theme.title)}`,
      type: "GROWING_THEME" as const,
      title: theme.title,
      entries: groupEntries,
      basePriority: 80,
    };
  });
}

function buildPreferenceGroup(entries: ReflectionMemoryEntry[]) {
  const preferences = sortedByStrength(
    entries.filter((entry) => entry.memoryType === "PREFERENCE"),
  );

  if (preferences.length === 0) {
    return null;
  }

  const theme = sortedByStrength(
    entries.filter((entry) => entry.memoryType === "THEME"),
  )[0];

  return {
    id: "reflection-language-preferences",
    type: "LANGUAGE_PREFERENCE" as const,
    title: "A language preference is becoming clear",
    entries: uniqueEntries(theme ? [...preferences, theme] : preferences),
    basePriority: 72,
  };
}

function buildRelationshipGroups(entries: ReflectionMemoryEntry[]) {
  const relationships = sortedByStrength(
    entries.filter((entry) => entry.memoryType === "RELATIONSHIP"),
  );
  const duplicates = relationships.filter(hasDuplicateSignal);
  const nonDuplicateRelationships = relationships.filter(
    (entry) => !hasDuplicateSignal(entry),
  );
  const groups: ReflectionGroup[] = [];

  if (nonDuplicateRelationships.length > 0) {
    groups.push({
      id: "reflection-related-work",
      type: "POSSIBLE_RELATIONSHIP",
      title: "Several pieces may belong together",
      entries: nonDuplicateRelationships.slice(0, 8),
      basePriority: 68,
    });
  }

  if (duplicates.length > 0) {
    groups.push({
      id: "reflection-possible-duplicates",
      type: "POSSIBLE_DUPLICATE",
      title: "A few items may be describing the same thing",
      entries: duplicates.slice(0, 6),
      basePriority: 66,
    });
  }

  return groups;
}

function buildEmergingPatternGroup(entries: ReflectionMemoryEntry[]) {
  const terms = sortedByStrength(
    entries.filter((entry) => entry.memoryType === "TERM"),
  );

  if (terms.length < 2) {
    return null;
  }

  return {
    id: "reflection-emerging-patterns",
    type: "EMERGING_PATTERN" as const,
    title: "A cluster of repeated ideas is asking for attention",
    entries: terms.slice(0, 8),
    basePriority: 58,
  };
}

function buildLearningUpdateGroup(entries: ReflectionMemoryEntry[]) {
  const recentEntries = sortedByStrength(entries).slice(0, 6);

  if (recentEntries.length === 0) {
    return null;
  }

  return {
    id: "reflection-learning-update",
    type: "LEARNING_UPDATE" as const,
    title: "What I am learning from recent review",
    entries: recentEntries,
    basePriority: 42,
  };
}

function uniqueEntries(entries: ReflectionMemoryEntry[]) {
  const seen = new Set<string>();

  return entries.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }

    seen.add(entry.id);
    return true;
  });
}

function scoreGroup(group: ReflectionGroup) {
  const materialCount = supportingMaterialFor(group.entries).length;
  const conceptCount = conceptsFor(group.entries).length;
  const occurrenceWeight = Math.min(totalOccurrences(group.entries), 30);
  const varietyWeight = Math.min(group.entries.length * 4, 24);

  return (
    group.basePriority +
    occurrenceWeight +
    varietyWeight +
    Math.min(materialCount * 2, 14) +
    Math.min(conceptCount, 10)
  );
}

function whyItMattersFor(group: ReflectionGroup) {
  if (group.type === "GROWING_THEME") {
    return "This may be one of the places where separate notes, workshop material, and review decisions are starting to form a body of work.";
  }

  if (group.type === "LANGUAGE_PREFERENCE") {
    return "This matters because wording choices shape future suggestions. I should not keep offering language that Deanne repeatedly changes.";
  }

  if (group.type === "POSSIBLE_RELATIONSHIP") {
    return "This matters because reviewing connected pieces together may reveal a stronger structure than reviewing them one at a time.";
  }

  if (group.type === "POSSIBLE_DUPLICATE") {
    return "This matters because duplicated or near-duplicated material can confuse review, but nothing should be merged or removed without approval.";
  }

  if (group.type === "EMERGING_PATTERN") {
    return "This matters because repeated language can be an early signal that an idea is becoming more central.";
  }

  return "This matters because it shows what recent human review is teaching me to notice next.";
}

function bodyFor(group: ReflectionGroup) {
  const concepts = conceptsFor(group.entries).slice(0, 4);
  const conceptPhrase =
    concepts.length > 0 ? concepts.join(", ") : "a few repeated ideas";

  if (group.type === "GROWING_THEME") {
    return `I've been seeing ${group.title} gather around ${conceptPhrase}. Something about this thread keeps returning across approved material, so I am holding it as one larger reflection rather than several small notes.`;
  }

  if (group.type === "LANGUAGE_PREFERENCE") {
    const preference = group.entries
      .map((entry) => extractPreferenceTerms(entry.title))
      .find((item): item is { preferred: string; previous: string } => item !== null);

    if (preference) {
      return `I noticed Deanne repeatedly favoring "${preference.preferred}" over "${preference.previous}." I will treat that as a writing preference to keep visible before I make future suggestions.`;
    }

    return "I noticed repeated edits to wording. I am keeping those edits together because they may show how Deanne wants the language to evolve.";
  }

  if (group.type === "POSSIBLE_RELATIONSHIP") {
    return `Several pieces seem to be leaning toward the same body of work around ${conceptPhrase}. I am not organizing them; I am only suggesting that they may deserve to be reviewed together.`;
  }

  if (group.type === "POSSIBLE_DUPLICATE") {
    return "Something caught my attention: a few items may be repeating the same idea or source. I am not treating them as duplicates yet; I am waiting for human review.";
  }

  if (group.type === "EMERGING_PATTERN") {
    return `I've been seeing ${conceptPhrase} more often. It may be too early to name the larger idea, but the repetition is now strong enough to watch.`;
  }

  return "I noticed recent review activity changing what I should pay attention to. I am keeping this as a learning update rather than a conclusion.";
}

function titleFor(group: ReflectionGroup) {
  if (group.type === "GROWING_THEME") {
    return `I keep returning to ${group.title}`;
  }

  return group.title;
}

function evidenceFor(group: ReflectionGroup): NotebookEvidence {
  const concepts = conceptsFor(group.entries);
  const supportingMaterial = supportingMaterialFor(group.entries);
  const firstSeen = minDate(group.entries, "firstSeen");
  const lastSeen = maxDate(group.entries, "lastSeen");
  const updatedAt = maxDate(group.entries, "updatedAt");
  const earlierObservations = uniqueList(
    group.entries.map((entry) => {
      if (entry.memoryType === "TERM") {
        return `I have seen "${entry.title}" recur in approved material.`;
      }

      if (entry.memoryType === "THEME") {
        return entry.description;
      }

      if (entry.memoryType === "RELATIONSHIP") {
        return `I noticed a possible connection around ${entry.title.toLowerCase()}.`;
      }

      if (entry.memoryType === "PREFERENCE") {
        return `I noticed repeated wording edits: ${entry.title}.`;
      }

      return entry.description;
    }),
    8,
  );

  return {
    whyINoticedThis: uniqueList(
      [
        concepts.length > 0
          ? `The same ideas keep returning: ${concepts.slice(0, 6).join(", ")}.`
          : "",
        supportingMaterial.length > 1
          ? `The pattern appears across more than one piece of approved material.`
          : "",
        group.entries.length > 1
          ? `I combined related remembered signals into one reflection so the Notebook does not repeat itself.`
          : "",
      ],
      6,
    ),
    supportingMaterial,
    earlierObservations,
    reviewDecisions: reviewDecisionsFor(group.entries),
    timeline: [
      `First noticed: ${formatDate(firstSeen)}`,
      `Most recently noticed: ${formatDate(lastSeen)}`,
      `Reflection updated: ${formatDate(updatedAt)}`,
    ],
  };
}

function historyFor(group: ReflectionGroup) {
  const firstSeen = minDate(group.entries, "firstSeen");
  const lastSeen = maxDate(group.entries, "lastSeen");

  return uniqueList([
    `This reflection began from material first noticed on ${formatDate(firstSeen)}.`,
    `It now draws from ${group.entries.length} related signal${
      group.entries.length === 1 ? "" : "s"
    } and ${supportingMaterialFor(group.entries).length} supporting piece${
      supportingMaterialFor(group.entries).length === 1 ? "" : "s"
    }.`,
    `It most recently changed on ${formatDate(lastSeen)}.`,
  ]);
}

function entryFromGroup(group: ReflectionGroup): NotebookEntry {
  const priority = scoreGroup(group);
  const updatedAt = maxDate(group.entries, "updatedAt");
  const supportingMaterial = supportingMaterialFor(group.entries);
  const reviewDecisions = reviewDecisionsFor(group.entries);

  return {
    id: group.id,
    type: group.type,
    title: titleFor(group),
    body: bodyFor(group),
    whyItMatters: whyItMattersFor(group),
    createdAt: minDate(group.entries, "firstSeen").toISOString(),
    updatedAt: updatedAt.toISOString(),
    priority,
    history: historyFor(group),
    evidence: evidenceFor({ ...group, entries: sortedByStrength(group.entries) }),
    archiveStatus: "CURRENT",
    relatedDocuments: supportingMaterial,
    humanDecisions: reviewDecisions,
  };
}

function questionFromGroup(group: ReflectionGroup): NotebookEntry | null {
  if (group.type === "LANGUAGE_PREFERENCE") {
    const preference = group.entries
      .map((entry) => extractPreferenceTerms(entry.title))
      .find((item): item is { preferred: string; previous: string } => item !== null);

    if (!preference) {
      return null;
    }

    return {
      ...entryFromGroup(group),
      id: `${group.id}-question`,
      type: "QUESTION",
      title: "I have a wording question",
      body: `I wonder if "${preference.preferred}" should become the wording I use when I suggest language in this area.`,
      whyItMatters:
        "Answering this would help me suggest language closer to Deanne's decisions without assuming final authority.",
      priority: scoreGroup(group) - 6,
    };
  }

  if (group.type === "POSSIBLE_RELATIONSHIP") {
    return {
      ...entryFromGroup(group),
      id: `${group.id}-question`,
      type: "QUESTION",
      title: "Should these be reviewed together?",
      body: "I noticed these pieces appear related. Would you like to review them as one group before deciding what they are?",
      whyItMatters:
        "Reviewing them together may reveal whether they are separate notes, a sequence, or one larger body of work.",
      priority: scoreGroup(group) - 4,
    };
  }

  if (group.type === "GROWING_THEME") {
    return {
      ...entryFromGroup(group),
      id: `${group.id}-question`,
      type: "QUESTION",
      title: "Is this becoming a central thread?",
      body: `I wonder if ${group.title} is becoming a central thread in the library, or if I should keep watching quietly.`,
      whyItMatters:
        "A human answer would keep me from overstating the importance of a pattern.",
      priority: scoreGroup(group) - 12,
    };
  }

  return null;
}

function buildReflectionGroups(entries: ReflectionMemoryEntry[]) {
  const groups: ReflectionGroup[] = [
    ...buildThemeGroups(entries),
    ...buildRelationshipGroups(entries),
  ];
  const preferenceGroup = buildPreferenceGroup(entries);
  const patternGroup = buildEmergingPatternGroup(entries);
  const learningGroup = buildLearningUpdateGroup(entries);

  if (preferenceGroup) {
    groups.push(preferenceGroup);
  }

  if (patternGroup) {
    groups.push(patternGroup);
  }

  if (learningGroup) {
    groups.push(learningGroup);
  }

  return groups
    .filter((group) => group.entries.length > 0)
    .sort((left, right) => scoreGroup(right) - scoreGroup(left));
}

function archiveTypeFor(entry: ReflectionMemoryEntry): NotebookEntryType {
  if (entry.memoryType === "THEME") {
    return "GROWING_THEME";
  }

  if (entry.memoryType === "PREFERENCE") {
    return "LANGUAGE_PREFERENCE";
  }

  if (entry.memoryType === "RELATIONSHIP") {
    return hasDuplicateSignal(entry) ? "POSSIBLE_DUPLICATE" : "POSSIBLE_RELATIONSHIP";
  }

  if (entry.memoryType === "TERM") {
    return "EMERGING_PATTERN";
  }

  return "REFLECTION";
}

function archiveBodyFor(entry: ReflectionMemoryEntry) {
  if (entry.status === "ARCHIVED") {
    return `I am keeping this older note accessible: ${entry.description}`;
  }

  return `I previously noticed this pattern: ${entry.description}`;
}

function archiveWhyItMattersFor(entry: ReflectionMemoryEntry) {
  if (entry.status === "ARCHIVED") {
    return "This remains available for history, but it should not be treated as a current priority unless Deanne brings it back.";
  }

  if (entry.memoryType === "PREFERENCE") {
    return "This may help future suggestions respect wording Deanne has already reviewed.";
  }

  if (entry.memoryType === "RELATIONSHIP") {
    return "This may help Deanne revisit related material without losing the earlier trail.";
  }

  if (entry.memoryType === "NOTE") {
    return "This note remains available so earlier context is not lost.";
  }

  return "This remains available because older observations can still support newer reflections.";
}

function archiveEntryFromMemoryEntry(entry: ReflectionMemoryEntry): NotebookEntry {
  const supportingMaterial = supportingMaterialFor([entry]);
  const reviewDecisions = reviewDecisionsFor([entry]);
  const group: ReflectionGroup = {
    id: `notebook-archive-${entry.id}`,
    type: archiveTypeFor(entry),
    title: entry.title,
    entries: [entry],
    basePriority: 20,
  };

  return {
    id: group.id,
    type: group.type,
    title: entry.title,
    body: archiveBodyFor(entry),
    whyItMatters: archiveWhyItMattersFor(entry),
    createdAt: entry.firstSeen.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    priority: scoreGroup(group),
    history: historyFor(group),
    evidence: evidenceFor(group),
    archiveStatus: entry.status === "ARCHIVED" ? "ARCHIVED" : "CURRENT",
    relatedDocuments: supportingMaterial,
    humanDecisions: reviewDecisions,
  };
}

function archiveEntriesFor(entries: ReflectionMemoryEntry[]) {
  return [...entries]
    .sort(
      (left, right) =>
        right.lastSeen.getTime() - left.lastSeen.getTime() ||
        right.updatedAt.getTime() - left.updatedAt.getTime() ||
        left.title.localeCompare(right.title),
    )
    .map(archiveEntryFromMemoryEntry);
}

export function createNotebookReflections(
  entries: ReflectionMemoryEntry[],
): ReflectionResult {
  const groups = buildReflectionGroups(entries);
  const observationEntries = groups
    .filter((group) => group.type !== "LEARNING_UPDATE")
    .map(entryFromGroup)
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 6);
  const learningUpdates = groups
    .filter((group) => group.type === "LEARNING_UPDATE")
    .map(entryFromGroup)
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 3);
  const questions = groups
    .map(questionFromGroup)
    .filter((entry): entry is NotebookEntry => entry !== null)
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 3);
  const [mostImportantObservation = null, ...otherObservations] =
    observationEntries;

  return {
    mostImportantObservation,
    otherObservations,
    questions,
    learningUpdates,
    archiveEntries: archiveEntriesFor(entries),
  };
}
