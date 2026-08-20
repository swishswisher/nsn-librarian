import type {
  BridgeCommandEnvelope,
  BridgeCommandReport,
  BridgeCommandType,
  BridgeDeviceRegistrationRequest,
  BridgeDeviceSummary,
  BridgeJson,
  BridgePlatform,
} from "../../../packages/bridge-protocol/src";
import {
  bridgeCommandIsExpired,
  commandStatusAllowsAcknowledgement,
  commandStatusAllowsCompletion,
  createBridgeCommandEnvelope,
  createPairingCode,
  hashPairingCode,
  normalizeDeviceRegistration,
  pairingRateLimitAllows,
  validatePairingRedemption,
} from "../../../packages/bridge-protocol/src";
import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";

const defaultOwnerId = "deanne";
const activePairingCodeLimit = 5;

export class BridgeCloudError extends Error {
  code: string;
  statusCode: number;

  constructor(message: string, statusCode = 400, code = "BRIDGE_CLOUD_ERROR") {
    super(message);
    this.name = "BridgeCloudError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function bridgePairingSecret() {
  const secret = process.env.NSN_BRIDGE_PAIRING_SECRET?.trim();

  if (secret) {
    return secret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new BridgeCloudError(
      "Bridge pairing is not configured for this deployment.",
      503,
    );
  }

  return "development-only-bridge-pairing-secret";
}

function bridgeCommandSigningSecret() {
  const secret = process.env.NSN_BRIDGE_COMMAND_SIGNING_SECRET?.trim();

  if (secret) {
    return secret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new BridgeCloudError(
      "Bridge command signing is not configured for this deployment.",
      503,
    );
  }

  return "development-only-bridge-command-signing-secret";
}

function bridgeJson(value: unknown): BridgeJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(bridgeJson);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        bridgeJson(nested),
      ]),
    );
  }

  return null;
}

function prismaJson(value: BridgeJson) {
  return value === null ? Prisma.JsonNull : value;
}

function deviceSummary(device: {
  appVersion: string;
  architecture: string;
  bridgeDeviceId: string;
  deviceDisplayName: string;
  lastSeenAt: Date | null;
  pairedAt: Date | null;
  platform: string;
  revokedAt: Date | null;
  status: string;
}): BridgeDeviceSummary {
  return {
    appVersion: device.appVersion,
    architecture: device.architecture,
    bridgeDeviceId: device.bridgeDeviceId,
    deviceDisplayName: device.deviceDisplayName,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    pairedAt: device.pairedAt?.toISOString() ?? null,
    platform:
      device.platform === "WINDOWS" ||
      device.platform === "MACOS" ||
      device.platform === "LINUX"
        ? device.platform
        : "UNKNOWN",
    revokedAt: device.revokedAt?.toISOString() ?? null,
    status:
      device.status === "UNPAIRED" ||
      device.status === "PAIRING" ||
      device.status === "PAIRED" ||
      device.status === "ONLINE" ||
      device.status === "OFFLINE" ||
      device.status === "UPDATE_REQUIRED" ||
      device.status === "REVOKED"
        ? device.status
        : "OFFLINE",
  };
}

async function expirePairingCodes(now = new Date()) {
  const prisma = getPrismaClient();

  await prisma.bridgePairingCode.updateMany({
    data: {
      status: "EXPIRED",
    },
    where: {
      expiresAt: {
        lte: now,
      },
      status: "ACTIVE",
    },
  });
}

async function expirePendingCommands(now = new Date()) {
  const prisma = getPrismaClient();

  await prisma.bridgeCommand.updateMany({
    data: {
      status: "EXPIRED",
    },
    where: {
      expiresAt: {
        lte: now,
      },
      status: {
        in: ["PENDING", "ACKNOWLEDGED", "RUNNING"],
      },
    },
  });
}

export async function createBridgePairingCode(actorUserId = defaultOwnerId) {
  const prisma = getPrismaClient();
  const now = new Date();

  await expirePairingCodes(now);

  const activeCodeCount = await prisma.bridgePairingCode.count({
    where: {
      expiresAt: {
        gt: now,
      },
      requestedByUserId: actorUserId,
      status: "ACTIVE",
    },
  });

  if (!pairingRateLimitAllows(activeCodeCount, activePairingCodeLimit)) {
    throw new BridgeCloudError(
      "Too many pairing codes are active. Wait a moment before creating another one.",
      429,
    );
  }

  const pairing = createPairingCode(bridgePairingSecret(), now);
  const row = await prisma.bridgePairingCode.create({
    data: {
      codeHash: pairing.codeHash,
      codeSuffix: pairing.codeSuffix,
      expiresAt: pairing.expiresAt,
      requestedByUserId: actorUserId,
      status: "ACTIVE",
    },
  });

  await prisma.bridgeAuditEntry.create({
    data: {
      actorUserId,
      eventType: "PAIRING_CODE_CREATED",
      pairingCodeId: row.id,
      safeSummary: "A short-lived Bridge pairing code was created.",
    },
  });

  return {
    code: pairing.code,
    expiresAt: row.expiresAt.toISOString(),
    id: row.id,
  };
}

