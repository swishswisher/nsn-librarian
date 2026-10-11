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

function configuredOrigin(value: string) {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        url.hostname.includes("*")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Deployment configuration is the authority. Request URL/Host/Forwarded
// headers are caller-controlled and cannot add an origin to this installation.
function trustedOrigins() {
  const primary = process.env.NSN_LIBRARIAN_APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  const additional = process.env.NSN_AUTH_TRUSTED_ORIGINS?.trim();
  if (additional && additional.split(",").some(value => !value.trim())) return new Set<string>();
  const values = [primary, ...(additional ? additional.split(",").map(value => value.trim()) : [])]
    .filter((value): value is string => Boolean(value));
  if (!values.length && process.env.NODE_ENV !== "production") {
    values.push("http://localhost:3000", "http://127.0.0.1:3000");
  }
  const origins = values.map(configuredOrigin);
  // A broken allowlist must not silently become a partly trusted deployment.
  return origins.every(origin => origin !== null) ? new Set(origins) : new Set<string>();
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
    // Require a single serialized HTTP(S) origin, rejecting lists, credentials,
    // paths and opaque/null origins rather than normalizing them into authority.
    const parsed = new URL(origin);
    return parsed.origin === origin && trustedOrigins().has(origin);
  } catch {
    return false;
  }
}
