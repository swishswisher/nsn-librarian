import {
  BridgeExecutorError,
  previewOrganizationPlanExecution,
} from "@/lib/bridge/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ planId: string }> },
) {
  const { planId } = await context.params;

  try {
    const preview = await previewOrganizationPlanExecution(planId);

    return Response.json({
      ok: true,
      preview,
    });
  } catch (error) {
    if (error instanceof BridgeExecutorError) {
      return Response.json(
        {
          ok: false,
          error: error.message,
          preview: error.preview,
        },
        { status: error.statusCode },
      );
    }

    return Response.json(
      {
        ok: false,
        error: "The Bridge could not preview this execution safely.",
      },
      { status: 500 },
    );
  }
}
