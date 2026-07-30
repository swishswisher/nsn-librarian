import { bridgeComingSoonMessage } from "@/lib/bridge/scanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    return Response.json(
      { ok: false, error: "Expected scan session form data." },
      { status: 400 },
    );
  }

  return Response.json(
    {
      ok: false,
      error: bridgeComingSoonMessage,
      message: bridgeComingSoonMessage,
    },
    { status: 503 },
  );
}
