import { revalidatePath } from "next/cache";

import {
  approveKnowledgeRelationship,
  keepKnowledgeRelationshipProvisional,
  rejectKnowledgeRelationship,
  reviseKnowledgeRelationship,
} from "@/lib/knowledge/relationships";
import { getKnowledgeGraphRoute, getKnowledgeRoute } from "@/lib/library/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  action?: unknown;
  explanation?: unknown;
  note?: unknown;
};

function optionalText(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ relationshipId: string }> },
) {
  const { relationshipId } = await context.params;
  let body: RequestBody;

  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return Response.json(
      { ok: false, error: "Expected a JSON request body." },
      { status: 400 },
    );
  }

  try {
    if (body.action === "APPROVE") {
      await approveKnowledgeRelationship(relationshipId);
    } else if (body.action === "REJECT") {
      await rejectKnowledgeRelationship(relationshipId, optionalText(body.note));
    } else if (body.action === "KEEP_PROVISIONAL") {
      await keepKnowledgeRelationshipProvisional(
        relationshipId,
        optionalText(body.note),
      );
    } else if (body.action === "REVISE") {
      await reviseKnowledgeRelationship({
        explanation: optionalText(body.explanation),
        note: optionalText(body.note),
        relationshipId,
      });
    } else {
      return Response.json(
        { ok: false, error: "Choose a valid relationship review action." },
        { status: 400 },
      );
    }

    revalidatePath(getKnowledgeRoute());
    revalidatePath(getKnowledgeGraphRoute());

    return Response.json({ ok: true });
  } catch {
    return Response.json(
      {
        ok: false,
        error: "The knowledge relationship could not be updated right now.",
      },
      { status: 500 },
    );
  }
}
