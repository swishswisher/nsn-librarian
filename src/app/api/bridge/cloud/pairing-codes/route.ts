import { createBridgePairingCode, BridgeCloudError } from "@/lib/bridge/cloud-coordinator";

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
      error: "The Librarian could not create a Bridge pairing code right now.",
      ok: false,
    },
    { status: 500 },
  );
}

export async function POST() {
  try {
    return Response.json({
      ok: true,
      pairing: await createBridgePairingCode(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
