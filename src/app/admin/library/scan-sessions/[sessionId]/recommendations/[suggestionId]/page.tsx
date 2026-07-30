import { notFound } from "next/navigation";

import { ScannedFileExamineView } from "@/components/library/ScannedFileExamineView";
import { getRecommendationExamination } from "@/lib/bridge/scanned-file-examination";
import {
  getRecommendationsRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";

export const dynamic = "force-dynamic";

type RecommendationExaminePageProps = {
  params: Promise<{
    sessionId: string;
    suggestionId: string;
  }>;
};

export default async function RecommendationExaminePage({
  params,
}: RecommendationExaminePageProps) {
  const { sessionId, suggestionId } = await params;
  const data = await getRecommendationExamination(sessionId, suggestionId);

  if (!data) {
    notFound();
  }

  return (
    <ScannedFileExamineView
      backHref={getScanSessionRoute(data.session.id)}
      backLabel="Back to Scan Session"
      data={data}
      recommendationsHref={getRecommendationsRoute(data.session.id)}
    />
  );
}
