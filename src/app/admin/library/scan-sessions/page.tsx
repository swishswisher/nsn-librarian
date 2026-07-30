import Link from "next/link";

import { ConnectFolderCard } from "@/components/library/BatchUploadCard";
import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnBadge, type NsnBadgeTone } from "@/components/library/NsnBadge";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnEmptyState } from "@/components/library/NsnEmptyState";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getBridgeScanSessions } from "@/lib/bridge/scan-sessions";
import { getScanSessionRoute } from "@/lib/library/routes";
import type { BridgeScanSessionStatus } from "@/lib/bridge/types";

export const dynamic = "force-dynamic";

function formatScanDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function statusLabel(status: BridgeScanSessionStatus) {
  if (status === "COMPLETED") {
    return "Completed";
  }

  if (status === "SCANNING") {
    return "Scanning";
  }

  if (status === "READING") {
    return "Reading";
  }

  if (status === "EXAMINING") {
    return "Examining";
  }

  if (status === "GENERATING_SUGGESTIONS") {
    return "Preparing recommendations";
  }

  if (status === "COMPLETED_WITH_ERRORS") {
    return "Completed with items needing attention";
  }

  if (status === "FAILED") {
    return "Needs attention";
  }

  return "Pending";
}

function statusTone(status: BridgeScanSessionStatus): NsnBadgeTone {
  if (status === "COMPLETED") {
    return "approved";
  }

  if (status === "FAILED" || status === "COMPLETED_WITH_ERRORS") {
    return "review";
  }

  return "pending";
}

export default async function ScanSessionsPage() {
  const scanSessions = await getBridgeScanSessions();

  return (
    <LibraryShell active="documents">
      <div className="grid gap-8">
        <NsnPageHeader
          description="Each scan session records what the Librarian found, examined, and recommended. The local folder remains the source of truth."
          eyebrow="Scan Sessions"
          title="Scan Sessions"
        />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          <ConnectFolderCard />

          <section aria-labelledby="scan-register-heading">
            <h3
              className="nsn-display mb-4 text-2xl text-[var(--nsn-navy)]"
              id="scan-register-heading"
            >
              Scan Sessions
            </h3>
            {scanSessions.length === 0 ? (
              <NsnEmptyState
                description="Connect a folder through the Bridge before scan sessions can begin. Nothing moves without approval."
                title="No scan sessions yet"
              />
            ) : (
              <div className="grid gap-3">
                {scanSessions.map((session) => (
                  <NsnCard key={session.id}>
                    <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <h4 className="break-words font-semibold text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                          {session.folderDisplayName}
                        </h4>
                        <p className="mt-1 break-words text-sm leading-6 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                          {session.totalFiles} file
                          {session.totalFiles === 1 ? "" : "s"} -{" "}
                          {session.supportedFiles} supported -{" "}
                          {session.unsupportedFiles} unsupported -{" "}
                          {session.failedFiles} need attention -{" "}
                          {formatScanDate(session.startedAt)}
                        </p>
                        <Link
                          className="mt-3 inline-flex min-h-10 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-3 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
                          href={getScanSessionRoute(session.id)}
                        >
                          View Scan Session
                        </Link>
                      </div>
                      <NsnBadge tone={statusTone(session.status)}>
                        {statusLabel(session.status)}
                      </NsnBadge>
                    </div>
                  </NsnCard>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </LibraryShell>
  );
}
