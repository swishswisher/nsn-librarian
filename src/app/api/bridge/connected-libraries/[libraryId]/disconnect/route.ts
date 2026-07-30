import {
  ConnectedLibraryError,
  disconnectConnectedLibrary,
} from "@/lib/bridge/connected-libraries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ libraryId: string }> },
) {
  const { libraryId } = await context.params;

  try {
    const library = await disconnectConnectedLibrary(libraryId);

    return Response.json({
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
        error: "The Bridge could not disconnect this folder right now.",
      },
      { status: 500 },
    );
  }
}
