export const legacyRecommendationGenerationId = "legacy";
export const legacyRecommendationGenerationVersion = "legacy";
export const currentRecommendationGenerationVersion =
  "organization-recommendations-v5";

export function isCurrentRecommendationGeneration(version: string) {
  return version === currentRecommendationGenerationVersion;
}
