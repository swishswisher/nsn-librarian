import { Prisma } from "@prisma/client";
import { currentReadableRootSql } from "@/lib/bridge/current-readable-root";
import { latestKnowledgeSnapshot } from "@/lib/bridge/current-knowledge-query";

// Source identity is the exact reviewed document in its root's latest snapshot.
// Old observations, unavailable files, changed bytes and inaccessible roots
// cannot be used to complete or retrieve a current Memory entry.
// Append-only notes do not replace the latest approval/correction authority.
export const memoryReviewAuthoritySql = Prisma.sql`authority."decisionType" IN ('ACCEPT', 'MODIFY', 'REJECT')`;
const reviewedObservationIsCurrent = Prisma.sql`
  observation.status IN ('APPROVED', 'MODIFIED')
  AND (observation.status <> 'MODIFIED' OR EXISTS (
    SELECT 1 FROM "HumanDecision" decision WHERE decision."observationSessionId" = observation.id
      AND decision."decisionType" = 'MODIFY' AND length(btrim(decision."editedSuggestion")) > 0
      AND decision.id = (SELECT authority.id FROM "HumanDecision" authority
        WHERE authority."observationSessionId" = observation.id AND ${memoryReviewAuthoritySql}
        ORDER BY authority."createdAt" DESC, authority.id DESC LIMIT 1)))
  AND observation.id = (SELECT current.id FROM "ObservationSession" current
    WHERE current."libraryDocumentId" = observation."libraryDocumentId"
    ORDER BY current."createdAt" DESC, current.id DESC LIMIT 1)
`;
const reviewedDocumentIsCurrent = Prisma.sql`
  ${reviewedObservationIsCurrent} AND EXISTS (SELECT 1 FROM "ScannedFile" file
    JOIN "LibraryDocument" document ON document.id = file."libraryDocumentId"
    WHERE file."sessionId" = latest.id AND file."libraryDocumentId" = observation."libraryDocumentId"
      AND file."sourceUnavailableAt" IS NULL AND file.checksum IS NOT NULL
      AND (document.checksum IS NULL OR file.checksum = document.checksum))
`;

// Standalone uploads remain valid human curation inputs. A document that has
// physical library provenance must satisfy current root/snapshot authority.
export const eligibleMemoryObservationSql = Prisma.sql`${reviewedObservationIsCurrent} AND (
  NOT EXISTS (SELECT 1 FROM "ScannedFile" bound WHERE bound."libraryDocumentId" = observation."libraryDocumentId")
  OR EXISTS (SELECT 1 FROM "ScannedFile" candidate
    JOIN "ScanSession" candidate_scan ON candidate_scan.id = candidate."sessionId"
    JOIN "ConnectedFolder" root ON root.id = candidate_scan."connectedFolderId" ${latestKnowledgeSnapshot}
    WHERE candidate."libraryDocumentId" = observation."libraryDocumentId" AND candidate_scan.id = latest.id
      AND ${currentReadableRootSql} AND ${reviewedDocumentIsCurrent})
)`;

