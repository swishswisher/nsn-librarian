export const bridgeConnectionStatuses = [
  "NOT_CONNECTED",
  "CONNECTED",
  "SCANNING",
  "ERROR",
] as const;

export type BridgeConnectionStatus = (typeof bridgeConnectionStatuses)[number];

export const bridgeScanSessionStatuses = [
  "PENDING",
  "SCANNING",
  "READING",
  "EXAMINING",
  "GENERATING_SUGGESTIONS",
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
] as const;

export type BridgeScanSessionStatus =
  (typeof bridgeScanSessionStatuses)[number];

export const scannedFileReadStatuses = [
  "PENDING",
  "SUPPORTED",
  "UNSUPPORTED",
  "FAILED",
] as const;

export type ScannedFileReadStatus = (typeof scannedFileReadStatuses)[number];

export const bridgeFileReadingStatuses = [
  "NOT_READ",
  "READ",
  "FAILED",
  "UNSUPPORTED",
] as const;

export type BridgeFileReadingStatus =
  (typeof bridgeFileReadingStatuses)[number];

export const audioTranscriptionStatuses = [
  "NOT_REQUESTED",
  "TRANSCRIBING",
  "COMPLETED",
  "UNAVAILABLE",
  "FAILED",
] as const;

export type AudioTranscriptionStatus =
  (typeof audioTranscriptionStatuses)[number];

export const audioPrivacyStates = [
  "PRIVATE",
  "INTERNAL",
  "REVIEW_REQUIRED",
  "WEBSITE_CANDIDATE",
  "APPROVED_FOR_PUBLIC_USE",
] as const;

export type AudioPrivacyState = (typeof audioPrivacyStates)[number];

export const videoProcessingStatuses = [
  "NOT_REQUESTED",
  "PROCESSING",
  "COMPLETED",
  "UNAVAILABLE",
  "FAILED",
] as const;

export type VideoProcessingStatus =
  (typeof videoProcessingStatuses)[number];

export const videoPrivacyStates = [
  "PRIVATE",
  "INTERNAL",
  "REVIEW_REQUIRED",
  "WEBSITE_CANDIDATE",
  "APPROVED_FOR_PUBLIC_USE",
] as const;

export type VideoPrivacyState = (typeof videoPrivacyStates)[number];

export const imageProcessingStatuses = [
  "NOT_REQUESTED",
  "PROCESSING",
  "COMPLETED",
  "UNAVAILABLE",
  "FAILED",
] as const;

export type ImageProcessingStatus =
  (typeof imageProcessingStatuses)[number];

export const imagePrivacyStates = [
  "PRIVATE",
  "INTERNAL",
  "REVIEW_REQUIRED",
  "WEBSITE_CANDIDATE",
  "APPROVED_FOR_PUBLIC_USE",
] as const;

export type ImagePrivacyState = (typeof imagePrivacyStates)[number];

export const audioHumanLabels = [
  "WORKSHOP",
  "CLIENT",
  "PRIVATE",
  "WEBSITE",
  "PODCAST",
  "MEETING",
  "RESEARCH",
  "ARCHIVE",
] as const;

export type AudioHumanLabel = (typeof audioHumanLabels)[number];

export const videoHumanLabels = [
  "WORKSHOP",
  "PRESENTATION",
  "WEBSITE",
  "INTERNAL",
  "PRIVATE",
  "INTERVIEW",
  "WEBINAR",
  "TRAINING",
  "ARCHIVE",
  "DUPLICATE_CANDIDATE",
] as const;

export type VideoHumanLabel = (typeof videoHumanLabels)[number];

export const imageHumanLabels = [
  "WORKSHOP",
  "PRESENTATION",
  "WEBSITE",
  "INTERNAL",
  "PRIVATE",
  "EVENT",
  "SCREENSHOT",
  "BRANDING_ASSET",
  "DUPLICATE_CANDIDATE",
] as const;

export type ImageHumanLabel = (typeof imageHumanLabels)[number];

export const scannedFileProcessingStages = [
  "DISCOVERED",
  "READING_IMAGE_METADATA",
  "METADATA_READY",
  "PREPARING_PREVIEW",
  "ANALYZING_IMAGE",
  "OCR_PROCESSING",
  "OBSERVING",
  "RECOMMENDATIONS_READY",
  "READING",
  "READ",
  "EXAMINING",
  "EXAMINED",
  "SUGGESTIONS_GENERATED",
  "UNSUPPORTED",
  "FAILED",
] as const;

export type ScannedFileProcessingStage =
  (typeof scannedFileProcessingStages)[number];

export const bridgeExtractionStatuses = [
  "PENDING",
  "EXTRACTING",
  "COMPLETED",
  "FAILED",
  "UNSUPPORTED",
] as const;

export type BridgeExtractionStatus = (typeof bridgeExtractionStatuses)[number];

