import { revalidatePath } from "next/cache";

import { executeExecutionUndo, BridgeUndoError } from "@/lib/bridge/undo";
import {
  getNotebookArchiveRoute,
  getNotebookRoute,
  getOrganizationPlanRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UndoRequestBody = {
  confirmation?: unknown;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ executionRunId: string }> },
) {
  const { executionRunId } = await context.params;
  let body: UndoRequestBody;

  try {
    body = (await request.json()) as UndoRequestBody;
  } catch {
    return Response.json(
      {
        ok: false,
        error: "Expected a JSON request body.",
      },
      { status: 400 },
    );
  }

  if (body.confirmation !== "UNDO") {
    return Response.json(
      {
        ok: false,
        error: "Type UNDO before the Bridge can restore these changes.",
      },
      { status: 400 },
    );
  }

  try {
    const result = await executeExecutionUndo(executionRunId, body.confirmation);

    revalidatePath(getOrganizationPlanRoute(result.scanSessionId));
    revalidatePath(getScanSessionRoute(result.scanSessionId));
    revalidatePath("/admin/library");
    revalidatePath(getNotebookRoute());
    revalidatePath(getNotebookArchiveRoute());

    return Response.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    if (error instanceof BridgeUndoError) {
      return Response.json(
        {
          ok: false,
          error: error.message,
          preview: error.preview,
          run: error.run,
        },
        { status: error.statusCode },
      );
    }

    return Response.json(
      {
        ok: false,
        error: "The Bridge could not undo this execution safely.",
      },
      { status: 500 },
    );
  }
}
