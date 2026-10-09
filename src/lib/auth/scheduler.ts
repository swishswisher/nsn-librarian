import { createHash, timingSafeEqual } from "node:crypto";

export const memoryRecoverySchedulerPath = "/api/cron/memory-recovery";

export function configuredSchedulerSecret() {
  const secret = process.env.CRON_SECRET;
  return secret && secret.length >= 32 && secret.length <= 256 && secret === secret.trim() ? secret : null;
}

export function authenticateSchedulerRequest(request: Request) {
  const secret = configuredSchedulerSecret();
  const authorization = request.headers.get("authorization");
  if (!secret || !authorization || authorization.length > 300) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}
