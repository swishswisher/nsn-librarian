import { revalidatePath } from "next/cache";

import { mergeKnowledgeObject } from "@/lib/knowledge/topics";
import {
  getKnowledgeGraphRoute,
  getKnowledgeRoute,
  getKnowledgeTopicRoute,
} from "@/lib/library/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  canonicalObjectId?: unknown;
  reason?: unknown;
};

function optionalText(value: unknown) {
  return typeof value === "string" ? value : undefined;
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

  if (typeof body.canonicalObjectId !== "string") {
    return Response.json(
      { ok: false, error: "Choose the knowledge item to keep." },
      { status: 400 },
    );
  }

  try {
    await mergeKnowledgeObject({
      canonicalObjectId: body.canonicalObjectId,
      mergedObjectId: objectId,
      reason: optionalText(body.reason),
    });

    revalidatePath(getKnowledgeRoute());
    revalidatePath(getKnowledgeGraphRoute());
    revalidatePath(getKnowledgeTopicRoute(body.canonicalObjectId));
    revalidatePath(getKnowledgeTopicRoute(objectId));

    return Response.json({ ok: true });
  } catch {
    return Response.json(
      {
        ok: false,
        error:
          "The knowledge items could not be merged. Choose two different existing items.",
      },
      { status: 500 },
    );
  }
}
