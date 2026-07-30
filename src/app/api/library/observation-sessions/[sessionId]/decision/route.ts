import { revalidatePath } from "next/cache";

import {
  isHumanDecisionType,
  ObservationSessionError,
  saveHumanDecision,
} from "@/lib/library/observation-sessions";
import { buildMemoryFromApprovedSession } from "@/lib/library/memory";
import { recordObservationDecisionNotebookEntry } from "@/lib/library/notebook";
import { getNotebookArchiveRoute, getNotebookRoute } from "@/lib/library/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DecisionRequestBody = {
  decisionType?: unknown;
  note?: unknown;
  editedSuggestion?: unknown;
};

function optionalText(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;
  let body: DecisionRequestBody;

  try {
    body = (await request.json()) as DecisionRequestBody;
  } catch {
    return Response.json(
      { ok: false, error: "Expected a JSON request body." },
      { status: 400 },
    );
  }

  if (!isHumanDecisionType(body.decisionType)) {
    return Response.json(
      { ok: false, error: "Choose a review action first." },
      { status: 400 },
    );
  }

  try {
    const result = await saveHumanDecision(sessionId, {
      decisionType: body.decisionType,
      note: optionalText(body.note),
      editedSuggestion: optionalText(body.editedSuggestion),
    });
    const memoryUpdatedCount =
      result.status === "APPROVED"
        ? await buildMemoryFromApprovedSession(sessionId)
        : 0;

    try {
      await recordObservationDecisionNotebookEntry(
        sessionId,
        result.decisionId,
        memoryUpdatedCount,
      );
    } catch {
      // Notebook reflection failures should not block the human review decision.
    }

    revalidatePath("/admin/library");
    revalidatePath("/admin/library/review");
    revalidatePath(`/admin/library/review/${sessionId}`);
    revalidatePath("/admin/library/memory");
    revalidatePath(getNotebookRoute());
    revalidatePath(getNotebookArchiveRoute());

    return Response.json({
      ok: true,
      decisionId: result.decisionId,
      status: result.status,
      memoryUpdatedCount,
    });
  } catch (error) {
    if (error instanceof ObservationSessionError) {
      return Response.json(
        { ok: false, error: error.message },
        { status: error.statusCode },
      );
    }

    return Response.json(
      { ok: false, error: "The review decision could not be saved right now." },
      { status: 500 },
    );
  }
}
