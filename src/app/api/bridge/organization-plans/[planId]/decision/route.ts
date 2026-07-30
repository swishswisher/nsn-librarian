import { revalidatePath } from "next/cache";

import {
  approveOrganizationPlan,
  cancelOrganizationPlan,
  OrganizationPlanError,
} from "@/lib/bridge/planner";
import {
  getNotebookArchiveRoute,
  getNotebookRoute,
  getOrganizationPlanRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PlanDecisionRequestBody = {
  action?: unknown;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ planId: string }> },
) {
  const { planId } = await context.params;
  let body: PlanDecisionRequestBody;

  try {
    body = (await request.json()) as PlanDecisionRequestBody;
  } catch {
    return Response.json(
      {
        ok: false,
        error: "Expected a JSON request body.",
      },
      { status: 400 },
    );
  }

  if (body.action !== "APPROVE" && body.action !== "CANCEL") {
    return Response.json(
      {
        ok: false,
        error: "Choose a plan action first.",
      },
      { status: 400 },
    );
  }

  try {
    const plan =
      body.action === "APPROVE"
        ? await approveOrganizationPlan(planId)
        : await cancelOrganizationPlan(planId);

    revalidatePath(getScanSessionRoute(plan.scanSessionId));
    revalidatePath(getOrganizationPlanRoute(plan.scanSessionId));
    revalidatePath("/admin/library");
    revalidatePath(getNotebookRoute());
    revalidatePath(getNotebookArchiveRoute());

    return Response.json({
      ok: true,
      plan,
    });
  } catch (error) {
    if (error instanceof OrganizationPlanError) {
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
        error: "The organization plan could not be updated right now.",
      },
      { status: 500 },
    );
  }
}
