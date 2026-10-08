import { NextResponse } from "next/server";

import { getHumanSession } from "@/lib/auth/session";
import { answerLibraryQuestion } from "@/lib/library/qa/answer";
import { recoverMemoryForWebAccess } from "@/lib/library/memory";

export const runtime = "nodejs";
export const maxDuration = 150;

export async function POST(request: Request) {
  if (!await getHumanSession()) {
    return NextResponse.json({ ok: false, error: "Authentication is required." },
      { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  let question: unknown;
  try { question = (await request.json() as { question?: unknown }).question; }
  catch { return NextResponse.json({ ok: false, error: "Enter a question about your library." }, { status: 400 }); }
  if (typeof question !== "string" || question.trim().length < 3 || question.length > 500) {
    return NextResponse.json({ ok: false, error: "Enter a question of up to 500 characters." }, { status: 400 });
  }
  try {
    await recoverMemoryForWebAccess();
    return NextResponse.json({ ok: true, result: await answerLibraryQuestion(question) },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: "The Librarian could not answer right now. Library search remains available." },
      { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
