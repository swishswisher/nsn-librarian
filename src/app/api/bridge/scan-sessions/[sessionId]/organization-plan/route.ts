import { revalidatePath } from "next/cache";

import {
  generateOrganizationPlanForScanSession,
  OrganizationPlanError,
} from "@/lib/bridge/planner";
import {
  getLegacyOrganizationSuggestionsRoute,
  getNotebookArchiveRoute,
  getNotebookRoute,
  getOrganizationPlanRoute,
  getRecommendationsRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;

  try {
    const plan = await generateOrganizationPlanForScanSession(sessionId);

    revalidatePath(getScanSessionRoute(sessionId));
    revalidatePath(getOrganizationPlanRoute(sessionId));
    revalidatePath(getRecommendationsRoute(sessionId));
    revalidatePath(getLegacyOrganizationSuggestionsRoute(sessionId));
    revalidatePath("/admin/library");
    revalidatePath(getNotebookRoute());
    revalidatePath(getNotebookArchiveRoute());

    return Response.json({
      ok: true,
      plan,
    });
  } catch (error) {
    if (error instanceof OrganizationPlanError) {
      return Response.json(
        {
          ok: false,
          error: error.message,
        },
        { status: error.statusCode },
      );
    }

    return Response.json(
      {
        ok: false,
        error: "The organization plan could not be generated right now.",
      },
      { status: 500 },
    );
  }
}
