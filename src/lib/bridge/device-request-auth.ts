import { createHash, randomUUID } from "node:crypto";

import {
  bridgeRequestHeaderNames,
  bridgeRequestTimestampIsFresh,
  verifyBridgeDeviceRequestSignature,
} from "../../../packages/bridge-protocol/src";

import { getPrismaClient } from "@/lib/db/prisma";
import { BridgeCloudError } from "@/lib/bridge/cloud-coordinator";

const nonceRetentionMs = 10 * 60 * 1000;

async function consumeBridgeRequestNonce(
  bridgeDeviceId: string,
  nonce: string,
) {
  const prisma = getPrismaClient();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + nonceRetentionMs);
  const nonceHash = createHash("sha256")
    .update(`${bridgeDeviceId}:${nonce}`)
    .digest("hex");

  await prisma.$executeRaw`
    DELETE FROM "BridgeRequestNonce"
    WHERE "expiresAt" <= ${now}
  `;
  const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "BridgeRequestNonce"
      ("id", "bridgeDeviceId", "nonceHash", "expiresAt", "createdAt")
    VALUES
      (${`bridge_nonce_${randomUUID()}`}, ${bridgeDeviceId}, ${nonceHash}, ${expiresAt}, ${now})
    ON CONFLICT ("nonceHash") DO NOTHING
    RETURNING "id"
  `;

  if (inserted.length === 0) {
    throw new BridgeCloudError(
      "This Bridge request has already been used.",
      409,
      "REQUEST_REPLAYED",
    );
  }
}

export async function authenticateBridgeDeviceRequest(input: {
  bodyText?: string;
  bridgeDeviceId: string;
  request: Request;
}) {
  const { request, bridgeDeviceId } = input;
  const claimedDeviceId = request.headers.get(bridgeRequestHeaderNames.deviceId);
  const nonce = request.headers.get(bridgeRequestHeaderNames.nonce);
  const signature = request.headers.get(bridgeRequestHeaderNames.signature);
  const timestamp = request.headers.get(bridgeRequestHeaderNames.timestamp);

  if (
    !claimedDeviceId ||
    claimedDeviceId !== bridgeDeviceId ||
    !nonce ||
    nonce.length < 24 ||
    !signature ||
    !timestamp
  ) {
    throw new BridgeCloudError(
      "This Bridge request could not be authenticated.",
      401,
      "BRIDGE_AUTH_REJECTED",
    );
  }

  if (!bridgeRequestTimestampIsFresh(timestamp)) {
    throw new BridgeCloudError(
      "This Bridge request has expired.",
      401,
      "REQUEST_EXPIRED",
    );
  }

  const prisma = getPrismaClient();
  const device = await prisma.bridgeDevice.findUnique({
    where: {
      bridgeDeviceId,
    },
  });

  if (!device || device.status === "REVOKED") {
    throw new BridgeCloudError(
      "This Bridge device is not paired.",
      401,
      "DEVICE_NOT_PAIRED",
    );
  }

  const url = new URL(request.url);
  const verified = verifyBridgeDeviceRequestSignature({
    bodyText: input.bodyText ?? "",
    bridgeDeviceId,
    method: request.method,
    nonce,
    pathname: url.pathname,
    publicKey: device.publicKey,
    signature,
    timestamp,
  });

  if (!verified) {
    throw new BridgeCloudError(
      "This Bridge request signature is invalid.",
      401,
      "REQUEST_SIGNATURE_INVALID",
    );
  }

  await consumeBridgeRequestNonce(bridgeDeviceId, nonce);

  return device;
}
