import { ensureKnowledgeGraphBackfill } from "@/lib/knowledge/graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The existing human-session and same-origin POST policy protects this route.
// Backfill retains its existing authority locks, eligibility and review rules.
export async function POST() {
  try {
    await ensureKnowledgeGraphBackfill();
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, error: "Knowledge refresh could not complete." }, { status: 503 });
  }
}
