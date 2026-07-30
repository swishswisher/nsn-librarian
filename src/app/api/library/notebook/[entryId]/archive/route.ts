import { revalidatePath } from "next/cache";

import { archiveNotebookEntry } from "@/lib/library/notebook";
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
    await archiveNotebookEntry(entryId);

    revalidatePath(getNotebookRoute());
    revalidatePath(getNotebookArchiveRoute());
    revalidatePath(getNotebookEntryRoute(entryId));

    return Response.json({ ok: true });
  } catch {
    return Response.json(
      {
        ok: false,
        error: "The Notebook could not archive this entry right now.",
      },
      { status: 500 },
    );
  }
}
