/** Optional operation counters for production-path scale regressions. */
export type KnowledgeWork = {
  rootFileVisits?: number;
  rootMembershipChecks?: number;
  memoryFileVisits?: number;
  memorySourceVisits?: number;
  memoryPairVisits?: number;
  currentSignalVisits?: number;
  candidateVisits?: number;
  poolNodeVisits?: number;
  correctionLookups?: number;
  unionMoves?: number;
  versionVisits?: number;
};

export function countKnowledgeWork(work: KnowledgeWork | undefined, key: keyof KnowledgeWork, count = 1) {
  if (work) work[key] = (work[key] ?? 0) + count;
}
