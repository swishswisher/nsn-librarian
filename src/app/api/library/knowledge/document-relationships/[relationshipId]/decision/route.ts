import { revalidatePath } from "next/cache";

import { RelationshipReviewError, reviewPersistentRelationship } from "@/lib/bridge/persistent-knowledge";
import { recordDocumentRelationshipNotebookEntry } from "@/lib/library/notebook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ relationshipId: string }> }) {
  const { relationshipId } = await context.params;
  let input: Record<string, unknown>;
  try {
    input = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "Choose a relationship review decision." }, { status: 400 });
  }
  try {
    const relationship = await reviewPersistentRelationship(
      relationshipId,
      input.action as "CONFIRM" | "SEPARATE" | "RECONSIDER",
      typeof input.note === "string" ? input.note : undefined,
    );
    try {
      await recordDocumentRelationshipNotebookEntry(relationship.id);
    } catch {
      // A Notebook error must not erase a saved human correction.
    }
    revalidatePath("/admin/library/knowledge");
    revalidatePath("/admin/library/notebook");
    return Response.json({ ok: true, status: relationship.status });
  } catch (error) {
    if (error instanceof RelationshipReviewError) {
      return Response.json({ ok: false, error: error.message }, { status: error.statusCode });
    }
    return Response.json({ ok: false, error: "This relationship could not be reviewed right now." }, { status: 500 });
  }
}
