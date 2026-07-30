import { redirect } from "next/navigation";

import { getScanSessionRoute } from "@/lib/library/routes";

export const dynamic = "force-dynamic";

type LibraryBatchCompatibilityPageProps = {
  params: Promise<{
    sessionId: string;
  }>;
};

export default async function LibraryBatchCompatibilityPage({
  params,
}: LibraryBatchCompatibilityPageProps) {
  const { sessionId } = await params;

  redirect(getScanSessionRoute(sessionId));
}
