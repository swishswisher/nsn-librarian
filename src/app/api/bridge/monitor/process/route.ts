import {
  BridgeMonitoringError,
  processMonitoringQueue,
} from "@/lib/bridge/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      connectedFolderId?: unknown;
      connectedLibraryId?: unknown;
      retryAttention?: unknown;
    } | null;
    const connectedLibraryId =
      typeof body?.connectedLibraryId === "string"
        ? body.connectedLibraryId
        : typeof body?.connectedFolderId === "string"
          ? body.connectedFolderId
          : undefined;
    const dashboard = await processMonitoringQueue({
      connectedFolderId: connectedLibraryId,
      retryAttention: body?.retryAttention === true,
    });

    return Response.json({
      ok: true,
      dashboard,
      message: "The Librarian processed watched folder changes.",
    });
  } catch (error) {
    if (error instanceof BridgeMonitoringError) {
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
          "The Librarian could not process watched folder changes right now.",
      },
      { status: 500 },
    );
  }
}
