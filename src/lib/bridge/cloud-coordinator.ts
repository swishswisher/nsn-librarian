import { retireRootReadWork } from "./command-lifecycle";
import { expireUnstartedCommands, settleUnstartedCommands } from "./command-lifecycle";
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
  commandStatusAllowsCompletion,
  createBridgeCommandEnvelope,
  createPairingCode,
  hashPairingCode,
  normalizeDeviceRegistration,
  pairingRateLimitAllows,
  validatePairingRedemption,
} from "../../../packages/bridge-protocol/src";
import { Prisma, type ConnectedLibrary } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import { lockAuthorityOwner } from "@/lib/db/authority";
import { deviceKeyFingerprint, latestScannedFileObservation, usableObservation } from "./observation-authority";
import { isCurrentReadableRoot } from "./current-readable-root";

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

async function expirePendingCommands(now = new Date()) { await expireUnstartedCommands(now); }

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

  const device = await prisma.$transaction(async (tx) => {
    await lockAuthorityOwner(tx, "BridgePairingCode", pairing.id);
    const current = await tx.bridgePairingCode.findUniqueOrThrow({ where: { id: pairing.id } });
    const freshValidation = validatePairingRedemption({
      actorUserId, appVersion: registration.appVersion, codeHash: current.codeHash,
      expectedUserId: current.requestedByUserId, expiresAt: current.expiresAt,
      pairingCode: registration.pairingCode, pairingSecret: bridgePairingSecret(),
      publicKey: registration.publicKey, status: current.status,
    });
    if (!freshValidation.ok) {
      throw new BridgeCloudError(freshValidation.message, 401, freshValidation.code);
    }
    const now = new Date();
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`bridge-device:${registration.bridgeDeviceId}`}, 0))::text`;
    const prior = await tx.bridgeDevice.findUnique({ where: { bridgeDeviceId: registration.bridgeDeviceId } });
    if (prior) await lockAuthorityOwner(tx, "BridgeDevice", prior.id);
    const previousDevice = prior ? await tx.bridgeDevice.findUniqueOrThrow({ where: { id: prior.id } }) : null;
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

    if (previousDevice && previousDevice.publicKey !== registration.publicKey) {
      await tx.connectedLibrary.updateMany({ where: { bridgeDeviceId: registration.bridgeDeviceId }, data: {
        isEnabled: false, disconnectedAt: now, status: "DISCONNECTED", monitoringState: "STOPPED", watchPermission: false,
      } });
      for (const root of await tx.connectedLibrary.findMany({ where: { bridgeDeviceId: registration.bridgeDeviceId }, select: { id: true }, orderBy: { id: "asc" } }))
        await retireRootReadWork(tx, root.id);
      await settleUnstartedCommands(tx, { bridgeDeviceId: registration.bridgeDeviceId }, "CANCELLED", "DEVICE_KEY_CHANGED");
    }
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
  expectedPublicKey?: string,
) {
  const prisma = getPrismaClient();
  const device = await prisma.$transaction(async (tx) => {
    const owner = await tx.bridgeDevice.findUnique({ where: { bridgeDeviceId }, select: { id: true } });
    if (owner) await lockAuthorityOwner(tx, "BridgeDevice", owner.id);
    const existing = await tx.bridgeDevice.findUnique({ where: { bridgeDeviceId } });
    if (!existing || existing.status === "REVOKED" || existing.revokedAt || (expectedPublicKey && existing.publicKey !== expectedPublicKey)) {
      throw new BridgeCloudError("This Bridge device is not paired.", 401, "DEVICE_NOT_PAIRED");
    }
    const device = await tx.bridgeDevice.update({
    data: {
      appVersion:
        typeof input.appVersion === "string" && input.appVersion.trim()
          ? input.appVersion.trim()
          : existing.appVersion,
      architecture:
        typeof input.architecture === "string" && input.architecture.trim()
          ? input.architecture.trim()
          : existing.architecture,
      lastSeenAt: new Date(),
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

    await tx.bridgeAuditEntry.create({
    data: {
      bridgeDeviceId,
      eventType: "HEARTBEAT_RECEIVED",
      safeSummary: "The Bridge checked in with NSN Librarian.",
    },
    });
    return device;
  });
  return deviceSummary(device);
}

export async function revokeBridgeDevice(bridgeDeviceId: string) {
  const prisma = getPrismaClient();
  const now = new Date();
  const device = await prisma.$transaction(async (tx) => {
    const owner = await tx.bridgeDevice.findUniqueOrThrow({ where: { bridgeDeviceId }, select: { id: true } });
    await lockAuthorityOwner(tx, "BridgeDevice", owner.id);
    const device = await tx.bridgeDevice.update({
    data: {
      revokedAt: now,
      status: "REVOKED",
    },
    where: {
      bridgeDeviceId,
    },
    });
    await tx.connectedLibrary.updateMany({
    data: {
      isEnabled: false,
      disconnectedAt: now,
      monitoringState: "STOPPED",
      status: "DISCONNECTED",
      watchPermission: false,
    },
    where: {
      bridgeDeviceId,
    },
    });
    for (const root of await tx.connectedLibrary.findMany({ where: { bridgeDeviceId }, select: { id: true }, orderBy: { id: "asc" } })) await retireRootReadWork(tx, root.id);
    await settleUnstartedCommands(tx, { bridgeDeviceId }, "CANCELLED", "DEVICE_REVOKED");
    await tx.bridgeAuditEntry.create({
    data: {
      bridgeDeviceId,
      eventType: "DEVICE_REVOKED",
      safeSummary: "A paired Bridge device was revoked.",
    },
    });
    return device;
  });
  return deviceSummary(device);
}

async function assertCommandTarget(input: {
  bridgeDeviceId: string;
  bridgeRootId?: string | null;
  connectedLibraryId?: string | null;
  commandType: BridgeCommandType;
}, prisma: Prisma.TransactionClient = getPrismaClient()) {
  if (!input.connectedLibraryId) {
    if (!["SELECT_FOLDERS", "REGISTER_ROOT"].includes(input.commandType)) {
      throw new BridgeCloudError("This command requires a connected folder.", 403);
    }
    return;
  }

  await prisma.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${input.connectedLibraryId} FOR SHARE`;

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

  if (library.bridgeDeviceId !== input.bridgeDeviceId) {
    throw new BridgeCloudError(
      "This command belongs to a different paired Mac.",
      403,
    );
  }

  if (
    !input.bridgeRootId || library.bridgeRootId !== input.bridgeRootId
  ) {
    throw new BridgeCloudError(
      "This command points to a different connected folder.",
      403,
    );
  }

  if (!commandRootAllows(input.commandType, library)) {
    throw new BridgeCloudError("This connected folder no longer authorizes that operation.", 403, "ROOT_NOT_CONNECTED");
  }
  return library;
}