export const organizationSuggestionTypes = [
  "MOVE_FILE",
  "RENAME_FILE",
  "CREATE_FOLDER",
  "GROUP_WITH_FILES",
  "POSSIBLE_DUPLICATE",
  "WEBSITE_CANDIDATE",
  "KEEP_UNCHANGED",
] as const;

export type OrganizationSuggestionType =
  (typeof organizationSuggestionTypes)[number];

export const organizationSuggestionStatuses = [
  "PENDING",
  "APPROVED",
  "MODIFIED",
  "REJECTED",
  "LEFT_UNCHANGED",
] as const;

export type OrganizationSuggestionStatus =
  (typeof organizationSuggestionStatuses)[number];

export const organizationPlanStatuses = [
  "DRAFT",
  "READY_FOR_EXECUTION",
  "EXECUTED",
  "CANCELLED",
] as const;

export type OrganizationPlanStatus = (typeof organizationPlanStatuses)[number];

export const organizationPlanActionTypes = [
  "CREATE_FOLDER",
  "RENAME_FOLDER",
  "MOVE_FILE",
  "RENAME_FILE",
  "MOVE_AND_RENAME_FILE",
  "WEBSITE_ACTION",
  "REVIEW_ONLY",
] as const;

export type OrganizationPlanActionType =
  (typeof organizationPlanActionTypes)[number];

export const organizationPlanWarningTypes = [
  "DUPLICATE_DESTINATION",
  "FILENAME_CONFLICT",
  "FOLDER_CONFLICT",
  "INVALID_PATH",
  "MISSING_PARENT",
  "OUTSIDE_ROOT_DESTINATION",
  "REVIEW_ONLY_ACTION",
] as const;

export type OrganizationPlanWarningType =
  (typeof organizationPlanWarningTypes)[number];

export const executionStatuses = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "BLOCKED",
] as const;

export type ExecutionStatus = (typeof executionStatuses)[number];

export const undoStatuses = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "BLOCKED",
] as const;

export type UndoStatus = (typeof undoStatuses)[number];

export const bridgeMonitoringStates = [
  "NOT_CONNECTED",
  "WATCHING",
  "PAUSED",
  "NEEDS_ATTENTION",
  "STOPPED",
] as const;

export type BridgeMonitoringState =
  (typeof bridgeMonitoringStates)[number];

export const bridgeMonitoringEventTypes = [
  "FILE_ADDED",
  "FILE_MODIFIED",
  "FILE_RENAMED",
  "FILE_MOVED",
  "FILE_DELETED",
  "FOLDER_ADDED",
  "FOLDER_RENAMED",
  "FOLDER_MOVED",
  "FOLDER_DELETED",
] as const;

export type BridgeMonitoringEventType =
  (typeof bridgeMonitoringEventTypes)[number];

export const bridgeMonitoringProcessingStatuses = [
  "QUEUED",
  "STABILIZING",
  "PROCESSING",
  "COMPLETED",
  "NEEDS_ATTENTION",
  "SKIPPED",
  "FAILED",
] as const;

export type BridgeMonitoringProcessingStatus =
  (typeof bridgeMonitoringProcessingStatuses)[number];

export const bridgeMonitoringBatchStatuses = [
  "OPEN",
  "PROCESSING",
  "READY_FOR_REVIEW",
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
] as const;

export type BridgeMonitoringBatchStatus =
  (typeof bridgeMonitoringBatchStatuses)[number];

export type BridgeUndoActionType =
  | "REMOVE_FOLDER"
  | "MOVE_FILE"
  | "RENAME_FILE";

export const bridgeExecutionIssueCategories = [
  "PLAN_NOT_READY",
  "PLAN_EMPTY",
  "PLAN_ALREADY_EXECUTED",
  "UNSUPPORTED_ACTION",
  "PATH_OUTSIDE_ROOT",
  "INVALID_PATH",
  "DUPLICATE_SOURCE",
  "DUPLICATE_DESTINATION",
  "DESTINATION_CONFLICT",
  "MISSING_PARENT",
  "MISSING_SOURCE",
  "CHANGED_SOURCE",
  "SOURCE_NOT_FILE",
  "ROOT_MISMATCH",
  "VALIDATION_FAILED",
  "FILESYSTEM_OPERATION_FAILED",
  "UNDO_ALREADY_COMPLETED",
  "UNDO_RUNNING",
  "UNDO_NOT_AVAILABLE",
  "FOLDER_NOT_EMPTY",
  "FOLDER_NOT_CREATED_BY_BRIDGE",
  "DUPLICATE_UNDO_DESTINATION",
  "PERMISSION_DENIED",
  "BRIDGE_UNAVAILABLE",
  "EXECUTION_BLOCKED",
] as const;

export type BridgeExecutionIssueCategory =
  (typeof bridgeExecutionIssueCategories)[number];

export type BridgeExecutionIssueSeverity = "BLOCKING" | "WARNING";

