import { NextResponse } from "next/server";

import {
  authConfigurationStatus,
  googleOAuthCredentials,
} from "@/lib/auth/config";
import {
  GOOGLE_OAUTH_COOKIE,
  createGoogleOAuthState,
  googleOAuthCookieOptions,
} from "@/lib/auth/google-oauth-state";
import { createGoogleAuthorizationUrl } from "@/lib/auth/google-oidc";
import { safeInternalPath } from "@/lib/auth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const nextPath = safeInternalPath(requestUrl.searchParams.get("next"));
  const configuration = authConfigurationStatus();

  if (!configuration.configured) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("error", "configuration");
    loginUrl.searchParams.set("next", nextPath);
    return NextResponse.redirect(loginUrl, 303);
  }

  const google = googleOAuthCredentials();
  const oauth = createGoogleOAuthState(nextPath);
  const redirectUri = new URL(
    "/api/auth/google/callback",
    request.url,
  ).toString();
  const authorizationUrl = createGoogleAuthorizationUrl({
    clientId: google.clientId,
    codeChallenge: oauth.codeChallenge,
    nonce: oauth.nonce,
    redirectUri,
    state: oauth.state,
  });
  const response = NextResponse.redirect(authorizationUrl, 302);
  response.cookies.set(
    GOOGLE_OAUTH_COOKIE,
    oauth.cookieValue,
    googleOAuthCookieOptions(),
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}