/** Permission repair and stopping access may operate on an unreadable root.
 * They still require the exact live device/root binding. All data operations
 * use canonical current root semantics; Undo may use a historical scan. */
export function commandRootAllows(commandType: string, root: Parameters<typeof isCurrentReadableRoot>[0] & {
  watchPermission: boolean;
}) {
  if (["REVOKE_ROOT_ACCESS", "UPDATE_ROOT_PERMISSIONS", "PAUSE_WATCHING", "STOP_WATCHING"].includes(commandType)) return Boolean(root);
  return isCurrentReadableRoot(root) &&
    (!["START_WATCHING", "RESUME_WATCHING"].includes(commandType) || Boolean(root?.watchPermission));
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
}, transaction?: Prisma.TransactionClient): Promise<BridgeCommandEnvelope> {
  if (!transaction) {
    return getPrismaClient().$transaction((tx) => createBridgeCloudCommand(input, tx));
  }
  const prisma = transaction;
  const available = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${input.bridgeDeviceId}
      AND status <> 'REVOKED' AND "revokedAt" IS NULL FOR SHARE`;
  if (!available.length) throw new BridgeCloudError("This Bridge device is not available.", 403);
  const device = await prisma.bridgeDevice.findUnique({
    where: {
      bridgeDeviceId: input.bridgeDeviceId,
    },
  });

  if (!device || device.status === "REVOKED" || device.revokedAt) {
    throw new BridgeCloudError("This Bridge device is not available.", 403);
  }

  const root = await assertCommandTarget(input, prisma);

  const envelope = createBridgeCommandEnvelope({
    authorizationContext: root ? {
      ...(input.authorizationContext && typeof input.authorizationContext === "object" && !Array.isArray(input.authorizationContext) ? input.authorizationContext : {}),
      rootConnectionRevision: root.nativeConnectionRevision,
      deviceKeyFingerprint: deviceKeyFingerprint(device.publicKey),
    } : input.authorizationContext ?? {},
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

  await recordBridgeHeartbeat(bridgeDeviceId);
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

  return (await authorizedBridgeCommands(rows)).map(commandEnvelopeFromRow);
}

export async function authorizedBridgeCommands<T extends {
  bridgeDeviceId: string; bridgeRootId: string | null;
  connectedLibraryId: string | null; commandType: string;
  authorizationContext?: unknown;
}>(rows: T[], transaction?: Prisma.TransactionClient): Promise<T[]> {
  const prisma = transaction ?? getPrismaClient();
  const ids = [...new Set(rows.flatMap((row) => row.connectedLibraryId ? [row.connectedLibraryId] : []))];
  const roots = new Map<string, ConnectedLibrary>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500).sort();
    if (transaction) await transaction.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder" WHERE id IN (${Prisma.join(chunk)}) ORDER BY id FOR SHARE`);
    for (const root of await prisma.connectedLibrary.findMany({ where: { id: { in: chunk } } })) roots.set(root.id, root);
  }
  return rows.filter((row) => {
    if (!row.connectedLibraryId) return ["SELECT_FOLDERS", "REGISTER_ROOT"].includes(row.commandType);
    const root = roots.get(row.connectedLibraryId);
    const context = row.authorizationContext && typeof row.authorizationContext === "object" && !Array.isArray(row.authorizationContext)
      ? row.authorizationContext as Record<string, unknown> : null;
    const revision = context?.rootConnectionRevision;
    return Boolean(root && (revision === root.nativeConnectionRevision || (revision === undefined && root.nativeConnectionRevision === 0)) &&
      root.bridgeDeviceId === row.bridgeDeviceId && root.bridgeRootId === row.bridgeRootId && commandRootAllows(row.commandType, root));
  });
}

