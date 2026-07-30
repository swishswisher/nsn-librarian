import {
  ConnectedLibraryError,
  hideConnectedLibrary,
} from "@/lib/bridge/connected-libraries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ libraryId: string }> },
) {
  const { libraryId } = await context.params;

  try {
    const library = await hideConnectedLibrary(libraryId);

    return Response.json({
      action: "HIDDEN",
      ok: true,
      library,
    });
  } catch (error) {
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
        error: "The Bridge could not remove this connection from the list.",
      },
      { status: 500 },
    );
  }
}
