import * as graph from "./graph";

// Page reads must not wait for a multi-stage, write-heavy graph backfill.
// The persistent library layout refreshes it separately and reloads saved data
// on completion. Direct service consumers retain the blocking default.
export const getKnowledgeReviewPageData = () => graph.getKnowledgeReviewPageData(false);
export const getKnowledgeGraphPageData = () => graph.getKnowledgeGraphPageData(false);
export const getKnowledgeHomepagePreview = () => graph.getKnowledgeHomepagePreview(false);
export const getKnowledgeTopicPageData = (topicId: string) => graph.getKnowledgeTopicPageData(topicId, false);
export const getRelatedKnowledgeForNotebookEntry = (entryId: string) => graph.getRelatedKnowledgeForNotebookEntry(entryId, false);
export const getKnowledgeContextForRecommendations = (suggestionIds: string[]) => graph.getKnowledgeContextForRecommendations(suggestionIds, false);
export { ensureKnowledgeGraphBackfill, trustedReasoningFilter } from "./graph";
