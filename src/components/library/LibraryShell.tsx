import { Suspense, type ReactNode } from "react";

import type { NsnBadgeTone } from "@/components/library/NsnBadge";
import { LibraryAccount } from "@/components/library/LibraryAccount";
import { MobileLibraryMenu } from "@/components/library/MobileLibraryMenu";
import { NsnSidebar, LibraryNavigation, type LibrarySection } from "@/components/library/NsnSidebar";
import { BridgeConnectionStatus } from "@/components/library/BridgeConnectionStatus";

type LibraryShellProps = {
  active: LibrarySection;
  bridgeLabel?: string;
  bridgeTone?: NsnBadgeTone;
  children: ReactNode;
};

export function LibraryShell({ active, bridgeLabel, bridgeTone, children }: LibraryShellProps) {
  return (
    <main className="nsn-shell" data-section={active}>
      <a className="nsn-skip-link" href="#library-content">Skip to content</a>
      <NsnSidebar active={active} />
      <section className="nsn-workspace">
        <header className="nsn-workspace-header">
          <span className="nsn-workspace-title"><span className="sm:hidden">NSN</span><span className="hidden sm:inline">Deanne’s workspace</span></span>
          <div className="nsn-header-tools">
            <BridgeConnectionStatus label={bridgeLabel} tone={bridgeTone} />
            <Suspense fallback={null}><LibraryAccount /></Suspense>
            <MobileLibraryMenu><LibraryNavigation active={active} /></MobileLibraryMenu>
          </div>
        </header>
        <div className="nsn-page-content" id="library-content" tabIndex={-1}>{children}</div>
      </section>
    </main>
  );
}
