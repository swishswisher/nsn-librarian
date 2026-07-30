import {
  getBridgeScanSessionProgress,
  markBridgeScanSessionFailed,
} from "@/lib/bridge/scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;

  try {
    await markBridgeScanSessionFailed(sessionId);
    const result = await getBridgeScanSessionProgress(sessionId);

    if (!result) {
      return Response.json(
        {
          ok: false,
          error: "The Librarian could not find that scan session.",
        },
        { status: 404 },
      );
    }

    return Response.json({
      ok: true,
      progress: result.progress,
      session: result.session,
    });
  } catch {
    return Response.json(
      {
        ok: false,
        error:
          "The Librarian could not mark this scan session as failed right now.",
      },
      { status: 500 },
    );
  }
}
