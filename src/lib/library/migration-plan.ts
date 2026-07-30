import type { MigrationActionType, MigrationStatus } from "@/types/library";

export type BuildMigrationPlanItemInput = {
  documentId: string;
  destinationPath: string;
  actionType?: MigrationActionType;
  notes?: string;
};

export type MigrationPlanItemDraft = {
  documentId: string;
  destinationPath: string;
  actionType: MigrationActionType;
  status: MigrationStatus;
  notes?: string;
};

export async function buildMigrationPlanItem(
  input: BuildMigrationPlanItemInput,
): Promise<MigrationPlanItemDraft> {
  return {
    documentId: input.documentId,
    destinationPath: input.destinationPath,
    actionType: input.actionType ?? "REVIEW",
    status: "PENDING",
    notes: input.notes,
  };
}