export type OrganizationSuggestionCounts = {
  total: number;
  pending: number;
  approved: number;
  modified: number;
  eligibleForPlanning: number;
  rejected: number;
  leftUnchanged: number;
};

export const connectedLibraryPlatforms = [
  "WINDOWS",
  "MACOS",
  "LINUX",
  "UNKNOWN",
] as const;

export type ConnectedLibraryPlatform =
  (typeof connectedLibraryPlatforms)[number];

export const connectedLibraryStatuses = [
  "CONNECTED",
  "PAUSED",
  "NEEDS_ATTENTION",
  "DISCONNECTED",
  "MERGED",
  "HIDDEN_FROM_ACTIVE_LIST",
] as const;

export type ConnectedLibraryStatus =
  (typeof connectedLibraryStatuses)[number];

export type ConnectedLibraryPermissions = {
  readPermission: boolean;
  watchPermission: boolean;
  recommendationPermission: boolean;
  organizationPlanPermission: boolean;
  createFolderPermission: boolean;
  moveFilePermission: boolean;
  renameFilePermission: boolean;
};

export type ConnectedLibrarySummary = ConnectedLibraryPermissions & {
  id: string;
  bridgeDeviceId: string | null;
  bridgeRootId: string | null;
  canonicalConnectedLibraryId: string | null;
  displayName: string;
  safeLocalLocation: string;
  platform: ConnectedLibraryPlatform;
  status: ConnectedLibraryStatus;
  connectedAt: string;
  disconnectedAt: string | null;
  hiddenFromActiveListAt: string | null;
  mergedAt: string | null;
  lastScanAt: string | null;
  lastBridgeCheckAt: string | null;
  lastMonitoringAt: string | null;
  isEnabled: boolean;
  monitoringState: BridgeMonitoringState;
  monitoringStartedAt: string | null;
  monitoringPausedAt: string | null;
  monitoringStoppedAt: string | null;
  monitoringLastCheckAt: string | null;
  monitoringLastSuccessfulCheckAt: string | null;
  monitoringHeartbeatAt: string | null;
  monitoringErrorCategory: string | null;
  lastDetectedChangeAt: string | null;
  scanSessionCount: number;
  recentChangeCount: number;
  itemsNeedingAttention: number;
  bridgeReachable: boolean;
  isLegacyConnection: boolean;
  isHiddenFromActiveList: boolean;
  isMergedDuplicate: boolean;
  legacyReason: string | null;
  requiresReconnect: boolean;
};

export type ConnectedFolder = {
  id: string;
  displayName: string;
  localPath: string;
  enabled: boolean;
  lastScanAt: Date | null;
  monitoringState?: BridgeMonitoringState;
  monitoringLastCheckAt?: Date | null;
  monitoringHeartbeatAt?: Date | null;
};

export type ScanSession = {
  id: string;
  connectedFolderId: string;
  startedAt: Date;
  completedAt: Date | null;
  status: BridgeScanSessionStatus;
  filesScanned: number;
  supportedFiles: number;
  unsupportedFiles: number;
  failedFiles: number;
  observationsCreated: number;
};

export type BridgeAudioMetadataDraft = {
  durationSeconds: number | null;
  sampleRateHz: number | null;
  bitrateKbps: number | null;
  channels: number | null;
  codec: string | null;
  container: string | null;
  sourceCreatedAt: Date | null;
  sourceModifiedAt: Date | null;
  audioFingerprint: string | null;
};

export type BridgeAudioMetadataSummary = {
  durationSeconds: number | null;
  sampleRateHz: number | null;
  bitrateKbps: number | null;
  channels: number | null;
  codec: string | null;
  container: string | null;
  sourceCreatedAt: string | null;
  sourceModifiedAt: string | null;
  transcriptSnippet: string | null;
  summary: string | null;
  transcriptionConfidence: number | null;
  transcriptionStatus: AudioTranscriptionStatus;
  transcriptionErrorCategory: string | null;
  privacyState: AudioPrivacyState;
  humanLabels: AudioHumanLabel[];
  machineLabels: string[];
  provisionalTopics: string[];
  provisionalPeople: string[];
  provisionalProjects: string[];
  provisionalActionItems: string[];
  provisionalQuestions: string[];
  duplicateKind: string | null;
  duplicateOfScannedFileId: string | null;
  duplicateConfidence: number | null;
  audioFingerprint: string | null;
};

export type BridgeVideoChapterSuggestion = {
  timestampSeconds: number;
  title: string;
  confidence: number;
};

export type BridgeVideoFrameDescription = {
  timestampSeconds: number;
  label: string;
  description: string;
  confidence: number;
};

export type BridgeVideoMetadataDraft = {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  codec: string | null;
  container: string | null;
  bitrateKbps: number | null;
  hasAudioTrack: boolean | null;
  sourceCreatedAt: Date | null;
  sourceModifiedAt: Date | null;
  videoFingerprint: string | null;
};

