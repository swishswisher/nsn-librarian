import {
  BridgeAudioReaderError,
  normalizeAudioHumanLabelsInput,
  normalizeAudioPrivacyInput,
  updateScannedAudioReviewState,
} from "@/lib/bridge/audio-reader";
import type { AudioPrivacyState } from "@/lib/bridge/types";

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
        error: "Choose a recording label or privacy setting first.",
      },
      { status: 400 },
    );
  }

  let privacyState: AudioPrivacyState | undefined;

  if (body.privacyState !== undefined) {
    const normalizedPrivacyState = normalizeAudioPrivacyInput(body.privacyState);

    if (!normalizedPrivacyState) {
      return Response.json(
        {
          ok: false,
          error: "Choose a valid recording privacy setting.",
        },
        { status: 400 },
      );
    }

    privacyState = normalizedPrivacyState;
  }

  try {
    const file = await updateScannedAudioReviewState({
      labels:
        body.labels === undefined
          ? undefined
          : normalizeAudioHumanLabelsInput(body.labels),
      privacyState,
      scannedFileId: fileId,
    });

    return Response.json({
      ok: true,
      file,
    });
  } catch (error) {
    if (error instanceof BridgeAudioReaderError) {
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
        error: "The Librarian could not update this recording right now.",
      },
      { status: 500 },
    );
  }
}