export async function pairBridgeDevice(
  input: BridgeDeviceRegistrationRequest,
  actorUserId = defaultOwnerId,
) {
  const prisma = getPrismaClient();
  const registration = normalizeDeviceRegistration(input);
  const codeHash = hashPairingCode(
    registration.pairingCode,
    bridgePairingSecret(),
  );
  const pairing = await prisma.bridgePairingCode.findUnique({
    where: {
      codeHash,
    },
  });

  if (!pairing) {
    throw new BridgeCloudError(
      "That pairing code could not be verified.",
      401,
      "PAIRING_CODE_INVALID",
    );
  }

  const validation = validatePairingRedemption({
    actorUserId,
    appVersion: registration.appVersion,
    codeHash: pairing.codeHash,
    expectedUserId: pairing.requestedByUserId,
    expiresAt: pairing.expiresAt,
    pairingCode: registration.pairingCode,
    pairingSecret: bridgePairingSecret(),
    publicKey: registration.publicKey,
    status: pairing.status,
  });

  if (!validation.ok) {
    await prisma.bridgePairingCode.update({
      data: {
        attemptCount: {
          increment: 1,
        },
      },
      where: {
        id: pairing.id,
      },
    });
    throw new BridgeCloudError(validation.message, 401, validation.code);
  }

  const now = new Date();
  const device = await prisma.$transaction(async (tx) => {
    const nextDevice = await tx.bridgeDevice.upsert({
      create: {
        appVersion: registration.appVersion,
        architecture: registration.architecture,
        bridgeDeviceId: registration.bridgeDeviceId,
        deviceDisplayName: registration.deviceDisplayName,
        lastSeenAt: null,
        pairedAt: now,
        platform: registration.platform,
        publicKey: registration.publicKey,
        revokedAt: null,
        status: "PAIRED",
      },
      update: {
        appVersion: registration.appVersion,
        architecture: registration.architecture,
        deviceDisplayName: registration.deviceDisplayName,
        lastSeenAt: null,
        pairedAt: now,
        platform: registration.platform,
        publicKey: registration.publicKey,
        revokedAt: null,
        status: "PAIRED",
      },
      where: {
        bridgeDeviceId: registration.bridgeDeviceId,
      },
    });

    await tx.bridgePairingCode.update({
      data: {
        consumedAt: now,
        pairedDeviceId: nextDevice.bridgeDeviceId,
        status: "CONSUMED",
      },
      where: {
        id: pairing.id,
      },
    });

    await tx.bridgeAuditEntry.create({
      data: {
        actorUserId,
        bridgeDeviceId: nextDevice.bridgeDeviceId,
        eventType: "DEVICE_PAIRED",
        pairingCodeId: pairing.id,
        safeSummary: "A Mac was paired with NSN Librarian.",
      },
    });

    return nextDevice;
  });

  return deviceSummary(device);
}

export async function listBridgeDevices() {
  const prisma = getPrismaClient();
  const devices = await prisma.bridgeDevice.findMany({
    orderBy: [{ status: "asc" }, { lastSeenAt: "desc" }],
  });

  return devices.map(deviceSummary);
}

