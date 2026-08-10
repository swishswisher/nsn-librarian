import { checkDatabaseAvailability } from "@/lib/db/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const health = await checkDatabaseAvailability();

  return Response.json(
    {
      databaseAvailable: health.available,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
      status: health.available ? 200 : 503,
    },
  );
}
