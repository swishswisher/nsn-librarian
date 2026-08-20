import {
  bridgeCommandIsExpired,
  createBridgeCommandReplayKey,
  hashBridgeCommandPayload,
  type BridgeCommandEnvelope,
  type BridgeCommandReport,
  type BridgeJson,
} from "../../../../packages/bridge-protocol/src";
import {
  executeBridgePlanActions,
  executeBridgeUndoActions,
  previewBridgeExecution,
  previewBridgeUndo,
} from "../../../../bridge-app/src/filesystem/operations";
import { readBridgeRootFile } from "../../../../bridge-app/src/filesystem/reader";
import { scanBridgeRoot } from "../../../../bridge-app/src/filesystem/scanner";
import {
  disconnectRoot,
  registerRootFromSelection,
} from "../../../../bridge-app/src/main/registry";
import {
  BridgeAppError,
  type BridgeExecutionPlanAction,
  type BridgePermissions,
  type BridgeUndoPlanAction,
  type FolderSelectionResult,
} from "../../../../bridge-app/src/types";
import {
  pauseBridgeWatcher,
  resumeBridgeWatcher,
  startBridgeWatcher,
  stopBridgeWatcher,
  takeBridgeWatcherEvents,
} from "../../../../bridge-app/src/watcher/watcher";

import {
  acknowledgeBridgeCommand,
  bridgeIdentityCanAuthenticate,
  fetchPendingBridgeCommands,
  getCompletePairedBridgeIdentity,
  reportBridgeCommand,
} from "./cloud-client";
import {
  loadBridgeCommandOutbox,
  queueBridgeCommandReport,
  removeBridgeCommandReport,
} from "./command-outbox";
import { readBridgeSecret, saveBridgeSecret } from "./keychain";

const replayCacheSecret = "processed-command-replay-keys";
const replayCacheLimit = 500;
const privatePathKeys = new Set(["actualPath", "localPath", "rootPath"]);

export type BridgeCommandRuntime = {
  selectFolders?: () => Promise<FolderSelectionResult[]>;
};

function payloadObject(payload: BridgeJson) {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, BridgeJson>)
    : {};
}

function jsonSafe(value: unknown): BridgeJson {
  return JSON.parse(
    JSON.stringify(value, (key, nestedValue) => {
      if (privatePathKeys.has(key)) {
        return undefined;
      }

      if (typeof nestedValue === "bigint") {
        return nestedValue.toString();
      }

      if (nestedValue instanceof Date) {
        return nestedValue.toISOString();
      }

      return nestedValue;
    }),
  ) as BridgeJson;
}

function requiredRootId(command: BridgeCommandEnvelope) {
  if (!command.bridgeRootId) {
    throw new BridgeAppError(
      "This Bridge command does not identify a connected folder.",
      "ROOT_REQUIRED",
      400,
    );
  }

  return command.bridgeRootId;
}

function executionActions(value: BridgeJson | undefined) {
  if (!Array.isArray(value)) {
    return [] satisfies BridgeExecutionPlanAction[];
  }

  return value.filter(
    (item): item is BridgeExecutionPlanAction =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      typeof item.id === "string" &&
      (item.actionType === "CREATE_FOLDER" ||
        item.actionType === "MOVE_FILE" ||
        item.actionType === "RENAME_FILE" ||
        item.actionType === "MOVE_AND_RENAME_FILE") &&
      typeof item.destinationRelativePath === "string",
  );
}

function undoActions(value: BridgeJson | undefined) {
  if (!Array.isArray(value)) {
    return [] satisfies BridgeUndoPlanAction[];
  }

  return value.filter(
    (item): item is BridgeUndoPlanAction =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      typeof item.id === "string" &&
      (item.actionType === "REMOVE_FOLDER" ||
        item.actionType === "MOVE_FILE" ||
        item.actionType === "RENAME_FILE") &&
      typeof item.sourceRelativePath === "string" &&
      typeof item.destinationRelativePath === "string",
  );
}

