import { BridgeCloudError } from "@/lib/bridge/cloud-coordinator";
import { queueRemoteMonitoringAction } from "@/lib/bridge/remote-monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: {
    params: Promise<{ action: string; libraryId: string }>;
  },
) {
  const { action, libraryId } = await context.params;

  if (action !== "start" && action !== "pause" && action !== "resume") {
    return Response.json(
      { error: "That watching action is not supported.", ok: false },
      { status: 404 },
    );
  }

  try {
    const result = await queueRemoteMonitoringAction(libraryId, action);

    return Response.json({
      commandId: result.commandId,
      library: result.library,
      message: result.message,
      ok: true,
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
        error: "The Librarian could not update watching right now.",
        ok: false,
      },
      { status: 500 },
    );
  }
}
