import {
  BridgeCloudError,
  pairBridgeDevice,
  platformFromRequest,
} from "@/lib/bridge/cloud-coordinator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
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
      error: "The Bridge could not be paired right now.",
      ok: false,
    },
    { status: 500 },
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    if (!body) {
      return Response.json(
        {
          error: "Expected a pairing request.",
          ok: false,
        },
        { status: 400 },
      );
    }

    const device = await pairBridgeDevice({
      appVersion:
        typeof body.appVersion === "string" ? body.appVersion : "",
      architecture:
        typeof body.architecture === "string" ? body.architecture : "",
      bridgeDeviceId:
        typeof body.bridgeDeviceId === "string" ? body.bridgeDeviceId : "",
      deviceDisplayName:
        typeof body.deviceDisplayName === "string"
          ? body.deviceDisplayName
          : "",
      pairingCode:
        typeof body.pairingCode === "string" ? body.pairingCode : "",
      platform: platformFromRequest(body.platform),
      publicKey: typeof body.publicKey === "string" ? body.publicKey : "",
    });

    return Response.json({
      device,
      ok: true,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
