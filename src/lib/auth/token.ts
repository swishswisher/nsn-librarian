import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  authSecret,
  findConfiguredAuthUser,
  type ConfiguredAuthUser,
  type NsnAuthRole,
} from "./config";

export const HUMAN_SESSION_COOKIE = "nsn_session";
const sessionVersion = 2;
const defaultSessionHours = 8;

type HumanSessionPayload = {
  email: string;
  expiresAt: number;
  googleSubject: string;
  issuedAt: number;
  jti: string;
  name: string;
  picture: string | null;
  role: NsnAuthRole;
  version: number;
};

export type HumanSession = {
  email: string;
  expiresAt: Date;
  googleSubject: string;
  name: string;
  picture: string | null;
  role: NsnAuthRole;
};

export type VerifiedGoogleIdentity = {
  email: string;
  googleSubject: string;
  name: string;
  picture: string | null;
};

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

function safePicture(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function createHumanSessionToken(
  user: ConfiguredAuthUser,
  identity: VerifiedGoogleIdentity,
) {
  const secret = authSecret();

  if (!secret) {
    throw new Error("NSN_AUTH_NOT_CONFIGURED");
  }

  if (
    user.email !== identity.email.trim().toLowerCase() ||
    (user.googleSubject && user.googleSubject !== identity.googleSubject)
  ) {
    throw new Error("GOOGLE_IDENTITY_NOT_APPROVED");
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: HumanSessionPayload = {
    email: user.email,
    expiresAt: issuedAt + sessionDurationSeconds(),
    googleSubject: identity.googleSubject,
    issuedAt,
    jti: randomUUID(),
    name: user.name || identity.name,
    picture: safePicture(identity.picture),
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
      typeof payload.googleSubject !== "string" ||
      !payload.googleSubject ||
      typeof payload.issuedAt !== "number" ||
      typeof payload.jti !== "string" ||
      payload.expiresAt <= now ||
      payload.issuedAt > now + 60 ||
      payload.expiresAt - payload.issuedAt > 24 * 60 * 60
    ) {
      return null;
    }

    const configuredUser = findConfiguredAuthUser(payload.email);

    if (
      !configuredUser ||
      (configuredUser.googleSubject &&
        configuredUser.googleSubject !== payload.googleSubject)
    ) {
      return null;
    }

    return {
      email: configuredUser.email,
      expiresAt: new Date(payload.expiresAt * 1000),
      googleSubject: payload.googleSubject,
      name: configuredUser.name,
      picture: safePicture(payload.picture),
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
