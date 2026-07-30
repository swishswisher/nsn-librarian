import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";

import type {
  BridgeDeviceRegistrationRequest,
  BridgePairingCodeStatus,
  BridgePlatform,
  BridgeProtocolValidationResult,
} from "./types";

export const pairingCodeTtlMs = 10 * 60 * 1000;
const pairingAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomPairingCharacter() {
  const index = randomBytes(1)[0] % pairingAlphabet.length;

  return pairingAlphabet[index];
}

export function createPlainPairingCode() {
  const raw = Array.from({ length: 8 }, randomPairingCharacter).join("");

  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizePairingCode(value: string) {
  return value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

export function pairingCodeSuffix(value: string) {
  const normalized = normalizePairingCode(value);

  return normalized.slice(-4);
}

export function hashPairingCode(value: string, secret: string) {
  return createHmac("sha256", secret)
    .update(normalizePairingCode(value))
    .digest("hex");
}

export function createPairingCode(secret: string, now = new Date()) {
  const code = createPlainPairingCode();

  return {
    code,
    codeHash: hashPairingCode(code, secret),
    codeSuffix: pairingCodeSuffix(code),
    expiresAt: new Date(now.getTime() + pairingCodeTtlMs),
  };
}

export function isPairingCodeExpired(expiresAt: Date | string, now = new Date()) {
  return new Date(expiresAt).getTime() <= now.getTime();
}

export function createBridgeDeviceId() {
  return `bridge_device_${randomBytes(18).toString("hex")}`;
}

export function createBridgeKeyPair() {
  const pair = generateKeyPairSync("ed25519");

  return {
    privateKey: pair.privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string,
    publicKey: pair.publicKey.export({
      format: "pem",
      type: "spki",
    }) as string,
  };
}

export function stableDeviceFingerprint(publicKey: string) {
  return createHash("sha256").update(publicKey).digest("hex");
}

export function normalizeBridgePlatform(value: string): BridgePlatform {
  if (value === "WINDOWS" || value === "MACOS" || value === "LINUX") {
    return value;
  }

  return "UNKNOWN";
}

export function validatePairingRedemption(input: {
  actorUserId: string;
  appVersion: string;
  codeHash: string;
  expectedUserId: string;
  expiresAt: Date | string;
  pairingCode: string;
  pairingSecret: string;
  publicKey: string;
  status: BridgePairingCodeStatus;
  now?: Date;
}): BridgeProtocolValidationResult {
  if (input.actorUserId !== input.expectedUserId) {
    return {
      code: "WRONG_USER",
      message: "This pairing code belongs to a different signed-in account.",
      ok: false,
    };
  }

  if (input.status !== "ACTIVE") {
    return {
      code: "PAIRING_CODE_USED",
      message: "This pairing code has already been used or revoked.",
      ok: false,
    };
  }

  if (isPairingCodeExpired(input.expiresAt, input.now)) {
    return {
      code: "PAIRING_CODE_EXPIRED",
      message: "This pairing code has expired.",
      ok: false,
    };
  }

  if (
    hashPairingCode(input.pairingCode, input.pairingSecret) !== input.codeHash
  ) {
    return {
      code: "PAIRING_CODE_MISMATCH",
      message: "The pairing code could not be verified.",
      ok: false,
    };
  }

  if (!input.publicKey.includes("PUBLIC KEY")) {
    return {
      code: "PUBLIC_KEY_REQUIRED",
      message: "The Bridge did not provide a valid public key.",
      ok: false,
    };
  }

  if (!input.appVersion.trim()) {
    return {
      code: "APP_VERSION_REQUIRED",
      message: "The Bridge did not provide its version.",
      ok: false,
    };
  }

  return {
    code: "PAIRING_ALLOWED",
    message: "Pairing is allowed.",
    ok: true,
  };
}

export function pairingRateLimitAllows(activeCodeCount: number, limit = 5) {
  return activeCodeCount < limit;
}

export function normalizeDeviceRegistration(
  input: BridgeDeviceRegistrationRequest,
): BridgeDeviceRegistrationRequest {
  return {
    appVersion: input.appVersion.trim(),
    architecture: input.architecture.trim() || "unknown",
    bridgeDeviceId: input.bridgeDeviceId.trim() || createBridgeDeviceId(),
    deviceDisplayName: input.deviceDisplayName.trim() || "This Mac",
    pairingCode: input.pairingCode.trim(),
    platform: normalizeBridgePlatform(input.platform),
    publicKey: input.publicKey.trim(),
  };
}
