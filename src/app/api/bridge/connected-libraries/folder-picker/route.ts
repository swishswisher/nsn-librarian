import {
  ConnectedLibraryError,
  getConnectedLibraryByFolderFingerprint,
} from "@/lib/bridge/connected-libraries";
import {
  chooseFolderWithLocalBridge,
  LocalBridgeClientError,
} from "@/lib/bridge/local-bridge-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const bridgeSelection = await chooseFolderWithLocalBridge();
    const selection = {
      ...bridgeSelection,
      ancestorRootIds: Array.isArray(bridgeSelection.ancestorRootIds)
        ? bridgeSelection.ancestorRootIds
        : [],
    };
    const existingLibrary = await getConnectedLibraryByFolderFingerprint(
      selection.rootId,
    );

    return Response.json({
      existingLibrary,
      ok: true,
      selection,
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

    if (error instanceof LocalBridgeClientError) {
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
        error:
          "The NSN Bridge could not open the folder picker right now.",
      },
      { status: 500 },
    );
  }
}
