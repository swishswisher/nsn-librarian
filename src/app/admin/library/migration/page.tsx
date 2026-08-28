import Link from "next/link";

import { LibraryShell } from "@/components/library/LibraryShell";
import { MigrationQueuePreview } from "@/components/library/MigrationQueuePreview";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getMigrationQueueRows } from "@/lib/library/data";
import { getOrganizationPlanSessionSelectorRoute } from "@/lib/library/routes";

export const dynamic = "force-dynamic";

export default async function LibraryMigrationPage() {
  const migrationQueueRows = await getMigrationQueueRows();

  return (
    <LibraryShell active="migration">
      <div className="grid gap-8">
        <NsnPageHeader
          description="Review approved Organization Plans and any older organization queue items. Nothing moves without approval and final confirmation."
          eyebrow="Organization Plans"
          title="Organization Plans"
        >
          <Link
            className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-gold)] bg-[var(--nsn-warm-beige)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sand)] [overflow-wrap:anywhere]"
            href={getOrganizationPlanSessionSelectorRoute()}
          >
            Choose a Scan Session to Build a Plan
          </Link>
        </NsnPageHeader>

        <MigrationQueuePreview items={migrationQueueRows} />
      </div>
    </LibraryShell>
  );
}
