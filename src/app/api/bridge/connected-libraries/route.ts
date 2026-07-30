import { getBridgeCloudStatus } from "@/lib/bridge/cloud-coordinator";
import { applyCloudBridgeReachability } from "@/lib/bridge/cloud-library-reachability";
import {
  connectBridgeLibrary,
  ConnectedLibraryError,
  getConnectedLibraries,
} from "@/lib/bridge/connected-libraries";
import {
  registerLocalBridgeRoot,
  LocalBridgeClientError,
} from "@/lib/bridge/local-bridge-client";

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

function connectedLibraryErrorResponse(error: unknown) {
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
      error: "The Bridge could not update connected libraries right now.",
    },
    { status: 500 },
  );
}

function permissionsFromBody(body: Record<string, unknown>) {
  return Object.fromEntries(
    permissionKeys
      .filter((key) => typeof body[key] === "boolean")
      .map((key) => [key, body[key]]),
  );
}

export async function GET() {
  try {
    const [libraries, cloud] = await Promise.all([
      getConnectedLibraries(),
      getBridgeCloudStatus().catch(() => ({
        connectedLibraries: [],
        devices: [],
      })),
    ]);

    return Response.json({
      ok: true,
      libraries: applyCloudBridgeReachability(libraries, cloud.devices),
    });
  } catch (error) {
    return connectedLibraryErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const selectionToken =
      typeof body?.selectionToken === "string"
        ? body.selectionToken.trim()
        : "";

    if (!selectionToken) {
      throw new ConnectedLibraryError("Choose a folder first.");
    }

    const root = await registerLocalBridgeRoot({
      displayName:
        typeof body?.displayName === "string" ? body.displayName : undefined,
      permissions: {
        ...permissionsFromBody(body ?? {}),
      },
      selectionToken,
    });
    const result = await connectBridgeLibrary({ root });

    return Response.json({
      action: result.action,
      alreadyConnected: result.alreadyConnected,
      ok: true,
      library: result.library,
    });
  } catch (error) {
    return connectedLibraryErrorResponse(error);
  }
}
