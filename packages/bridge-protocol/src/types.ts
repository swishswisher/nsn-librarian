export const bridgePlatforms = [
  "WINDOWS",
  "MACOS",
  "LINUX",
  "UNKNOWN",
] as const;
export type BridgePlatform = (typeof bridgePlatforms)[number];

export const bridgeDeviceStatuses = [
  "UNPAIRED",
  "PAIRING",
  "PAIRED",
  "ONLINE",
  "OFFLINE",
  "UPDATE_REQUIRED",
  "REVOKED",
] as const;
export type BridgeDeviceStatus = (typeof bridgeDeviceStatuses)[number];

export const bridgePairingCodeStatuses = [
  "ACTIVE",
  "CONSUMED",
  "EXPIRED",
  "REVOKED",
] as const;
export type BridgePairingCodeStatus =
  (typeof bridgePairingCodeStatuses)[number];

export const bridgeCommandTypes = [
  "SELECT_FOLDERS",
  "REGISTER_ROOT",
  "SCAN_LIBRARY",
  "START_WATCHING",
  "PAUSE_WATCHING",
  "RESUME_WATCHING",
  "STOP_WATCHING",
  "READ_FILE_TEMPORARILY",
  "PREVIEW_EXECUTION",
  "EXECUTE_PLAN",
  "PREVIEW_UNDO",
  "EXECUTE_UNDO",
  "RECONCILE_LIBRARY",
  "REVOKE_ROOT_ACCESS",
] as const;
export type BridgeCommandType = (typeof bridgeCommandTypes)[number];

export const bridgeCommandStatuses = [
  "PENDING",
  "ACKNOWLEDGED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
  "REJECTED",
] as const;
export type BridgeCommandStatus = (typeof bridgeCommandStatuses)[number];

export type BridgeJson =
  | null
  | boolean
  | number
  | string
  | BridgeJson[]
  | { [key: string]: BridgeJson };

export type BridgeDeviceRegistrationRequest = {
  appVersion: string;
  architecture: string;
  bridgeDeviceId: string;
  deviceDisplayName: string;
  pairingCode: string;
  platform: BridgePlatform;
  publicKey: string;
};

export type BridgeDeviceSummary = {
  appVersion: string;
  architecture: string;
  bridgeDeviceId: string;
  deviceDisplayName: string;
  lastSeenAt: string | null;
  pairedAt: string | null;
  platform: BridgePlatform;
  revokedAt: string | null;
  status: BridgeDeviceStatus;
};

export type BridgeCommandEnvelope = {
  authorizationContext: BridgeJson;
  bridgeDeviceId: string;
  bridgeRootId: string | null;
  commandId: string;
  commandType: BridgeCommandType;
  connectedLibraryId: string | null;
  expiresAt: string;
  idempotencyKey: string;
  issuedAt: string;
  payload: BridgeJson;
  payloadHash: string;
  signature: string;
};

export type BridgeCommandReport = {
  commandId: string;
  result?: BridgeJson;
  safeErrorCategory?: string | null;
  status: Extract<BridgeCommandStatus, "COMPLETED" | "FAILED" | "REJECTED">;
};

export type BridgeReleaseAsset = {
  architecture: "arm64" | "x64" | "universal";
  available: boolean;
  fileName: string;
  kind: "dmg" | "json" | "checksums";
  sha256: string;
  sizeBytes: number | null;
  url: string | null;
};

export type BridgeReleaseManifest = {
  assets: BridgeReleaseAsset[];
  minimumMacOSVersion: string;
  privacySummary: string[];
  releaseDate: string;
  releaseNotes: string[];
  systemRequirements: string[];
  version: string;
};

export type BridgeProtocolValidationResult = {
  ok: boolean;
  code: string;
  message: string;
};
