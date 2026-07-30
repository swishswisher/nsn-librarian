import {
  acknowledgeBridgeCloudCommand,
  BridgeCloudError,
} from "@/lib/bridge/cloud-coordinator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ commandId: string }> },
) {
  const { commandId } = await context.params;
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const bridgeDeviceId =
    typeof body?.bridgeDeviceId === "string" ? body.bridgeDeviceId : "";

  if (!bridgeDeviceId) {
    return Response.json(
      {
        error: "The Bridge device could not be verified.",
        ok: false,
      },
      { status: 400 },
    );
  }

  try {
    return Response.json({
      command: await acknowledgeBridgeCloudCommand(bridgeDeviceId, commandId),
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
        error: "The Bridge command could not be acknowledged right now.",
        ok: false,
      },
      { status: 500 },
    );
  }
}