export async function currentMemorySourceRows(tx: Prisma.TransactionClient, sourceIds: string[]) {
  if (!sourceIds.length) return [];
  const rows: Array<{ observationSessionId: string; connectedLibraryId: string }> = [];
  for (let offset = 0; offset < sourceIds.length; offset += 500) rows.push(...await tx.$queryRaw<typeof rows>(Prisma.sql`
    SELECT DISTINCT observation.id AS "observationSessionId", root.id AS "connectedLibraryId"
    FROM "ObservationSession" observation
    JOIN "ScannedFile" candidate ON candidate."libraryDocumentId" = observation."libraryDocumentId"
    JOIN "ScanSession" candidate_scan ON candidate_scan.id = candidate."sessionId"
    JOIN "ConnectedFolder" root ON root.id = candidate_scan."connectedFolderId" ${latestKnowledgeSnapshot}
    WHERE observation.id IN (${Prisma.join(sourceIds.slice(offset, offset + 500))}) AND ${currentReadableRootSql}
      AND candidate_scan.id = latest.id AND ${reviewedDocumentIsCurrent}
  `));
  const rootIds = [...new Set(rows.map((row) => row.connectedLibraryId))].sort();
  const allowed = new Set<string>();
  for (let offset = 0; offset < rootIds.length; offset += 500) {
    const roots = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT root.id FROM "ConnectedFolder" root WHERE root.id IN (${Prisma.join(rootIds.slice(offset, offset + 500))})
        AND ${currentReadableRootSql} ORDER BY root.id FOR SHARE
    `);
    for (const root of roots) allowed.add(root.id);
  }
  return rows.filter((row) => allowed.has(row.connectedLibraryId));
}

export function validMemorySourcesSql(rootIds?: string[]) {
  return Prisma.sql`
    EXISTS (SELECT 1 FROM "MemorySearchSource" source WHERE source."memoryEntryId" = memory.id)
    AND NOT EXISTS (
      SELECT 1 FROM "MemorySearchSource" source
      WHERE source."memoryEntryId" = memory.id AND NOT EXISTS (
        SELECT 1 FROM "ObservationSession" observation
        JOIN "ConnectedFolder" root ON root.id = source."connectedLibraryId" ${latestKnowledgeSnapshot}
        WHERE observation.id = source."observationSessionId" AND ${currentReadableRootSql} AND ${reviewedDocumentIsCurrent}
          AND ${rootIds ? (rootIds.length ? Prisma.sql`root.id IN (${Prisma.join(rootIds)})` : Prisma.sql`false`) : Prisma.sql`true`}
      )
    )
  `;
}

export function eligibleMemorySql(rootIds?: string[]) {
  return Prisma.sql`memory.status = 'ACTIVE' AND memory."searchProvenanceComplete" = true
    AND memory."searchSourceCount" = (SELECT count(*) FROM "MemorySearchSource" source WHERE source."memoryEntryId" = memory.id)
    AND ${validMemorySourcesSql(rootIds)}`;
}

// Memory's human curation page also includes standalone uploads with no root.
// These are not application evidence. Modern unbound entries still retain and
// verify their observation manifest; legacy unbound notes remain human history.
export const curatedMemorySql = Prisma.sql`${eligibleMemorySql()} OR (
  memory.status = 'ACTIVE' AND memory."searchSourceCount" = 0
  AND NOT EXISTS (SELECT 1 FROM "MemorySearchSource" source WHERE source."memoryEntryId" = memory.id)
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(memory.evidence) = 'array'
    THEN memory.evidence ELSE '[]'::jsonb END) item
    CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(item->'sourceSessionIds') = 'array'
      THEN item->'sourceSessionIds' ELSE '[]'::jsonb END AS ids,
      CASE WHEN jsonb_typeof(item->'sourceAuthorities') = 'array' THEN item->'sourceAuthorities' ELSE '[]'::jsonb END AS authorities) manifest
    WHERE item->>'kind' = 'MEMORY_PROVENANCE_REQUIRED' AND NOT (
      jsonb_array_length(manifest.ids) > 0
      AND jsonb_array_length(manifest.ids) = (SELECT count(DISTINCT required.id) FROM jsonb_array_elements_text(manifest.ids) required(id))
      AND jsonb_array_length(manifest.ids) = jsonb_array_length(manifest.authorities)
      AND jsonb_array_length(manifest.ids) = (
        SELECT count(DISTINCT observation.id) FROM jsonb_array_elements_text(manifest.ids) required(id)
          JOIN jsonb_array_elements(manifest.authorities) binding ON binding->>'observationSessionId' = required.id
          JOIN "ObservationSession" observation ON observation.id = required.id
          WHERE ${reviewedObservationIsCurrent}
            AND binding->>'decisionId' IS NOT DISTINCT FROM (SELECT authority.id FROM "HumanDecision" authority
              WHERE authority."observationSessionId" = observation.id AND ${memoryReviewAuthoritySql}
              ORDER BY authority."createdAt" DESC, authority.id DESC LIMIT 1)
            AND NOT EXISTS (SELECT 1 FROM "ScannedFile" bound WHERE bound."libraryDocumentId" = observation."libraryDocumentId"))
    ))
)`;
