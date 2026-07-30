import { BridgeCloudError } from "@/lib/bridge/cloud-coordinator";
import { authenticateBridgeDeviceRequest } from "@/lib/bridge/device-request-auth";
import { fetchRecoverableBridgeCommands } from "@/lib/bridge/recoverable-commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await context.params;

  try {
    await authenticateBridgeDeviceRequest({
      bridgeDeviceId: deviceId,
      request,
    });

    return Response.json({
      commands: await fetchRecoverableBridgeCommands(deviceId),
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
