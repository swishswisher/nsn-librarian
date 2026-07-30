import { BridgeReaderError, readScannedFile } from "@/lib/bridge/reader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await context.params;

  try {
    const result = await readScannedFile(fileId);

    return Response.json(result);
  } catch (error) {
    if (error instanceof BridgeReaderError) {
      return Response.json(
        {
          ok: false,
          error: error.message,
        },
        { status: error.statusCode },
      );
    }

    return Response.json(
      {
        ok: false,
        error: "The Librarian could not read this file right now.",
      },
      { status: 500 },
    );
  }
}
