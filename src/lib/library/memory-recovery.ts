import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { configuredSchedulerSecret } from "@/lib/auth/scheduler";
import { getPrismaClient } from "@/lib/db/prisma";
import { recoverScheduledMemoryOwner } from "./memory";
import { eligibleMemoryObservationSql } from "./memory-provenance";

export const memoryRecoveryBudget = { owners: 20, durationMs: 45_000, ownerMs: 15_000 } as const;
const healthId = "memory-recovery";

async function recordHealth(action: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  await getPrismaClient().$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '250ms'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '500ms'");
    await action(tx);
  }, { maxWait: 250, timeout: 1000 });
}

export async function getMemoryRecoveryProgress() {
  return getPrismaClient().$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '3000ms'");
    const [counts] = await tx.$queryRaw<Array<{ pending: bigint; completed: bigint; inspection: bigint }>>(Prisma.sql`
      SELECT count(*) FILTER (WHERE observation."memoryReconciliationStatus" LIKE 'PENDING@%') AS pending,
        count(*) FILTER (WHERE observation."memoryReconciliationStatus" LIKE 'COMPLETED@%') AS completed,
        count(*) FILTER (WHERE observation."memoryReconciliationStatus" LIKE 'PENDING@%'
          AND observation."memoryRecoveryFailureGeneration" = observation."memoryReconciliationStatus"
          AND observation."memoryRecoveryFailureCount" >= 3) AS inspection
      FROM "ObservationSession" observation WHERE ${eligibleMemoryObservationSql}`);
    const state = await tx.memoryRecoveryState.findUnique({ where: { id: healthId } });
    return { pending: Number(counts.pending), completed: Number(counts.completed), needsInspection: Number(counts.inspection),
      schedulerConfigured: Boolean(configuredSchedulerSecret()), lastSuccessfulRunAt: state?.lastSuccessfulRunAt?.toISOString() ?? null,
      lastStartedAt: state?.lastStartedAt.toISOString() ?? null, lastFinishedAt: state?.lastFinishedAt?.toISOString() ?? null,
      lastRunStatus: state?.lastRunStatus ?? null };
  }, { maxWait: 500, timeout: 5000 });
}

async function deferFailedOwner(owner: { id: string; generation: string }) {
  await getPrismaClient().$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '500ms'");
    await tx.$executeRaw(Prisma.sql`
      UPDATE "ObservationSession" SET
        "memoryRecoveryFailureCount" = CASE WHEN "memoryRecoveryFailureGeneration" = ${owner.generation}
          THEN LEAST("memoryRecoveryFailureCount" + 1, 100) ELSE 1 END,
        "memoryRecoveryFailureGeneration" = ${owner.generation},
        "memoryRecoveryNextAttemptAt" = (clock_timestamp() AT TIME ZONE 'UTC') + LEAST(300, power(2,
          CASE WHEN "memoryRecoveryFailureGeneration" = ${owner.generation}
            THEN LEAST("memoryRecoveryFailureCount", 9) ELSE 0 END)) * interval '1 second',
        "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
      WHERE id = ${owner.id} AND "memoryReconciliationStatus" = ${owner.generation}`);
  }, { maxWait: 250, timeout: 1000 });
}

export async function runScheduledMemoryRecovery() {
  const prisma = getPrismaClient(), startedAt = new Date(), deadline = Date.now() + memoryRecoveryBudget.durationMs;
  const runGeneration = randomUUID();
  await recordHealth((tx) => tx.memoryRecoveryState.upsert({ where: { id: healthId },
    create: { id: healthId, runGeneration, lastStartedAt: startedAt, lastRunStatus: "RUNNING" },
    update: { runGeneration, lastStartedAt: startedAt, lastFinishedAt: null, lastRunStatus: "RUNNING" } }));
  let completed = 0, failed = 0, busy = 0, attempted = 0;
  try {
    // Eligibility precedes the work window. Failure backoff/rotation is durable;
    // a dead invocation never owns the next independently scheduled delivery.
    const owners = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '3000ms'");
      return tx.$queryRaw<Array<{ id: string; generation: string }>>(Prisma.sql`
        SELECT observation.id, observation."memoryReconciliationStatus" AS generation FROM "ObservationSession" observation
        WHERE observation."memoryReconciliationStatus" LIKE 'PENDING@%'
          AND (observation."memoryRecoveryNextAttemptAt" IS NULL OR observation."memoryRecoveryNextAttemptAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
            OR observation."memoryRecoveryFailureGeneration" IS DISTINCT FROM observation."memoryReconciliationStatus")
          AND (observation.status = 'REJECTED' OR ${eligibleMemoryObservationSql})
        ORDER BY observation."updatedAt", observation.id LIMIT ${memoryRecoveryBudget.owners}`);
    }, { maxWait: 500, timeout: 5000 });
    for (const owner of owners) {
      const remaining = deadline - Date.now(); if (remaining < 1500) break;
      attempted++;
      try {
        const outcome = await recoverScheduledMemoryOwner(owner, Math.min(memoryRecoveryBudget.ownerMs, remaining - 1000));
        if (outcome === "COMPLETED") completed++; else if (outcome === "BUSY") busy++;
      } catch {
        failed++;
        // No SQL/provider diagnostic or owner identity escapes to logs/response.
        // Contention on retry metadata must not cancel later independent owners.
        // The exact pending generation remains discoverable even if this fails.
        await deferFailedOwner(owner).catch(() => undefined);
      }
    }
    await recordHealth((tx) => tx.memoryRecoveryState.updateMany({ where: { id: healthId, runGeneration }, data: {
      lastFinishedAt: new Date(), lastRunStatus: failed ? "RETRY_REQUIRED" : "SUCCEEDED",
      ...(failed ? {} : { lastSuccessfulRunAt: new Date() }),
    } }));
    const progress = await getMemoryRecoveryProgress();
    return { ok: failed === 0, attempted, completed, failed, busy, remaining: progress.pending,
      needsInspection: progress.needsInspection, lastSuccessfulRunAt: progress.lastSuccessfulRunAt, elapsedMs: Date.now() - startedAt.getTime() };
  } catch {
    await recordHealth((tx) => tx.memoryRecoveryState.updateMany({ where: { id: healthId, runGeneration },
      data: { lastFinishedAt: new Date(), lastRunStatus: "FAILED" } })).catch(() => undefined);
    throw new Error("Scheduled Memory restoration could not finish.");
  }
}
