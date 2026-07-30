import { processNextBridgeScanSessionFile } from "@/lib/bridge/processing-pipeline";
import { ConnectedLibraryError } from "@/lib/bridge/connected-libraries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;

  try {
    const body = (await request.json().catch(() => null)) as {
      retryFailed?: unknown;
      retryStartedAt?: unknown;
    } | null;
    const retryStartedAt =
      typeof body?.retryStartedAt === "string"
        ? new Date(body.retryStartedAt)
        : null;
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
    if (error instanceof ConnectedLibraryError) {
      return Response.json(
        {
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
