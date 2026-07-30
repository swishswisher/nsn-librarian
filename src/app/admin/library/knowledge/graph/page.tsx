import Link from "next/link";

import { KnowledgeGraphExplorer } from "@/components/library/KnowledgeGraphExplorer";
import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getKnowledgeGraphPageData } from "@/lib/knowledge/queries";
import { getKnowledgeRoute } from "@/lib/library/routes";

export const dynamic = "force-dynamic";

export default async function KnowledgeGraphPage() {
  const data = await getKnowledgeGraphPageData();

  return (
    <LibraryShell active="knowledge">
      <div className="grid min-w-0 gap-8">
        <NsnPageHeader
          description="Explore first-degree relationships without loading the entire library at once. A readable list is always available alongside the structured view."
          eyebrow="Knowledge Graph"
          title="Relationship Explorer"
        >
          <Link
            className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
            href={getKnowledgeRoute()}
          >
            Back to Knowledge Review
          </Link>
        </NsnPageHeader>

        <KnowledgeGraphExplorer
          objects={data.objects}
          relationships={data.relationships}
        />
      </div>
    </LibraryShell>
  );
}
