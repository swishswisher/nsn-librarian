import { notFound } from "next/navigation";

import { ScannedFileExamineView } from "@/components/library/ScannedFileExamineView";
import { getScannedFileExamination } from "@/lib/bridge/scanned-file-examination";
import {
  getRecommendationsRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";

export const dynamic = "force-dynamic";

type ScannedFileExaminePageProps = {
  params: Promise<{
    sessionId: string;
    fileId: string;
  }>;
};

export default async function ScannedFileExaminePage({
  params,
}: ScannedFileExaminePageProps) {
  const { fileId, sessionId } = await params;
  const data = await getScannedFileExamination(sessionId, fileId);

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
