import { getConnectedLibrary } from "@/lib/bridge/connected-libraries";
import { startBridgeScanSessionForConnectedLibrary } from "@/lib/bridge/processing-pipeline";
import type {
  BridgeBatchScanApiResponse,
  BridgeBatchScanItem,
} from "@/lib/bridge/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeScanError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "The Librarian could not start this folder scan.";
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    connectedLibraryIds?: unknown;
  } | null;
  const connectedLibraryIds = Array.isArray(body?.connectedLibraryIds)
    ? [
        ...new Set(
          body.connectedLibraryIds.filter(
            (item): item is string => typeof item === "string" && item.trim().length > 0,
          ),
        ),
      ]
    : [];

  if (connectedLibraryIds.length === 0) {
    return Response.json(
      {
        ok: false,
        error: "Select at least one connected library before scanning.",
      } satisfies BridgeBatchScanApiResponse,
      { status: 400 },
    );
  }

  const results: BridgeBatchScanItem[] = [];

  for (const connectedLibraryId of connectedLibraryIds) {
    const library = await getConnectedLibrary(connectedLibraryId);
    const displayName = library?.displayName ?? "Connected Library";

    try {
      const result = await startBridgeScanSessionForConnectedLibrary(
        connectedLibraryId,
      );

      results.push({
        connectedLibraryId,
        displayName,
        ok: true,
        progress: result.progress,
        session: result.session,
      });
    } catch (error) {
      results.push({
        connectedLibraryId,
        displayName,
        error: safeScanError(error),
        ok: false,
        progress: null,
        session: null,
      });
    }
  }

  return Response.json({
    alreadyActiveCount: results.filter(
      (result) => result.ok && result.progress?.isActive,
    ).length,
    failedCount: results.filter((result) => !result.ok).length,
    ok: true,
    results,
    startedCount: results.filter((result) => result.ok).length,
  } satisfies BridgeBatchScanApiResponse);
}
