import { LibraryShell } from "@/components/library/LibraryShell";
import { NsnPageHeader } from "@/components/library/NsnPageHeader";
import { NsnCard } from "@/components/library/NsnCard";
import { OrganizationSuggestionsReviewPanel } from "@/components/library/OrganizationSuggestionsReviewPanel";
import { ReviewQueue } from "@/components/library/ReviewQueue";
import { getOrganizationSuggestionsForConnectedLibraries } from "@/lib/bridge/organization-suggestions";
import { getKnowledgeContextForRecommendations } from "@/lib/knowledge/queries";
import { getReviewQueueItems } from "@/lib/library/data";

export const dynamic = "force-dynamic";

export default async function LibraryReviewPage() {
  const [reviewQueueItems, organizationRecommendations] = await Promise.all([
    getReviewQueueItems(),
    getOrganizationSuggestionsForConnectedLibraries(),
  ]);
  const topicsBySuggestionId = await getKnowledgeContextForRecommendations(
    organizationRecommendations.suggestions.map((suggestion) => suggestion.id),
  );

  return (
    <LibraryShell active="review">
      <div className="grid gap-8">
        <NsnPageHeader
          description="Review what the Librarian noticed before anything becomes trusted Memory. The machine suggests. Deanne decides."
          eyebrow="Recommendations"
          title="Review the Librarian's Recommendations"
        />

        <ReviewQueue items={reviewQueueItems} />

        <NsnCard tone="aqua">
          <p className="break-words text-sm leading-7 text-[var(--nsn-slate)] [overflow-wrap:anywhere]">
            Organization recommendations remain folder-specific. Use the library
            filters to review one connected folder at a time, or All to compare
            the full queue.
          </p>
        </NsnCard>

        <OrganizationSuggestionsReviewPanel
          libraryIdBySuggestionId={
            organizationRecommendations.libraryIdBySuggestionId
          }
          libraryNameBySuggestionId={
            organizationRecommendations.libraryNameBySuggestionId
          }
          libraryOptions={organizationRecommendations.libraries}
          suggestions={organizationRecommendations.suggestions}
          topicsBySuggestionId={topicsBySuggestionId}
        />
      </div>
    </LibraryShell>
  );
}
