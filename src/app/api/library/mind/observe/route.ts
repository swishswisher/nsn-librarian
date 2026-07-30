import {
  createObservationSessionForDocument,
  ObservationSessionError,
} from "@/lib/library/observation-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ObserveRequestBody = {
  documentId?: unknown;
};

function getDocumentId(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export async function POST(request: Request) {
  let body: ObserveRequestBody;

  try {
    body = (await request.json()) as ObserveRequestBody;
  } catch {
    return Response.json(
      { ok: false, error: "Expected a JSON request body." },
      { status: 400 },
    );
  }

  const documentId = getDocumentId(body.documentId);

  if (!documentId) {
    return Response.json(
      { ok: false, error: "A library item id is required." },
      { status: 400 },
    );
  }

  try {
    const { connectionCount, observerType, result, sessionId } =
      await createObservationSessionForDocument(documentId);

    return Response.json({
      ok: true,
      result,
      sessionId,
      observerType,
      connectionCount,
      hasReviewableSuggestions: result.planSuggestions.length > 0,
    });
  } catch (error) {
    if (error instanceof ObservationSessionError) {
      return Response.json(
        { ok: false, error: error.message },
        { status: error.statusCode },
      );
    }

    return Response.json(
      { ok: false, error: "The Librarian could not observe this item right now." },
      { status: 500 },
    );
  }
}