export type BridgeVideoMetadataSummary = {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  codec: string | null;
  container: string | null;
  bitrateKbps: number | null;
  hasAudioTrack: boolean | null;
  sourceCreatedAt: string | null;
  sourceModifiedAt: string | null;
  transcriptSnippet: string | null;
  summary: string | null;
  transcriptionConfidence: number | null;
  transcriptionStatus: VideoProcessingStatus;
  transcriptionErrorCategory: string | null;
  frameAnalysisStatus: VideoProcessingStatus;
  frameAnalysisErrorCategory: string | null;
  privacyState: VideoPrivacyState;
  humanLabels: VideoHumanLabel[];
  machineLabels: string[];
  provisionalTopics: string[];
  provisionalPeople: string[];
  provisionalProjects: string[];
  provisionalQuestions: string[];
  selectedFrameDescriptions: BridgeVideoFrameDescription[];
  chapterSuggestions: BridgeVideoChapterSuggestion[];
  relatedSignals: string[];
  duplicateKind: string | null;
  duplicateOfScannedFileId: string | null;
  duplicateConfidence: number | null;
  videoFingerprint: string | null;
};

export type BridgeImageMetadataDraft = {
  width: number | null;
  height: number | null;
  format: string;
  sizeBytes: bigint;
  orientation: string | null;
  colorProfile: string | null;
  embeddedDate: Date | null;
  cameraDevice: string | null;
  sourceCreatedAt: Date | null;
  sourceModifiedAt: Date | null;
  imageFingerprint: string | null;
};

export type BridgeImageMetadataSummary = {
  width: number | null;
  height: number | null;
  format: string | null;
  orientation: string | null;
  colorProfile: string | null;
  embeddedDate: string | null;
  cameraDevice: string | null;
  sourceCreatedAt: string | null;
  sourceModifiedAt: string | null;
  previewStatus: ImageProcessingStatus;
  previewErrorCategory: string | null;
  visualAnalysisStatus: ImageProcessingStatus;
  visualAnalysisErrorCategory: string | null;
  ocrStatus: ImageProcessingStatus;
  ocrErrorCategory: string | null;
  privacyState: ImagePrivacyState;
  humanLabels: ImageHumanLabel[];
  machineLabels: string[];
  provisionalTopics: string[];
  provisionalQuestions: string[];
  relatedSignals: string[];
  summary: string | null;
  textSnippet: string | null;
  duplicateKind: string | null;
  duplicateOfScannedFileId: string | null;
  duplicateConfidence: number | null;
  imageFingerprint: string | null;
};

export type ScannedFile = {
  id: string;
  sessionId: string;
  localPath: string;
  relativePath: string;
  fileType: string;
  checksum: string | null;
  sizeBytes: bigint | null;
  lastModified: Date | null;
  readStatus: ScannedFileReadStatus;
  readingStatus: BridgeFileReadingStatus;
  extractionStatus: BridgeExtractionStatus;
  characterCount: number | null;
  extractedAt: Date | null;
  extractionErrorCategory: string | null;
  previewText: string | null;
  libraryDocumentId: string | null;
  processingStage: ScannedFileProcessingStage;
  processingErrorCategory: string | null;
  processedAt: Date | null;
  sourceUnavailableAt: Date | null;
  sourceUnavailableReason: string | null;
  sourceCreatedAt: Date | null;
  scanError?: string | null;
  audioMetadata?: BridgeAudioMetadataSummary | null;
  imageMetadata?: BridgeImageMetadataSummary | null;
  videoMetadata?: BridgeVideoMetadataSummary | null;
};

export type BridgeStatus = {
  status: BridgeConnectionStatus;
  label: string;
  connectedFolders: ConnectedFolder[];
};

export type BridgeUnavailableResult = {
  ok: false;
  message: string;
};

export type ConnectedLibraryMutationSuccess = {
  action?: "CONNECTED" | "RECONNECTED" | "ALREADY_CONNECTED" | "UPDATED" | "DISCONNECTED" | "HIDDEN";
  alreadyConnected?: boolean;
  ok: true;
  library: ConnectedLibrarySummary;
  permissionUpdate?: {
    commandId: string;
    status: "PENDING";
  };
};

export type ConnectedLibraryListResponse =
  | {
      ok: true;
      libraries: ConnectedLibrarySummary[];
    }
  | {
      ok: false;
      error: string;
    };

export type ConnectedLibraryMutationResponse =
  | ConnectedLibraryMutationSuccess
  | {
      ok: false;
      error: string;
    };

export type ConnectedLibraryBatchConnectionItem = {
  action?: ConnectedLibraryMutationSuccess["action"];
  alreadyConnected?: boolean;
  error?: string;
  library: ConnectedLibrarySummary | null;
  ok: boolean;
  rootId: string | null;
  selectionToken: string;
};

export type ConnectedLibraryBatchConnectionResponse =
  | {
      ok: true;
      connectedCount: number;
      alreadyConnectedCount: number;
      needsAttentionCount: number;
      results: ConnectedLibraryBatchConnectionItem[];
      libraries: ConnectedLibrarySummary[];
    }
  | {
      ok: false;
      error: string;
    };