export async function acknowledgeBridgeCloudCommand(
  bridgeDeviceId: string,
  commandId: string,
  expectedPublicKey?: string,
) {
  const result = await getPrismaClient().$transaction(async (prisma) => {
    await prisma.$queryRaw(Prisma.sql`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${bridgeDeviceId} FOR SHARE`);
    const device = await prisma.bridgeDevice.findUnique({ where: { bridgeDeviceId } });
    const binding = await prisma.bridgeCommand.findUnique({ where: { commandId } });
    if (binding?.connectedLibraryId) await prisma.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder" WHERE id = ${binding.connectedLibraryId} FOR SHARE`);
    await prisma.$queryRaw(Prisma.sql`SELECT "commandId" FROM "BridgeCommand" WHERE "commandId" = ${commandId} FOR UPDATE`);
    const row = await prisma.bridgeCommand.findUnique({ where: { commandId } });
    if (!row || row.bridgeDeviceId !== bridgeDeviceId) throw new BridgeCloudError("That Bridge command could not be found.", 404);
    if (!["PENDING", "ACKNOWLEDGED", "RUNNING"].includes(row.status)) return row;
    if (!device || (expectedPublicKey && device.publicKey !== expectedPublicKey) || device.status === "REVOKED" || device.revokedAt) throw new BridgeCloudError("This device was revoked.", 401);
    if (row.connectedLibraryId) {
      const root = await prisma.connectedLibrary.findUnique({ where: { id: row.connectedLibraryId } });
      const context = row.authorizationContext && typeof row.authorizationContext === "object" && !Array.isArray(row.authorizationContext) ? row.authorizationContext : {};
      const revision = context.rootConnectionRevision;
      if (!root || root.bridgeDeviceId !== bridgeDeviceId || root.bridgeRootId !== row.bridgeRootId || !commandRootAllows(row.commandType, root) ||
          !(revision === root.nativeConnectionRevision || (revision === undefined && root.nativeConnectionRevision === 0))) {
        if (row.status === "PENDING") {
          await settleUnstartedCommands(prisma, { commandId }, "CANCELLED", "ROOT_NOT_CONNECTED");
          return prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId } });
        }
        throw new BridgeCloudError("This command no longer authorizes a physical operation.", 403);
      }
    }
    if (row.status !== "PENDING") return row;
    if (bridgeCommandIsExpired(row.expiresAt)) {
      await settleUnstartedCommands(prisma, { commandId }, "EXPIRED", "COMMAND_EXPIRED");
      return prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId } });
    }
    const acknowledged = await prisma.bridgeCommand.update({ data: { acknowledgedAt: new Date(), status: "ACKNOWLEDGED" }, where: { commandId } });
    await prisma.bridgeAuditEntry.create({ data: { bridgeDeviceId, commandId, connectedLibraryId: row.connectedLibraryId,
      eventType: "COMMAND_ACKNOWLEDGED", safeSummary: "The Bridge acknowledged a queued command." } });
    return acknowledged;
  });
  if (result.status === "CANCELLED") throw new BridgeCloudError("This command no longer authorizes an operation.", 403);
  if (result.status === "EXPIRED") throw new BridgeCloudError("That Bridge command has expired.", 410);
  return commandEnvelopeFromRow(result);
}

