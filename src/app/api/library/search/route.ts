import { NextResponse } from "next/server";

import { getHumanSession } from "@/lib/auth/session";
import { searchLibrary } from "@/lib/library/search";
import { recoverMemoryForWebAccess } from "@/lib/library/memory";

export const runtime = "nodejs";
export const maxDuration = 150;

export async function GET(request: Request) {
  if (!await getHumanSession()) {
    return NextResponse.json({ error: "Authentication is required.", ok: false },
      { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    await recoverMemoryForWebAccess();
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return NextResponse.json({ ok: true, results: await searchLibrary(query) },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: "Library search is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
