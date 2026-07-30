import { DocumentTable } from "@/components/library/DocumentTable";
import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnButton } from "@/components/library/NsnButton";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getLibraryDocuments } from "@/lib/library/data";

export const dynamic = "force-dynamic";

type LibraryDocumentsPageProps = {
  searchParams: Promise<{
    examined?: string | string[];
  }>;
};

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LibraryDocumentsPage({
  searchParams,
}: LibraryDocumentsPageProps) {
  const highlightedDocumentId = firstSearchParam((await searchParams).examined);
  const libraryDocumentRows = await getLibraryDocuments();

  return (
    <LibraryShell active="documents">
      <div className="grid gap-8">
        <NsnPageHeader
          description="See what the Librarian has examined, what it could read, and what still needs attention."
          eyebrow="My Library"
          title="My Library"
        >
          <NsnButton disabled type="button" variant="secondary">
            Reasoning Coming Later
          </NsnButton>
        </NsnPageHeader>

        <DocumentTable
          documents={libraryDocumentRows}
          highlightedDocumentId={highlightedDocumentId}
        />
      </div>
    </LibraryShell>
  );
}
