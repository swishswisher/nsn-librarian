import assert from "node:assert/strict";
import test from "node:test";
import type { NextRequest } from "next/server";

import { authConfigurationStatus } from "../../src/lib/auth/config";
import {
  createGoogleOAuthState,
  verifyGoogleOAuthState,
} from "../../src/lib/auth/google-oauth-state";
import { createGoogleAuthorizationUrl } from "../../src/lib/auth/google-oidc";
import { requestIsSameOrigin, safeInternalPath } from "../../src/lib/auth/http";
import {
  isBridgeReleaseManifestPath,
  isHumanApiPath,
  isPublicMachinePath,
} from "../../src/lib/auth/route-policy";
import {
  createHumanSessionToken,
  verifyHumanSessionToken,
} from "../../src/lib/auth/token";
import { proxy } from "../../src/proxy";

const originalEnvironment = {
  AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID,
  AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET,
  AUTH_SECRET: process.env.AUTH_SECRET,
  NSN_AUTH_ALLOWED_USERS_JSON: process.env.NSN_AUTH_ALLOWED_USERS_JSON,
};

function approvedUsers() {
  return [
    {
      email: "david@example.com",
      googleSubject: "google-david-123",
      name: "David",
      role: "OWNER" as const,
    },
    {
      email: "deanne@example.com",
      googleSubject: "google-deanne-456",
      name: "Deanne",
      role: "LIBRARIAN" as const,
    },
  ];
}

function configureAuth() {
  process.env.AUTH_SECRET =
    "test-auth-secret-that-is-longer-than-thirty-two-characters";
  process.env.AUTH_GOOGLE_ID = "google-client-id.apps.googleusercontent.com";
  process.env.AUTH_GOOGLE_SECRET = "google-client-secret";
  process.env.NSN_AUTH_ALLOWED_USERS_JSON = JSON.stringify(approvedUsers());
}

function proxyRequest(pathname: string, method = "GET"): NextRequest {
  const url = new URL(`https://nsn-librarian.vercel.app${pathname}`);

  return {
    cookies: {
      get: () => undefined,
    },
    method,
    nextUrl: url,
    url: url.toString(),
  } as unknown as NextRequest;
}

test.after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("accepts only configured Google identities and rejects a tampered session", () => {
  configureAuth();
  assert.equal(authConfigurationStatus().configured, true);

  const user = approvedUsers()[0];
  const token = createHumanSessionToken(user, {
    email: user.email,
    googleSubject: user.googleSubject,
    name: user.name,
    picture: "https://lh3.googleusercontent.com/example",
  });
  const session = verifyHumanSessionToken(token);

  assert.equal(session?.email, "david@example.com");
  assert.equal(session?.googleSubject, "google-david-123");
  assert.equal(session?.role, "OWNER");
  assert.equal(verifyHumanSessionToken(`${token}tampered`), null);

  process.env.NSN_AUTH_ALLOWED_USERS_JSON = JSON.stringify([
    approvedUsers()[1],
  ]);
  assert.equal(verifyHumanSessionToken(token), null);
});

test("rejects a Google subject mismatch even when the email is allowlisted", () => {
  configureAuth();
  const user = approvedUsers()[0];

  assert.throws(
    () =>
      createHumanSessionToken(user, {
        email: user.email,
        googleSubject: "different-google-subject",
        name: user.name,
        picture: null,
      }),
    /GOOGLE_IDENTITY_NOT_APPROVED/,
  );
});

test("signs OAuth state, binds the browser response, and creates PKCE", () => {
  configureAuth();
  const oauth = createGoogleOAuthState("/admin/library/review?focus=1");
  const verified = verifyGoogleOAuthState(oauth.cookieValue, oauth.state);

  assert.equal(verified?.nextPath, "/admin/library/review?focus=1");
  assert.ok((verified?.codeVerifier.length ?? 0) >= 43);
  assert.ok(oauth.codeChallenge.length >= 43);
  assert.equal(
    verifyGoogleOAuthState(`${oauth.cookieValue}tampered`, oauth.state),
    null,
  );
  assert.equal(verifyGoogleOAuthState(oauth.cookieValue, "wrong-state"), null);
});

