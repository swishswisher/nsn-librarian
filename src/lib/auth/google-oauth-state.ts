import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { authSecret } from "./config";
import { safeInternalPath } from "./http";

export const GOOGLE_OAUTH_COOKIE = "nsn_google_oauth";
const oauthStateVersion = 1;
const oauthStateTtlSeconds = 10 * 60;

type GoogleOAuthStatePayload = {
  codeVerifier: string;
  expiresAt: number;
  issuedAt: number;
  nextPath: string;
  nonce: string;
  state: string;
  version: number;
};

function signatureFor(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function randomValue(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function createGoogleOAuthState(nextPath: string) {
  const secret = authSecret();

  if (!secret) {
    throw new Error("NSN_AUTH_NOT_CONFIGURED");
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: GoogleOAuthStatePayload = {
    codeVerifier: randomValue(48),
    expiresAt: issuedAt + oauthStateTtlSeconds,
    issuedAt,
    nextPath: safeInternalPath(nextPath),
    nonce: randomValue(),
    state: randomValue(),
    version: oauthStateVersion,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );

  return {
    codeChallenge: createHash("sha256")
      .update(payload.codeVerifier)
      .digest("base64url"),
    cookieValue: `${encodedPayload}.${signatureFor(encodedPayload, secret)}`,
    nonce: payload.nonce,
    state: payload.state,
  };
}

export function verifyGoogleOAuthState(
  cookieValue: string | null | undefined,
  returnedState: string,
) {
  const secret = authSecret();

  if (!secret || !cookieValue || !returnedState) {
    return null;
  }

  const [encodedPayload, suppliedSignature, extra] = cookieValue.split(".");

  if (!encodedPayload || !suppliedSignature || extra) {
    return null;
  }

  const expectedSignature = signatureFor(encodedPayload, secret);

  if (!safeEqual(suppliedSignature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<GoogleOAuthStatePayload>;
    const now = Math.floor(Date.now() / 1000);

    if (
      payload.version !== oauthStateVersion ||
      typeof payload.codeVerifier !== "string" ||
      payload.codeVerifier.length < 43 ||
      payload.codeVerifier.length > 128 ||
      typeof payload.expiresAt !== "number" ||
      typeof payload.issuedAt !== "number" ||
      typeof payload.nextPath !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.state !== "string" ||
      payload.expiresAt <= now ||
      payload.issuedAt > now + 60 ||
      payload.expiresAt - payload.issuedAt > oauthStateTtlSeconds ||
      !safeEqual(payload.state, returnedState)
    ) {
      return null;
    }

    return {
      codeVerifier: payload.codeVerifier,
      nextPath: safeInternalPath(payload.nextPath),
      nonce: payload.nonce,
    };
  } catch {
    return null;
  }
}

export function googleOAuthCookieOptions(expiresAt?: Date) {
  return {
    expires: expiresAt,
    httpOnly: true,
    maxAge: expiresAt ? 0 : oauthStateTtlSeconds,
    path: "/api/auth/google",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}
