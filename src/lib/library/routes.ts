function encodedId(value: string) {
  return encodeURIComponent(value);
}

export function getLibraryHomeRoute() {
  return "/admin/library";
}

export function getScanSessionsRoute() {
  return "/admin/library/scan-sessions";
}

export function getConnectedLibrariesRoute() {
  return "/admin/library/connected-libraries";
}

export function getBridgeMonitoringRoute() {
  return "/admin/library/monitoring";
}

export function getBridgeDownloadRoute() {
  return "/download/bridge";
}

export function getConnectThisMacRoute() {
  return "/connect-this-mac";
}

export function getScanSessionRoute(sessionId: string) {
  return `${getScanSessionsRoute()}/${encodedId(sessionId)}`;
}

export function getRecommendationsRoute(sessionId: string) {
  return `${getScanSessionRoute(sessionId)}/recommendations`;
}

export function getRecommendationExamineRoute(
  sessionId: string,
  suggestionId: string,
) {
  return `${getRecommendationsRoute(sessionId)}/${encodedId(suggestionId)}`;
}

export function getScannedFileExamineRoute(
  sessionId: string,
  scannedFileId: string,
) {
  return `${getScanSessionRoute(sessionId)}/files/${encodedId(
    scannedFileId,
  )}/examine`;
}

export function getOrganizationPlanRoute(sessionId: string) {
  return `${getScanSessionRoute(sessionId)}/organization-plan`;
}

export function getLegacyOrganizationSuggestionsRoute(sessionId: string) {
  return `${getScanSessionRoute(sessionId)}/organization-suggestions`;
}

export function getNotebookRoute() {
  return "/admin/library/notebook";
}

export function getNotebookArchiveRoute() {
  return `${getNotebookRoute()}/archive`;
}

export function getNotebookEntryRoute(entryId: string) {
  return `${getNotebookRoute()}/${encodedId(entryId)}`;
}

export function getKnowledgeRoute() {
  return "/admin/library/knowledge";
}

export function getKnowledgeGraphRoute() {
  return `${getKnowledgeRoute()}/graph`;
}

export function getKnowledgeTopicRoute(topicId: string) {
  return `${getKnowledgeRoute()}/topics/${encodedId(topicId)}`;
}
