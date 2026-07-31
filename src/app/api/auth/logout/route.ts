import { NextResponse } from "next/server";

import { requestIsSameOrigin } from "@/lib/auth/http";
import {
  humanSessionCookieOptions,
  HUMAN_SESSION_COOKIE,
} from "@/lib/auth/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!requestIsSameOrigin(request)) {
    return NextResponse.json(
      { error: "This sign-out request was rejected.", ok: false },
      { status: 403 },
    );
  }

  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  response.cookies.set(HUMAN_SESSION_COOKIE, "", {
    ...humanSessionCookieOptions(new Date(0)),
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
