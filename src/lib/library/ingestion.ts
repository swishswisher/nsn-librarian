import type { LibraryBatchStatus, LibrarySourceType } from "@/types/library";

export type CreateLibraryBatchInput = {
  name: string;
  sourceType?: LibrarySourceType;
  notes?: string;
};

export type LibraryBatchDraft = {
  id: string;
  name: string;
  sourceType: LibrarySourceType;
  notes?: string;
  status: LibraryBatchStatus;
  createdAt: string;
};

export async function createLibraryBatch(
  input: CreateLibraryBatchInput,
): Promise<LibraryBatchDraft> {
  return {
    id: "placeholder-batch",
    name: input.name,
    sourceType: input.sourceType ?? "LOCAL_UPLOAD",
    notes: input.notes,
    status: "DRAFT",
    createdAt: new Date().toISOString(),
  };
}
