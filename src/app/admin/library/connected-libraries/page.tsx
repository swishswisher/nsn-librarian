import { ConnectedLibrariesManager } from "@/components/library/ConnectedLibrariesManager";
import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getBridgeCloudStatus } from "@/lib/bridge/cloud-coordinator";
import { getConnectedLibraries } from "@/lib/bridge/connected-libraries";
import { cloudBridgeHealth } from "@/lib/bridge/effective-health";
import { getLocalBridgeHealth } from "@/lib/bridge/local-bridge-client";

export const dynamic = "force-dynamic";

export default async function ConnectedLibrariesPage() {
  const [libraries, localBridgeHealth, cloudStatus] = await Promise.all([
    getConnectedLibraries(),
    getLocalBridgeHealth(),
    getBridgeCloudStatus().catch(() => ({
      connectedLibraries: [],
      devices: [],
    })),
  ]);
  const bridgeHealth = localBridgeHealth.ok
    ? localBridgeHealth
    : cloudBridgeHealth(cloudStatus.devices);
  const connectedCount = libraries.filter(
    (library) =>
      library.bridgeReachable &&
      library.isEnabled &&
      !library.isHiddenFromActiveList &&
      !library.isLegacyConnection &&
      !library.isMergedDuplicate &&
      (library.status === "CONNECTED" ||
        library.status === "PAUSED" ||
        library.status === "NEEDS_ATTENTION"),
  ).length;
  const historicalCount = libraries.filter(
    (library) =>
      !library.isHiddenFromActiveList &&
      !library.isMergedDuplicate &&
      !(
        library.isEnabled &&
        !library.isLegacyConnection &&
        (library.status === "CONNECTED" ||
          library.status === "PAUSED" ||
          library.status === "NEEDS_ATTENTION")
      ),
  ).length;

  return (
    <LibraryShell
      active="connected-libraries"
      bridgeLabel={
        bridgeHealth.ok
          ? `${connectedCount} active, ${historicalCount} historical`
          : bridgeHealth.paired
            ? "Mac paired, Bridge offline"
            : "Bridge not paired"
      }
      bridgeTone={bridgeHealth.ok ? "approved" : "pending"}
    >
      <div className="grid min-w-0 gap-8">
        <NsnPageHeader
          description="Connected Libraries are local folders Deanne has allowed the Bridge to inspect. The database stores knowledge work and history, not copied files."
          eyebrow="Bridge"
          subtitle="The local computer remains the source of truth."
          title="Connected Libraries"
        />

        <ConnectedLibrariesManager
          initialBridgeHealth={bridgeHealth}
          initialLibraries={libraries}
        />
      </div>
    </LibraryShell>
  );
}
