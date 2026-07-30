type MigrationRequestBody = {
  documentId?: unknown;
  actionType?: unknown;
  destinationPath?: unknown;
  notes?: unknown;
};

export async function POST(request: Request) {
  let body: MigrationRequestBody;

  try {
    body = (await request.json()) as MigrationRequestBody;
  } catch {
    return Response.json(
      { ok: false, error: "Expected a JSON request body." },
      { status: 400 },
    );
  }

  return Response.json({
    ok: true,
    message: "Migration action accepted by placeholder endpoint.",
    migration: {
      documentId:
        typeof body.documentId === "string" ? body.documentId : "mock-document",
      actionType: typeof body.actionType === "string" ? body.actionType : "REVIEW",
      destinationPath:
        typeof body.destinationPath === "string"
          ? body.destinationPath
          : "Needs Review",
      notes: typeof body.notes === "string" ? body.notes : null,
    },
    placeholder: true,
  });
}
