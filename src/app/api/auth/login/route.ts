import { NextResponse } from "next/server";

import {
  authConfigurationStatus,
  findConfiguredAuthUser,
} from "@/lib/auth/config";
import { requestIsSameOrigin, safeInternalPath } from "@/lib/auth/http";
import { verifyNsnPassword } from "@/lib/auth/password";
import {
  createHumanSessionToken,
  humanSessionCookieOptions,
  HUMAN_SESSION_COOKIE,
} from "@/lib/auth/token";
import {
  loginThrottleState,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/lib/auth/throttle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dummyPasswordHash =
  "scrypt$16384$8$1$P8jHqWKy4BTWAxtbx0F4KA$lJEt1Uo6FGfSbOhXh4BdNhks_I_olwzdWWIUMCEPUMmSoc4y1WshMpXT8HgvnEC0W_YfGE18U-OAc-8RMvQXwQ";

function loginRedirect(request: Request, error: string, nextPath: string) {
  const url = new URL("/login", request.url);
  url.searchParams.set("error", error);
  url.searchParams.set("next", nextPath);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request) {
  let nextPath = "/admin/library";

  try {
    if (!requestIsSameOrigin(request)) {
      return NextResponse.json(
        { error: "This sign-in request was rejected.", ok: false },
        { status: 403 },
      );
    }

    const formData = await request.formData();
    const email = String(formData.get("email") ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 254);
    const password = String(formData.get("password") ?? "").slice(0, 512);
    nextPath = safeInternalPath(formData.get("next"));
    const configuration = authConfigurationStatus();

    if (!configuration.configured) {
      return loginRedirect(request, "configuration", nextPath);
    }

    const throttle = await loginThrottleState(request, email);

    if (!throttle.allowed) {
      const response = loginRedirect(request, "locked", nextPath);
      response.headers.set("Retry-After", String(throttle.retryAfterSeconds));
      return response;
    }

    const user = findConfiguredAuthUser(email);
    const passwordMatches = await verifyNsnPassword(
      password,
      user?.passwordHash ?? dummyPasswordHash,
    );

    if (!user || !passwordMatches) {
      await recordLoginFailure(request, email || "unknown");
      return loginRedirect(request, "invalid", nextPath);
    }

    await recordLoginSuccess(request, user.email);
    const token = createHumanSessionToken(user);
    const response = NextResponse.redirect(new URL(nextPath, request.url), 303);
    response.cookies.set(
      HUMAN_SESSION_COOKIE,
      token,
      humanSessionCookieOptions(),
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return loginRedirect(request, "unavailable", nextPath);
  }
}
