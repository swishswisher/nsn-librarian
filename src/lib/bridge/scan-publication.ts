import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { indexScanKnowledge } from "@/lib/library/search-index";
import { latestKnowledgeSnapshot, readableKnowledgeRoot } from "./current-knowledge-query";
import { persistScanWorkingKnowledge } from "./persistent-knowledge";
import { lockCurrentScanPublication, scanPublicationTransactionOptions } from "./scan-publication-lock";
import { loadScanWorkingKnowledge } from "./scan-working-knowledge";
import type { KnowledgeWork } from "./knowledge-work";

export const scanPublicationBatchSize = 2;
const retryDelayMs = 60_000;
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
        const current = await lockCurrentScanPublication(tx, sessionId);
        if (!current) return false;
        if (stage === "searchIndexStatus" && current.knowledgePersistenceStatus !== "COMPLETED") return false;
        if (current[stage] === "COMPLETED") return true;
        expectedStatus = current[stage];
        const index = await loadScanWorkingKnowledge(sessionId, undefined, tx);
        if (stage === "knowledgePersistenceStatus") await persistScanWorkingKnowledge(index, work, tx);
        else await indexScanKnowledge(index, undefined, undefined, tx);
        await tx.scanSession.update({ where: { id: sessionId }, data: { [stage]: "COMPLETED" } });
        return true;
      }, scanPublicationTransactionOptions);
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

/** Identity authority changes hashes but not extracted document evidence. The
 * ordinary publisher repairs Search even if the eager projection request dies. */
export async function invalidateRootSearchPublication(tx: Prisma.TransactionClient, rootId: string) {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "ScanSession" session SET "searchIndexStatus" = ${`NOT_ATTEMPTED@${crypto.randomUUID()}`}
    WHERE session.id IN (SELECT latest.id FROM "ConnectedFolder" root ${latestKnowledgeSnapshot}
      WHERE root.id = ${rootId} AND ${readableKnowledgeRoot})
  `);
}
