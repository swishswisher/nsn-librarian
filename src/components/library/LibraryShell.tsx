import type { ReactNode } from "react";

import type { NsnBadgeTone } from "@/components/library/NsnBadge";
import { LibraryQuickNav } from "@/components/library/LibraryQuickNav";
import { NsnSidebar, type LibrarySection } from "@/components/library/NsnSidebar";
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

export async function LibraryShell({
  active,
  bridgeLabel,
  bridgeTone,
  children,
}: LibraryShellProps) {
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

  return (
    <main className="min-h-screen bg-[var(--nsn-cream)] text-[var(--nsn-navy)] lg:grid lg:grid-cols-[280px_minmax(0,1fr)]">
      <NsnSidebar active={active} />

      <section className="min-w-0">
        <div className="border-b border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 py-4 sm:px-6 lg:px-8">
          <div className="mx-auto grid max-w-7xl gap-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 text-sm text-[var(--nsn-slate)]">
                <span
                  aria-hidden="true"
                  className={[
                    "h-2.5 w-2.5 rounded-full",
                    resolvedBridgeTone === "review"
                      ? "bg-[var(--nsn-warning)]"
                      : resolvedBridgeTone === "migration"
                        ? "bg-[var(--nsn-gold)]"
                        : resolvedBridgeTone === "approved"
                          ? "bg-[var(--nsn-success)]"
                          : "bg-[var(--nsn-warm-gray)]",
                  ].join(" ")}
                />
                <span>Bridge: {resolvedBridgeLabel}</span>
              </div>
              <div
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--nsn-border)] bg-[var(--nsn-soft-aqua)] text-xs font-semibold text-[var(--nsn-teal-dark)]"
              >
                N
              </div>
            </div>
            <LibraryQuickNav />
          </div>
        </div>

        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </div>
      </section>
    </main>
  );
}
