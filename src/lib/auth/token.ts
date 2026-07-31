import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  findConfiguredAuthUser,
  type ConfiguredAuthUser,
  type NsnAuthRole,
} from "./config";

export const HUMAN_SESSION_COOKIE = "nsn_session";
const sessionVersion = 1;
const defaultSessionHours = 8;

type HumanSessionPayload = {
  email: string;
  expiresAt: number;
  issuedAt: number;
  jti: string;
  name: string;
  role: NsnAuthRole;
  version: number;
};

export type HumanSession = {
  email: string;
  expiresAt: Date;
  name: string;
  role: NsnAuthRole;
};

function authSecret() {
  const secret = process.env.NSN_AUTH_SECRET?.trim() ?? "";
  return secret.length >= 32 ? secret : null;
}

function sessionDurationSeconds() {
  const configured = Number(process.env.NSN_AUTH_SESSION_HOURS ?? defaultSessionHours);
  const hours = Number.isFinite(configured)
    ? Math.min(24, Math.max(1, configured))
    : defaultSessionHours;
  return Math.round(hours * 60 * 60);
}

function encodePayload(payload: HumanSessionPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signatureFor(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function safeSignatureEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function createHumanSessionToken(user: ConfiguredAuthUser) {
  const secret = authSecret();

  if (!secret) {
    throw new Error("NSN_AUTH_NOT_CONFIGURED");
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: HumanSessionPayload = {
    email: user.email,
    expiresAt: issuedAt + sessionDurationSeconds(),
    issuedAt,
    jti: randomUUID(),
    name: user.name,
    role: user.role,
    version: sessionVersion,
  };
  const encodedPayload = encodePayload(payload);

  return `${encodedPayload}.${signatureFor(encodedPayload, secret)}`;
}

export function verifyHumanSessionToken(token: string | null | undefined) {
  const secret = authSecret();

  if (!secret || !token) {
    return null;
  }

  const [encodedPayload, suppliedSignature, extra] = token.split(".");

  if (!encodedPayload || !suppliedSignature || extra) {
    return null;
  }

  const expectedSignature = signatureFor(encodedPayload, secret);

  if (!safeSignatureEqual(suppliedSignature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<HumanSessionPayload>;
    const now = Math.floor(Date.now() / 1000);

    if (
      payload.version !== sessionVersion ||
      typeof payload.email !== "string" ||
      typeof payload.expiresAt !== "number" ||
      typeof payload.issuedAt !== "number" ||
      typeof payload.jti !== "string" ||
      payload.expiresAt <= now ||
      payload.issuedAt > now + 60 ||
      payload.expiresAt - payload.issuedAt > 24 * 60 * 60
    ) {
      return null;
    }

    const configuredUser = findConfiguredAuthUser(payload.email);

    if (!configuredUser) {
      return null;
    }

    return {
      email: configuredUser.email,
      expiresAt: new Date(payload.expiresAt * 1000),
      name: configuredUser.name,
      role: configuredUser.role,
    } satisfies HumanSession;
  } catch {
    return null;
  }
}

export function humanSessionCookieOptions(expiresAt?: Date) {
  return {
    expires: expiresAt,
    httpOnly: true,
    maxAge: expiresAt
      ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
      : sessionDurationSeconds(),
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}
