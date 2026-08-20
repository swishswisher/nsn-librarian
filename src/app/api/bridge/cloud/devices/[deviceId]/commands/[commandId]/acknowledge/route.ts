import {
  acknowledgeBridgeCloudCommand,
  BridgeCloudError,
} from "@/lib/bridge/cloud-coordinator";
import { authenticateBridgeDeviceRequest } from "@/lib/bridge/device-request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: {
    params: Promise<{ commandId: string; deviceId: string }>;
  },
) {
  const { commandId, deviceId } = await context.params;

  try {
    const bodyText = await request.text();
    await authenticateBridgeDeviceRequest({
      bodyText,
      bridgeDeviceId: deviceId,
      request,
    });

    return Response.json({
      command: await acknowledgeBridgeCloudCommand(deviceId, commandId),
      ok: true,
    });
  } catch (error) {
    if (error instanceof BridgeCloudError) {
      return Response.json(
        { code: error.code, error: error.message, ok: false },
        { status: error.statusCode },
      );
    }

    return Response.json(
      {
        error: "The Bridge command could not be acknowledged right now.",
        ok: false,
      },
      { status: 500 },
    );
  }
}
