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
  correctionGraphQueries?: number;
  correctionGraphRows?: number;
  correctionGraphEndpoints?: number;
  correctionGraphNeighbors?: number;
  searchRefreshQueries?: number;
  searchRefreshSignals?: number;
  searchRefreshEntries?: number;
  searchRefreshUpdates?: number;
  searchRefreshUpdateQueries?: number;
  latestObservationQueries?: number;
};

export function countKnowledgeWork(work: KnowledgeWork | undefined, key: keyof KnowledgeWork, count = 1) {
  if (work) work[key] = (work[key] ?? 0) + count;
}
