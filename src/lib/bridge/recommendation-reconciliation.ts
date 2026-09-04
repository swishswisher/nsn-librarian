import path from "node:path";

import type { OrganizationSuggestionType } from "./types";

export type RecommendationAlternative = {
  confidence: number;
  explanation: string;
  proposedFileName: string | null;
  proposedRelativePath: string | null;
  requiredFolderPaths: string[];
  suggestionType: OrganizationSuggestionType;
  title: string;
};

export type RecommendationDuplicateMatch = {
  connectedLibraryName: string;
  relativePath: string;
  signals: string[];
};

export type RecommendationDraft = {
  alternatives: RecommendationAlternative[];
  confidence: number;
  duplicateEvidence: RecommendationDuplicateMatch[];
  explanation: string;
  proposedFileName?: string | null;
  proposedRelativePath?: string | null;
  requiredFolderPaths: string[];
  suggestionType: OrganizationSuggestionType;
  supportingInformation: string[];
  title: string;
  whySuggested: string[];
};

export type RecommendationSupport = {
  alternatives: RecommendationAlternative[];
  details: string[];
  duplicateEvidence: RecommendationDuplicateMatch[];
  requiredFolderPaths: string[];
};

const locationSuggestionTypes = new Set<OrganizationSuggestionType>([
  "GROUP_WITH_FILES",
  "MOVE_FILE",
]);

