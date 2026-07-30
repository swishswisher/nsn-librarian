import { revalidatePath } from "next/cache";

import {
  BridgeExecutorError,
  executeOrganizationPlan,
} from "@/lib/bridge/executor";
import {
  BridgeCloudError,
  queueExecutionCommandForApprovedPlan,
} from "@/lib/bridge/cloud-coordinator";
import {
  getNotebookArchiveRoute,
  getNotebookRoute,
  getOrganizationPlanRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExecuteRequestBody = {
  confirmation?: unknown;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ planId: string }> },
) {
  const { planId } = await context.params;
  let body: ExecuteRequestBody;

  try {
    body = (await request.json()) as ExecuteRequestBody;
  } catch {
    return Response.json(
      {
        ok: false,
        error: "Expected a JSON request body.",
      },
      { status: 400 },
    );
  }

  if (body.confirmation !== "EXECUTE") {
    return Response.json(
      {
        ok: false,
        error: "Type EXECUTE before the Bridge can execute this plan.",
      },
      { status: 400 },
    );
  }

  try {
    const queuedCommand = await queueExecutionCommandForApprovedPlan(
      planId,
      body.confirmation,
    );

    if (queuedCommand) {
      revalidatePath("/admin/library");

      return Response.json({
        command: queuedCommand,
        message:
          "The approved plan was sent to the paired Bridge for safe execution.",
        ok: true,
        queuedExecution: true,
      });
    }

    const result = await executeOrganizationPlan(planId, body.confirmation);

    revalidatePath(getOrganizationPlanRoute(result.plan.scanSessionId));
    revalidatePath(getScanSessionRoute(result.plan.scanSessionId));
    revalidatePath("/admin/library");
    revalidatePath(getNotebookRoute());
    revalidatePath(getNotebookArchiveRoute());

    return Response.json({
      ok: true,
      ...result,
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

    if (error instanceof BridgeCloudError) {
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
        error: "The Bridge could not execute this plan safely.",
      },
      { status: 500 },
    );
  }
}
