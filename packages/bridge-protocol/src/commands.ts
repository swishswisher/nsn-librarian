import { createHash, createHmac, randomUUID } from "node:crypto";

import type {
  BridgeCommandEnvelope,
  BridgeCommandStatus,
  BridgeCommandType,
  BridgeJson,
  BridgeProtocolValidationResult,
} from "./types";

export const defaultCommandTtlMs = 5 * 60 * 1000;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  );

  return `{${entries
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableStringify(nestedValue)}`)
    .join(",")}}`;
}

export function hashBridgeCommandPayload(payload: BridgeJson) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function signingPayload(envelope: Omit<BridgeCommandEnvelope, "signature">) {
  return stableStringify({
    authorizationContext: envelope.authorizationContext,
    bridgeDeviceId: envelope.bridgeDeviceId,
    bridgeRootId: envelope.bridgeRootId,
    commandId: envelope.commandId,
    commandType: envelope.commandType,
    connectedLibraryId: envelope.connectedLibraryId,
    expiresAt: envelope.expiresAt,
    idempotencyKey: envelope.idempotencyKey,
    issuedAt: envelope.issuedAt,
    payloadHash: envelope.payloadHash,
  });
}

export function signBridgeCommandEnvelope(
  envelope: Omit<BridgeCommandEnvelope, "signature">,
  secret: string,
) {
  return createHmac("sha256", secret)
    .update(signingPayload(envelope))
    .digest("hex");
}

export function verifyBridgeCommandSignature(
  envelope: BridgeCommandEnvelope,
  secret: string,
) {
  const { signature, ...unsigned } = envelope;

  return signature === signBridgeCommandEnvelope(unsigned, secret);
}

export function createBridgeCommandEnvelope(input: {
  authorizationContext?: BridgeJson;
  bridgeDeviceId: string;
  bridgeRootId?: string | null;
  commandId?: string;
  commandType: BridgeCommandType;
  connectedLibraryId?: string | null;
  expiresAt?: Date;
  idempotencyKey?: string;
  issuedAt?: Date;
  payload?: BridgeJson;
  signingSecret: string;
}): BridgeCommandEnvelope {
  const issuedAt = input.issuedAt ?? new Date();
  const expiresAt =
    input.expiresAt ?? new Date(issuedAt.getTime() + defaultCommandTtlMs);
  const payload = input.payload ?? {};
  const unsigned = {
    authorizationContext: input.authorizationContext ?? {},
    bridgeDeviceId: input.bridgeDeviceId,
    bridgeRootId: input.bridgeRootId ?? null,
    commandId: input.commandId ?? randomUUID(),
    commandType: input.commandType,
    connectedLibraryId: input.connectedLibraryId ?? null,
    expiresAt: expiresAt.toISOString(),
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    issuedAt: issuedAt.toISOString(),
    payload,
    payloadHash: hashBridgeCommandPayload(payload),
  };

  return {
    ...unsigned,
    signature: signBridgeCommandEnvelope(unsigned, input.signingSecret),
  };
}

export function bridgeCommandIsExpired(
  expiresAt: string | Date,
  now = new Date(),
) {
  return new Date(expiresAt).getTime() <= now.getTime();
}

export function createBridgeCommandReplayKey(envelope: Pick<BridgeCommandEnvelope, "bridgeDeviceId" | "commandId" | "idempotencyKey">) {
  return `${envelope.bridgeDeviceId}:${envelope.commandId}:${envelope.idempotencyKey}`;
}

export function validateBridgeCommandForDevice(input: {
  alreadyProcessedReplayKeys?: Set<string>;
  deviceStatus: "PAIRED" | "ONLINE" | "OFFLINE" | "REVOKED" | string;
  envelope: BridgeCommandEnvelope;
  expectedBridgeDeviceId: string;
  now?: Date;
  signingSecret: string;
}): BridgeProtocolValidationResult {
  if (input.deviceStatus === "REVOKED") {
    return {
      code: "DEVICE_REVOKED",
      message: "This Bridge device has been revoked.",
      ok: false,
    };
  }

  if (input.envelope.bridgeDeviceId !== input.expectedBridgeDeviceId) {
    return {
      code: "WRONG_DEVICE",
      message: "This command belongs to another Bridge device.",
      ok: false,
    };
  }

  if (bridgeCommandIsExpired(input.envelope.expiresAt, input.now)) {
    return {
      code: "COMMAND_EXPIRED",
      message: "This Bridge command has expired.",
      ok: false,
    };
  }

  if (
    hashBridgeCommandPayload(input.envelope.payload) !==
    input.envelope.payloadHash
  ) {
    return {
      code: "PAYLOAD_CHANGED",
      message: "This Bridge command payload could not be verified.",
      ok: false,
    };
  }

  if (!verifyBridgeCommandSignature(input.envelope, input.signingSecret)) {
    return {
      code: "COMMAND_SIGNATURE_INVALID",
      message: "This Bridge command signature could not be verified.",
      ok: false,
    };
  }

  if (
    input.alreadyProcessedReplayKeys?.has(
      createBridgeCommandReplayKey(input.envelope),
    )
  ) {
    return {
      code: "COMMAND_REPLAYED",
      message: "This Bridge command has already been processed.",
      ok: false,
    };
  }

  return {
    code: "COMMAND_ALLOWED",
    message: "This Bridge command can be handled.",
    ok: true,
  };
}

export function commandStatusAllowsAcknowledgement(status: BridgeCommandStatus) {
  return status === "PENDING";
}

export function commandStatusAllowsCompletion(status: BridgeCommandStatus) {
  return status === "ACKNOWLEDGED" || status === "RUNNING";
}
