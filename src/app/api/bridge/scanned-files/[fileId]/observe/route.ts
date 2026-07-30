import { createObservationSessionForScannedFile } from "@/lib/bridge/scanned-file-observations";
import { BridgeReaderError } from "@/lib/bridge/reader";
import { ObservationSessionError } from "@/lib/library/observation-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await context.params;

  try {
    const { connectionCount, observerType, result, sessionId } =
      await createObservationSessionForScannedFile(fileId);

    return Response.json({
      ok: true,
      result,
      sessionId,
      observerType,
      connectionCount,
      hasReviewableSuggestions: result.planSuggestions.length > 0,
    });
  } catch (error) {
    if (error instanceof BridgeReaderError) {
      return Response.json(
        {
          ok: false,
          error: error.message,
        },
        { status: error.statusCode },
      );
    }

    if (error instanceof ObservationSessionError) {
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
        error: "The Librarian could not examine this file right now.",
      },
      { status: 500 },
    );
  }
}
