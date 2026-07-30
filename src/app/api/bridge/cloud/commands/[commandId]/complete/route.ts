import {
  BridgeCloudError,
  completeBridgeCloudCommand,
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
  const status = body?.status;

  if (!bridgeDeviceId) {
    return Response.json(
      {
        error: "The Bridge device could not be verified.",
        ok: false,
      },
      { status: 400 },
    );
  }

  if (status !== "COMPLETED" && status !== "FAILED" && status !== "REJECTED") {
    return Response.json(
      {
        error: "Choose a safe command result first.",
        ok: false,
      },
      { status: 400 },
    );
  }

  try {
    return Response.json({
      command: await completeBridgeCloudCommand(bridgeDeviceId, {
        commandId,
        result: body?.result === undefined ? null : (body.result as never),
        safeErrorCategory:
          typeof body?.safeErrorCategory === "string"
            ? body.safeErrorCategory
            : null,
        status,
      }),
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
        error: "The Bridge command result could not be recorded right now.",
        ok: false,
      },
      { status: 500 },
    );
  }
}
