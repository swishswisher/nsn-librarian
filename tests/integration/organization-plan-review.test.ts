import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  actionCanBeChosen,
  chooseActionForSource,
  organizationPlanDecisionGroups,
  organizationPlanDownload,
  organizationPlanLiveSummary,
} from "../../src/lib/bridge/organization-plan-review";
import { currentRecommendationGenerationVersion } from "../../src/lib/bridge/recommendation-generation";
import {
  calibratedDuplicateConfidence,
  reconcileRecommendationDrafts,
  recommendationSupportFromJson,
  type RecommendationDraft,
} from "../../src/lib/bridge/recommendation-reconciliation";
import type {
  BridgeOrganizationPlan,
  BridgeOrganizationPlanAction,
  OrganizationSuggestionType,
  OrganizationPlanActionType,
} from "../../src/lib/bridge/types";

function action(input: {
  actionType?: OrganizationPlanActionType;
  id: string;
  plannedRelativePath?: string | null;
  requiredFolderPaths?: string[];
  selectedForExecution?: boolean;
  sourceRelativePath: string;
}): BridgeOrganizationPlanAction {
  return {
    actionType: input.actionType ?? "MOVE_FILE",
    confidence: 0.63,
    evidence: {
      approvedMemory: [],
      approvedObservation: [],
      humanModification: [],
      originatingSuggestion: [],
    },
    humanEdits: [],
    id: input.id,
    order: 1,
    originatingSuggestion: {
      explanation: "The recording is about a workshop.",
      status: "APPROVED",
      title: "Move workshop recording",
    },
    plannedFileName: "Workshop_Voice_Memo.m4a",
    plannedFolderPath: input.plannedRelativePath
      ?.split("/")
      .slice(0, -1)
      .join("/") ?? null,
    plannedRelativePath: input.plannedRelativePath ?? null,
    recommendationGenerationId: "test-generation",
    recommendationGenerationVersion: currentRecommendationGenerationVersion,
    reason:
      "This is an audio recording about a workshop, so it may belong with other workshop recordings.",
    requiredFolderPaths: input.requiredFolderPaths ?? [],
    selectedForExecution: input.selectedForExecution ?? false,
    sourceRelativePath: input.sourceRelativePath,
    suggestionId: `suggestion-${input.id}`,
    suggestionType: "MOVE_FILE",
  };
}

const source = "Workshops_Unsorted/Workshop_Voice_Memo.m4a";

function recommendationDraft(input: {
  confidence?: number;
  duplicateEvidence?: RecommendationDraft["duplicateEvidence"];
  proposedFileName?: string | null;
  proposedRelativePath?: string | null;
  suggestionType: OrganizationSuggestionType;
  title?: string;
}): RecommendationDraft {
  return {
    alternatives: [],
    confidence: input.confidence ?? 0.7,
    duplicateEvidence: input.duplicateEvidence ?? [],
    explanation: `Review ${input.title ?? input.suggestionType.toLowerCase()}.`,
    proposedFileName: input.proposedFileName ?? null,
    proposedRelativePath: input.proposedRelativePath ?? null,
    requiredFolderPaths: [],
    suggestionType: input.suggestionType,
    supportingInformation: ["Evidence available for human review."],
    title: input.title ?? input.suggestionType,
    whySuggested: ["The visible evidence supports reviewing this option."],
  };
}

test("the page explains that choices do not move files and exposes the required process", async () => {
  const sourceText = await readFile(
    "src/components/library/OrganizationPlanReviewPanel.tsx",
    "utf8",
  );

  assert.match(sourceText, /Choose which changes to include/);
  assert.match(sourceText, /Nothing will move yet/);
  assert.match(sourceText, /Choose file destinations/);
  assert.match(sourceText, /Save choices/);
  assert.match(sourceText, /Review final plan/);
  assert.match(sourceText, /Authorize execution/);
  assert.match(sourceText, /type="radio"/);
  assert.doesNotMatch(sourceText, /type="checkbox"/);
});

