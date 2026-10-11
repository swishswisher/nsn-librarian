import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { currentRecommendationGenerationVersion } from "./recommendation-generation";
import type { BridgeScanProcessingProgress } from "./types";

type Counts = { filesRead: number; filesExamined: number; filesProcessed: number; filesWithSuggestions: number;
  failedFiles: number; suggestionsGenerated: number; pendingSuggestions: number; lastActivityAt: Date | null;
  aiUsage: BridgeScanProcessingProgress["aiUsage"] };

// Constant query/result size. Aggregate each session's eligible child set once;
// progress must not transfer full file rows, media, and observation history.
export async function scanProgressCounts(sessionId: string): Promise<Counts> {
  const [row] = await getPrismaClient().$queryRaw<Counts[]>(Prisma.sql`
    WITH suggestions AS (
      SELECT "scannedFileId", count(*)::integer AS total,
        count(*) FILTER (WHERE status = 'PENDING')::integer AS pending
      FROM "OrganizationSuggestion" WHERE "scanSessionId" = ${sessionId}
        AND "invalidatedAt" IS NULL AND "recommendationGenerationVersion" = ${currentRecommendationGenerationVersion}
      GROUP BY "scannedFileId"
    ), files AS (
      SELECT f.*, coalesce(s.total, 0) AS suggestions, coalesce(s.pending, 0) AS pending,
        (f."processingStage" = 'FAILED' OR f."readStatus" = 'FAILED' OR f."readingStatus" = 'FAILED' OR f."extractionStatus" = 'FAILED') AS failed,
        (f."fileType" !~ '^(IMAGE|AUDIO|VIDEO)_' AND f."readStatus" = 'SUPPORTED') AS document
      FROM "ScannedFile" f LEFT JOIN suggestions s ON s."scannedFileId" = f.id WHERE f."sessionId" = ${sessionId}
    )
    SELECT count(*) FILTER (WHERE "readingStatus" = 'READ')::integer AS "filesRead",
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "ObservationSession" o WHERE o."libraryDocumentId" = files."libraryDocumentId"))::integer AS "filesExamined",
      count(*) FILTER (WHERE failed OR "processingStage" = 'UNSUPPORTED' OR "readStatus" = 'UNSUPPORTED'
        OR ("processingStage" IN ('SUGGESTIONS_GENERATED', 'RECOMMENDATIONS_READY') AND suggestions > 0))::integer AS "filesProcessed",
      count(*) FILTER (WHERE suggestions > 0)::integer AS "filesWithSuggestions",
      count(*) FILTER (WHERE failed)::integer AS "failedFiles",
      coalesce(sum(suggestions), 0)::integer AS "suggestionsGenerated", coalesce(sum(pending), 0)::integer AS "pendingSuggestions",
      max(greatest("processedAt", "extractedAt")) AS "lastActivityAt",
      jsonb_build_object(
        'models', coalesce(array_agg(DISTINCT "aiModel" ORDER BY "aiModel") FILTER (WHERE document AND "aiModel" IS NOT NULL), ARRAY[]::text[]),
        'processingVersions', coalesce(array_agg(DISTINCT "observationVersion" ORDER BY "observationVersion") FILTER (WHERE document AND "observationVersion" IS NOT NULL), ARRAY[]::text[]),
        'requests', coalesce(sum("aiRequestCount") FILTER (WHERE document), 0),
        'httpAttempts', coalesce(sum("aiHttpAttempts") FILTER (WHERE document), 0),
        'inputTokens', coalesce(sum("aiInputTokens") FILTER (WHERE document), 0),
        'outputTokens', coalesce(sum("aiOutputTokens") FILTER (WHERE document), 0),
        'unreportedTokenRequests', count(*) FILTER (WHERE document AND "aiRequestCount" > 0 AND ("aiInputTokens" IS NULL OR "aiOutputTokens" IS NULL)),
        'newlyObserved', count(*) FILTER (WHERE document AND "observationOrigin" = 'NEW_AI'),
        'reusedObservations', count(*) FILTER (WHERE document AND "observationOrigin" = 'REUSED_AI'),
        'failedObservations', count(*) FILTER (WHERE document AND "observationOrigin" = 'BASIC' AND "aiRequestCount" > 0),
        'pendingDocuments', count(*) FILTER (WHERE document AND "observationOrigin" IS NULL AND "processingStage" <> 'FAILED'),
        'avoidedRequests', count(*) FILTER (WHERE document AND "observationOrigin" = 'REUSED_AI')
      ) AS "aiUsage" FROM files`);
  return row;
}
