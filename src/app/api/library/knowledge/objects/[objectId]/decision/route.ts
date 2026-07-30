import { revalidatePath } from "next/cache";

import {
  approveKnowledgeObject,
  keepKnowledgeObjectProvisional,
  rejectKnowledgeObject,
  reviseKnowledgeObject,
} from "@/lib/knowledge/topics";
import {
  getKnowledgeGraphRoute,
  getKnowledgeRoute,
  getKnowledgeTopicRoute,
} from "@/lib/library/routes";
import {
  knowledgeObjectTypes,
  type KnowledgeObjectType,
} from "@/types/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  action?: unknown;
  description?: unknown;
  name?: unknown;
  note?: unknown;
  objectType?: unknown;
};

const objectTypes = new Set<string>(knowledgeObjectTypes);

function optionalText(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function objectTypeFrom(value: unknown): KnowledgeObjectType | null {
  return typeof value === "string" && objectTypes.has(value)
    ? (value as KnowledgeObjectType)
    : null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ objectId: string }> },
) {
  const { objectId } = await context.params;
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
      await approveKnowledgeObject(objectId);
    } else if (body.action === "REJECT") {
      await rejectKnowledgeObject(objectId, optionalText(body.note));
    } else if (body.action === "KEEP_PROVISIONAL") {
      await keepKnowledgeObjectProvisional(objectId, optionalText(body.note));
    } else if (body.action === "REVISE") {
      await reviseKnowledgeObject({
        description: optionalText(body.description),
        name: optionalText(body.name),
        note: optionalText(body.note),
        objectId,
        objectType: objectTypeFrom(body.objectType),
      });
    } else {
      return Response.json(
        { ok: false, error: "Choose a valid knowledge review action." },
        { status: 400 },
      );
    }

    revalidatePath(getKnowledgeRoute());
    revalidatePath(getKnowledgeGraphRoute());
    revalidatePath(getKnowledgeTopicRoute(objectId));

    return Response.json({ ok: true });
  } catch {
    return Response.json(
      {
        ok: false,
        error:
          "The knowledge item could not be updated. If this duplicates another item, use Merge with Existing.",
      },
      { status: 500 },
    );
  }
}