test("two destinations for one source become one mutually exclusive group with keep as the default", () => {
  const actions = [
    action({
      id: "audio-workshops",
      plannedRelativePath: "Audio/Workshops/Workshop_Voice_Memo.m4a",
      sourceRelativePath: source,
    }),
    action({
      id: "workshop",
      plannedRelativePath: "Workshop/Workshop_Voice_Memo.m4a",
      sourceRelativePath: source,
    }),
  ];
  const groups = organizationPlanDecisionGroups(actions);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.actions.length, 2);
  assert.deepEqual(chooseActionForSource([], actions, source, null), []);

  const firstChoice = chooseActionForSource([], actions, source, actions[0]!.id);
  const secondChoice = chooseActionForSource(
    firstChoice,
    actions,
    source,
    actions[1]!.id,
  );

  assert.deepEqual(firstChoice, [actions[0]!.id]);
  assert.deepEqual(secondChoice, [actions[1]!.id]);
});

test("folder dependencies and live safety counts follow the current destination", () => {
  const actions = [
    action({
      id: "audio-workshops",
      plannedRelativePath: "Audio/Workshops/Workshop_Voice_Memo.m4a",
      requiredFolderPaths: ["Audio", "Audio/Workshops"],
      sourceRelativePath: source,
    }),
    action({
      actionType: "MOVE_AND_RENAME_FILE",
      id: "operations",
      plannedRelativePath: "Operations/workshop-note.m4a",
      requiredFolderPaths: ["Operations"],
      sourceRelativePath: "Loose/voice-note.m4a",
    }),
  ];

  assert.deepEqual(organizationPlanLiveSummary(actions, []), {
    filesDeleted: 0,
    filesMoved: 0,
    filesOverwritten: 0,
    filesRenamed: 0,
    folderPaths: [],
    foldersCreated: 0,
  });
  assert.deepEqual(
    organizationPlanLiveSummary(actions, actions.map((item) => item.id)),
    {
      filesDeleted: 0,
      filesMoved: 2,
      filesOverwritten: 0,
      filesRenamed: 1,
      folderPaths: ["Audio", "Audio/Workshops", "Operations"],
      foldersCreated: 3,
    },
  );
});

test("review-only items cannot become choices and exported JSON contains only shown saved choices", () => {
  const chosen = action({
    id: "chosen",
    plannedRelativePath: "Audio/Workshops/Workshop_Voice_Memo.m4a",
    selectedForExecution: true,
    sourceRelativePath: source,
  });
  const unselected = action({
    id: "not-chosen",
    plannedRelativePath: "Workshop/Workshop_Voice_Memo.m4a",
    sourceRelativePath: source,
  });
  const reviewOnly = action({
    actionType: "REVIEW_ONLY",
    id: "review-only",
    plannedRelativePath: null,
    sourceRelativePath: "Duplicates/copy.txt",
  });
  const plan = {
    actions: [chosen, unselected, reviewOnly],
    approvedActions: 2,
    connectedLibraryId: "library",
    createdAt: "2026-09-01T00:00:00.000Z",
    createdBy: "NSN Librarian",
    history: [],
    id: "plan",
    modifiedActions: 0,
    rejectedActions: 0,
    scanSessionId: "session",
    skippedItems: [],
    status: "DRAFT",
    summary: {
      blockingWarnings: 0,
      estimatedOperations: 1,
      filesAffected: 1,
      foldersAffected: 1,
      moves: 1,
      newFolders: 0,
      renames: 0,
      requiredFolderCreations: 0,
      reviewOnlyNotes: 1,
      selectableFileActions: 2,
      selectedFileActions: 1,
      unselectedAlternatives: 1,
      warnings: 0,
    },
    totalActions: 3,
    unchangedActions: 0,
    updatedAt: "2026-09-01T00:00:00.000Z",
    warnings: [],
  } satisfies BridgeOrganizationPlan;

  assert.equal(actionCanBeChosen(reviewOnly), false);
  assert.deepEqual(
    organizationPlanDecisionGroups(plan.actions).flatMap((group) =>
      group.actions.map((item) => item.id),
    ),
    ["chosen", "not-chosen"],
  );

  const download = organizationPlanDownload(
    plan,
    "2026-09-01T01:00:00.000Z",
  );

  assert.deepEqual(download.plan.actions.map((item) => item.id), ["chosen"]);
  assert.deepEqual(
    download.executable.selectedFileActions.map((item) => item.id),
    ["chosen"],
  );
  assert.deepEqual(
    download.nonExecutable.alternatives.map((item) => item.id),
    ["not-chosen"],
  );
  assert.deepEqual(
    download.nonExecutable.reviewOnlyNotes.map((item) => item.id),
    ["review-only"],
  );
  assert.equal(download.plan.summary.reviewOnlyNotes, 1);
  assert.equal(download.plan.totalActions, 1);
  assert.equal(download.totals.estimatedOperations, 1);
  assert.equal(download.totals.unselectedAlternatives, 1);
  assert.equal(download.safety.executionAllowed, false);
});

