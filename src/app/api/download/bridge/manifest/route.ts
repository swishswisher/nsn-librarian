import { getBridgeReleaseManifest } from "@/lib/bridge/release-manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function buildBridgeReleaseManifestResponse(
  loadManifest = getBridgeReleaseManifest,
) {
  try {
    return Response.json({
      manifest: await loadManifest(),
      ok: true,
    });
  } catch {
    return Response.json(
      {
        error: "The Bridge download information is not available right now.",
        ok: false,
      },
      { status: 503 },
    );
  }
}

export async function GET() {
  return buildBridgeReleaseManifestResponse();
}
