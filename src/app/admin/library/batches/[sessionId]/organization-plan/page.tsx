import { redirect } from "next/navigation";

import { getOrganizationPlanRoute } from "@/lib/library/routes";

type LegacyBatchOrganizationPlanPageProps = {
  params: Promise<{
    sessionId: string;
  }>;
};

export default async function LegacyBatchOrganizationPlanPage({
  params,
}: LegacyBatchOrganizationPlanPageProps) {
  const { sessionId } = await params;

  redirect(getOrganizationPlanRoute(sessionId));
}
