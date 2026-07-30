import { BridgeMonitoringDashboard } from "@/components/library/BridgeMonitoringDashboard";
import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getMonitoringDashboardData } from "@/lib/bridge/monitor";

export const dynamic = "force-dynamic";

export default async function BridgeMonitoringPage() {
  const dashboard = await getMonitoringDashboardData();

  return (
    <LibraryShell active="monitoring">
      <div className="grid min-w-0 gap-8">
        <NsnPageHeader
          description="Continuous monitoring keeps the Librarian aware of local folder changes. It records metadata, prepares provisional review material, and leaves every decision with Deanne."
          eyebrow="Bridge Monitoring"
          title="Bridge Monitoring"
        />

        <BridgeMonitoringDashboard initialDashboard={dashboard} />
      </div>
    </LibraryShell>
  );
}