export type BridgeScannedFileDraft = {
  localPath: string;
  relativePath: string;
  fileType: string;
  checksum: string | null;
  sizeBytes: bigint | null;
  lastModified: Date | null;
  sourceCreatedAt?: Date | null;
  readStatus: ScannedFileReadStatus;
  scanError?: string | null;
  audioMetadata?: BridgeAudioMetadataDraft | null;
  imageMetadata?: BridgeImageMetadataDraft | null;
  videoMetadata?: BridgeVideoMetadataDraft | null;
};

export type BridgeFolderScanResult = {
  folderDisplayName: string;
  rootPath: string;
  bridgeRootId?: string;
  safeLocation?: string;
  files: BridgeScannedFileDraft[];
  totalFiles: number;
  supportedFiles: number;
  unsupportedFiles: number;
  failedFiles: number;
  startedAt: Date;
  completedAt: Date;
};

export type BridgeScanSessionSummary = {
  id: string;
  connectedLibraryId: string;
  folderDisplayName: string;
  startedAt: string;
  completedAt: string | null;
  status: BridgeScanSessionStatus;
  totalFiles: number;
  supportedFiles: number;
  unsupportedFiles: number;
  failedFiles: number;
};

export type BridgeScanProcessingProgress = {
  sessionId: string;
  folderDisplayName: string;
  currentStage: BridgeScanSessionStatus;
  isActive: boolean;
  isStale: boolean;
  startedAt: string;
  lastActivityAt: string;
  filesDiscovered: number;
  supportedFiles: number;
  unsupportedFiles: number;
  failedFiles: number;
  filesRead: number;
  filesExamined: number;
  filesProcessed: number;
  filesWithSuggestions: number;
  suggestionsGenerated: number;
  pendingSuggestions: number;
  remainingFiles: number;
  completedAt: string | null;
};

export type BridgeScannedFileSummary = {
  id: string;
  relativePath: string;
  fileType: string;
  checksum: string | null;
  sizeBytes: string | null;
  lastModified: string | null;
  sourceCreatedAt: string | null;
  readStatus: ScannedFileReadStatus;
  readingStatus: BridgeFileReadingStatus;
  extractionStatus: BridgeExtractionStatus;
  characterCount: number | null;
  extractedAt: string | null;
  extractionErrorCategory: string | null;
  previewText: string | null;
  processingStage: ScannedFileProcessingStage;
  processingErrorCategory: string | null;
  processedAt: string | null;
  sourceUnavailableAt: string | null;
  sourceUnavailableReason: string | null;
  scanError: string | null;
  audioMetadata: BridgeAudioMetadataSummary | null;
  imageMetadata: BridgeImageMetadataSummary | null;
  videoMetadata: BridgeVideoMetadataSummary | null;
  hasObservation: boolean;
  hasReviewedObservation: boolean;
  organizationSuggestionCounts: OrganizationSuggestionCounts;
};

export type BridgeMonitoringEventSummary = {
  id: string;
  eventType: BridgeMonitoringEventType;
  previousRelativePath: string | null;
  currentRelativePath: string | null;
  detectedAt: string;
  stabilizedAt: string | null;
  processingStatus: BridgeMonitoringProcessingStatus;
  safeErrorCategory: string | null;
  renameMoveConfidence: number | null;
  sizeBefore: string | null;
  sizeAfter: string | null;
  modifiedAtBefore: string | null;
  modifiedAtAfter: string | null;
  scanSessionId: string | null;
};

export type BridgeMonitoringBatchSummary = {
  id: string;
  connectedFolderId: string;
  scanSessionId: string | null;
  startedAt: string;
  completedAt: string | null;
  status: BridgeMonitoringBatchStatus;
  totalEvents: number;
  fileEvents: number;
  folderEvents: number;
  supportedFileEvents: number;
  unsupportedFileEvents: number;
  failedEvents: number;
  notificationTitle: string | null;
  notificationSummary: string | null;
  notebookEntryId: string | null;
};

export type BridgeMonitoringFolderSummary = {
  id: string;
  displayName: string;
  state: BridgeMonitoringState;
  humanState: string;
  startedAt: string | null;
  pausedAt: string | null;
  stoppedAt: string | null;
  lastCheckAt: string | null;
  lastSuccessfulCheckAt: string | null;
  heartbeatAt: string | null;
  errorCategory: string | null;
  lastDetectedChangeAt: string | null;
  watchingAppearsStopped: boolean;
  needsReconciliation: boolean;
  queuedEvents: number;
  processingEvents: number;
  completedEvents: number;
  attentionEvents: number;
  recentEvents: BridgeMonitoringEventSummary[];
  recentBatches: BridgeMonitoringBatchSummary[];
};