export async function recordBridgeHeartbeat(
  bridgeDeviceId: string,
  input: {
    appVersion?: unknown;
    architecture?: unknown;
    platform?: unknown;
  } = {},
) {
  const prisma = getPrismaClient();
  const existing = await prisma.bridgeDevice.findUnique({
    where: {
      bridgeDeviceId,
    },
  });

  if (!existing || existing.status === "REVOKED") {
    throw new BridgeCloudError(
      "This Bridge device is not paired.",
      401,
      "DEVICE_NOT_PAIRED",
    );
  }

  const now = new Date();
  const device = await prisma.bridgeDevice.update({
    data: {
      appVersion:
        typeof input.appVersion === "string" && input.appVersion.trim()
          ? input.appVersion.trim()
          : existing.appVersion,
      architecture:
        typeof input.architecture === "string" && input.architecture.trim()
          ? input.architecture.trim()
          : existing.architecture,
      lastSeenAt: now,
      platform:
        input.platform === "WINDOWS" ||
        input.platform === "MACOS" ||
        input.platform === "LINUX" ||
        input.platform === "UNKNOWN"
          ? input.platform
          : existing.platform,
      status: "ONLINE",
    },
    where: {
      bridgeDeviceId,
    },
  });

  await prisma.bridgeAuditEntry.create({
    data: {
      bridgeDeviceId,
      eventType: "HEARTBEAT_RECEIVED",
      safeSummary: "The Bridge checked in with NSN Librarian.",
    },
  });

  return deviceSummary(device);
}

export async function revokeBridgeDevice(bridgeDeviceId: string) {
  const prisma = getPrismaClient();
  const now = new Date();
  const device = await prisma.bridgeDevice.update({
    data: {
      revokedAt: now,
      status: "REVOKED",
    },
    where: {
      bridgeDeviceId,
    },
  });

  await prisma.bridgeCommand.updateMany({
    data: {
      status: "CANCELLED",
    },
    where: {
      bridgeDeviceId,
      status: {
        in: ["PENDING", "ACKNOWLEDGED", "RUNNING"],
      },
    },
  });

  await prisma.connectedLibrary.updateMany({
    data: {
      isEnabled: false,
      monitoringState: "STOPPED",
      status: "DISCONNECTED",
      watchPermission: false,
    },
    where: {
      bridgeDeviceId,
    },
  });

  await prisma.bridgeAuditEntry.create({
    data: {
      bridgeDeviceId,
      eventType: "DEVICE_REVOKED",
      safeSummary: "A paired Bridge device was revoked.",
    },
  });

  return deviceSummary(device);
}

async function assertCommandTarget(input: {
  bridgeDeviceId: string;
  bridgeRootId?: string | null;
  connectedLibraryId?: string | null;
}) {
  if (!input.connectedLibraryId) {
    return;
  }

  const prisma = getPrismaClient();
  const library = await prisma.connectedLibrary.findUnique({
    where: {
      id: input.connectedLibraryId,
    },
  });

  if (!library) {
    throw new BridgeCloudError(
      "The Librarian could not find that connected library.",
      404,
    );
  }

  if (library.bridgeDeviceId && library.bridgeDeviceId !== input.bridgeDeviceId) {
    throw new BridgeCloudError(
      "This command belongs to a different paired Mac.",
      403,
    );
  }

  if (
    input.bridgeRootId &&
    library.bridgeRootId &&
    library.bridgeRootId !== input.bridgeRootId
  ) {
    throw new BridgeCloudError(
      "This command points to a different connected folder.",
      403,
    );
  }
}

export async function createBridgeCloudCommand(input: {
  authorizationContext?: BridgeJson;
  bridgeDeviceId: string;
  bridgeRootId?: string | null;
  commandType: BridgeCommandType;
  connectedLibraryId?: string | null;
  expiresAt?: Date;
  idempotencyKey?: string;
  payload?: BridgeJson;
}) {
  const prisma = getPrismaClient();
  const device = await prisma.bridgeDevice.findUnique({
    where: {
      bridgeDeviceId: input.bridgeDeviceId,
    },
  });

  if (!device || device.status === "REVOKED") {
    throw new BridgeCloudError("This Bridge device is not available.", 403);
  }

  await assertCommandTarget(input);

  const envelope = createBridgeCommandEnvelope({
    authorizationContext: input.authorizationContext ?? {},
    bridgeDeviceId: input.bridgeDeviceId,
    bridgeRootId: input.bridgeRootId ?? null,
    commandType: input.commandType,
    connectedLibraryId: input.connectedLibraryId ?? null,
    expiresAt: input.expiresAt,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload ?? {},
    signingSecret: bridgeCommandSigningSecret(),
  });
  const existing = await prisma.bridgeCommand.findUnique({
    where: {
      idempotencyKey: envelope.idempotencyKey,
    },
  });

  if (existing) {
    return commandEnvelopeFromRow(existing);
  }

  const row = await prisma.bridgeCommand.create({
    data: {
      authorizationContext: prismaJson(envelope.authorizationContext),
      bridgeDeviceId: envelope.bridgeDeviceId,
      bridgeRootId: envelope.bridgeRootId,
      commandId: envelope.commandId,
      commandType: envelope.commandType,
      connectedLibraryId: envelope.connectedLibraryId,
      expiresAt: new Date(envelope.expiresAt),
      idempotencyKey: envelope.idempotencyKey,
      issuedAt: new Date(envelope.issuedAt),
      payload: prismaJson(envelope.payload),
      payloadHash: envelope.payloadHash,
      signature: envelope.signature,
      status: "PENDING",
    },
  });

  await prisma.bridgeAuditEntry.create({
    data: {
      bridgeDeviceId: row.bridgeDeviceId,
      commandId: row.commandId,
      connectedLibraryId: row.connectedLibraryId,
      eventType: "COMMAND_CREATED",
      safeSummary: "A Bridge command was queued for a paired Mac.",
    },
  });

  return commandEnvelopeFromRow(row);
}

