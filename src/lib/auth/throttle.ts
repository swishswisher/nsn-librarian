import { createHash } from "node:crypto";

import { getPrismaClient } from "@/lib/db/prisma";

const attemptWindowMs = 15 * 60 * 1000;
const lockDurationMs = 15 * 60 * 1000;
const maximumFailures = 5;

type ThrottleRow = {
  failureCount: number;
  lockedUntil: Date | null;
  windowStartedAt: Date;
};

function clientAddress(request: Request) {
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function throttleKey(request: Request, email: string) {
  return createHash("sha256")
    .update(`${email.trim().toLowerCase()}|${clientAddress(request)}`)
    .digest("hex");
}

async function loadThrottle(key: string) {
  const rows = await getPrismaClient().$queryRaw<ThrottleRow[]>`
    SELECT
      "failureCount" AS "failureCount",
      "lockedUntil" AS "lockedUntil",
      "windowStartedAt" AS "windowStartedAt"
    FROM "NsnAuthThrottle"
    WHERE "key" = ${key}
    LIMIT 1
  `;

  return rows[0] ?? null;
}

export async function loginThrottleState(request: Request, email: string) {
  const key = throttleKey(request, email);
  const record = await loadThrottle(key);
  const now = Date.now();

  if (record?.lockedUntil && record.lockedUntil.getTime() > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((record.lockedUntil.getTime() - now) / 1000),
      ),
    };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

export async function recordLoginFailure(request: Request, email: string) {
  const key = throttleKey(request, email);
  const existing = await loadThrottle(key);
  const now = new Date();
  const windowExpired =
    !existing || now.getTime() - existing.windowStartedAt.getTime() > attemptWindowMs;
  const nextFailureCount = windowExpired ? 1 : existing.failureCount + 1;
  const windowStartedAt = windowExpired ? now : existing.windowStartedAt;
  const lockedUntil =
    nextFailureCount >= maximumFailures
      ? new Date(now.getTime() + lockDurationMs)
      : null;

  await getPrismaClient().$executeRaw`
    INSERT INTO "NsnAuthThrottle" (
      "key",
      "failureCount",
      "windowStartedAt",
      "lockedUntil",
      "updatedAt"
    ) VALUES (
      ${key},
      ${nextFailureCount},
      ${windowStartedAt},
      ${lockedUntil},
      ${now}
    )
    ON CONFLICT ("key") DO UPDATE SET
      "failureCount" = EXCLUDED."failureCount",
      "windowStartedAt" = EXCLUDED."windowStartedAt",
      "lockedUntil" = EXCLUDED."lockedUntil",
      "updatedAt" = EXCLUDED."updatedAt"
  `;
}

export async function recordLoginSuccess(request: Request, email: string) {
  const key = throttleKey(request, email);
  await getPrismaClient().$executeRaw`
    DELETE FROM "NsnAuthThrottle" WHERE "key" = ${key}
  `;
}
