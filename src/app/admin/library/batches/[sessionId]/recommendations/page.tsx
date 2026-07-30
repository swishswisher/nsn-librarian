import { redirect } from "next/navigation";

import { getRecommendationsRoute } from "@/lib/library/routes";

type LegacyBatchRecommendationsPageProps = {
  params: Promise<{
    sessionId: string;
  }>;
};

export default async function LegacyBatchRecommendationsPage({
  params,
}: LegacyBatchRecommendationsPageProps) {
  const { sessionId } = await params;

  redirect(getRecommendationsRoute(sessionId));
}