const organizationSuggestionTypes = new Set<OrganizationSuggestionType>([
  "MOVE_FILE",
  "RENAME_FILE",
  "CREATE_FOLDER",
  "GROUP_WITH_FILES",
  "POSSIBLE_DUPLICATE",
  "WEBSITE_CANDIDATE",
  "KEEP_UNCHANGED",
]);

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedPathKey(value: string | null | undefined) {
  const normalized = path.posix
    .normalize((value ?? "").trim().replace(/\\/g, "/"))
    .replace(/^\.\//, "")
    .replace(/\/$/, "");

  return normalized === "." ? "" : normalized.toLowerCase();
}

function folderFromRelativePath(relativePath: string) {
  const folder = path.posix.dirname(relativePath);

  return folder === "." ? "" : folder;
}

function effectiveDestination(
  currentRelativePath: string,
  draft: RecommendationDraft,
) {
  if (draft.proposedRelativePath) {
    return draft.proposedRelativePath;
  }

  if (draft.proposedFileName) {
    const currentFolder = folderFromRelativePath(currentRelativePath);

    return currentFolder
      ? path.posix.join(currentFolder, draft.proposedFileName)
      : draft.proposedFileName;
  }

  return null;
}

function isNoOpFileChange(
  currentRelativePath: string,
  draft: RecommendationDraft,
) {
  if (
    draft.suggestionType !== "MOVE_FILE" &&
    draft.suggestionType !== "GROUP_WITH_FILES" &&
    draft.suggestionType !== "RENAME_FILE"
  ) {
    return false;
  }

  const destination = effectiveDestination(currentRelativePath, draft);

  return (
    destination === null ||
    normalizedPathKey(destination) === normalizedPathKey(currentRelativePath)
  );
}

function sortDrafts(drafts: RecommendationDraft[]) {
  return [...drafts].sort(
    (left, right) =>
      right.confidence - left.confidence ||
      left.title.localeCompare(right.title) ||
      (left.proposedRelativePath ?? "").localeCompare(
        right.proposedRelativePath ?? "",
      ),
  );
}

function alternativeFromDraft(
  draft: RecommendationDraft,
  requiredFolderPaths: string[],
): RecommendationAlternative {
  return {
    confidence: draft.confidence,
    explanation: draft.explanation,
    proposedFileName: draft.proposedFileName ?? null,
    proposedRelativePath: draft.proposedRelativePath ?? null,
    requiredFolderPaths,
    suggestionType: draft.suggestionType,
    title: draft.title,
  };
}

function requiredFoldersFor(
  currentRelativePath: string,
  draft: RecommendationDraft,
  createFolderDrafts: RecommendationDraft[],
) {
  const destination = effectiveDestination(currentRelativePath, draft);

  if (!destination) {
    return uniqueStrings(draft.requiredFolderPaths);
  }

  const destinationFolder = folderFromRelativePath(destination);
  const matchingFolders = createFolderDrafts
    .map((candidate) => candidate.proposedRelativePath ?? "")
    .filter(
      (folder) =>
        folder &&
        normalizedPathKey(folder) === normalizedPathKey(destinationFolder),
    );

  return uniqueStrings([...draft.requiredFolderPaths, ...matchingFolders]);
}

function combineMoveAndRename(
  currentRelativePath: string,
  location: RecommendationDraft,
  rename: RecommendationDraft,
) {
  const locationPath = effectiveDestination(currentRelativePath, location);
  const proposedFileName = rename.proposedFileName;

  if (!locationPath || !proposedFileName) {
    return location;
  }

  const destinationFolder = folderFromRelativePath(locationPath);
  const proposedRelativePath = destinationFolder
    ? path.posix.join(destinationFolder, proposedFileName)
    : proposedFileName;

  return {
    ...location,
    confidence: Math.max(location.confidence, rename.confidence),
    explanation: `${location.explanation} The current filename also appears generic, so the same reviewed change can use the clearer name ${proposedFileName}.`,
    proposedFileName,
    proposedRelativePath,
    supportingInformation: uniqueStrings([
      ...location.supportingInformation,
      ...rename.supportingInformation,
      "The folder and filename changes are presented as one decision.",
    ]),
    title: "Consider moving and renaming this file",
    whySuggested: uniqueStrings([
      ...location.whySuggested,
      ...rename.whySuggested,
    ]),
  } satisfies RecommendationDraft;
}

function duplicateEvidenceStrength(matches: RecommendationDuplicateMatch[]) {
  const signals = matches
    .flatMap((match) => match.signals)
    .join(" ")
    .toLowerCase();

  if (/exact (?:content|checksum|hash)|same checksum/.test(signals)) {
    return "EXACT" as const;
  }

  if (/matching (?:audio|video|image|media|visual)? ?fingerprint/.test(signals)) {
    return "STRONG" as const;
  }

  if (
    (/matching (?:file )?size/.test(signals) && /filename|name/.test(signals)) ||
    (/duration/.test(signals) && /filename|name|dimensions|resolution/.test(signals))
  ) {
    return "MEDIUM" as const;
  }

  return "WEAK" as const;
}

export function calibratedDuplicateConfidence(
  proposedConfidence: number,
  matches: RecommendationDuplicateMatch[],
) {
  const strength = duplicateEvidenceStrength(matches);

  if (strength === "EXACT") {
    return 0.98;
  }

  if (strength === "STRONG") {
    return Math.min(Math.max(proposedConfidence, 0.72), 0.82);
  }

  if (strength === "MEDIUM") {
    return Math.min(proposedConfidence, 0.65);
  }

  return Math.min(proposedConfidence, 0.52);
}

function reconcileDuplicates(drafts: RecommendationDraft[]) {
  const concrete = drafts
    .map((draft) => ({
      ...draft,
      duplicateEvidence: draft.duplicateEvidence.filter(
        (match) =>
          Boolean(match.relativePath.trim()) && match.signals.length > 0,
      ),
    }))
    .filter((draft) => draft.duplicateEvidence.length > 0)
    .map((draft) => ({
      ...draft,
      confidence: calibratedDuplicateConfidence(
        draft.confidence,
        draft.duplicateEvidence,
      ),
    }));

  if (concrete.length === 0) {
    return null;
  }

  const strongest = sortDrafts(concrete)[0];

  if (!strongest) {
    return null;
  }

  const matches = new Map<string, RecommendationDuplicateMatch>();

  for (const draft of concrete) {
    for (const match of draft.duplicateEvidence) {
      const key = `${match.connectedLibraryName.toLowerCase()}\u001f${normalizedPathKey(
        match.relativePath,
      )}`;
      const existing = matches.get(key);

      matches.set(key, {
        connectedLibraryName: match.connectedLibraryName,
        relativePath: match.relativePath,
        signals: uniqueStrings([
          ...(existing?.signals ?? []),
          ...match.signals,
        ]),
      });
    }
  }

  const duplicateEvidence = [...matches.values()];

  return {
    ...strongest,
    confidence: calibratedDuplicateConfidence(
      strongest.confidence,
      duplicateEvidence,
    ),
    duplicateEvidence,
    supportingInformation: uniqueStrings(
      concrete.flatMap((draft) => draft.supportingInformation),
    ),
  } satisfies RecommendationDraft;
}

function uniqueDrafts(drafts: RecommendationDraft[]) {
  const seen = new Set<string>();

  return drafts.filter((draft) => {
    const key = [
      draft.suggestionType,
      normalizedPathKey(draft.proposedRelativePath),
      (draft.proposedFileName ?? "").trim().toLowerCase(),
      draft.title.trim().toLowerCase(),
    ].join("\u001f");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export function reconcileRecommendationDrafts(
  currentRelativePath: string,
  drafts: RecommendationDraft[],
) {
  const viable = uniqueDrafts(
    drafts.filter((draft) => !isNoOpFileChange(currentRelativePath, draft)),
  );
  const createFolderDrafts = viable.filter(
    (draft) => draft.suggestionType === "CREATE_FOLDER",
  );
  const locationDrafts = sortDrafts(
    viable.filter((draft) => locationSuggestionTypes.has(draft.suggestionType)),
  );
  const renameDrafts = sortDrafts(
    viable.filter((draft) => draft.suggestionType === "RENAME_FILE"),
  );
  const duplicate = reconcileDuplicates(
    viable.filter((draft) => draft.suggestionType === "POSSIBLE_DUPLICATE"),
  );
  const website = sortDrafts(
    viable.filter((draft) => draft.suggestionType === "WEBSITE_CANDIDATE"),
  )[0];
  const keep = sortDrafts(
    viable.filter((draft) => draft.suggestionType === "KEEP_UNCHANGED"),
  )[0];
  const primaryLocation = locationDrafts[0];
  const primaryRename = renameDrafts[0];
  let primary = primaryLocation ?? primaryRename ?? null;

  if (primaryLocation && primaryRename) {
    primary = combineMoveAndRename(
      currentRelativePath,
      primaryLocation,
      primaryRename,
    );
  }

  if (primary) {
    const primaryDestination = effectiveDestination(currentRelativePath, primary);
    const closeAlternatives = locationDrafts
      .slice(1)
      .filter(
        (candidate) =>
          primary!.confidence - candidate.confidence <= 0.1 &&
          normalizedPathKey(effectiveDestination(currentRelativePath, candidate)) !==
            normalizedPathKey(primaryDestination),
      )
      .map((candidate) =>
        alternativeFromDraft(
          candidate,
          requiredFoldersFor(
            currentRelativePath,
            candidate,
            createFolderDrafts,
          ),
        ),
      );
    const requiredFolderPaths = requiredFoldersFor(
      currentRelativePath,
      primary,
      createFolderDrafts,
    );

    primary = {
      ...primary,
      alternatives: [...primary.alternatives, ...closeAlternatives],
      explanation:
        closeAlternatives.length > 0
          ? `${primary.explanation} Other plausible destinations are shown as alternatives to this same decision.`
          : primary.explanation,
      requiredFolderPaths,
      supportingInformation: uniqueStrings([
        ...primary.supportingInformation,
        ...requiredFolderPaths.map(
          (folder) =>
            `Required folder if approved: ${folder}. This is not a separate approval; the plan will create it only as a dependency of this file change.`,
        ),
      ]),
    };
  }

  const reconciled = [duplicate, primary, website].filter(
    (draft): draft is RecommendationDraft => Boolean(draft),
  );

  if (reconciled.length === 0 && keep) {
    reconciled.push(keep);
  }

  return sortDrafts(reconciled);
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function alternativeArray(value: unknown): RecommendationAlternative[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const candidate = item as Record<string, unknown>;

    if (
      typeof candidate.title !== "string" ||
      typeof candidate.explanation !== "string" ||
      typeof candidate.confidence !== "number" ||
      typeof candidate.suggestionType !== "string" ||
      !organizationSuggestionTypes.has(
        candidate.suggestionType as OrganizationSuggestionType,
      )
    ) {
      return [];
    }

    return [
      {
        confidence: candidate.confidence,
        explanation: candidate.explanation,
        proposedFileName:
          typeof candidate.proposedFileName === "string"
            ? candidate.proposedFileName
            : null,
        proposedRelativePath:
          typeof candidate.proposedRelativePath === "string"
            ? candidate.proposedRelativePath
            : null,
        requiredFolderPaths: stringArray(candidate.requiredFolderPaths),
        suggestionType: candidate.suggestionType as OrganizationSuggestionType,
        title: candidate.title,
      },
    ];
  });
}

function duplicateMatchArray(value: unknown): RecommendationDuplicateMatch[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const candidate = item as Record<string, unknown>;

    if (
      typeof candidate.connectedLibraryName !== "string" ||
      typeof candidate.relativePath !== "string"
    ) {
      return [];
    }

    return [
      {
        connectedLibraryName: candidate.connectedLibraryName,
        relativePath: candidate.relativePath,
        signals: stringArray(candidate.signals),
      },
    ];
  });
}

export function recommendationSupportFromJson(
  value: unknown,
): RecommendationSupport {
  if (Array.isArray(value)) {
    return {
      alternatives: [],
      details: stringArray(value),
      duplicateEvidence: [],
      requiredFolderPaths: [],
    };
  }

  if (!value || typeof value !== "object") {
    return {
      alternatives: [],
      details: [],
      duplicateEvidence: [],
      requiredFolderPaths: [],
    };
  }

  const support = value as Record<string, unknown>;

  return {
    alternatives: alternativeArray(support.alternatives),
    details: stringArray(support.details),
    duplicateEvidence: duplicateMatchArray(support.duplicateEvidence),
    requiredFolderPaths: stringArray(support.requiredFolderPaths),
  };
}

export function recommendationSupportForStorage(
  draft: Pick<
    RecommendationDraft,
    | "alternatives"
    | "duplicateEvidence"
    | "requiredFolderPaths"
    | "supportingInformation"
  >,
) {
  return {
    alternatives: draft.alternatives,
    details: draft.supportingInformation,
    duplicateEvidence: draft.duplicateEvidence,
    requiredFolderPaths: draft.requiredFolderPaths,
    version: 1,
  };
}
