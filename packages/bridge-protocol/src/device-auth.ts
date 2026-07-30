import {
  createHash,
  randomBytes,
  sign as signPayload,
  verify as verifyPayload,
} from "node:crypto";

export const bridgeRequestMaxClockSkewMs = 5 * 60 * 1000;

export const bridgeRequestHeaderNames = {
  deviceId: "x-nsn-bridge-device-id",
  nonce: "x-nsn-bridge-nonce",
  signature: "x-nsn-bridge-signature",
  timestamp: "x-nsn-bridge-timestamp",
} as const;

export type BridgeSignedRequestInput = {
  bodyText?: string;
  bridgeDeviceId: string;
  method: string;
  nonce: string;
  pathname: string;
  timestamp: string;
};

export function hashBridgeRequestBody(bodyText = "") {
  return createHash("sha256").update(bodyText).digest("hex");
}

export function createBridgeRequestNonce() {
  return randomBytes(24).toString("hex");
}

export function canonicalBridgeRequest(input: BridgeSignedRequestInput) {
  return [
    input.bridgeDeviceId,
    input.method.toUpperCase(),
    input.pathname,
    input.timestamp,
    input.nonce,
    hashBridgeRequestBody(input.bodyText ?? ""),
  ].join("\n");
}

export function signBridgeDeviceRequest(
  input: BridgeSignedRequestInput & { privateKey: string },
) {
  return signPayload(
    null,
    Buffer.from(canonicalBridgeRequest(input), "utf8"),
    input.privateKey,
  ).toString("base64");
}

export function verifyBridgeDeviceRequestSignature(
  input: BridgeSignedRequestInput & {
    publicKey: string;
    signature: string;
  },
) {
  try {
    return verifyPayload(
      null,
      Buffer.from(canonicalBridgeRequest(input), "utf8"),
      input.publicKey,
      Buffer.from(input.signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function bridgeRequestTimestampIsFresh(
  timestamp: string,
  now = new Date(),
  maxClockSkewMs = bridgeRequestMaxClockSkewMs,
) {
  const value = new Date(timestamp).getTime();

  if (Number.isNaN(value)) {
    return false;
  }

  return Math.abs(now.getTime() - value) <= maxClockSkewMs;
}

export function createBridgeDeviceRequestHeaders(input: {
  bodyText?: string;
  bridgeDeviceId: string;
  method: string;
  pathname: string;
  privateKey: string;
  nonce?: string;
  timestamp?: string;
}) {
  const nonce = input.nonce ?? createBridgeRequestNonce();
  const timestamp = input.timestamp ?? new Date().toISOString();
  const signature = signBridgeDeviceRequest({
    bodyText: input.bodyText,
    bridgeDeviceId: input.bridgeDeviceId,
    method: input.method,
    nonce,
    pathname: input.pathname,
    privateKey: input.privateKey,
    timestamp,
  });

  return {
    [bridgeRequestHeaderNames.deviceId]: input.bridgeDeviceId,
    [bridgeRequestHeaderNames.nonce]: nonce,
    [bridgeRequestHeaderNames.signature]: signature,
    [bridgeRequestHeaderNames.timestamp]: timestamp,
  };
}
