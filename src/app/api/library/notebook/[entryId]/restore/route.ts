import { revalidatePath } from "next/cache";

import { restoreNotebookEntry } from "@/lib/library/notebook";
import {
  getNotebookArchiveRoute,
  getNotebookEntryRoute,
  getNotebookRoute,
} from "@/lib/library/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ entryId: string }> },
) {
  const { entryId } = await context.params;

  try {
    await restoreNotebookEntry(entryId);

    revalidatePath(getNotebookRoute());
    revalidatePath(getNotebookArchiveRoute());
    revalidatePath(getNotebookEntryRoute(entryId));

    return Response.json({ ok: true });
  } catch {
    return Response.json(
      {
        ok: false,
        error: "The Notebook could not restore this entry right now.",
      },
      { status: 500 },
    );
  }
}
