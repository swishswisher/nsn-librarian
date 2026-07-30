import {
  BridgeCloudError,
  recordBridgeHeartbeat,
} from "@/lib/bridge/cloud-coordinator";
import { authenticateBridgeDeviceRequest } from "@/lib/bridge/device-request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await context.params;

  try {
    const bodyText = await request.text();
    await authenticateBridgeDeviceRequest({
      bodyText,
      bridgeDeviceId: deviceId,
      request,
    });
    const body = bodyText
      ? (JSON.parse(bodyText) as Record<string, unknown>)
      : {};

    return Response.json({
      device: await recordBridgeHeartbeat(deviceId, body),
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
        error: "The Bridge heartbeat could not be recorded right now.",
        ok: false,
      },
      { status: 500 },
    );
  }
}