export async function completeBridgeCloudCommand(
  bridgeDeviceId: string,
  report: BridgeCommandReport,
  transaction?: Prisma.TransactionClient,
): Promise<BridgeCommandEnvelope> {
  if (!transaction) return getPrismaClient().$transaction((tx) => completeBridgeCloudCommand(bridgeDeviceId, report, tx), { timeout: 120_000 });
  const prisma = transaction;
  await prisma.$queryRaw(Prisma.sql`SELECT "commandId" FROM "BridgeCommand" WHERE "commandId" = ${report.commandId} FOR UPDATE`);
  const row = await prisma.bridgeCommand.findUnique({
    where: {
      commandId: report.commandId,
    },
  });

  if (!row || row.bridgeDeviceId !== bridgeDeviceId) {
    throw new BridgeCloudError("That Bridge command could not be found.", 404);
  }

  if (["COMPLETED", "FAILED", "REJECTED", "EXPIRED", "CANCELLED"].includes(row.status)) {
    return commandEnvelopeFromRow(row);
  }

  if (!commandStatusAllowsCompletion(row.status)) {
    throw new BridgeCloudError(
      "The Bridge command has not been acknowledged yet.",
      409,
    );
  }

  if (row.commandType === "READ_FILE_TEMPORARILY" && report.status === "COMPLETED") {
    const payload = row.payload;
    const fileId = payload && !Array.isArray(payload) && typeof payload === "object" &&
      typeof payload.scannedFileId === "string" ? payload.scannedFileId : null;
    const file = fileId ? await latestScannedFileObservation(fileId) : null;
    if (!file || !payload || Array.isArray(payload) || typeof payload !== "object" ||
        file.sessionId !== payload.scanSessionId || file.readingStatus !== "READ" ||
        file.extractionStatus !== "COMPLETED" || !usableObservation(file.libraryDocument?.observationSessions[0]) ||
        !["EXAMINED", "SUGGESTIONS_GENERATED", "RECOMMENDATIONS_READY"].includes(file.processingStage)) {
      throw new BridgeCloudError("The observation is not durably complete. Retry this report.",
        503, "OBSERVATION_IN_PROGRESS");
    }
  }

  const completion = await prisma.bridgeCommand.updateMany({
    data: {
      completedAt: report.safeErrorCategory === "COMMAND_RECOVERY_REQUIRED" ? null : new Date(),
      result: prismaJson(report.result ?? null),
      safeErrorCategory: report.safeErrorCategory ?? null,
      status: report.safeErrorCategory === "COMMAND_RECOVERY_REQUIRED" ? "RUNNING" : report.status,
    },
    where: {
      commandId: report.commandId, status: { in: ["ACKNOWLEDGED", "RUNNING"] },
    },
  });
  const completed = await prisma.bridgeCommand.findUniqueOrThrow({ where: { commandId: report.commandId } });
  if (!completion.count) return commandEnvelopeFromRow(completed);

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
