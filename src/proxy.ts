import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { requestIsSameOrigin } from "@/lib/auth/http";
import {
  isHumanApiPath,
  isPublicAuthPath,
  isPublicMachinePath,
  methodCanChangeState,
} from "@/lib/auth/route-policy";
import {
  HUMAN_SESSION_COOKIE,
  verifyHumanSessionToken,
} from "@/lib/auth/token";

function protectedResponse() {
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return response;
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const session = verifyHumanSessionToken(
    request.cookies.get(HUMAN_SESSION_COOKIE)?.value,
  );

  if (pathname === "/login") {
    if (session) {
      return NextResponse.redirect(new URL("/admin/library", request.url));
    }

    return protectedResponse();
  }

  if (isPublicAuthPath(pathname) || isPublicMachinePath(pathname)) {
    return protectedResponse();
  }

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Authentication is required.", ok: false },
        {
          headers: { "Cache-Control": "no-store" },
          status: 401,
        },
      );
    }

    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set(
      "next",
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    return NextResponse.redirect(loginUrl);
  }

  if (
    isHumanApiPath(pathname) &&
    methodCanChangeState(request.method) &&
    !requestIsSameOrigin(request)
  ) {
    return NextResponse.json(
      { error: "This request did not come from the NSN Librarian.", ok: false },
      {
        headers: { "Cache-Control": "no-store" },
        status: 403,
      },
    );
  }

  return protectedResponse();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
