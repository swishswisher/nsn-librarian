import {
  BridgeMonitoringError,
  resumeMonitoringForFolder,
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
    const dashboard = await resumeMonitoringForFolder(folderId);
    const library = await getConnectedLibrary(folderId);

    return Response.json({
      ok: true,
      dashboard,
      library,
      message: "Folder monitoring resumed.",
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
        error: "The Bridge could not resume folder monitoring right now.",
      },
      { status: 500 },
    );
  }
}
