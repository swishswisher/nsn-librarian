import { getBridgeCloudStatus, listBridgeDevices } from "@/lib/bridge/cloud-coordinator";
import { cloudBridgeHealth } from "@/lib/bridge/effective-health";
import { bridgeHomeHealthDisplay } from "@/lib/bridge/home-health";
import { getLocalBridgeHealth } from "@/lib/bridge/local-bridge-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
  if (request && new URL(request.url).searchParams.get("view") === "indicator") {
    try {
      const devices = await listBridgeDevices();
      const display = bridgeHomeHealthDisplay({
        devices, bridgeHealth: cloudBridgeHealth(devices), formatLastSeen: (value) => value,
      });
      return Response.json({ ok: true, label: display.badgeLabel, tone: display.badgeTone });
    } catch {
      return Response.json({ ok: false }, { status: 503 });
    }
  }
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
