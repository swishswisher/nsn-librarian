import { LibraryExplorer } from "@/components/library/LibraryExplorer";
import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getLibraryExplorerData } from "@/lib/library/explorer-data";

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
  const highlightedFileId = firstSearchParam((await searchParams).examined);
  const explorerData = await getLibraryExplorerData();

  return (
    <LibraryShell active="documents">
      <div className="grid gap-8">
        <NsnPageHeader
          description="Browse connected roots, folders, and scanned files without changing anything on the Mac."
          eyebrow="Connected Libraries"
          title="My Library"
        />

        <LibraryExplorer
          data={explorerData}
          highlightedFileId={highlightedFileId}
        />
      </div>
    </LibraryShell>
  );
}