export type BridgeMonitoringDashboard = {
  isDevelopment: boolean;
  folders: BridgeMonitoringFolderSummary[];
  queue: {
    queued: number;
    processing: number;
    needsAttention: number;
    completed: number;
  };
  recentEvents: BridgeMonitoringEventSummary[];
  recentBatches: BridgeMonitoringBatchSummary[];
};

export type BridgeMonitoringApiSuccess = {
  ok: true;
  dashboard: BridgeMonitoringDashboard;
  library?: ConnectedLibrarySummary | null;
  message?: string;
};

export type BridgeMonitoringApiFailure = {
  ok: false;
  error: string;
};

export type BridgeMonitoringApiResponse =
  | BridgeMonitoringApiSuccess
  | BridgeMonitoringApiFailure;

export type BridgeScanSessionDetail = BridgeScanSessionSummary & {
  organizationSummary: OrganizationSuggestionCounts & {
    filesExamined: number;
  };
  scannedFiles: BridgeScannedFileSummary[];
};

export type BridgeScanApiSuccess = {
  ok: true;
  alreadyActive?: boolean;
  session: BridgeScanSessionSummary;
  progress: BridgeScanProcessingProgress;
};

export type BridgeScanApiFailure = {
  ok: false;
  error: string;
};

export type BridgeScanApiResponse =
  | BridgeScanApiSuccess
  | BridgeScanApiFailure;

export type BridgeBatchScanItem = {
  connectedLibraryId: string;
  displayName: string;
  error?: string;
  ok: boolean;
  progress: BridgeScanProcessingProgress | null;
  session: BridgeScanSessionSummary | null;
};

export type BridgeBatchScanApiResponse =
  | {
      ok: true;
      startedCount: number;
      alreadyActiveCount: number;
      failedCount: number;
      results: BridgeBatchScanItem[];
    }
  | BridgeScanApiFailure;

export type BridgeScanProgressApiSuccess = {
  ok: true;
  session: BridgeScanSessionSummary;
  progress: BridgeScanProcessingProgress;
};

export type BridgeScanProgressApiResponse =
  | BridgeScanProgressApiSuccess
  | BridgeScanApiFailure;

export type BridgeReadPreview = {
  scannedFileId: string;
  fileName: string;
  relativePath: string;
  fileType: string;
  characterCount: number;
  extractedText: string;
  warnings: string[];
};

export type BridgeReadFileApiSuccess = {
  ok: true;
  queued?: false;
  file: BridgeScannedFileSummary;
  preview: BridgeReadPreview;
};

export type BridgeReadFileApiQueued = {
  ok: true;
  queued: true;
  file: BridgeScannedFileSummary;
  message: string;
  progress: BridgeScanProcessingProgress;
  session: BridgeScanSessionSummary;
};

export type BridgeReadFileApiFailure = {
  ok: false;
  error: string;
  category?: string;
};

export type BridgeReadFileApiResponse =
  | BridgeReadFileApiSuccess
  | BridgeReadFileApiQueued
  | BridgeReadFileApiFailure;

export type BridgeObserveScannedFileApiSuccess = {
  ok: true;
  result: import("@/lib/librarian-mind").MindResult;
  sessionId: string;
  observerType: string;
  connectionCount: number;
  hasReviewableSuggestions: boolean;
};

export type BridgeObserveScannedFileApiFailure = {
  ok: false;
  error: string;
};

export type BridgeObserveScannedFileApiResponse =
  | BridgeObserveScannedFileApiSuccess
  | BridgeObserveScannedFileApiFailure;

export type BridgeOrganizationSuggestionRevision = {
  id: string;
  revisedRelativePath: string | null;
  revisedFileName: string | null;
  context: string | null;
  createdAt: string;
};

export type BridgeOrganizationSuggestionSummary = {
  id: string;
  scannedFileId: string;
  scanSessionId: string;
  suggestionType: OrganizationSuggestionType;
  currentRelativePath: string;
  proposedRelativePath: string | null;
  proposedFileName: string | null;
  title: string;
  explanation: string;
  confidence: number;
  status: OrganizationSuggestionStatus;
  createdAt: string;
  reviewedAt: string | null;
  whySuggested: string[];
  supportingInformation: string[];
  revisions: BridgeOrganizationSuggestionRevision[];
};

export type BridgeOrganizationSuggestionGenerationSuccess = {
  ok: true;
  file: BridgeScannedFileSummary;
  suggestions: BridgeOrganizationSuggestionSummary[];
  createdCount: number;
  existingCount: number;
};

export type BridgeOrganizationSuggestionMutationSuccess = {
  ok: true;
  suggestion: BridgeOrganizationSuggestionSummary;
};

export type BridgeOrganizationSuggestionFailure = {
  ok: false;
  error: string;
};

export type BridgeOrganizationSuggestionGenerationResponse =
  | BridgeOrganizationSuggestionGenerationSuccess
  | BridgeOrganizationSuggestionFailure;

