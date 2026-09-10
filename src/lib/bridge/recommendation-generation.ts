export const legacyRecommendationGenerationId = "legacy";
export const legacyRecommendationGenerationVersion = "legacy";
export const currentRecommendationGenerationVersion =
  "organization-recommendations-v7";

export function isCurrentRecommendationGeneration(version: string) {
  return version === currentRecommendationGenerationVersion;
}
