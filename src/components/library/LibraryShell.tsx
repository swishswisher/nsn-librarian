import { Suspense, type ReactNode } from "react";

import type { NsnBadgeTone } from "@/components/library/NsnBadge";
import { LibraryAccount } from "@/components/library/LibraryAccount";
import { MobileLibraryMenu } from "@/components/library/MobileLibraryMenu";
import { NsnSidebar, LibraryNavigation, type LibrarySection } from "@/components/library/NsnSidebar";
import { getBridgeCloudStatus } from "@/lib/bridge/cloud-coordinator";
import { effectiveBridgeHealth } from "@/lib/bridge/effective-health";
import { bridgeHomeHealthDisplay } from "@/lib/bridge/home-health";
import { getLocalBridgeHealth } from "@/lib/bridge/local-bridge-client";

type LibraryShellProps = {
  active: LibrarySection;
  bridgeLabel?: string;
  bridgeTone?: NsnBadgeTone;
  children: ReactNode;
};

function BridgeStatus({ label, tone }: { label: string; tone?: NsnBadgeTone }) {
  return (
    <div className="flex items-center gap-3 text-sm text-[var(--nsn-slate)]" role="status">
      <span aria-hidden="true" className={[
        "h-2.5 w-2.5 rounded-full",
        tone === "review" ? "bg-[var(--nsn-warning)]"
          : tone === "migration" ? "bg-[var(--nsn-gold)]"
          : tone === "approved" ? "bg-[var(--nsn-success)]"
          : "bg-[var(--nsn-warm-gray)]",
      ].join(" ")} />
      <span>Bridge: {label}</span>
    </div>
  );
}

async function ResolvedBridgeStatus({ bridgeLabel, bridgeTone }: Pick<LibraryShellProps, "bridgeLabel" | "bridgeTone">) {
  let resolvedBridgeLabel = bridgeLabel;
  let resolvedBridgeTone = bridgeTone;

  if (!resolvedBridgeLabel || !resolvedBridgeTone) {
    const [localBridgeHealth, cloudBridgeStatus] = await Promise.all([
      getLocalBridgeHealth(),
      getBridgeCloudStatus().catch(() => ({ devices: [] })),
    ]);
    const bridgeHealth = effectiveBridgeHealth(
      localBridgeHealth,
      cloudBridgeStatus.devices,
    );
    const bridgeDisplay = bridgeHomeHealthDisplay({
      bridgeHealth,
      devices: cloudBridgeStatus.devices,
      formatLastSeen: (value) => value,
    });

    resolvedBridgeLabel ??= bridgeDisplay.badgeLabel;
    resolvedBridgeTone ??= bridgeDisplay.badgeTone;
  }

  return <BridgeStatus label={resolvedBridgeLabel!} tone={resolvedBridgeTone} />;
}

export function LibraryShell({ active, bridgeLabel, bridgeTone, children }: LibraryShellProps) {
  return (
    <main className="nsn-shell" data-section={active}>
      <a className="nsn-skip-link" href="#library-content">Skip to content</a>
      <NsnSidebar active={active} />
      <section className="nsn-workspace">
        <header className="nsn-workspace-header">
          <span className="nsn-workspace-title"><span className="sm:hidden">NSN</span><span className="hidden sm:inline">Deanne’s workspace</span></span>
          <div className="nsn-header-tools">
            <Suspense fallback={<BridgeStatus label="Checking connection…" />}>
              <ResolvedBridgeStatus bridgeLabel={bridgeLabel} bridgeTone={bridgeTone} />
            </Suspense>
            <Suspense fallback={null}><LibraryAccount /></Suspense>
            <MobileLibraryMenu><LibraryNavigation active={active} /></MobileLibraryMenu>
          </div>
        </header>
        <div className="nsn-page-content" id="library-content" tabIndex={-1}>{children}</div>
      </section>
    </main>
  );
}