export type BridgeOrganizationSuggestionMutationResponse =
  | BridgeOrganizationSuggestionMutationSuccess
  | BridgeOrganizationSuggestionFailure;

export type BridgeOrganizationSuggestionReviewPageData = {
  session: BridgeScanSessionSummary;
  suggestions: BridgeOrganizationSuggestionSummary[];
};

export type BridgeScannedFileExaminationData = {
  session: BridgeScanSessionSummary;
  file: BridgeScannedFileSummary;
  preview: BridgeReadPreview | null;
  previewError: string | null;
  observationReview: import("@/types/library").ObservationSessionReview | null;
  suggestions: BridgeOrganizationSuggestionSummary[];
  approvedMemoryUsed: string[];
};

export type BridgeAudioMetadataMutationSuccess = {
  ok: true;
  file: BridgeScannedFileSummary;
};

export type BridgeAudioMetadataMutationFailure = {
  ok: false;
  error: string;
};

export type BridgeAudioMetadataMutationResponse =
  | BridgeAudioMetadataMutationSuccess
  | BridgeAudioMetadataMutationFailure;

export type BridgeVideoMetadataMutationSuccess = {
  ok: true;
  file: BridgeScannedFileSummary;
};

export type BridgeVideoMetadataMutationFailure = {
  ok: false;
  error: string;
};

export type BridgeVideoMetadataMutationResponse =
  | BridgeVideoMetadataMutationSuccess
  | BridgeVideoMetadataMutationFailure;

export type BridgeImageMetadataMutationSuccess = {
  ok: true;
  file: BridgeScannedFileSummary;
};

export type BridgeImageMetadataMutationFailure = {
  ok: false;
  error: string;
};

export type BridgeImageMetadataMutationResponse =
  | BridgeImageMetadataMutationSuccess
  | BridgeImageMetadataMutationFailure;

export type BridgeOrganizationPlanAction = {
  id: string;
  order: number;
  actionType: OrganizationPlanActionType;
  suggestionId: string;
  suggestionType: OrganizationSuggestionType;
  sourceRelativePath: string;
  plannedRelativePath: string | null;
  plannedFolderPath: string | null;
  plannedFileName: string | null;
  reason: string;
  confidence: number;
  originatingSuggestion: {
    title: string;
    explanation: string;
    status: OrganizationSuggestionStatus;
  };
  humanEdits: {
    revisedRelativePath: string | null;
    revisedFileName: string | null;
    context: string | null;
    createdAt: string;
  }[];
  evidence: {
    approvedObservation: string[];
    approvedMemory: string[];
    humanModification: string[];
    originatingSuggestion: string[];
  };
};

export type BridgeOrganizationPlanWarning = {
  id: string;
  warningType: OrganizationPlanWarningType;
  title: string;
  description: string;
  affectedActions: string[];
};

export type BridgeOrganizationPlanSkippedItem = {
  id: string;
  suggestionId: string;
  currentRelativePath: string;
  title: string;
  status: OrganizationSuggestionStatus;
  reason: string;
};

export type BridgeOrganizationPlanHistoryItem = {
  id: string;
  at: string;
  label: string;
  detail: string;
};

export type BridgeOrganizationPlanSummary = {
  filesAffected: number;
  foldersAffected: number;
  moves: number;
  renames: number;
  newFolders: number;
  estimatedOperations: number;
  warnings: number;
};

export type BridgeOrganizationPlan = {
  id: string;
  scanSessionId: string;
  connectedLibraryId: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  status: OrganizationPlanStatus;
  totalActions: number;
  approvedActions: number;
  modifiedActions: number;
  rejectedActions: number;
  unchangedActions: number;
  summary: BridgeOrganizationPlanSummary;
  actions: BridgeOrganizationPlanAction[];
  warnings: BridgeOrganizationPlanWarning[];
  skippedItems: BridgeOrganizationPlanSkippedItem[];
  history: BridgeOrganizationPlanHistoryItem[];
};

export type BridgeOrganizationPlanPageData = {
  session: BridgeScanSessionSummary;
  plan: BridgeOrganizationPlan | null;
  planningEligibility: OrganizationSuggestionCounts;
  latestExecution: BridgeExecutionRunSummary | null;
};

export type BridgeOrganizationPlanGenerationSuccess = {
  ok: true;
  plan: BridgeOrganizationPlan;
};

export type BridgeOrganizationPlanMutationSuccess = {
  ok: true;
  plan: BridgeOrganizationPlan;
};

export type BridgeOrganizationPlanFailure = {
  ok: false;
  error: string;
};

export type BridgeOrganizationPlanGenerationResponse =
  | BridgeOrganizationPlanGenerationSuccess
  | BridgeOrganizationPlanFailure;

export type BridgeOrganizationPlanMutationResponse =
  | BridgeOrganizationPlanMutationSuccess
  | BridgeOrganizationPlanFailure;

export type BridgeOrganizationPlanDownload = {
  exportedAt: string;
  safety: {
    executionAllowed: false;
    note: string;
  };
  plan: BridgeOrganizationPlan;
};