test("recommendation reconciliation rejects exact and normalized no-op destinations", () => {
  const currentPath = "Damaged/broken-audio.mp3";
  const reconciled = reconcileRecommendationDrafts(currentPath, [
    recommendationDraft({
      proposedRelativePath: currentPath,
      suggestionType: "MOVE_FILE",
    }),
    recommendationDraft({
      proposedRelativePath: ".\\DAMAGED\\broken-audio.mp3\\",
      suggestionType: "GROUP_WITH_FILES",
    }),
    recommendationDraft({
      confidence: 0.5,
      suggestionType: "KEEP_UNCHANGED",
    }),
  ]);

  assert.deepEqual(
    reconciled.map((draft) => draft.suggestionType),
    ["KEEP_UNCHANGED"],
  );
});

test("competing destinations become alternatives within one organization decision", () => {
  const reconciled = reconcileRecommendationDrafts(
    "Clients/Loose/Alice_Client_Intake.docx",
    [
      recommendationDraft({
        confidence: 0.74,
        proposedRelativePath: "Clinical Tools/Alice_Client_Intake.docx",
        suggestionType: "MOVE_FILE",
        title: "Place with clinical tools",
      }),
      recommendationDraft({
        confidence: 0.69,
        proposedRelativePath: "Alice/Alice_Client_Intake.docx",
        suggestionType: "GROUP_WITH_FILES",
        title: "Place with Alice files",
      }),
    ],
  );

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.suggestionType, "MOVE_FILE");
  assert.equal(
    reconciled[0]?.proposedRelativePath,
    "Clinical Tools/Alice_Client_Intake.docx",
  );
  assert.deepEqual(
    reconciled[0]?.alternatives.map((alternative) => ({
      path: alternative.proposedRelativePath,
      type: alternative.suggestionType,
    })),
    [{ path: "Alice/Alice_Client_Intake.docx", type: "GROUP_WITH_FILES" }],
  );
});

test("a required folder and its move are represented as one decision", () => {
  const reconciled = reconcileRecommendationDrafts(
    "Clients/Loose/Alice_Client_Intake.docx",
    [
      recommendationDraft({
        confidence: 0.64,
        proposedRelativePath: "Clinical Tools",
        suggestionType: "CREATE_FOLDER",
      }),
      recommendationDraft({
        confidence: 0.78,
        proposedRelativePath: "Clinical Tools/Alice_Client_Intake.docx",
        suggestionType: "MOVE_FILE",
      }),
    ],
  );

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.suggestionType, "MOVE_FILE");
  assert.deepEqual(reconciled[0]?.requiredFolderPaths, ["Clinical Tools"]);
  assert.match(
    reconciled[0]?.supportingInformation.join(" ") ?? "",
    /not a separate approval/i,
  );
});

