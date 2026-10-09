import { revalidatePath } from "next/cache";

import { createIdentityCorrection, RelationshipReviewError } from "@/lib/bridge/persistent-knowledge";
import { recordDocumentRelationshipNotebookEntry } from "@/lib/library/notebook";
import { refreshSearchForIdentityRelationship } from "@/lib/library/search-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let input: Record<string, unknown>;
  try {
    input = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "Choose the files and describe the correction." }, { status: 400 });
  }
  try {
    const relationship = await createIdentityCorrection({
      kind: input.kind as "SAME_CLIENT" | "BELONGS_TO_PROJECT",
      note: typeof input.note === "string" ? input.note : "",
      sourceSignalId: typeof input.sourceSignalId === "string" ? input.sourceSignalId : "",
      targetSignalId: typeof input.targetSignalId === "string" ? input.targetSignalId : "",
    });
    await refreshSearchForIdentityRelationship(relationship.id);
    try {
      await recordDocumentRelationshipNotebookEntry(relationship.id);
    } catch {
      // Keep the saved correction even if a Notebook update fails.
    }
    revalidatePath("/admin/library/knowledge");
    revalidatePath("/admin/library/notebook");
    revalidatePath("/admin/library/search");
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof RelationshipReviewError) {
      return Response.json({ ok: false, error: error.message }, { status: error.statusCode });
    }
    return Response.json({ ok: false, error: "This correction could not be saved right now." }, { status: 500 });
  }
}
