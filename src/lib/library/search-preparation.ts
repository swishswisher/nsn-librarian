export interface SearchPreparationProgress {
  indexed: number;
  reused: number;
  failed: number;
  remaining: number;
  completed: boolean;
  claimedFiles: number;
  processedFiles: number;
  waitingForClaims: boolean;
}

export async function runSearchPreparationBatches(
  prepareBatch: (retryFailed: boolean) => Promise<SearchPreparationProgress>,
  onProgress: (progress: SearchPreparationProgress) => void,
) {
  let retryFailed = true;
  for (;;) {
    const progress = await prepareBatch(retryFailed);
    onProgress(progress);
    if (progress.remaining === 0 || progress.processedFiles === 0) return progress;
    retryFailed = false;
  }
}
