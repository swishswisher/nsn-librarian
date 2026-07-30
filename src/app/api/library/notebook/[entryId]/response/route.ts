import { revalidatePath } from "next/cache";

import { saveNotebookEntryResponse } from "@/lib/library/notebook";
import {
  getNotebookArchiveRoute,
  getNotebookEntryRoute,
  getNotebookRoute,
} from "@/lib/library/routes";
import type { NotebookRevisionAction } from "@/types/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NotebookResponseBody = {
  actionType?: unknown;
  note?: unknown;
  revisedBody?: unknown;
  revisedSummary?: unknown;
  revisedTitle?: unknown;
};

const validActions = new Set<NotebookRevisionAction>([
  "ACCEPT_REFLECTION",
  "REVISE_REFLECTION",
  "REVISE_WORDING",
  "ADD_CONTEXT",
  "ANSWER_QUESTION",
  "REJECT_REFLECTION",
  "APPROVE_FOR_MEMORY",
  "KEEP_NOTEBOOK_ONLY",
]);

function optionalText(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function actionFrom(value: unknown): NotebookRevisionAction | null {
  return typeof value === "string" &&
    validActions.has(value as NotebookRevisionAction)
    ? (value as NotebookRevisionAction)
    : null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ entryId: string }> },
) {
  const { entryId } = await context.params;
  let body: NotebookResponseBody;

  try {
    body = (await request.json()) as NotebookResponseBody;
  } catch {
    return Response.json(
      { ok: false, error: "Expected a JSON request body." },
      { status: 400 },
    );
  }

  const actionType = actionFrom(body.actionType);

  if (!actionType) {
    return Response.json(
      { ok: false, error: "Choose a Notebook response action first." },
      { status: 400 },
    );
  }

  try {
    await saveNotebookEntryResponse(entryId, {
      actionType,
      note: optionalText(body.note),
      revisedBody: optionalText(body.revisedBody),
      revisedSummary: optionalText(body.revisedSummary),
      revisedTitle: optionalText(body.revisedTitle),
    });

    revalidatePath(getNotebookRoute());
    revalidatePath(getNotebookArchiveRoute());
    revalidatePath(getNotebookEntryRoute(entryId));

    return Response.json({ ok: true });
  } catch {
    return Response.json(
      {
        ok: false,
        error: "The Notebook response could not be saved right now.",
      },
      { status: 500 },
    );
  }
}