test("requests identity scopes only and uses the exact callback URI", () => {
  const url = createGoogleAuthorizationUrl({
    clientId: "client-id",
    codeChallenge: "challenge",
    nonce: "nonce",
    redirectUri: "https://nsn-librarian.vercel.app/api/auth/google/callback",
    state: "state",
  });

  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://nsn-librarian.vercel.app/api/auth/google/callback",
  );
  assert.equal(url.toString().includes("gmail"), false);
  assert.equal(url.toString().includes("drive"), false);
  assert.equal(url.toString().includes("calendar"), false);
});

test("refuses more than two approved human accounts", () => {
  configureAuth();
  process.env.NSN_AUTH_ALLOWED_USERS_JSON = JSON.stringify([
    ...approvedUsers(),
    {
      email: "third@example.com",
      name: "Third",
      role: "LIBRARIAN",
    },
  ]);

  assert.equal(authConfigurationStatus().tooManyUsers, true);
  assert.equal(authConfigurationStatus().configured, false);
});

test("protects human APIs but exempts signed Bridge device traffic", () => {
  assert.equal(
    isPublicMachinePath("/api/bridge/cloud/devices/device-1/commands"),
    true,
  );
  assert.equal(
    isPublicMachinePath("/api/bridge/cloud/pairing-codes/redeem"),
    true,
  );
  assert.equal(
    isBridgeReleaseManifestPath("/api/download/bridge/manifest"),
    true,
  );
  assert.equal(
    isPublicMachinePath("/api/download/bridge/manifest"),
    true,
  );
  assert.equal(
    isPublicMachinePath("/api/download/bridge/anything-else"),
    false,
  );
  assert.equal(isHumanApiPath("/api/bridge/scan"), true);
  assert.equal(
    isHumanApiPath("/api/bridge/organization-plans/plan-1/execute"),
    true,
  );
  assert.equal(isHumanApiPath("/api/library/review"), true);
  assert.equal(isHumanApiPath("/api/database/health"), true);
  assert.equal(isHumanApiPath("/api/download/bridge/anything-else"), true);
});

test("allows only the exact Bridge release manifest through proxy without human auth", async () => {
  const manifestResponse = proxy(proxyRequest("/api/download/bridge/manifest"));
  const protectedDownloadResponse = proxy(
    proxyRequest("/api/download/bridge/anything-else"),
  );
  const protectedHumanResponse = proxy(proxyRequest("/api/library/review"));

  assert.equal(manifestResponse.status, 200);
  assert.equal(protectedDownloadResponse.status, 401);
  assert.equal(protectedHumanResponse.status, 401);

  assert.deepEqual(await protectedDownloadResponse.json(), {
    error: "Authentication is required.",
    ok: false,
  });
});

test("blocks open redirects and cross-origin state-changing requests", () => {
  assert.equal(safeInternalPath("https://example.com"), "/admin/library");
  assert.equal(safeInternalPath("//example.com"), "/admin/library");
  assert.equal(safeInternalPath("/admin/library/review"), "/admin/library/review");

  assert.equal(
    requestIsSameOrigin(
      new Request("https://nsn-librarian.vercel.app/api/library/review", {
        headers: {
          host: "nsn-librarian.vercel.app",
          origin: "https://nsn-librarian.vercel.app",
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
      }),
    ),
    true,
  );
  assert.equal(
    requestIsSameOrigin(
      new Request("https://nsn-librarian.vercel.app/api/library/review", {
        headers: {
          host: "nsn-librarian.vercel.app",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        method: "POST",
      }),
    ),
    false,
  );
});
