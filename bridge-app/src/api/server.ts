import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

import {
  assertBridgeExecutionAllowed,
  executeBridgePlanActions,
  executeBridgeUndoActions,
  previewBridgeUndo,
  previewBridgeExecution,
} from "../filesystem/operations";
import { readBridgeRootFile } from "../filesystem/reader";
import { resolveBridgeRootFile } from "../filesystem/resolver";
import { scanBridgeRoot } from "../filesystem/scanner";
import {
  disconnectRoot,
  getRootSummary,
  listRoots,
  registerRootFromSelection,
  updateRoot,
} from "../main/registry";
import { permissionPatchFromInput } from "../permissions/defaults";
import { openNativeFolderSelection } from "../picker/native-picker";
import {
  applyCors,
  authenticateRequest,
  validateOrigin,
} from "../security/request-auth";
import {
  BridgeAppError,
  bridgeVersion,
  type BridgeExecutionPlanAction,
  type BridgeUndoPlanAction,
} from "../types";
import {
  pauseBridgeWatcher,
  resumeBridgeWatcher,
  startBridgeWatcher,
  stopBridgeWatcher,
  takeBridgeWatcherEvents,
} from "../watcher/watcher";

const maxBodyBytes = 512 * 1024;

function jsonSafe(value: unknown) {
  return JSON.stringify(value, (_key, nestedValue) =>
    typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue,
  );
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
) {
  applyCors(request, response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(jsonSafe(payload));
}

function safeErrorPayload(error: unknown) {
  if (error instanceof BridgeAppError) {
    return {
      code: error.code,
      error: error.message,
      ok: false,
      statusCode: error.statusCode,
    };
  }

  return {
    code: "BRIDGE_ERROR",
    error: "The NSN Bridge could not complete that request safely.",
    ok: false,
    statusCode: 500,
  };
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > maxBodyBytes) {
      throw new BridgeAppError(
        "The Bridge request was too large.",
        "REQUEST_TOO_LARGE",
        413,
      );
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new BridgeAppError(
      "The Bridge could not read that request.",
      "INVALID_JSON",
      400,
    );
  }
}

function rootRoute(pathname: string) {
  const match = /^\/bridge\/v1\/roots\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);

  return match
    ? {
        action: match[2] ?? null,
        rootId: decodeURIComponent(match[1]),
      }
    : null;
}

function rootReadRoute(pathname: string) {
  const match = /^\/bridge\/v1\/roots\/([^/]+)\/read$/.exec(pathname);

  return match ? decodeURIComponent(match[1]) : null;
}

function rootWatchRoute(pathname: string) {
  const match = /^\/bridge\/v1\/roots\/([^/]+)\/watch\/([^/]+)$/.exec(pathname);

  return match
    ? {
        action: match[2],
        rootId: decodeURIComponent(match[1]),
      }
    : null;
}

function watcherPayload(root: Awaited<ReturnType<typeof startBridgeWatcher>>) {
  return {
    rootAvailable: root.status === "CONNECTED",
    safeErrorCategory:
      root.watcherState === "NEEDS_ATTENTION" ? "WATCHER_START_FAILED" : null,
    startedAt: root.lastWatchingAt,
    status: root.watcherState,
  };
}

function actionsFromBody(value: unknown): BridgeExecutionPlanAction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is BridgeExecutionPlanAction =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { id?: unknown }).id === "string" &&
      ((item as { actionType?: unknown }).actionType === "CREATE_FOLDER" ||
        (item as { actionType?: unknown }).actionType === "MOVE_FILE" ||
        (item as { actionType?: unknown }).actionType === "RENAME_FILE" ||
        (item as { actionType?: unknown }).actionType ===
          "MOVE_AND_RENAME_FILE") &&
      typeof (item as { destinationRelativePath?: unknown })
        .destinationRelativePath === "string",
  );
}

