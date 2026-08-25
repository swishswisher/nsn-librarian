import { BridgeMonitoringError, ingestBridgeWatchEvents } from "@/lib/bridge/monitor";
import { authenticateBridgeDeviceRequest } from "@/lib/bridge/device-request-auth";
import { BridgeCloudError } from "@/lib/bridge/cloud-coordinator";

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
    const result = await ingestBridgeWatchEvents(deviceId, body.events);

    return Response.json({
      ...result,
      ok: true,
    });
  } catch (error) {
    if (error instanceof BridgeCloudError) {
      return Response.json(
        { code: error.code, error: error.message, ok: false },
        { status: error.statusCode },
      );
    }

    if (error instanceof BridgeMonitoringError) {
      return Response.json(
        { code: error.category, error: error.message, ok: false },
        { status: error.statusCode },
      );
    }

    return Response.json(
      {
        error: "The Bridge watch events could not be recorded right now.",
        ok: false,
      },
      { status: 500 },
    );
  }
}
