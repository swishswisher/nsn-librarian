import { LibraryShell } from "@/components/library/LibraryShell";
import { MigrationQueuePreview } from "@/components/library/MigrationQueuePreview";
import { NsnButton } from "@/components/library/NsnButton";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getMigrationQueueRows } from "@/lib/library/data";

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
          <NsnButton disabled type="button" variant="accent">
            Choose a Scan Session to Build a Plan
          </NsnButton>
        </NsnPageHeader>

        <MigrationQueuePreview items={migrationQueueRows} />
      </div>
    </LibraryShell>
  );
}
