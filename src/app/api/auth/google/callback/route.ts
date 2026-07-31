import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  authConfigurationStatus,
  findConfiguredAuthUser,
  googleOAuthCredentials,
} from "@/lib/auth/config";
import {
  GOOGLE_OAUTH_COOKIE,
  googleOAuthCookieOptions,
  verifyGoogleOAuthState,
} from "@/lib/auth/google-oauth-state";
import {
  exchangeGoogleAuthorizationCode,
  verifyGoogleIdToken,
} from "@/lib/auth/google-oidc";
import {
  createHumanSessionToken,
  humanSessionCookieOptions,
  HUMAN_SESSION_COOKIE,
} from "@/lib/auth/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clearOAuthCookie(response: NextResponse) {
  response.cookies.set(GOOGLE_OAUTH_COOKIE, "", {
    ...googleOAuthCookieOptions(new Date(0)),
    maxAge: 0,
  });
}

function loginRedirect(
  request: Request,
  error: string,
  nextPath = "/admin/library",
) {
  const url = new URL("/login", request.url);
  url.searchParams.set("error", error);
  url.searchParams.set("next", nextPath);
  const response = NextResponse.redirect(url, 303);
  clearOAuthCookie(response);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const returnedState = requestUrl.searchParams.get("state") ?? "";
  const oauth = verifyGoogleOAuthState(
    request.cookies.get(GOOGLE_OAUTH_COOKIE)?.value,
    returnedState,
  );
  const nextPath = oauth?.nextPath ?? "/admin/library";

  try {
    const providerError = requestUrl.searchParams.get("error");

    if (providerError) {
      return loginRedirect(
        request,
        providerError === "access_denied" ? "denied" : "invalid",
        nextPath,
      );
    }

    if (!authConfigurationStatus().configured) {
      return loginRedirect(request, "configuration", nextPath);
    }

    const returnedIssuer = requestUrl.searchParams.get("iss");

    if (
      returnedIssuer &&
      returnedIssuer !== "https://accounts.google.com" &&
      returnedIssuer !== "accounts.google.com"
    ) {
      return loginRedirect(request, "invalid", nextPath);
    }

    const code = requestUrl.searchParams.get("code") ?? "";

    if (!oauth || !code || code.length > 4096) {
      return loginRedirect(request, "invalid", nextPath);
    }

    const google = googleOAuthCredentials();
    const redirectUri = new URL(
      "/api/auth/google/callback",
      request.url,
    ).toString();
    const idToken = await exchangeGoogleAuthorizationCode({
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      code,
      codeVerifier: oauth.codeVerifier,
      redirectUri,
    });
    const identity = await verifyGoogleIdToken({
      clientId: google.clientId,
      idToken,
      nonce: oauth.nonce,
    });
    const user = findConfiguredAuthUser(identity.email);

    if (
      !user ||
      (user.googleSubject && user.googleSubject !== identity.googleSubject)
    ) {
      return loginRedirect(request, "unauthorized", nextPath);
    }

    const token = createHumanSessionToken(user, identity);
    const response = NextResponse.redirect(new URL(nextPath, request.url), 303);
    response.cookies.set(
      HUMAN_SESSION_COOKIE,
      token,
      humanSessionCookieOptions(),
    );
    clearOAuthCookie(response);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return loginRedirect(request, "unavailable", nextPath);
  }
}
