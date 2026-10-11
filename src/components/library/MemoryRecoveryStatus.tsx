import { NsnCard } from "./NsnCard";
import type { getMemoryRecoveryProgress } from "@/lib/library/memory-recovery";

export function MemoryRecoveryStatus({ progress }: { progress: Awaited<ReturnType<typeof getMemoryRecoveryProgress>> }) {
  if (!progress.pending) return null;
  return (
    <NsnCard tone="aqua">
      <div role="status">
        <p className="font-medium">Existing Memory is still being restored.</p>
        <p className="mt-2 text-sm">{progress.completed} reviews restored; {progress.pending} still waiting. Only fully checked Memory is shown.</p>
        {progress.needsInspection > 0 && <p className="mt-2 text-sm">{progress.needsInspection} reviews have needed repeated attempts and may need inspection.</p>}
        {!progress.schedulerConfigured ? <p className="mt-2 text-sm">Automatic restoration has not been configured. An administrator needs to activate it.</p>
          : !progress.lastSuccessfulRunAt ? <p className="mt-2 text-sm">Automatic restoration has not yet been verified.</p>
            : <p className="mt-2 text-sm">Last successful restoration check: {new Date(progress.lastSuccessfulRunAt).toLocaleString("en", { timeZone: "UTC" })} UTC.</p>}
        {progress.lastRunStatus === "FAILED" && <p className="mt-2 text-sm">The last automatic check could not finish. Your existing Memory remains safe.</p>}
      </div>
    </NsnCard>
  );
}
