import { processNextBridgeScanSessionFile } from "@/lib/bridge/processing-pipeline";
import { BridgeCloudError } from "@/lib/bridge/cloud-coordinator";
import { ConnectedLibraryError } from "@/lib/bridge/connected-libraries";
import {
  OrganizationSuggestionError,
  prepareOrganizationRecommendationRegeneration,
} from "@/lib/bridge/organization-suggestions";
import { queueRemoteRecommendationRegenerationForSession } from "@/lib/bridge/remote-read-commands";
import { remoteSessionIsCloudManaged } from "@/lib/bridge/remote-scan-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    confirmation?: unknown;
    regenerate?: unknown;
    retryFailed?: unknown;
    retryStartedAt?: unknown;
  } | null;
  const regenerate = body?.regenerate === true;
  const confirmedReviewedDecisions = body?.confirmation === "REGENERATE";

  try {
    if (await remoteSessionIsCloudManaged(sessionId)) {
      const result =
        await queueRemoteRecommendationRegenerationForSession(sessionId, {
          confirmedReviewedDecisions,
          regenerate,
        });

      return Response.json(
        {
          message: result.message,
          ok: true,
          progress: result.progress,
          queued: result.queued,
          queuedFiles: result.queuedFiles,
          session: result.session,
        },
        { status: result.queued ? 202 : 200 },
      );
    }

    const retryStartedAt =
      typeof body?.retryStartedAt === "string"
        ? new Date(body.retryStartedAt)
        : null;

    if (regenerate) {
      await prepareOrganizationRecommendationRegeneration(sessionId, {
        confirmedReviewedDecisions,
      });
    }

    const result = await processNextBridgeScanSessionFile(sessionId, {
      includeFailed: body?.retryFailed === true,
      retryStartedAt:
        retryStartedAt && Number.isFinite(retryStartedAt.getTime())
          ? retryStartedAt
          : undefined,
    });

    return Response.json({
      ok: true,
      progress: result.progress,
      session: result.session,
    });
  } catch (error) {
    if (
      error instanceof BridgeCloudError ||
      error instanceof ConnectedLibraryError ||
      error instanceof OrganizationSuggestionError
    ) {
      return Response.json(
        {
          ...(error instanceof BridgeCloudError ? { code: error.code } : {}),
          ok: false,
          error: error.message,
        },
        { status: error.statusCode },
      );
    }

    return Response.json(
      {
        ok: false,
        error:
          "The Librarian could not retry automatic processing for this scan session right now.",
      },
      { status: 500 },
    );
  }
}
