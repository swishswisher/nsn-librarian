import {
  ConnectedLibraryError,
  getConnectedLibraryPermissionUpdateStatus,
} from "@/lib/bridge/connected-libraries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  if (error instanceof ConnectedLibraryError) {
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
      error: "The Bridge could not check that permission update right now.",
    },
    { status: 500 },
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ commandId: string; libraryId: string }> },
) {
  const { commandId, libraryId } = await context.params;

  try {
    const result = await getConnectedLibraryPermissionUpdateStatus(
      libraryId,
      commandId,
    );

    if ("error" in result) {
      return Response.json({
        done: result.done,
        error: result.error,
        library: result.library,
        ok: false,
        status: result.status,
      });
    }

    return Response.json({
      done: result.done,
      library: result.library,
      ok: true,
      status: result.status,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
