import { revalidatePath } from "next/cache";

import {
  OrganizationSuggestionError,
  resetOrganizationSuggestionDecisionsForScanSession,
} from "@/lib/bridge/organization-suggestions";
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

type ResetRequestBody = {
  confirmation?: unknown;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;
  let body: ResetRequestBody;

  try {
    body = (await request.json()) as ResetRequestBody;
  } catch {
    return Response.json(
      {
        ok: false,
        error: "Expected a JSON request body.",
      },
      { status: 400 },
    );
  }

  if (body.confirmation !== "RESET") {
    return Response.json(
      {
        ok: false,
        error: "Type RESET before reopening this scan session's recommendations.",
      },
      { status: 400 },
    );
  }

  try {
    const result =
      await resetOrganizationSuggestionDecisionsForScanSession(sessionId);

    revalidatePath(getScanSessionRoute(sessionId));
    revalidatePath(getRecommendationsRoute(sessionId));
    revalidatePath(getLegacyOrganizationSuggestionsRoute(sessionId));
    revalidatePath(getOrganizationPlanRoute(sessionId));
    revalidatePath("/admin/library");
    revalidatePath(getNotebookRoute());
    revalidatePath(getNotebookArchiveRoute());

    return Response.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    if (error instanceof OrganizationSuggestionError) {
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
        error: "The recommendation decisions could not be reset right now.",
      },
      { status: 500 },
    );
  }
}
