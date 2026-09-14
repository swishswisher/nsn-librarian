export const legacyRecommendationGenerationId = "legacy";
export const legacyRecommendationGenerationVersion = "legacy";
export const currentRecommendationGenerationVersion =
  "organization-recommendations-v11";

export function isCurrentRecommendationGeneration(version: string) {
  return version === currentRecommendationGenerationVersion;
}