export type BridgeExecutionPreviewAction = {
  id: string;
  sequence: number;
  actionType: OrganizationPlanActionType;
  sourceRelativePath: string | null;
  destinationRelativePath: string;
  description: string;
};

export type BridgeExecutionIssue = {
  id: string;
  severity: BridgeExecutionIssueSeverity;
  category: BridgeExecutionIssueCategory;
  title: string;
  description: string;
  affectedActionIds: string[];
};

export type BridgeExecutionPreview = {
  organizationPlanId: string;
  canExecute: boolean;
  estimatedOperations: number;
  actions: BridgeExecutionPreviewAction[];
  conflicts: BridgeExecutionIssue[];
  missingFiles: BridgeExecutionIssue[];
  changedFiles: BridgeExecutionIssue[];
  blockingIssues: BridgeExecutionIssue[];
  warnings: BridgeExecutionIssue[];
};

export type BridgeExecutionActionSummary = {
  id: string;
  actionType: string;
  sourceRelativePath: string;
  destinationRelativePath: string;
  status: ExecutionStatus;
  startedAt: string | null;
  completedAt: string | null;
  safeErrorCategory: string | null;
  sourceChecksumBefore: string | null;
  destinationChecksumAfter: string | null;
  sequence: number;
  createdFilesystemItem: boolean;
};

export type BridgeUndoActionSummary = {
  id: string;
  originalExecutionActionId: string;
  actionType: BridgeUndoActionType;
  sourceRelativePath: string;
  destinationRelativePath: string;
  sequence: number;
  status: UndoStatus;
  startedAt: string | null;
  completedAt: string | null;
  safeErrorCategory: string | null;
};

export type BridgeUndoRunSummary = {
  id: string;
  executionRunId: string;
  status: UndoStatus;
  startedAt: string;
  completedAt: string | null;
  totalActions: number;
  completedActions: number;
  failedActions: number;
  durationMs: number | null;
  safeErrorCategory: string | null;
  actions: BridgeUndoActionSummary[];
};

export type BridgeExecutionRunSummary = {
  id: string;
  organizationPlanId: string;
  connectedLibraryId: string;
  status: ExecutionStatus;
  startedAt: string;
  completedAt: string | null;
  totalActions: number;
  completedActions: number;
  successfulActions: number;
  failedActions: number;
  durationMs: number | null;
  safeErrorCategory: string | null;
  errorCategory: string | null;
  bridgeRootId: string | null;
  permissionSnapshot: unknown;
  reconciliationStatus: string;
  actions: BridgeExecutionActionSummary[];
  undoRuns: BridgeUndoRunSummary[];
  latestUndoRun: BridgeUndoRunSummary | null;
};

export type BridgeExecutionPreviewSuccess = {
  ok: true;
  preview: BridgeExecutionPreview;
};

export type BridgeExecutionSuccess = {
  ok: true;
  preview: BridgeExecutionPreview;
  run: BridgeExecutionRunSummary;
  plan: BridgeOrganizationPlan;
};

export type BridgeExecutionFailure = {
  ok: false;
  error: string;
  preview?: BridgeExecutionPreview;
};

export type BridgeExecutionPreviewResponse =
  | BridgeExecutionPreviewSuccess
  | BridgeExecutionFailure;

export type BridgeExecutionResponse =
  | BridgeExecutionSuccess
  | BridgeExecutionFailure;

export type BridgeUndoPreviewAction = {
  id: string;
  originalExecutionActionId: string;
  sequence: number;
  actionType: BridgeUndoActionType;
  sourceRelativePath: string;
  destinationRelativePath: string;
  description: string;
};

export type BridgeUndoPreview = {
  executionRunId: string;
  organizationPlanId: string;
  canUndo: boolean;
  estimatedOperations: number;
  actions: BridgeUndoPreviewAction[];
  conflicts: BridgeExecutionIssue[];
  missingFiles: BridgeExecutionIssue[];
  changedFiles: BridgeExecutionIssue[];
  blockedActions: BridgeExecutionIssue[];
  blockingIssues: BridgeExecutionIssue[];
  warnings: BridgeExecutionIssue[];
};

export type BridgeUndoPreviewSuccess = {
  ok: true;
  preview: BridgeUndoPreview;
};

export type BridgeUndoSuccess = {
  ok: true;
  executionRun: BridgeExecutionRunSummary;
  preview: BridgeUndoPreview;
  run: BridgeUndoRunSummary;
  scanSessionId: string;
};

export type BridgeUndoFailure = {
  ok: false;
  error: string;
  preview?: BridgeUndoPreview;
  run?: BridgeUndoRunSummary;
};

export type BridgeUndoPreviewResponse =
  | BridgeUndoPreviewSuccess
  | BridgeUndoFailure;

export type BridgeUndoResponse = BridgeUndoSuccess | BridgeUndoFailure;
