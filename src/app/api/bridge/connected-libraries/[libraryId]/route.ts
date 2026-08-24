import {
  ConnectedLibraryError,
  getConnectedLibrary,
  updateConnectedLibrary,
} from "@/lib/bridge/connected-libraries";
import { stopMonitoringForFolder } from "@/lib/bridge/monitor";
import type { ConnectedLibraryStatus } from "@/lib/bridge/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const permissionKeys = [
  "readPermission",
  "watchPermission",
  "recommendationPermission",
  "organizationPlanPermission",
  "createFolderPermission",
  "moveFilePermission",
  "renameFilePermission",
] as const;
const statuses = new Set<ConnectedLibraryStatus>([
  "CONNECTED",
  "PAUSED",
  "NEEDS_ATTENTION",
  "DISCONNECTED",
]);

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
      error: "The Bridge could not update this connected library right now.",
    },
    { status: 500 },
  );
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ libraryId: string }> },
) {
  const { libraryId } = await context.params;

  try {
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const update: Parameters<typeof updateConnectedLibrary>[1] = {};

    if (typeof body?.displayName === "string") {
      update.displayName = body.displayName;
    }

    if (typeof body?.status === "string" && statuses.has(body.status as ConnectedLibraryStatus)) {
      update.status = body.status as ConnectedLibraryStatus;
    }

    for (const key of permissionKeys) {
      if (typeof body?.[key] === "boolean") {
        update[key] = body[key];
      }
    }

    const result = await updateConnectedLibrary(libraryId, update);
    let library = result.library;

    if (
      !result.permissionUpdate &&
      (body?.watchPermission === false || body?.readPermission === false)
    ) {
      await stopMonitoringForFolder(libraryId);
      library = (await getConnectedLibrary(libraryId)) ?? library;
    }

    return Response.json({
      action: result.action,
      ok: true,
      library,
      permissionUpdate: result.permissionUpdate,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
