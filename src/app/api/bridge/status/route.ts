import { getBridgeCloudStatus } from "@/lib/bridge/cloud-coordinator";
import { getLocalBridgeHealth } from "@/lib/bridge/local-bridge-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [localBridge, cloudBridge] = await Promise.all([
    getLocalBridgeHealth(),
    getBridgeCloudStatus().catch(() => ({
      connectedLibraries: [],
      devices: [],
    })),
  ]);

  return Response.json({
    bridge: localBridge,
    cloud: cloudBridge,
    ok: true,
  });
}
