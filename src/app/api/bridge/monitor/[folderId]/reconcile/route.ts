import {
  BridgeMonitoringError,
  reconcileMonitoringForFolder,
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
    const dashboard = await reconcileMonitoringForFolder(folderId);
    const library = await getConnectedLibrary(folderId);

    return Response.json({
      ok: true,
      dashboard,
      library,
      message: "The Bridge checked the folder and reconciled missed changes.",
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
        error: "The Bridge could not reconcile that folder right now.",
      },
      { status: 500 },
    );
  }
}
