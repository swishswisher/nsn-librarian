import { revalidatePath } from "next/cache";

import {
  clearOrganizationPlanSelection,
  OrganizationPlanError,
  saveOrganizationPlanSelection,
} from "@/lib/bridge/planner";
import {
  getNotebookArchiveRoute,
  getNotebookRoute,
  getOrganizationPlanRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SelectionRequestBody = {
  action?: unknown;
  actionIds?: unknown;
};

function selectedActionIdsFrom(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export async function POST(
  request: Request,
  context: { params: Promise<{ planId: string }> },
) {
  const { planId } = await context.params;
  let body: SelectionRequestBody;

  try {
    body = (await request.json()) as SelectionRequestBody;
  } catch {
    return Response.json(
      {
        ok: false,
        error: "Expected a JSON request body.",
      },
      { status: 400 },
    );
  }

  try {
    const plan =
      body.action === "CLEAR"
        ? await clearOrganizationPlanSelection(planId)
        : await saveOrganizationPlanSelection(
            planId,
            selectedActionIdsFrom(body.actionIds),
          );

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
        error: "The selected plan actions could not be saved right now.",
      },
      { status: 500 },
    );
  }
}
