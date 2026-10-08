import { authenticateSchedulerRequest } from "@/lib/auth/scheduler";
import { runScheduledMemoryRecovery } from "@/lib/library/memory-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!authenticateSchedulerRequest(request)) return Response.json({ ok: false, error: "Scheduler authentication is required." }, { status: 401, headers });
  try {
    const result = await runScheduledMemoryRecovery();
    if (!result.ok) console.warn("Scheduled Memory restoration requires another attempt.");
    return Response.json(result, { status: result.ok ? 200 : 503, headers });
  } catch {
    console.error("Scheduled Memory restoration could not finish.");
    return Response.json({ ok: false, error: "Memory restoration will need another scheduled attempt." }, { status: 503, headers });
  }
}
