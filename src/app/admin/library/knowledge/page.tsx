import Link from "next/link";

import { KnowledgeReviewPanel } from "@/components/library/KnowledgeReviewPanel";
import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { getKnowledgeReviewPageData } from "@/lib/knowledge/queries";
import { getKnowledgeGraphRoute } from "@/lib/library/routes";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const data = await getKnowledgeReviewPageData();
  const provisionalCount =
    data.objects.filter((object) => object.status === "PROVISIONAL").length +
    data.relationships.filter(
      (relationship) => relationship.status === "PROVISIONAL",
    ).length;
  const approvedCount = data.objects.filter(
    (object) => object.status === "APPROVED",
  ).length;

  return (
    <LibraryShell active="knowledge">
      <div className="grid min-w-0 gap-8">
        <NsnPageHeader
          description="The Knowledge Graph tracks recurring topics, frameworks, concepts, and relationships across the library. Only approved knowledge becomes trusted."
          eyebrow="Knowledge Graph"
          title="Topic Intelligence"
        >
          <Link
            className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-teal)] bg-[var(--nsn-teal)] px-4 text-center text-sm font-semibold text-[var(--nsn-white)] transition hover:bg-[var(--nsn-teal-dark)]"
            href={getKnowledgeGraphRoute()}
          >
            Open Graph View
          </Link>
        </NsnPageHeader>

        <NsnCard tone="aqua">
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.72fr)]">
            <div className="min-w-0">
              <p className="nsn-display break-words text-2xl leading-8 text-[var(--nsn-navy)] [overflow-wrap:anywhere]">
                Files remain containers. Knowledge becomes the semantic layer.
              </p>
              <p className="mt-3 break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
                The Librarian can propose topics and relationships, but Deanne
                decides what becomes trusted. Rejected proposals stay preserved
                as history and are excluded from trusted reasoning.
              </p>
            </div>
            <dl className="grid gap-3 rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] p-4 text-sm leading-6 text-[var(--nsn-slate)] sm:grid-cols-2">
              <div>
                <dt className="font-semibold text-[var(--nsn-navy)]">
                  Needs review
                </dt>
                <dd>{provisionalCount}</dd>
              </div>
              <div>
                <dt className="font-semibold text-[var(--nsn-navy)]">
                  Trusted knowledge
                </dt>
                <dd>{approvedCount}</dd>
              </div>
            </dl>
          </div>
        </NsnCard>

        <KnowledgeReviewPanel
          mergeTargets={data.mergeTargets}
          objects={data.objects}
          relationships={data.relationships}
        />
      </div>
    </LibraryShell>
  );
}
