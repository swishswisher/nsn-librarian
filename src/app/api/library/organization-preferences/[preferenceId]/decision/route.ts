import { revalidatePath } from "next/cache";

import {
  OrganizationPreferenceError,
  reviewOrganizationPreference,
  type PreferenceAction,
} from "@/lib/library/organization-preferences";
import { recordOrganizationPreferenceNotebookEntry } from "@/lib/library/notebook";
import { getNotebookArchiveRoute, getNotebookRoute } from "@/lib/library/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ preferenceId: string }> }) {
  const { preferenceId } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "Expected a review request." }, { status: 400 });
  }

  try {
    const result = await reviewOrganizationPreference(preferenceId, {
      action: body.action as PreferenceAction,
      destination: typeof body.destination === "string" ? body.destination : undefined,
      note: typeof body.note === "string" ? body.note : undefined,
      scopeTerms: Array.isArray(body.scopeTerms)
        ? body.scopeTerms.filter((term): term is string => typeof term === "string")
        : undefined,
    });
    try {
      await recordOrganizationPreferenceNotebookEntry(result.id);
    } catch {
      // Notebook availability cannot undo a saved human preference decision.
    }
    revalidatePath("/admin/library/memory");
    revalidatePath(getNotebookRoute());
    revalidatePath(getNotebookArchiveRoute());
    return Response.json({ ok: true, status: result.status });
  } catch (error) {
    if (error instanceof OrganizationPreferenceError) {
      return Response.json({ ok: false, error: error.message }, { status: error.statusCode });
    }
    return Response.json({ ok: false, error: "The preference could not be reviewed right now." }, { status: 500 });
  }
}
