import {
  BridgeCloudError,
  fetchPendingBridgeCloudCommands,
} from "@/lib/bridge/cloud-coordinator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await context.params;

  try {
    return Response.json({
      commands: await fetchPendingBridgeCloudCommands(deviceId),
      ok: true,
    });
  } catch (error) {
    if (error instanceof BridgeCloudError) {
      return Response.json(
        {
          error: error.message,
          ok: false,
        },
        { status: error.statusCode },
      );
    }

    return Response.json(
      {
        error: "The Bridge could not fetch commands right now.",
        ok: false,
      },
      { status: 500 },
    );
  }
}
