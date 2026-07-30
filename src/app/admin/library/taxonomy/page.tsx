import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnButton } from "@/components/library/NsnButton";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { TaxonomyPreview } from "@/components/library/TaxonomyPreview";

export default function LibraryTaxonomyPage() {
  return (
    <LibraryShell active="taxonomy">
      <div className="grid gap-8">
        <NsnPageHeader
          description="Settings and the Library Map will guide how the Librarian understands approved library locations over time."
          eyebrow="Settings"
          title="Settings"
        >
          <NsnButton disabled type="button" variant="secondary">
            Settings Editing Coming Later
          </NsnButton>
        </NsnPageHeader>

        <TaxonomyPreview />
      </div>
    </LibraryShell>
  );
}
