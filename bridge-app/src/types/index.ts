export const bridgeVersion = process.env.NSN_BRIDGE_APP_VERSION ?? "0.1.0";

export const bridgePlatforms = ["WINDOWS", "MACOS", "LINUX", "UNKNOWN"] as const;
export type BridgePlatform = (typeof bridgePlatforms)[number];

export const bridgeRootStatuses = [
  "CONNECTED",
  "PAUSED",
  "NEEDS_ATTENTION",
  "DISCONNECTED",
] as const;
export type BridgeRootStatus = (typeof bridgeRootStatuses)[number];

export type BridgePermissions = {
  readPermission: boolean;
  watchPermission: boolean;
  recommendationPermission: boolean;
  organizationPlanPermission: boolean;
  createFolderPermission: boolean;
  moveFilePermission: boolean;
  renameFilePermission: boolean;
};

export type BridgeRootRecord = BridgePermissions & {
  id: string;
  actualPath: string;
  connectedAt: string;
  displayName: string;
  lastScanAt: string | null;
  lastWatchingAt: string | null;
  platform: BridgePlatform;
  safeLocation: string;
  status: BridgeRootStatus;
  updatedAt: string;
  watcherState: "WATCHING" | "PAUSED" | "STOPPED" | "NEEDS_ATTENTION";
};

export type BridgeRootSummary = BridgePermissions & {
  id: string;
  connectedAt: string;
  displayName: string;
  lastScanAt: string | null;
  lastWatchingAt: string | null;
  platform: BridgePlatform;
  safeLocation: string;
  status: BridgeRootStatus;
  updatedAt: string;
  watcherState: BridgeRootRecord["watcherState"];
};

export type FolderSelectionRecord = {
  ancestorRootIds: string[];
  actualPath: string;
  createdAt: string;
  expiresAt: string;
  platform: BridgePlatform;
  rootId: string;
  safeLocation: string;
  suggestedDisplayName: string;
  token: string;
};

export type FolderSelectionResult = {
  ancestorRootIds: string[];
  selectionToken: string;
  rootId: string;
  suggestedDisplayName: string;
  platform: BridgePlatform;
  safeLocation: string;
  expiresAt: string;
};

export type BridgeScannedFileDraft = {
  localPath: string;
  relativePath: string;
  fileType: string;
  checksum: string | null;
  sizeBytes: bigint | null;
  lastModified: Date | null;
  sourceCreatedAt?: Date | null;
  readStatus: "PENDING" | "SUPPORTED" | "UNSUPPORTED" | "FAILED";
  scanError?: string | null;
};

export type BridgeFolderScanResult = {
  folderDisplayName: string;
  rootPath: string;
  bridgeRootId: string;
  safeLocation: string;
  files: BridgeScannedFileDraft[];
  totalFiles: number;
  supportedFiles: number;
  unsupportedFiles: number;
  failedFiles: number;
  startedAt: Date;
  completedAt: Date;
};

export type BridgeReadResult = {
  relativePath: string;
  fileName: string;
  fileType: string;
  characterCount: number;
  extractedText: string;
  warnings: string[];
  audioMetadata?: BridgeTemporaryAudioMetadata | null;
  videoMetadata?: BridgeTemporaryVideoMetadata | null;
};

export type BridgeTemporaryAudioMetadata = {
  durationSeconds: number | null;
  sampleRateHz: number | null;
  bitrateKbps: number | null;
  channels: number | null;
  codec: string | null;
  container: string | null;
  sourceCreatedAt: Date | null;
  sourceModifiedAt: Date | null;
  audioFingerprint: string | null;
  transcriptSnippet: string | null;
  summary: string | null;
  transcriptionConfidence: number | null;
  transcriptionStatus: "NOT_REQUESTED" | "TRANSCRIBING" | "COMPLETED" | "UNAVAILABLE" | "FAILED";
  transcriptionErrorCategory: string | null;
  machineLabels: string[];
  provisionalTopics: string[];
  provisionalPeople: string[];
  provisionalProjects: string[];
  provisionalActionItems: string[];
  provisionalQuestions: string[];
};

export type BridgeTemporaryVideoMetadata = {
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
  transcriptSnippet: string | null;
  summary: string | null;
  transcriptionConfidence: number | null;
  transcriptionStatus: "NOT_REQUESTED" | "PROCESSING" | "COMPLETED" | "UNAVAILABLE" | "FAILED";
  transcriptionErrorCategory: string | null;
  frameAnalysisStatus: "NOT_REQUESTED" | "PROCESSING" | "COMPLETED" | "UNAVAILABLE" | "FAILED";
  frameAnalysisErrorCategory: string | null;
  machineLabels: string[];
  provisionalTopics: string[];
  provisionalPeople: string[];
  provisionalProjects: string[];
  provisionalQuestions: string[];
  selectedFrameDescriptions: Array<{
    timestampSeconds: number;
    label: string;
    description: string;
    confidence: number;
  }>;
  chapterSuggestions: Array<{
    timestampSeconds: number;
    title: string;
    confidence: number;
  }>;
  relatedSignals: string[];
};

export type BridgeResolvedFile = {
  localPath: string;
  relativePath: string;
  fileName: string;
  sizeBytes: bigint;
  lastModified: Date;
  sourceCreatedAt: Date | null;
};

export type BridgeChangeEvent = {
  id: string;
  rootId: string;
  eventType:
    | "FILE_ADDED"
    | "FILE_MODIFIED"
    | "FILE_RENAMED"
    | "FILE_MOVED"
    | "FILE_DELETED"
    | "FOLDER_ADDED"
    | "FOLDER_RENAMED"
    | "FOLDER_MOVED"
    | "FOLDER_DELETED";
  relativePath: string;
  detectedAt: string;
};

export type BridgeExecutionPlanAction = {
  id: string;
  actionType:
    | "CREATE_FOLDER"
    | "MOVE_FILE"
    | "RENAME_FILE"
    | "MOVE_AND_RENAME_FILE";
  sourceRelativePath?: string | null;
  sourceChecksum?: string | null;
  sourceLastModified?: string | null;
  sourceSizeBytes?: string | null;
  destinationRelativePath: string;
};

export type BridgeUndoPlanAction = {
  id: string;
  actionType: "REMOVE_FOLDER" | "MOVE_FILE" | "RENAME_FILE";
  sourceRelativePath: string;
  sourceChecksum?: string | null;
  sourceLastModified?: string | null;
  sourceSizeBytes?: string | null;
  destinationRelativePath: string;
};

export class BridgeAppError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, code = "BRIDGE_ERROR", statusCode = 400) {
    super(message);
    this.name = "BridgeAppError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
