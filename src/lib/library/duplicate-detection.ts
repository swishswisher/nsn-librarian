export type DuplicateCandidate = {
  documentId: string;
  duplicateOfDocumentId: string;
  similarityScore: number;
  reason: string;
};

export async function detectPossibleDuplicates(): Promise<DuplicateCandidate[]> {
  return [];
}
