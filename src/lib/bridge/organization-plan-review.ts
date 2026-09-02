import type {
  BridgeOrganizationPlan,
  BridgeOrganizationPlanAction,
  BridgeOrganizationPlanDownload,
  OrganizationPlanActionType,
} from "./types";
import { isCurrentRecommendationGeneration } from "./recommendation-generation";

export type OrganizationPlanDecisionGroup = {
  actions: BridgeOrganizationPlanAction[];
  sourceRelativePath: string;
};

export type OrganizationPlanLiveSummary = {
  foldersCreated: number;
  folderPaths: string[];
  filesDeleted: 0;
  filesMoved: number;
  filesOverwritten: 0;
  filesRenamed: number;
};

const selectableActionTypes = new Set<OrganizationPlanActionType>([
  "MOVE_FILE",
  "RENAME_FILE",
  "MOVE_AND_RENAME_FILE",
]);

export function actionCanBeChosen(action: BridgeOrganizationPlanAction) {
  return (
    selectableActionTypes.has(action.actionType) &&
    Boolean(action.sourceRelativePath.trim()) &&
    Boolean(action.plannedRelativePath?.trim()) &&
    isCurrentRecommendationGeneration(
      action.recommendationGenerationVersion ?? "",
    )
  );
}

function sourceKey(value: string) {
  return value.trim().replaceAll("\\", "/").toLowerCase();
}

export function organizationPlanDecisionGroups(
  actions: BridgeOrganizationPlanAction[],
) {
  const groups = new Map<string, OrganizationPlanDecisionGroup>();

  for (const action of actions) {
    if (!actionCanBeChosen(action)) {
      continue;
    }

    const key = sourceKey(action.sourceRelativePath);
    const group = groups.get(key);

    if (group) {
      group.actions.push(action);
      continue;
    }

    groups.set(key, {
      actions: [action],
      sourceRelativePath: action.sourceRelativePath,
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      actions: [...group.actions].sort(
        (left, right) =>
          (left.plannedRelativePath ?? "").localeCompare(
            right.plannedRelativePath ?? "",
          ) || left.id.localeCompare(right.id),
      ),
    }))
    .sort((left, right) =>
      left.sourceRelativePath.localeCompare(right.sourceRelativePath),
    );
}

export function selectedActionIdsFromActions(
  actions: BridgeOrganizationPlanAction[],
) {
  return actions
    .filter(
      (action) => actionCanBeChosen(action) && action.selectedForExecution === true,
    )
    .map((action) => action.id);
}

export function chooseActionForSource(
  selectedActionIds: string[],
  actions: BridgeOrganizationPlanAction[],
  sourceRelativePath: string,
  actionId: string | null,
) {
  const sameSourceIds = new Set(
    actions
      .filter(
        (action) =>
          actionCanBeChosen(action) &&
          sourceKey(action.sourceRelativePath) === sourceKey(sourceRelativePath),
      )
      .map((action) => action.id),
  );
  const nextIds = selectedActionIds.filter((id) => !sameSourceIds.has(id));

  return actionId && sameSourceIds.has(actionId)
    ? [...nextIds, actionId]
    : nextIds;
}

export function organizationPlanLiveSummary(
  actions: BridgeOrganizationPlanAction[],
  selectedActionIds: string[],
): OrganizationPlanLiveSummary {
  const selectedIds = new Set(selectedActionIds);
  const selectedActions = actions.filter(
    (action) => actionCanBeChosen(action) && selectedIds.has(action.id),
  );
  const folderPaths = [
    ...new Set(
      selectedActions.flatMap((action) => action.requiredFolderPaths ?? []),
    ),
  ].sort((left, right) => left.localeCompare(right));

  return {
    filesDeleted: 0,
    filesMoved: selectedActions.filter(
      (action) =>
        action.actionType === "MOVE_FILE" ||
        action.actionType === "MOVE_AND_RENAME_FILE",
    ).length,
    filesOverwritten: 0,
    filesRenamed: selectedActions.filter(
      (action) =>
        action.actionType === "RENAME_FILE" ||
        action.actionType === "MOVE_AND_RENAME_FILE",
    ).length,
    folderPaths,
    foldersCreated: folderPaths.length,
  };
}

export function organizationPlanDownload(
  plan: BridgeOrganizationPlan,
  exportedAt = new Date().toISOString(),
): BridgeOrganizationPlanDownload {
  const selectedFileActions = plan.actions.filter(
    (action) => actionCanBeChosen(action) && action.selectedForExecution === true,
  );
  const requiredFolderCreations = plan.actions.filter(
    (action) =>
      action.actionType === "CREATE_FOLDER" &&
      action.requiredForSelectedActions === true &&
      isCurrentRecommendationGeneration(
        action.recommendationGenerationVersion ?? "",
      ),
  );
  const executableActions = [
    ...requiredFolderCreations,
    ...selectedFileActions,
  ].sort((left, right) => left.order - right.order);
  const selectedIds = new Set(selectedFileActions.map((action) => action.id));
  const alternatives = plan.actions
    .filter((action) => actionCanBeChosen(action) && !selectedIds.has(action.id))
    .sort((left, right) => left.order - right.order);
  const reviewOnlyNotes = plan.actions
    .filter((action) => !actionCanBeChosen(action) && !requiredFolderCreations.includes(action))
    .sort((left, right) => left.order - right.order);
  const recommendationGenerations = [
    ...new Map(
      plan.actions
        .map((action) =>
          action.recommendationGenerationId &&
          action.recommendationGenerationVersion
            ? [
                action.recommendationGenerationId,
                {
                  id: action.recommendationGenerationId,
                  version: action.recommendationGenerationVersion,
                },
              ]
            : null,
        )
        .filter(
          (
            item,
          ): item is [
            string,
            {
              id: string;
              version: string;
            },
          ] => item !== null,
        ),
    ).values(),
  ].sort((left, right) => left.id.localeCompare(right.id));

  const totals = {
    ...plan.summary,
    estimatedOperations: executableActions.length,
    filesAffected: new Set(
      selectedFileActions.map((action) => action.sourceRelativePath),
    ).size,
    requiredFolderCreations: requiredFolderCreations.length,
    reviewOnlyNotes: reviewOnlyNotes.length,
    selectableFileActions: selectedFileActions.length + alternatives.length,
    selectedFileActions: selectedFileActions.length,
    unselectedAlternatives: alternatives.length,
  };

  return {
    connectedLibraryId: plan.connectedLibraryId,
    executable: {
      requiredFolderCreations,
      selectedFileActions,
    },
    exportedAt,
    nonExecutable: {
      alternatives,
      reviewOnlyNotes,
      skippedItems: plan.skippedItems,
    },
    plan: {
      ...plan,
      actions: executableActions,
      summary: totals,
      totalActions: executableActions.length,
    },
    recommendationGenerations,
    safety: {
      executionAllowed: false,
      note: "This JSON is an organization plan only. It does not authorize moving, renaming, creating, deleting, copying, or publishing files.",
    },
    scanSessionId: plan.scanSessionId,
    totals,
    warnings: plan.warnings,
  };
}
