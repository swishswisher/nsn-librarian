CREATE TABLE "NsnAuthThrottle" (
  "key" TEXT NOT NULL,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "lockedUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NsnAuthThrottle_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "NsnAuthThrottle_lockedUntil_idx"
  ON "NsnAuthThrottle"("lockedUntil");

CREATE INDEX "NsnAuthThrottle_updatedAt_idx"
  ON "NsnAuthThrottle"("updatedAt");
