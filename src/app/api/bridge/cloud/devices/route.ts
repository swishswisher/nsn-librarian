import { BridgeCloudError, listBridgeDevices } from "@/lib/bridge/cloud-coordinator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({
      devices: await listBridgeDevices(),
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
        error: "The Librarian could not read Bridge devices right now.",
        ok: false,
      },
      { status: 500 },
    );
  }
}
