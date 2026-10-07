import { Prisma } from "@prisma/client";
import { currentReadableRootSql } from "./current-readable-root";

// Shared SQL predicates keep authorization and the canonical completed snapshot
// inside the query, before any user-visible result limit. Aliases are fixed here.
export const readableKnowledgeRoot = currentReadableRootSql;

export const latestKnowledgeSnapshot = Prisma.sql`
  JOIN LATERAL (
    SELECT snapshot.id FROM "ScanSession" snapshot
    WHERE snapshot."connectedFolderId" = root.id
      AND snapshot.status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
      AND snapshot."inventoryGeneration" = root."physicalInventoryGeneration"
      AND NOT EXISTS (SELECT 1 FROM "ExecutionRun" physical_run WHERE physical_run."connectedLibraryId" = root.id AND physical_run.status IN ('PENDING', 'RUNNING'))
      AND NOT EXISTS (SELECT 1 FROM "UndoRun" physical_undo JOIN "ExecutionRun" undo_owner ON undo_owner.id = physical_undo."executionRunId"
        WHERE undo_owner."connectedLibraryId" = root.id AND physical_undo.status IN ('PENDING', 'RUNNING'))
    ORDER BY snapshot."startedAt" DESC, snapshot.id DESC LIMIT 1
  ) latest ON true`;

export function currentKnowledgeFile(relativePath: Prisma.Sql, checksum: Prisma.Sql) {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "ScannedFile" file
    WHERE file."sessionId" = latest.id AND file.checksum = ${checksum}
      AND lower(replace(btrim(file."relativePath"), chr(92), '/')) =
          lower(replace(btrim(${relativePath}), chr(92), '/'))
  )`;
}
