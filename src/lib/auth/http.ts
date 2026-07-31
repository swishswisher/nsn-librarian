export function safeInternalPath(value: unknown, fallback = "/admin/library") {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();

  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    trimmed.includes("\u0000")
  ) {
    return fallback;
  }

  return trimmed;
}

export function requestIsSameOrigin(request: Request) {
  const method = request.method.toUpperCase();

  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }

  const fetchSite = request.headers.get("sec-fetch-site");

  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site") {
    return false;
  }

  const origin = request.headers.get("origin");

  if (!origin) {
    return false;
  }

  try {
    const requestUrl = new URL(request.url);
    const forwardedHost =
      request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    const forwardedProtocol =
      request.headers.get("x-forwarded-proto") ?? requestUrl.protocol.replace(":", "");
    const expectedOrigin = forwardedHost
      ? `${forwardedProtocol}://${forwardedHost}`
      : requestUrl.origin;

    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}
