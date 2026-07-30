import {
  BridgeMonitoringError,
  stopMonitoringForFolder,
} from "@/lib/bridge/monitor";
import { getConnectedLibrary } from "@/lib/bridge/connected-libraries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ folderId: string }> },
) {
  const { folderId } = await context.params;

  try {
    const dashboard = await stopMonitoringForFolder(folderId);
    const library = await getConnectedLibrary(folderId);

    return Response.json({
      ok: true,
      dashboard,
      library,
      message: "Folder monitoring stopped.",
    });
  } catch (error) {
    if (error instanceof BridgeMonitoringError) {
      return Response.json(
        {
          ok: false,
          error: error.message,
          code: error.category,
        },
        { status: error.statusCode },
      );
    }

    return Response.json(
      {
        ok: false,
        error: "The Bridge could not stop folder monitoring right now.",
      },
      { status: 500 },
    );
  }
}
