type ReviewRequestBody = {
  documentId?: unknown;
  decisionStatus?: unknown;
  notes?: unknown;
};

export async function POST(request: Request) {
  let body: ReviewRequestBody;

  try {
    body = (await request.json()) as ReviewRequestBody;
  } catch {
    return Response.json(
      { ok: false, error: "Expected a JSON request body." },
      { status: 400 },
    );
  }

  return Response.json({
    ok: true,
    message: "Review decision accepted by placeholder endpoint.",
    review: {
      documentId:
        typeof body.documentId === "string" ? body.documentId : "mock-document",
      decisionStatus:
        typeof body.decisionStatus === "string"
          ? body.decisionStatus
          : "NEEDS_REVIEW",
      notes: typeof body.notes === "string" ? body.notes : null,
    },
    placeholder: true,
  });
}