test("duplicate recommendations retain a named counterpart and concrete evidence", () => {
  const duplicateEvidence = [
    {
      connectedLibraryName: "Root B",
      relativePath: "Archive/Alice_Client_Intake-copy.docx",
      signals: [
        "Exact content match: the non-empty files have the same checksum.",
        "Matching file size: 4321 bytes.",
      ],
    },
  ];
  const [duplicate] = reconcileRecommendationDrafts(
    "Clients/Loose/Alice_Client_Intake.docx",
    [
      recommendationDraft({
        confidence: 0.95,
        duplicateEvidence,
        suggestionType: "POSSIBLE_DUPLICATE",
      }),
    ],
  );

  assert.equal(duplicate?.confidence, 0.98);
  assert.deepEqual(duplicate?.duplicateEvidence, duplicateEvidence);
  assert.equal(
    duplicate?.duplicateEvidence[0]?.relativePath,
    "Archive/Alice_Client_Intake-copy.docx",
  );
});

test("unsupported duplicate claims are removed or capped at cautious confidence", () => {
  const withoutCounterpart = reconcileRecommendationDrafts("Damaged/item.mp4", [
    recommendationDraft({
      confidence: 0.95,
      suggestionType: "POSSIBLE_DUPLICATE",
    }),
  ]);
  const weakEvidence = [
    {
      connectedLibraryName: "Root A",
      relativePath: "Damaged/item-copy.mp4",
      signals: ["Filename resembles the current file."],
    },
  ];

  assert.deepEqual(withoutCounterpart, []);
  assert.equal(calibratedDuplicateConfidence(0.95, weakEvidence), 0.52);
});

test("audio and video duplicate confidence follows the evidence strength", () => {
  const audioEvidence = [
    {
      connectedLibraryName: "Root A",
      relativePath: "Audio/meeting-copy.m4a",
      signals: ["Matching audio fingerprint."],
    },
  ];
  const videoEvidence = [
    {
      connectedLibraryName: "Root B",
      relativePath: "Video/workshop-copy.mp4",
      signals: [
        "Matching video duration within one second.",
        "Matching normalized filename.",
      ],
    },
  ];

  assert.equal(calibratedDuplicateConfidence(0.95, audioEvidence), 0.82);
  assert.equal(calibratedDuplicateConfidence(0.95, videoEvidence), 0.65);
  assert.equal(audioEvidence[0]?.relativePath, "Audio/meeting-copy.m4a");
  assert.equal(videoEvidence[0]?.relativePath, "Video/workshop-copy.mp4");
});

test("structured recommendation evidence remains backward compatible", () => {
  assert.deepEqual(recommendationSupportFromJson(["Legacy evidence."]), {
    alternatives: [],
    details: ["Legacy evidence."],
    duplicateEvidence: [],
    requiredFolderPaths: [],
  });

  const structured = recommendationSupportFromJson({
    alternatives: [
      {
        confidence: 0.62,
        explanation: "Another plausible destination.",
        proposedFileName: null,
        proposedRelativePath: "Alice/intake.docx",
        requiredFolderPaths: ["Alice"],
        suggestionType: "GROUP_WITH_FILES",
        title: "Place with Alice files",
      },
    ],
    details: ["Reviewed evidence."],
    duplicateEvidence: [],
    requiredFolderPaths: ["Clinical Tools"],
    version: 1,
  });

  assert.equal(structured.alternatives.length, 1);
  assert.deepEqual(structured.details, ["Reviewed evidence."]);
  assert.deepEqual(structured.requiredFolderPaths, ["Clinical Tools"]);
});

test("the recommendation review shows alternatives, dependencies, and duplicate evidence", async () => {
  const sourceText = await readFile(
    "src/components/library/OrganizationSuggestionsReviewPanel.tsx",
    "utf8",
  );

  assert.match(sourceText, /One organization decision/);
  assert.match(sourceText, /Other destinations considered/);
  assert.match(sourceText, /File to compare/);
  assert.match(sourceText, /never deletes either file/i);
});