function requiredExecutionActions(value: BridgeJson | undefined) {
  const actions = executionActions(value);

  if (actions.length === 0) {
    throw new BridgeAppError(
      "The execution command did not contain any valid approved actions.",
      "NO_VALID_ACTIONS",
      422,
    );
  }

  return actions;
}

function requiredUndoActions(value: BridgeJson | undefined) {
  const actions = undoActions(value);

  if (actions.length === 0) {
    throw new BridgeAppError(
      "The Undo command did not contain any valid approved actions.",
      "NO_VALID_UNDO_ACTIONS",
      422,
    );
  }

  return actions;
}

function permissionPatch(payload: Record<string, BridgeJson>) {
  const names: Array<keyof BridgePermissions> = [
    "readPermission",
    "watchPermission",
    "recommendationPermission",
    "organizationPlanPermission",
    "createFolderPermission",
    "moveFilePermission",
    "renameFilePermission",
  ];
  const permissions: Partial<BridgePermissions> = {};

  for (const name of names) {
    if (typeof payload[name] === "boolean") {
      permissions[name] = payload[name] as boolean;
    }
  }

  return permissions;
}

async function loadReplayKeys() {
  const raw = await readBridgeSecret(replayCacheSecret);

  if (!raw) {
    return [] as string[];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

async function rememberReplayKey(key: string) {
  const current = await loadReplayKeys();
  const next = [...current.filter((item) => item !== key), key].slice(
    -replayCacheLimit,
  );
  await saveBridgeSecret(replayCacheSecret, JSON.stringify(next));
}

async function executeCommand(
  command: BridgeCommandEnvelope,
  runtime: BridgeCommandRuntime,
) {
  const payload = payloadObject(command.payload);

  switch (command.commandType) {
    case "SELECT_FOLDERS": {
      if (!runtime.selectFolders) {
        throw new BridgeAppError(
          "Open NSN Bridge on this Mac before choosing folders.",
          "LOCAL_INTERACTION_REQUIRED",
          409,
        );
      }

      return runtime.selectFolders();
    }
    case "REGISTER_ROOT":
      return registerRootFromSelection({
        displayName:
          typeof payload.displayName === "string"
            ? payload.displayName
            : undefined,
        permissions: permissionPatch(payload),
        selectionToken:
          typeof payload.selectionToken === "string"
            ? payload.selectionToken
            : "",
      });
    case "SCAN_LIBRARY":
      return scanBridgeRoot(requiredRootId(command));
    case "START_WATCHING":
      return startBridgeWatcher(requiredRootId(command));
    case "PAUSE_WATCHING":
      return pauseBridgeWatcher(requiredRootId(command));
    case "RESUME_WATCHING":
      return resumeBridgeWatcher(requiredRootId(command));
    case "STOP_WATCHING":
      return stopBridgeWatcher(requiredRootId(command));
    case "READ_FILE_TEMPORARILY":
      return readBridgeRootFile(
        requiredRootId(command),
        typeof payload.relativePath === "string" ? payload.relativePath : "",
      );
    case "PREVIEW_EXECUTION":
      return previewBridgeExecution(
        requiredRootId(command),
        requiredExecutionActions(payload.actions),
      );
    case "EXECUTE_PLAN":
      return executeBridgePlanActions(
        requiredRootId(command),
        requiredExecutionActions(payload.actions),
      );
    case "PREVIEW_UNDO":
      return previewBridgeUndo(
        requiredRootId(command),
        requiredUndoActions(payload.actions),
      );
    case "EXECUTE_UNDO":
      return executeBridgeUndoActions(
        requiredRootId(command),
        requiredUndoActions(payload.actions),
      );
    case "RECONCILE_LIBRARY": {
      const rootId = requiredRootId(command);
      const scan = await scanBridgeRoot(rootId);
      const events = await takeBridgeWatcherEvents(rootId);

      return { events, scan };
    }
    case "REVOKE_ROOT_ACCESS": {
      const rootId = requiredRootId(command);
      await stopBridgeWatcher(rootId).catch(() => undefined);
      return disconnectRoot(rootId);
    }
    default:
      throw new BridgeAppError(
        "This version of NSN Bridge does not support that command.",
        "COMMAND_UNSUPPORTED",
        422,
      );
  }
}

async function submitPersistedReport(
  replayKey: string,
  report: BridgeCommandReport,
) {
  await queueBridgeCommandReport(replayKey, report);

  try {
    await reportBridgeCommand(report);
    await removeBridgeCommandReport(report.commandId);
    return true;
  } catch {
    return false;
  }
}

async function flushPendingReports() {
  const pending = await loadBridgeCommandOutbox();
  const delivered = new Set<string>();

  for (const item of pending) {
    try {
      await reportBridgeCommand(item.report);
      await removeBridgeCommandReport(item.report.commandId);
      await rememberReplayKey(item.replayKey);
      delivered.add(item.report.commandId);
    } catch {
      // The report remains in the local outbox. Never repeat the file action.
    }
  }

  return delivered;
}

async function rejectCommand(
  command: BridgeCommandEnvelope,
  safeErrorCategory: string,
  replayKey: string,
) {
  const report: BridgeCommandReport = {
    commandId: command.commandId,
    result: null,
    safeErrorCategory,
    status: "REJECTED",
  };

  await acknowledgeBridgeCommand(command.commandId).catch(() => undefined);
  await submitPersistedReport(replayKey, report);
}

export async function processPendingBridgeCommands(
  runtime: BridgeCommandRuntime = {},
) {
  const identity = await getCompletePairedBridgeIdentity();

  if (!bridgeIdentityCanAuthenticate(identity)) {
    return [];
  }

  const { bridgeDeviceId } = identity;
  const deliveredReports = await flushPendingReports();
  const commands = await fetchPendingBridgeCommands();
  const replayKeys = new Set(await loadReplayKeys());
  const pendingReports = new Set(
    (await loadBridgeCommandOutbox()).map((item) => item.report.commandId),
  );
  const reports: BridgeCommandReport[] = [];

  for (const command of commands) {
    const replayKey = createBridgeCommandReplayKey(command);

    if (command.bridgeDeviceId !== bridgeDeviceId) {
      continue;
    }

    if (deliveredReports.has(command.commandId)) {
      continue;
    }

    if (pendingReports.has(command.commandId)) {
      continue;
    }

    if (bridgeCommandIsExpired(command.expiresAt)) {
      await rejectCommand(command, "COMMAND_EXPIRED", replayKey).catch(
        () => undefined,
      );
      continue;
    }

    if (hashBridgeCommandPayload(command.payload) !== command.payloadHash) {
      await rejectCommand(command, "PAYLOAD_CHANGED", replayKey).catch(
        () => undefined,
      );
      continue;
    }

    if (replayKeys.has(replayKey)) {
      await rejectCommand(
        command,
        "COMMAND_RECOVERY_REQUIRED",
        replayKey,
      ).catch(() => undefined);
      continue;
    }

    // Persist the replay marker before acknowledgement or filesystem work. If
    // the process stops mid-command, the command is never executed a second time.
    await rememberReplayKey(replayKey);
    replayKeys.add(replayKey);
    await acknowledgeBridgeCommand(command.commandId);

    let report: BridgeCommandReport;

    try {
      const result = await executeCommand(command, runtime);
      report = {
        commandId: command.commandId,
        result: jsonSafe(result),
        safeErrorCategory: null,
        status: "COMPLETED",
      };
    } catch (error) {
      report = {
        commandId: command.commandId,
        result: null,
        safeErrorCategory:
          error instanceof BridgeAppError
            ? error.code
            : "BRIDGE_COMMAND_FAILED",
        status: "FAILED",
      };
    }

    await submitPersistedReport(replayKey, report);
    reports.push(report);
  }

  return reports;
}
