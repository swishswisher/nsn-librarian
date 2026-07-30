import Link from "next/link";
import { notFound } from "next/navigation";

import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnCard } from "@/components/library/NsnCard";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { OrganizationPlanGenerateButton } from "@/components/library/OrganizationPlanGenerateButton";
import { OrganizationSuggestionsReviewPanel } from "@/components/library/OrganizationSuggestionsReviewPanel";
import { getOrganizationSuggestionsForScanSession } from "@/lib/bridge/organization-suggestions";
import { getKnowledgeContextForRecommendations } from "@/lib/knowledge/queries";
import { getNotebookEntryForScanSession } from "@/lib/library/notebook";
import {
  getNotebookEntryRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";

export const dynamic = "force-dynamic";

type RecommendationsPageProps = {
  params: Promise<{
    sessionId: string;
  }>;
};

export default async function RecommendationsPage({
  params,
}: RecommendationsPageProps) {
  const { sessionId } = await params;
  const data = await getOrganizationSuggestionsForScanSession(sessionId);

  if (!data) {
    notFound();
  }

  const notebookReflection = await getNotebookEntryForScanSession(data.session.id);
  const topicsBySuggestionId = await getKnowledgeContextForRecommendations(
    data.suggestions.map((suggestion) => suggestion.id),
  );

  return (
    <LibraryShell active="review">
      <div className="grid gap-8">
        <NsnPageHeader
          description="These are practical recommendations only. No file moves unless Deanne approves a plan, previews the organization, and gives final confirmation."
          eyebrow="Recommendations"
          subtitle={data.session.folderDisplayName}
          title="Review the Librarian's Recommendations"
        >
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            {notebookReflection ? (
              <Link
                className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-gold)] bg-[var(--nsn-warm-beige)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sand)]"
                href={getNotebookEntryRoute(notebookReflection.id)}
              >
                Notebook Context
              </Link>
            ) : null}
            <Link
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-[var(--nsn-border)] bg-[var(--nsn-card)] px-4 text-center text-sm font-semibold text-[var(--nsn-navy)] transition hover:bg-[var(--nsn-sage-mist)]"
              href={getScanSessionRoute(data.session.id)}
            >
              Back to Scan Session
            </Link>
          </div>
        </NsnPageHeader>

        <NsnCard tone="aqua">
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
            <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
              The Librarian is proposing organization recommendations, not
              changing files. Approved, rejected, edited, and unchanged
              decisions are stored for review only. No folder is created and no
              local file is changed.
            </p>
            <OrganizationPlanGenerateButton scanSessionId={data.session.id} />
          </div>
        </NsnCard>

        <OrganizationSuggestionsReviewPanel
          notebookHref={
            notebookReflection ? getNotebookEntryRoute(notebookReflection.id) : null
          }
          scanSessionId={data.session.id}
          suggestions={data.suggestions}
          topicsBySuggestionId={topicsBySuggestionId}
        />
      </div>
    </LibraryShell>
  );
}
