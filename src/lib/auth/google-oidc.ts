import { createPublicKey, verify } from "node:crypto";

import type { VerifiedGoogleIdentity } from "./token";

const googleAuthorizationEndpoint =
  "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenEndpoint = "https://oauth2.googleapis.com/token";
const googleJwksEndpoint = "https://www.googleapis.com/oauth2/v3/certs";
const acceptedIssuers = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  token_type?: string;
};

type GoogleIdTokenClaims = {
  aud?: string | string[];
  email?: string;
  email_verified?: boolean;
  exp?: number;
  iat?: number;
  iss?: string;
  name?: string;
  nonce?: string;
  picture?: string;
  sub?: string;
};

type GoogleJwk = JsonWebKey & {
  alg?: string;
  kid?: string;
  use?: string;
};

let cachedJwks: { expiresAt: number; keys: GoogleJwk[] } | null = null;

function parseMaxAge(cacheControl: string | null) {
  const match = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/i);
  const seconds = match ? Number(match[1]) : 300;
  return Number.isFinite(seconds) ? Math.min(3600, Math.max(60, seconds)) : 300;
}

async function googleSigningKeys() {
  const now = Date.now();

  if (cachedJwks && cachedJwks.expiresAt > now) {
    return cachedJwks.keys;
  }

  const response = await fetch(googleJwksEndpoint, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error("GOOGLE_JWKS_UNAVAILABLE");
  }

  const body = (await response.json()) as { keys?: GoogleJwk[] };

  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error("GOOGLE_JWKS_INVALID");
  }

  cachedJwks = {
    expiresAt:
      now + parseMaxAge(response.headers.get("cache-control")) * 1000,
    keys: body.keys,
  };

  return body.keys;
}

function parseJwtPart<T>(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function audienceMatches(audience: string | string[] | undefined, clientId: string) {
  return typeof audience === "string"
    ? audience === clientId
    : Array.isArray(audience) && audience.includes(clientId);
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

export function createGoogleAuthorizationUrl(input: {
  clientId: string;
  codeChallenge: string;
  nonce: string;
  redirectUri: string;
  state: string;
}) {
  const url = new URL(googleAuthorizationEndpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  return url;
}

export async function exchangeGoogleAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  const response = await fetch(googleTokenEndpoint, {
    body,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  const payload = (await response.json().catch(() => null)) as
    | GoogleTokenResponse
    | null;

  if (!response.ok || !payload?.id_token) {
    throw new Error("GOOGLE_CODE_EXCHANGE_FAILED");
  }

  return payload.id_token;
}

export async function verifyGoogleIdToken(input: {
  clientId: string;
  idToken: string;
  nonce: string;
}): Promise<VerifiedGoogleIdentity> {
  const parts = input.idToken.split(".");

  if (parts.length !== 3) {
    throw new Error("GOOGLE_ID_TOKEN_INVALID");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJwtPart<{ alg?: string; kid?: string }>(encodedHeader);

  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("GOOGLE_ID_TOKEN_ALGORITHM_INVALID");
  }

  const keys = await googleSigningKeys();
  const jwk = keys.find(
    (candidate) =>
      candidate.kid === header.kid &&
      (!candidate.alg || candidate.alg === "RS256") &&
      (!candidate.use || candidate.use === "sig"),
  );

  if (!jwk) {
    cachedJwks = null;
    throw new Error("GOOGLE_SIGNING_KEY_NOT_FOUND");
  }

  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const signatureValid = verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
    publicKey,
    Buffer.from(encodedSignature, "base64url"),
  );

  if (!signatureValid) {
    throw new Error("GOOGLE_ID_TOKEN_SIGNATURE_INVALID");
  }

  const claims = parseJwtPart<GoogleIdTokenClaims>(encodedPayload);
  const now = Math.floor(Date.now() / 1000);
  const email = claims.email?.trim().toLowerCase() ?? "";

  if (
    !claims.iss ||
    !acceptedIssuers.has(claims.iss) ||
    !audienceMatches(claims.aud, input.clientId) ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    typeof claims.iat !== "number" ||
    claims.iat > now + 60 ||
    claims.iat < now - 24 * 60 * 60 ||
    claims.nonce !== input.nonce ||
    claims.email_verified !== true ||
    !email ||
    !claims.sub
  ) {
    throw new Error("GOOGLE_ID_TOKEN_CLAIMS_INVALID");
  }

  return {
    email,
    googleSubject: claims.sub,
    name: claims.name?.trim() || email,
    picture: safePicture(claims.picture),
  };
}
