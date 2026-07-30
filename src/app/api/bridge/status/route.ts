import { getBridgeCloudStatus } from "@/lib/bridge/cloud-coordinator";
import { cloudBridgeHealth } from "@/lib/bridge/effective-health";
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
  const bridge = localBridge.ok
    ? localBridge
    : cloudBridgeHealth(cloudBridge.devices);

  return Response.json({
    bridge,
    cloud: cloudBridge,
    ok: true,
  });
}
