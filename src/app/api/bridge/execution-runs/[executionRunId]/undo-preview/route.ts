import { previewRemoteExecutionUndo } from "@/lib/bridge/remote-undo";
import { BridgeUndoError, previewExecutionUndo } from "@/lib/bridge/undo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ executionRunId: string }> },
) {
  const { executionRunId } = await context.params;

  try {
    const preview =
      (await previewRemoteExecutionUndo(executionRunId)) ??
      (await previewExecutionUndo(executionRunId));

    return Response.json({
      ok: true,
      preview,
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
        error: "The Bridge could not preview this undo safely.",
      },
      { status: 500 },
    );
  }
}
