import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { BridgeAppError } from "../types";
import { requirePairingSecret } from "./pairing";

const defaultAllowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];

export function allowedOrigins() {
  const configured = process.env.NSN_BRIDGE_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return configured && configured.length > 0
    ? new Set(configured)
    : new Set(defaultAllowedOrigins);
}

export function validateOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;

  if (!origin) {
    return;
  }

  if (!allowedOrigins().has(origin)) {
    throw new BridgeAppError(
      "The NSN Bridge rejected a request from an unexpected page.",
      "ORIGIN_NOT_ALLOWED",
      403,
    );
  }
}

export function applyCors(request: IncomingMessage, response: ServerResponse) {
  const origin = request.headers.origin;

  if (origin && allowedOrigins().has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }

  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization,Content-Type,X-NSN-Bridge-Client",
  );
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export async function authenticateRequest(request: IncomingMessage) {
  validateOrigin(request);

  const authorization = request.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const expectedSecret = await requirePairingSecret();

  if (!token || !safeEqual(token, expectedSecret)) {
    throw new BridgeAppError(
      "The NSN Bridge could not verify this request.",
      "UNAUTHORIZED",
      401,
    );
  }
}
