import { getBridgeScanSessionProgress } from "@/lib/bridge/scan-sessions";
import { expireRemoteReadCommandsForSession } from "@/lib/bridge/remote-read-commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;

  await expireRemoteReadCommandsForSession(sessionId);

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
}
