import {
  BridgeVideoReaderError,
  normalizeVideoHumanLabelsInput,
  normalizeVideoPrivacyInput,
  updateScannedVideoReviewState,
} from "@/lib/bridge/video-reader";
import type { VideoPrivacyState } from "@/lib/bridge/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
        error: "Choose a video label or privacy setting first.",
      },
      { status: 400 },
    );
  }

  let privacyState: VideoPrivacyState | undefined;

  if (body.privacyState !== undefined) {
    const normalizedPrivacyState = normalizeVideoPrivacyInput(body.privacyState);

    if (!normalizedPrivacyState) {
      return Response.json(
        {
          ok: false,
          error: "Choose a valid video privacy setting.",
        },
        { status: 400 },
      );
    }

    privacyState = normalizedPrivacyState;
  }

  try {
    const file = await updateScannedVideoReviewState({
      labels:
        body.labels === undefined
          ? undefined
          : normalizeVideoHumanLabelsInput(body.labels),
      privacyState,
      scannedFileId: fileId,
    });

    return Response.json({
      file,
      ok: true,
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
        error: "The Librarian could not update this video right now.",
      },
      { status: 500 },
    );
  }
}
