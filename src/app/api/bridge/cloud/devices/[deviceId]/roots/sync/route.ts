import { BridgeCloudError } from "@/lib/bridge/cloud-coordinator";
import { authenticateBridgeDeviceRequest } from "@/lib/bridge/device-request-auth";
import { syncBridgeDeviceRoots } from "@/lib/bridge/device-root-sync";

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
      libraries: await syncBridgeDeviceRoots(deviceId, body.roots),
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
        error: "The Bridge could not synchronize connected folders right now.",
        ok: false,
      },
      { status: 500 },
    );
  }
}
