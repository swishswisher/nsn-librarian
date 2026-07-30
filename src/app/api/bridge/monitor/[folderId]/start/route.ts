import { getConnectedLibrary } from "@/lib/bridge/connected-libraries";
import {
  BridgeMonitoringError,
  startMonitoringForConnectedLibrary,
} from "@/lib/bridge/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ folderId: string }> },
) {
  const { folderId } = await context.params;

  try {
    const dashboard = await startMonitoringForConnectedLibrary(folderId);
    const library = await getConnectedLibrary(folderId);

    return Response.json({
      ok: true,
      dashboard,
      library,
      message: "The Bridge is watching for changes.",
    });
  } catch (error) {
    if (error instanceof BridgeMonitoringError) {
      return Response.json(
        {
          ok: false,
          code: error.category,
          error: error.message,
        },
        { status: error.statusCode },
      );
    }

    return Response.json(
      {
        ok: false,
        error: "The Bridge could not start folder monitoring right now.",
      },
      { status: 500 },
    );
  }
}
