import { NextResponse } from "next/server";

import { getHumanSession } from "@/lib/auth/session";
import { getPrismaClient } from "@/lib/db/prisma";
import { usableScanSnapshotWhere } from "@/lib/bridge/persistent-knowledge";
import { getSearchBackfillProgress, prepareSearchBatch } from "@/lib/library/search-backfill";
import { backfillHistoricalMemorySearchSources } from "@/lib/library/memory";

export const runtime = "nodejs";

async function authorizedSession(sessionId: string) {
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findFirst({
    select: { id: true, connectedFolderId: true },
    where: { id: sessionId, status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] },
      connectedFolder: { isEnabled: true, readPermission: true, status: "CONNECTED",
        disconnectedAt: null, hiddenFromActiveListAt: null, mergedAt: null } },
  });
  if (!session) return null;
  const latest = await prisma.scanSession.findFirst({
    select: { id: true }, orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    where: { connectedFolderId: session.connectedFolderId, ...usableScanSnapshotWhere },
  });
  return latest?.id === session.id ? session : null;
}

export async function GET(request: Request) {
  if (!await getHumanSession()) return NextResponse.json({ ok: false }, { status: 401 });
  const sessionId = new URL(request.url).searchParams.get("sessionId") ?? "";
  if (!sessionId || sessionId.length > 100 || !await authorizedSession(sessionId)) {
    return NextResponse.json({ ok: false, error: "This scan is not available for search preparation." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, progress: await getSearchBackfillProgress(sessionId) },
    { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!await getHumanSession()) {
    return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  }
  let sessionId: unknown;
  let retryFailed = false;
  let memoryBackfill = false;
  try {
    const body = await request.json() as { sessionId?: unknown; retryFailed?: unknown };
    sessionId = body.sessionId;
    retryFailed = body.retryFailed === true;
    memoryBackfill = (body as { memoryBackfill?: unknown }).memoryBackfill === true;
  }
  catch { return NextResponse.json({ ok: false, error: "Choose a scan session." }, { status: 400 }); }
  if (typeof sessionId !== "string" || sessionId.length > 100) {
    return NextResponse.json({ ok: false, error: "Choose a scan session." }, { status: 400 });
  }
  const session = await authorizedSession(sessionId);
  if (!session) {
    return NextResponse.json({ ok: false, error: "This scan is not available for search preparation." }, { status: 404 });
  }
  try {
    if (memoryBackfill) {
      const progress = await backfillHistoricalMemorySearchSources();
      return NextResponse.json({ ok: true, memoryProgress: progress },
        { headers: { "Cache-Control": "no-store" } });
    }
    const progress = await prepareSearchBatch(session.id, retryFailed);
    return NextResponse.json({ ok: true, progress }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    await getPrismaClient().scanSession.update({ data: { searchIndexStatus: "INCOMPLETE" }, where: { id: session.id } });
    return NextResponse.json({ ok: false, error: "Search preparation could not finish. You can try again." }, { status: 503 });
  }
}
