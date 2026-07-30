import {
  bridgeRequestHeaderNames,
  bridgeRequestTimestampIsFresh,
  verifyBridgeDeviceRequestSignature,
} from "../../../packages/bridge-protocol/src";

import { getPrismaClient } from "@/lib/db/prisma";
import { BridgeCloudError } from "@/lib/bridge/cloud-coordinator";

const seenNonces = new Map<string, number>();
const nonceRetentionMs = 10 * 60 * 1000;

function pruneSeenNonces(now = Date.now()) {
  for (const [key, expiresAt] of seenNonces.entries()) {
    if (expiresAt <= now) {
      seenNonces.delete(key);
    }
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
    throw new BridgeCloudError("This Bridge request could not be authenticated.", 401);
  }

  if (!bridgeRequestTimestampIsFresh(timestamp)) {
    throw new BridgeCloudError("This Bridge request has expired.", 401);
  }

  const prisma = getPrismaClient();
  const device = await prisma.bridgeDevice.findUnique({
    where: {
      bridgeDeviceId,
    },
  });

  if (!device || device.status === "REVOKED") {
    throw new BridgeCloudError("This Bridge device is not paired.", 401);
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
    throw new BridgeCloudError("This Bridge request signature is invalid.", 401);
  }

  pruneSeenNonces();
  const replayKey = `${bridgeDeviceId}:${nonce}`;

  if (seenNonces.has(replayKey)) {
    throw new BridgeCloudError("This Bridge request has already been used.", 409);
  }

  seenNonces.set(replayKey, Date.now() + nonceRetentionMs);

  return device;
}
