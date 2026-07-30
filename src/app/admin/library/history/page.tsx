import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";

export default function LibraryHistoryPage() {
  return (
    <LibraryShell active="history">
      <div className="grid gap-8">
        <NsnPageHeader
          description="Activity will show what the Librarian noticed, what Deanne approved, and what changed over time."
          eyebrow="Activity"
          title="Activity"
        />

        <NsnCard tone="sand">
          <div className="max-w-2xl">
            <h2 className="nsn-display text-2xl text-[var(--nsn-navy)]">
              Activity is coming later.
            </h2>
            <p className="mt-3 text-sm leading-7 text-[var(--nsn-slate)]">
              Future history will keep a calm record of scan sessions,
              recommendations, approvals, and organization decisions. Nothing
              moves without approval.
            </p>
          </div>
        </NsnCard>
      </div>
    </LibraryShell>
  );
}
