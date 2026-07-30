import { redirect } from "next/navigation";

import { getRecommendationsRoute } from "@/lib/library/routes";

type LegacyOrganizationSuggestionsPageProps = {
  params: Promise<{
    sessionId: string;
  }>;
};

export default async function LegacyOrganizationSuggestionsPage({
  params,
}: LegacyOrganizationSuggestionsPageProps) {
  const { sessionId } = await params;

  redirect(getRecommendationsRoute(sessionId));
}
