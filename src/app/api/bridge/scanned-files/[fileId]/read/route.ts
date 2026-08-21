import { BridgeCloudError } from "@/lib/bridge/cloud-coordinator";
import { BridgeReaderError, readScannedFile } from "@/lib/bridge/reader";
import { queueRemoteReadRetryForScannedFile } from "@/lib/bridge/remote-read-commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await context.params;

  try {
    const queuedRemoteRead = await queueRemoteReadRetryForScannedFile(fileId);

    if (queuedRemoteRead) {
      return Response.json(queuedRemoteRead, { status: 202 });
    }

    const result = await readScannedFile(fileId);

    return Response.json(result);
  } catch (error) {
    if (error instanceof BridgeCloudError) {
      return Response.json(
        {
          category: error.code,
          error: error.message,
          ok: false,
        },
        { status: error.statusCode },
      );
    }

    if (error instanceof BridgeReaderError) {
      return Response.json(
        {
          category: error.category,
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
