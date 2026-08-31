import { revalidatePath } from "next/cache";

import {
  OrganizationSuggestionError,
  resetOrganizationSuggestionDecision,
  reviewOrganizationSuggestion,
  type ReviewOrganizationSuggestionInput,
} from "@/lib/bridge/organization-suggestions";
import { recordRecommendationDecisionNotebookEntry } from "@/lib/library/notebook";
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

type DecisionRequestBody = {
  action?: unknown;
  scanSessionId?: unknown;
  destinationFolder?: unknown;
  fileName?: unknown;
  context?: unknown;
};

function optionalText(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function requiredText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function actionFrom(value: unknown): ReviewOrganizationSuggestionInput["action"] | null {
  if (
    value === "APPROVE" ||
    value === "MODIFY" ||
    value === "REJECT" ||
    value === "LEAVE_UNCHANGED"
  ) {
    return value;
  }

  return null;
}

function resetActionFrom(value: unknown) {
  return value === "RESET" || value === "CHANGE_DECISION";
}

export async function POST(
  request: Request,
  context: { params: Promise<{ suggestionId: string }> },
) {
  const { suggestionId } = await context.params;
  let body: DecisionRequestBody;

  try {
    body = (await request.json()) as DecisionRequestBody;
  } catch {
    return Response.json(
      {
        ok: false,
        error: "Expected a JSON request body.",
      },
      { status: 400 },
    );
  }

  const action = actionFrom(body.action);
  const isResetAction = resetActionFrom(body.action);
  const scanSessionId = requiredText(body.scanSessionId);

  if (!action && !isResetAction) {
    return Response.json(
      {
        ok: false,
        error: "Choose a review action first.",
      },
      { status: 400 },
    );
  }

  if (!scanSessionId) {
    return Response.json(
      {
        ok: false,
        error: "The Librarian could not match this recommendation to a scan session.",
      },
      { status: 400 },
    );
  }

  try {
    const suggestion = isResetAction
      ? await resetOrganizationSuggestionDecision(suggestionId, scanSessionId)
      : await reviewOrganizationSuggestion(suggestionId, {
          action: action as ReviewOrganizationSuggestionInput["action"],
          context: optionalText(body.context),
          destinationFolder: optionalText(body.destinationFolder),
          fileName: optionalText(body.fileName),
          scanSessionId,
        });

    if (!isResetAction) {
      try {
        await recordRecommendationDecisionNotebookEntry(suggestion.id);
      } catch {
        // Notebook reflection failures should not block recommendation review.
      }
    }

    revalidatePath(getScanSessionRoute(suggestion.scanSessionId));
    revalidatePath(getRecommendationsRoute(suggestion.scanSessionId));
    revalidatePath(getLegacyOrganizationSuggestionsRoute(suggestion.scanSessionId));
    revalidatePath(getOrganizationPlanRoute(suggestion.scanSessionId));
    revalidatePath(getNotebookRoute());
    revalidatePath(getNotebookArchiveRoute());

    return Response.json({
      ok: true,
      suggestion,
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
        error: "The organization suggestion could not be saved right now.",
      },
      { status: 500 },
    );
  }
}