function undoActionsFromBody(value: unknown): BridgeUndoPlanAction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is BridgeUndoPlanAction =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { id?: unknown }).id === "string" &&
      ((item as { actionType?: unknown }).actionType === "REMOVE_FOLDER" ||
        (item as { actionType?: unknown }).actionType === "MOVE_FILE" ||
        (item as { actionType?: unknown }).actionType === "RENAME_FILE") &&
      typeof (item as { sourceRelativePath?: unknown }).sourceRelativePath ===
        "string" &&
      typeof (item as { destinationRelativePath?: unknown })
        .destinationRelativePath === "string",
  );
}

async function handleAuthenticatedRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  await authenticateRequest(request);

  if (request.method === "GET" && url.pathname === "/bridge/v1/roots") {
    sendJson(request, response, 200, {
      ok: true,
      roots: await listRoots(),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/bridge/v1/folder-selections") {
    const body = await readJsonBody(request);
    const developmentPath =
      typeof body.developmentPath === "string" ? body.developmentPath : null;
    const selection = await openNativeFolderSelection({ developmentPath });

    sendJson(request, response, 200, {
      ok: true,
      selection,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/bridge/v1/roots") {
    const body = await readJsonBody(request);
    const nestedPermissions =
      typeof body.permissions === "object" &&
      body.permissions !== null &&
      !Array.isArray(body.permissions)
        ? (body.permissions as Record<string, unknown>)
        : {};
    const root = await registerRootFromSelection({
      displayName:
        typeof body.displayName === "string" ? body.displayName : undefined,
      permissions: permissionPatchFromInput({
        ...body,
        ...nestedPermissions,
      }),
      selectionToken:
        typeof body.selectionToken === "string" ? body.selectionToken : "",
    });

    sendJson(request, response, 200, {
      ok: true,
      root,
      watcher: watcherPayload(root),
    });
    return;
  }

  const readRootId = rootReadRoute(url.pathname);

  if (request.method === "POST" && readRootId) {
    const body = await readJsonBody(request);
    const result = await readBridgeRootFile(
      readRootId,
      typeof body.relativePath === "string" ? body.relativePath : "",
    );

    sendJson(request, response, 200, {
      ok: true,
      result,
    });
    return;
  }

  const watchRoute = rootWatchRoute(url.pathname);

  if (request.method === "POST" && watchRoute) {
    const root =
      watchRoute.action === "start"
        ? await startBridgeWatcher(watchRoute.rootId)
        : watchRoute.action === "pause"
          ? await pauseBridgeWatcher(watchRoute.rootId)
          : watchRoute.action === "resume"
            ? await resumeBridgeWatcher(watchRoute.rootId)
            : watchRoute.action === "stop"
              ? await stopBridgeWatcher(watchRoute.rootId)
              : null;

    if (!root) {
      throw new BridgeAppError(
        "The Bridge could not find that watcher action.",
        "NOT_FOUND",
        404,
      );
    }

    sendJson(request, response, 200, {
      ok: true,
      root,
    });
    return;
  }

  const rootMatch = rootRoute(url.pathname);

  if (rootMatch && request.method === "GET" && !rootMatch.action) {
    sendJson(request, response, 200, {
      ok: true,
      root: await getRootSummary(rootMatch.rootId),
    });
    return;
  }

  if (rootMatch && request.method === "PATCH" && !rootMatch.action) {
    const body = await readJsonBody(request);
    const permissionPatch = permissionPatchFromInput(body);

    if (permissionPatch.readPermission === false) {
      permissionPatch.watchPermission = false;
    }

    let root = await updateRoot(rootMatch.rootId, {
      displayName:
        typeof body.displayName === "string" ? body.displayName : undefined,
      permissions: permissionPatch,
      status:
        body.status === "CONNECTED" ||
        body.status === "PAUSED" ||
        body.status === "NEEDS_ATTENTION" ||
        body.status === "DISCONNECTED"
          ? body.status
          : undefined,
    });

    if (
      permissionPatch.watchPermission === false ||
      permissionPatch.readPermission === false ||
      body.status === "DISCONNECTED"
    ) {
      root = await stopBridgeWatcher(rootMatch.rootId);
    }

    sendJson(request, response, 200, {
      ok: true,
      root,
    });
    return;
  }

  if (rootMatch && request.method === "POST" && rootMatch.action === "disconnect") {
    await stopBridgeWatcher(rootMatch.rootId).catch(() => undefined);
    const root = await disconnectRoot(rootMatch.rootId);

    sendJson(request, response, 200, {
      ok: true,
      root,
    });
    return;
  }

  if (rootMatch && request.method === "POST" && rootMatch.action === "scan") {
    const scan = await scanBridgeRoot(rootMatch.rootId);

    sendJson(request, response, 200, {
      ok: true,
      scan,
    });
    return;
  }

  if (
    rootMatch &&
    request.method === "POST" &&
    rootMatch.action === "resolve-file"
  ) {
    const body = await readJsonBody(request);
    const file = await resolveBridgeRootFile(
      rootMatch.rootId,
      typeof body.relativePath === "string" ? body.relativePath : "",
    );

    sendJson(request, response, 200, {
      file,
      ok: true,
    });
    return;
  }

  if (rootMatch && request.method === "POST" && rootMatch.action === "events") {
    sendJson(request, response, 200, {
      events: await takeBridgeWatcherEvents(rootMatch.rootId),
      ok: true,
    });
    return;
  }

  if (rootMatch && request.method === "POST" && rootMatch.action === "execution-preview") {
    const body = await readJsonBody(request);

    sendJson(request, response, 200, {
      ok: true,
      preview: await previewBridgeExecution(
        rootMatch.rootId,
        actionsFromBody(body.actions),
      ),
    });
    return;
  }

  if (rootMatch && request.method === "POST" && rootMatch.action === "execution-assert") {
    const body = await readJsonBody(request);

    sendJson(request, response, 200, {
      ok: true,
      preview: await assertBridgeExecutionAllowed(
        rootMatch.rootId,
        actionsFromBody(body.actions),
      ),
    });
    return;
  }

  if (rootMatch && request.method === "POST" && rootMatch.action === "execute") {
    const body = await readJsonBody(request);

    sendJson(request, response, 200, {
      execution: await executeBridgePlanActions(
        rootMatch.rootId,
        actionsFromBody(body.actions),
      ),
      ok: true,
    });
    return;
  }

  if (
    rootMatch &&
    request.method === "POST" &&
    rootMatch.action === "undo-preview"
  ) {
    const body = await readJsonBody(request);

    sendJson(request, response, 200, {
      ok: true,
      preview: await previewBridgeUndo(
        rootMatch.rootId,
        undoActionsFromBody(body.actions),
      ),
    });
    return;
  }

  if (rootMatch && request.method === "POST" && rootMatch.action === "undo") {
    const body = await readJsonBody(request);

    sendJson(request, response, 200, {
      ok: true,
      undo: await executeBridgeUndoActions(
        rootMatch.rootId,
        undoActionsFromBody(body.actions),
      ),
    });
    return;
  }

  throw new BridgeAppError(
    "The NSN Bridge could not find that local endpoint.",
    "NOT_FOUND",
    404,
  );
}

export function createBridgeServer() {
  return createServer((request, response) => {
    void (async () => {
      applyCors(request, response);

      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      const requestUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "127.0.0.1"}`,
      );

      validateOrigin(request);

      if (request.method === "GET" && requestUrl.pathname === "/bridge/v1/health") {
        sendJson(request, response, 200, {
          ok: true,
          paired: true,
          platform: process.platform,
          status: "BRIDGE_READY",
          version: bridgeVersion,
        });
        return;
      }

      await handleAuthenticatedRequest(request, response, requestUrl);
    })().catch((error: unknown) => {
      const payload = safeErrorPayload(error);
      sendJson(request, response, payload.statusCode, payload);
    });
  });
}
