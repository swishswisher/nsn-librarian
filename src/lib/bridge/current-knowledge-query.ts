import { Prisma } from "@prisma/client";

// Shared SQL predicates keep authorization and the canonical completed snapshot
// inside the query, before any user-visible result limit. Aliases are fixed here.
export const readableKnowledgeRoot = Prisma.sql`
  root.enabled AND root."readPermission" AND root.status = 'CONNECTED'
  AND root."disconnectedAt" IS NULL AND root."hiddenFromActiveListAt" IS NULL
  AND root."mergedAt" IS NULL AND root."canonicalConnectedLibraryId" IS NULL`;

export const latestKnowledgeSnapshot = Prisma.sql`
  JOIN LATERAL (
    SELECT snapshot.id FROM "ScanSession" snapshot
    WHERE snapshot."connectedFolderId" = root.id
      AND snapshot.status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
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
