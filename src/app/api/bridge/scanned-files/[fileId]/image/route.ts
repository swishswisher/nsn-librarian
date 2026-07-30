import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import {
  BridgeImageReaderError,
  getScannedImagePreviewSource,
  normalizeImageHumanLabelsInput,
  normalizeImagePrivacyInput,
  updateScannedImageReviewState,
} from "@/lib/bridge/image-reader";
import type { ImagePrivacyState } from "@/lib/bridge/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await context.params;

  try {
    const source = await getScannedImagePreviewSource(fileId);
    const stream = createReadStream(source.filePath);

    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Length": source.fileSize.toString(),
        "Content-Type": source.contentType,
      },
    });
  } catch (error) {
    if (error instanceof BridgeImageReaderError) {
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
        error: "The Librarian could not open this image preview right now.",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    labels?: unknown;
    privacyState?: unknown;
  } | null;

  if (!body || (body.labels === undefined && body.privacyState === undefined)) {
    return Response.json(
      {
        ok: false,
        error: "Choose an image label or privacy setting first.",
      },
      { status: 400 },
    );
  }

  let privacyState: ImagePrivacyState | undefined;

  if (body.privacyState !== undefined) {
    const normalizedPrivacyState = normalizeImagePrivacyInput(body.privacyState);

    if (!normalizedPrivacyState) {
      return Response.json(
        {
          ok: false,
          error: "Choose a valid image privacy setting.",
        },
        { status: 400 },
      );
    }

    privacyState = normalizedPrivacyState;
  }

  try {
    const file = await updateScannedImageReviewState({
      labels:
        body.labels === undefined
          ? undefined
          : normalizeImageHumanLabelsInput(body.labels),
      privacyState,
      scannedFileId: fileId,
    });

    return Response.json({
      file,
      ok: true,
    });
  } catch (error) {
    if (error instanceof BridgeImageReaderError) {
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
        error: "The Librarian could not update this image right now.",
      },
      { status: 500 },
    );
  }
}