export async function queueExecutionCommandForApprovedPlan(
  planId: string,
  confirmation: unknown,
) {
  if (confirmation !== "EXECUTE") {
    throw new BridgeCloudError(
      "Type EXECUTE before the Bridge can execute this plan.",
      400,
    );
  }

  const prisma = getPrismaClient();
  const plan = await prisma.organizationPlan.findUnique({
    select: {
      actions: true,
      connectedLibrary: {
        select: {
          bridgeDeviceId: true,
          bridgeRootId: true,
          id: true,
          isEnabled: true,
          status: true,
        },
      },
      connectedLibraryId: true,
      id: true,
      scanSessionId: true,
      status: true,
      totalActions: true,
      warnings: true,
    },
    where: {
      id: planId,
    },
  });

  if (!plan) {
    throw new BridgeCloudError(
      "The Librarian could not find that organization plan.",
      404,
    );
  }

  if (!plan.connectedLibrary.bridgeDeviceId) {
    return null;
  }

  if (plan.status !== "READY_FOR_EXECUTION") {
    throw new BridgeCloudError(
      "This plan is not approved for execution yet.",
      409,
    );
  }

  if (plan.totalActions <= 0) {
    throw new BridgeCloudError(
      "No planned actions are ready to execute.",
      409,
    );
  }

  if (
    !plan.connectedLibrary.isEnabled ||
    plan.connectedLibrary.status === "DISCONNECTED"
  ) {
    throw new BridgeCloudError(
      "Reconnect this Mac before executing the plan.",
      409,
    );
  }

  if (!plan.connectedLibrary.bridgeRootId) {
    throw new BridgeCloudError(
      "Reconnect this folder before executing the plan.",
      409,
    );
  }

  return createBridgeCloudCommand({
    authorizationContext: {
      approvedBy: "Deanne",
      confirmation: "EXECUTE",
      expiresReason:
        "Organization execution commands are short-lived and plan-specific.",
    },
    bridgeDeviceId: plan.connectedLibrary.bridgeDeviceId,
    bridgeRootId: plan.connectedLibrary.bridgeRootId,
    commandType: "EXECUTE_PLAN",
    connectedLibraryId: plan.connectedLibraryId,
    idempotencyKey: `execute-plan:${plan.id}`,
    payload: {
      actions: bridgeJson(plan.actions),
      organizationPlanId: plan.id,
      scanSessionId: plan.scanSessionId,
      warnings: bridgeJson(plan.warnings),
    },
  });
}

function commandEnvelopeFromRow(row: {
  authorizationContext: unknown;
  bridgeDeviceId: string;
  bridgeRootId: string | null;
  commandId: string;
  commandType: string;
  connectedLibraryId: string | null;
  expiresAt: Date;
  idempotencyKey: string;
  issuedAt: Date;
  payload: unknown;
  payloadHash: string;
  signature: string;
}): BridgeCommandEnvelope {
  return {
    authorizationContext: bridgeJson(row.authorizationContext),
    bridgeDeviceId: row.bridgeDeviceId,
    bridgeRootId: row.bridgeRootId,
    commandId: row.commandId,
    commandType: row.commandType as BridgeCommandType,
    connectedLibraryId: row.connectedLibraryId,
    expiresAt: row.expiresAt.toISOString(),
    idempotencyKey: row.idempotencyKey,
    issuedAt: row.issuedAt.toISOString(),
    payload: bridgeJson(row.payload),
    payloadHash: row.payloadHash,
    signature: row.signature,
  };
}

