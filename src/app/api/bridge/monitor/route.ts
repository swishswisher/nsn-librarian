import {
  BridgeMonitoringError,
  getMonitoringDashboardData,
  startMonitoringForConnectedLibrary,
  startMonitoringForConfiguredFolder,
} from "@/lib/bridge/monitor";
import { getConnectedLibrary } from "@/lib/bridge/connected-libraries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function monitoringErrorResponse(error: unknown) {
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
      error:
        "The Bridge could not update folder monitoring right now. Check the connected folder and try again.",
    },
    { status: 500 },
  );
}

export async function GET() {
  try {
    const dashboard = await getMonitoringDashboardData();

    return Response.json({
      ok: true,
      dashboard,
    });
  } catch (error) {
    return monitoringErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      connectedLibraryId?: unknown;
    } | null;
    const connectedLibraryId =
      typeof body?.connectedLibraryId === "string" &&
      body.connectedLibraryId.trim()
        ? body.connectedLibraryId.trim()
        : null;
    const dashboard = connectedLibraryId
      ? await startMonitoringForConnectedLibrary(connectedLibraryId)
      : await startMonitoringForConfiguredFolder();
    const library = connectedLibraryId
      ? await getConnectedLibrary(connectedLibraryId)
      : null;

    return Response.json({
      ok: true,
      dashboard,
      library,
      message: "The Bridge is watching for changes.",
    });
  } catch (error) {
    return monitoringErrorResponse(error);
  }
}
