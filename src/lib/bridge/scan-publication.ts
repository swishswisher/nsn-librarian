import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { indexScanKnowledge } from "@/lib/library/search-index";
import { latestKnowledgeSnapshot, readableKnowledgeRoot } from "./current-knowledge-query";
import { persistScanWorkingKnowledge, usableScanSnapshotWhere } from "./persistent-knowledge";
import { loadScanWorkingKnowledge } from "./scan-working-knowledge";
import type { KnowledgeWork } from "./knowledge-work";

export const scanPublicationBatchSize = 2;
const retryDelayMs = 60_000;
const stageTimeoutMs = 30 * 60_000;
type Stage = "knowledgePersistenceStatus" | "searchIndexStatus";

function retryTime(column: Prisma.Sql) {
  return Prisma.sql`CASE WHEN ${column} ~ '^INCOMPLETE@[0-9]+$'
    THEN split_part(${column}, '@', 2)::numeric ELSE 0 END`;
}

/** NOT_ATTEMPTED/INCOMPLETE are durable work, not terminal success. A retry
 * deadline lives in the existing string status, so failures cannot monopolize
 * the coordinator's small window. No in-memory owner or new schema is needed. */
export async function publishScanDerivedKnowledge(sessionId: string, through: "KNOWLEDGE" | "SEARCH" = "SEARCH", work?: KnowledgeWork) {
  const prisma = getPrismaClient();
  const stages: Stage[] = through === "KNOWLEDGE" ? ["knowledgePersistenceStatus"] :
    ["knowledgePersistenceStatus", "searchIndexStatus"];
  for (const stage of stages) {
    let expectedStatus: string | undefined;
    try {
      const ready = await prisma.$transaction(async (tx) => {
        const session = await tx.scanSession.findUnique({ where: { id: sessionId },
          select: { connectedFolderId: true } });
        if (!session) return false;
        // The database owns this lock until commit/rollback or connection death.
        // The root key also serializes publication of competing snapshots.
        const [lock] = await tx.$queryRaw<Array<{ owned: boolean }>>(Prisma.sql`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${`scan-publication:${session.connectedFolderId}`}, 0)) AS owned
        `);
        if (!lock?.owned) return false;
        // Keep the authorization row stable through this stage's commit. A
        // concurrent revocation takes effect after these already-owned writes;
        // the next stage must authorize again and cannot run under stale rights.
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder"
          WHERE id = ${session.connectedFolderId} FOR SHARE`);
        const current = await tx.scanSession.findFirst({
          where: { ...usableScanSnapshotWhere, connectedFolderId: session.connectedFolderId,
            connectedFolder: { isEnabled: true, readPermission: true, status: "CONNECTED",
              disconnectedAt: null, hiddenFromActiveListAt: null, mergedAt: null,
              canonicalConnectedLibraryId: null } },
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          select: { id: true, knowledgePersistenceStatus: true, searchIndexStatus: true },
        });
        if (current?.id !== sessionId) return false;
        if (stage === "searchIndexStatus" && current.knowledgePersistenceStatus !== "COMPLETED") return false;
        if (current[stage] === "COMPLETED") return true;
        expectedStatus = current[stage];
        const index = await loadScanWorkingKnowledge(sessionId, undefined, tx);
        if (stage === "knowledgePersistenceStatus") await persistScanWorkingKnowledge(index, work, tx);
        else await indexScanKnowledge(index, undefined, undefined, tx);
        await tx.scanSession.update({ where: { id: sessionId }, data: { [stage]: "COMPLETED" } });
        return true;
      }, { isolationLevel: "Serializable", timeout: stageTimeoutMs, maxWait: 5_000 });
      if (!ready) return false;
    } catch {
      // Never roll a newer worker's success back. The failed stage transaction
      // has already rolled back all its writes. Preserve primary completion and
      // completed Knowledge, and defer the next automatic attempt durably.
      if (expectedStatus !== undefined) await prisma.scanSession.updateMany({
        where: { id: sessionId, [stage]: expectedStatus },
        data: { [stage]: `INCOMPLETE@${Date.now() + retryDelayMs}`,
          ...(stage === "knowledgePersistenceStatus" ? { searchIndexStatus: "INCOMPLETE" } : {}) },
      });
      return false;
    }
  }
  return true;
}

/** Called by ordinary Bridge command polling, including after the original
 * command/request has ended. Only authorized latest completed snapshots enter
 * the deterministic two-scan retry budget. */
export async function recoverPendingScanPublications(scope: { deviceId?: string; sessionId?: string } = {}, now = new Date()) {
  const knowledge = Prisma.sql`session."knowledgePersistenceStatus"`;
  const search = Prisma.sql`session."searchIndexStatus"`;
  const retry = Prisma.sql`CASE WHEN ${knowledge} <> 'COMPLETED'
    THEN ${retryTime(knowledge)} ELSE ${retryTime(search)} END`;
  const sessions = await getPrismaClient().$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT session.id FROM "ConnectedFolder" root
    ${latestKnowledgeSnapshot}
    JOIN "ScanSession" session ON session.id = latest.id
    WHERE ${readableKnowledgeRoot}
      AND ${scope.deviceId ? Prisma.sql`root."bridgeDeviceId" = ${scope.deviceId}` : Prisma.sql`true`}
      AND ${scope.sessionId ? Prisma.sql`root.id = (SELECT "connectedFolderId" FROM "ScanSession" WHERE id = ${scope.sessionId})
        AND session.id = ${scope.sessionId}` : Prisma.sql`true`}
      AND (${knowledge} <> 'COMPLETED' OR ${search} <> 'COMPLETED')
      AND ${retry} <= ${now.getTime()}
    ORDER BY ${retry} ASC, session."startedAt" ASC, session.id ASC
    LIMIT ${scanPublicationBatchSize}
  `);
  let completed = 0;
  for (const session of sessions) if (await publishScanDerivedKnowledge(session.id)) completed++;
  return { attempted: sessions.length, completed };
}

export function recoverScanPublicationsForDevice(deviceId: string, now = new Date()) {
  return recoverPendingScanPublications({ deviceId }, now);
}

/** Write the retry obligation in the same transaction as human authority. A
 * unique generation also prevents a late failure report from settling a later
 * decision that happens to have the same pending status. Historical scans and
 * inaccessible roots are never made current by this invalidation. */
export async function invalidateDocumentScanPublications(tx: Prisma.TransactionClient, documentId: string) {
  const pending = `NOT_ATTEMPTED@${crypto.randomUUID()}`;
  await tx.$executeRaw(Prisma.sql`
    UPDATE "ScanSession" session SET "knowledgePersistenceStatus" = ${pending}, "searchIndexStatus" = ${pending}
    WHERE session.id IN (
      SELECT latest.id FROM "ConnectedFolder" root ${latestKnowledgeSnapshot}
      WHERE ${readableKnowledgeRoot} AND EXISTS (
        SELECT 1 FROM "ScannedFile" file WHERE file."sessionId" = latest.id
          AND file."libraryDocumentId" = ${documentId}
      )
    )
  `);
}
