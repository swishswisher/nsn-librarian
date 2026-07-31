import {
  startBridgeScanSessionForConnectedLibrary,
  startBridgeScanSessionFromEnvironment,
} from "@/lib/bridge/processing-pipeline";
import { ConnectedLibraryError } from "@/lib/bridge/connected-libraries";
import { getPrismaClient } from "@/lib/db/prisma";
import { BridgeCloudError } from "@/lib/bridge/cloud-coordinator";
import { queueRemoteBridgeScan } from "@/lib/bridge/remote-scan-queue";
import {
  BridgeScannerError,
  isDevelopmentBridgeScannerEnabled,
} from "@/lib/bridge/scanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    connectedLibraryId?: unknown;
  } | null;
  const connectedLibraryId =
    typeof body?.connectedLibraryId === "string" &&
    body.connectedLibraryId.trim()
      ? body.connectedLibraryId.trim()
      : null;

  if (!connectedLibraryId && !isDevelopmentBridgeScannerEnabled()) {
    return Response.json(
      {
        ok: false,
        error: "Connect a folder before starting a scan.",
      },
      { status: 403 },
    );
  }

  try {
    let result;

    if (connectedLibraryId) {
      const library = await getPrismaClient().connectedLibrary.findUnique({
        select: { bridgeDeviceId: true },
        where: { id: connectedLibraryId },
      });

      result = library?.bridgeDeviceId
        ? await queueRemoteBridgeScan(connectedLibraryId)
        : await startBridgeScanSessionForConnectedLibrary(connectedLibraryId);
    } else {
      result = await startBridgeScanSessionFromEnvironment();
    }

    return Response.json({
      ok: true,
      alreadyActive: result.alreadyActive,
      progress: result.progress,
      session: result.session,
    });
  } catch (error) {
    if (
      error instanceof BridgeScannerError ||
      error instanceof ConnectedLibraryError ||
      error instanceof BridgeCloudError
    ) {
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
          "The Librarian could not start the folder scan right now. Open NSN Bridge on the connected Mac and try again.",
      },
      { status: 500 },
    );
  }
}
