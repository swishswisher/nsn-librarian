import { redirect } from "next/navigation";

import { getRecommendationsRoute } from "@/lib/library/routes";

type LegacyBatchOrganizationSuggestionsPageProps = {
  params: Promise<{
    sessionId: string;
  }>;
};

export default async function LegacyBatchOrganizationSuggestionsPage({
  params,
}: LegacyBatchOrganizationSuggestionsPageProps) {
  const { sessionId } = await params;

  redirect(getRecommendationsRoute(sessionId));
}
