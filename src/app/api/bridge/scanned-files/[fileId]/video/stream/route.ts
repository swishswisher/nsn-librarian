import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import {
  BridgeVideoReaderError,
  getScannedVideoPlaybackSource,
} from "@/lib/bridge/video-reader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function rangeFromHeader(rangeHeader: string | null, fileSize: number) {
  if (!rangeHeader?.startsWith("bytes=")) {
    return null;
  }

  const [rawStart, rawEnd] = rangeHeader.replace("bytes=", "").split("-");
  const start = rawStart ? Number.parseInt(rawStart, 10) : 0;
  const end = rawEnd ? Number.parseInt(rawEnd, 10) : fileSize - 1;

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= fileSize
  ) {
    return null;
  }

  return {
    end: Math.min(end, fileSize - 1),
    start,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await context.params;

  try {
    const source = await getScannedVideoPlaybackSource(fileId);
    const range = rangeFromHeader(request.headers.get("range"), source.fileSize);

    if (range) {
      const stream = createReadStream(source.filePath, {
        end: range.end,
        start: range.start,
      });
      const contentLength = range.end - range.start + 1;

      return new Response(Readable.toWeb(stream) as ReadableStream, {
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": contentLength.toString(),
          "Content-Range": `bytes ${range.start}-${range.end}/${source.fileSize}`,
          "Content-Type": source.contentType,
        },
        status: 206,
      });
    }

    const stream = createReadStream(source.filePath);

    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": source.fileSize.toString(),
        "Content-Type": source.contentType,
      },
    });
  } catch (error) {
    if (error instanceof BridgeVideoReaderError) {
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
        error: "The Librarian could not open this video preview right now.",
      },
      { status: 500 },
    );
  }
}
