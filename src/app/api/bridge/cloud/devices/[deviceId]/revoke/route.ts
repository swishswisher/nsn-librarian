import { BridgeCloudError, revokeBridgeDevice } from "@/lib/bridge/cloud-coordinator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await context.params;

  try {
    return Response.json({
      device: await revokeBridgeDevice(deviceId),
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
        error: "The Bridge device could not be revoked right now.",
        ok: false,
      },
      { status: 500 },
    );
  }
}
