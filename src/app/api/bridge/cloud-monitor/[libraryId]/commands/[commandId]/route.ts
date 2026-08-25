import { BridgeCloudError } from "@/lib/bridge/cloud-coordinator";
import { getRemoteMonitoringActionStatus } from "@/lib/bridge/remote-monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: {
    params: Promise<{ commandId: string; libraryId: string }>;
  },
) {
  const { commandId, libraryId } = await context.params;

  try {
    const result = await getRemoteMonitoringActionStatus(libraryId, commandId);

    if ("error" in result) {
      return Response.json({
        done: result.done,
        error: result.error,
        library: result.library,
        ok: false,
        status: result.status,
      });
    }

    return Response.json({
      done: result.done,
      library: result.library,
      ok: true,
      status: result.status,
    });
  } catch (error) {
    if (error instanceof BridgeCloudError) {
      return Response.json(
        { error: error.message, ok: false },
        { status: error.statusCode },
      );
    }

    return Response.json(
      {
        error: "The Librarian could not check that watching update right now.",
        ok: false,
      },
      { status: 500 },
    );
  }
}