export async function fetchPendingBridgeCloudCommands(bridgeDeviceId: string) {
  const prisma = getPrismaClient();

  await recordBridgeHeartbeat(bridgeDeviceId).catch(() => undefined);
  await expirePendingCommands();

  const rows = await prisma.bridgeCommand.findMany({
    orderBy: {
      issuedAt: "asc",
    },
    where: {
      bridgeDeviceId,
      expiresAt: {
        gt: new Date(),
      },
      status: "PENDING",
    },
  });

  return rows.map(commandEnvelopeFromRow);
}

export async function acknowledgeBridgeCloudCommand(
  bridgeDeviceId: string,
  commandId: string,
) {
  const prisma = getPrismaClient();
  const row = await prisma.bridgeCommand.findUnique({
    where: {
      commandId,
    },
  });

  if (!row || row.bridgeDeviceId !== bridgeDeviceId) {
    throw new BridgeCloudError("That Bridge command could not be found.", 404);
  }

  if (bridgeCommandIsExpired(row.expiresAt)) {
    await prisma.bridgeCommand.update({
      data: {
        status: "EXPIRED",
      },
      where: {
        commandId,
      },
    });
    throw new BridgeCloudError("That Bridge command has expired.", 410);
  }

  if (!commandStatusAllowsAcknowledgement(row.status)) {
    return commandEnvelopeFromRow(row);
  }

  const acknowledged = await prisma.bridgeCommand.update({
    data: {
      acknowledgedAt: new Date(),
      status: "ACKNOWLEDGED",
    },
    where: {
      commandId,
    },
  });

  await prisma.bridgeAuditEntry.create({
    data: {
      bridgeDeviceId,
      commandId,
      connectedLibraryId: row.connectedLibraryId,
      eventType: "COMMAND_ACKNOWLEDGED",
      safeSummary: "The Bridge acknowledged a queued command.",
    },
  });

  return commandEnvelopeFromRow(acknowledged);
}

export async function completeBridgeCloudCommand(
  bridgeDeviceId: string,
  report: BridgeCommandReport,
) {
  const prisma = getPrismaClient();
  const row = await prisma.bridgeCommand.findUnique({
    where: {
      commandId: report.commandId,
    },
  });

  if (!row || row.bridgeDeviceId !== bridgeDeviceId) {
    throw new BridgeCloudError("That Bridge command could not be found.", 404);
  }

  if (row.status === "COMPLETED" || row.status === "FAILED") {
    return commandEnvelopeFromRow(row);
  }

  if (!commandStatusAllowsCompletion(row.status)) {
    throw new BridgeCloudError(
      "The Bridge command has not been acknowledged yet.",
      409,
    );
  }

  const completed = await prisma.bridgeCommand.update({
    data: {
      completedAt: new Date(),
      result: prismaJson(report.result ?? null),
      safeErrorCategory: report.safeErrorCategory ?? null,
      status: report.status,
    },
    where: {
      commandId: report.commandId,
    },
  });

  await prisma.bridgeAuditEntry.create({
    data: {
      bridgeDeviceId,
      commandId: report.commandId,
      connectedLibraryId: row.connectedLibraryId,
      eventType:
        report.status === "COMPLETED"
          ? "COMMAND_COMPLETED"
          : "COMMAND_REJECTED",
      safeSummary:
        report.status === "COMPLETED"
          ? "The Bridge completed a command safely."
          : "The Bridge rejected or failed a command safely.",
    },
  });

  return commandEnvelopeFromRow(completed);
}

export async function getBridgeCloudStatus() {
  const prisma = getPrismaClient();
  const [devices, connectedLibraries] = await Promise.all([
    listBridgeDevices(),
    prisma.connectedLibrary.findMany({
      select: {
        bridgeDeviceId: true,
        bridgeRootId: true,
        displayName: true,
        id: true,
        monitoringState: true,
        status: true,
      },
      where: {
        status: {
          notIn: ["MERGED", "HIDDEN_FROM_ACTIVE_LIST"],
        },
      },
    }),
  ]);

  return {
    connectedLibraries: connectedLibraries.map((library) => ({
      bridgeDeviceId: library.bridgeDeviceId,
      bridgeRootId: library.bridgeRootId,
      displayName: library.displayName,
      id: library.id,
      monitoringState: library.monitoringState,
      status: library.status,
    })),
    devices,
  };
}

export function platformFromRequest(value: unknown): BridgePlatform {
  return value === "WINDOWS" ||
    value === "MACOS" ||
    value === "LINUX" ||
    value === "UNKNOWN"
    ? value
    : "UNKNOWN";
}
