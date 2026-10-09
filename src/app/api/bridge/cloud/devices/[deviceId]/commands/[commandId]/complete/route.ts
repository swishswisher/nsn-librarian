import type {
  BridgeCommandReport,
  BridgeJson,
} from "../../../../../../../../../../packages/bridge-protocol/src";

import {
  BridgeCloudError,
  completeBridgeCloudCommand,
} from "@/lib/bridge/cloud-coordinator";
import { prepareBridgeCommandReportForPersistence } from "@/lib/bridge/cloud-command-results";
import { authenticateBridgeDeviceRequest } from "@/lib/bridge/device-request-auth";
import { applyRemoteExecutionReport } from "@/lib/bridge/remote-execution";
import { importRemoteBridgeScanReport } from "@/lib/bridge/remote-scan-queue";
import { applyRemoteUndoReport } from "@/lib/bridge/remote-undo";
import { getPrismaClient } from "@/lib/db/prisma";
import { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: {
    params: Promise<{ commandId: string; deviceId: string }>;
  },
) {
  const { commandId, deviceId } = await context.params;

  try {
    const bodyText = await request.text();
    const authenticated = await authenticateBridgeDeviceRequest({
      bodyText,
      bridgeDeviceId: deviceId,
      request,
      allowHistoricalCompletion: true,
    });
    const body = bodyText
      ? (JSON.parse(bodyText) as Record<string, unknown>)
      : {};
    const status =
      body.status === "COMPLETED" ||
      body.status === "FAILED" ||
      body.status === "REJECTED"
        ? body.status
        : null;

    if (!status) {
      throw new BridgeCloudError("Expected a safe Bridge command result.", 400);
    }

    const submittedReport: BridgeCommandReport = {
      commandId,
      result:
        body.result === undefined
          ? undefined
          : (body.result as BridgeCommandReport["result"]),
      safeErrorCategory:
        typeof body.safeErrorCategory === "string"
          ? body.safeErrorCategory
          : null,
      status,
    };
    const command = await getPrismaClient().bridgeCommand.findUnique({
      where: { commandId },
    });

    if (!command || command.bridgeDeviceId !== deviceId) {
      throw new BridgeCloudError("That Bridge command could not be found.", 404);
    }

    if (["COMPLETED", "FAILED", "REJECTED", "EXPIRED", "CANCELLED"].includes(command.status)) {
      return Response.json({ command: await completeBridgeCloudCommand(deviceId, submittedReport), ok: true });
    }
    if (!["ACKNOWLEDGED", "RUNNING"].includes(command.status)) throw new BridgeCloudError("Acknowledge the command before reporting its outcome.", 409);
    const physical = command.commandType === "EXECUTE_PLAN" || command.commandType === "EXECUTE_UNDO";
    if (physical) {
      const completed = await getPrismaClient().$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${deviceId} FOR SHARE`);
        const device = await tx.bridgeDevice.findUniqueOrThrow({ where: { bridgeDeviceId: deviceId } });
        if (device.publicKey !== authenticated.publicKey) throw new BridgeCloudError("Device authority changed during this request.", 401);
        if (command.connectedLibraryId) await tx.$queryRaw(Prisma.sql`SELECT id FROM "ConnectedFolder" WHERE id = ${command.connectedLibraryId} FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT "commandId" FROM "BridgeCommand" WHERE "commandId" = ${commandId} FOR UPDATE`);
        const fresh = await tx.bridgeCommand.findUniqueOrThrow({ where: { commandId } });
        if (!["ACKNOWLEDGED", "RUNNING"].includes(fresh.status)) return completeBridgeCloudCommand(deviceId, submittedReport, tx);
        const result = fresh.commandType === "EXECUTE_PLAN"
          ? await applyRemoteExecutionReport({ commandPayload: fresh.payload, report: submittedReport }, tx)
          : await applyRemoteUndoReport({ commandPayload: fresh.payload, report: submittedReport }, tx);
        const unresolved = fresh.commandType === "EXECUTE_PLAN"
          ? await tx.executionRun.findUniqueOrThrow({ where: { id: (fresh.payload as { executionRunId: string }).executionRunId } })
          : await tx.undoRun.findUniqueOrThrow({ where: { id: (fresh.payload as { undoRunId: string }).undoRunId } });
        return completeBridgeCloudCommand(deviceId, { ...submittedReport, result,
          ...(unresolved.status === "RUNNING" ? { safeErrorCategory: "COMMAND_RECOVERY_REQUIRED" } : {}) }, tx);
      }, { timeout: 120_000 });
      return Response.json({ command: completed, ok: true });
    }
    if (authenticated.status === "REVOKED" || authenticated.revokedAt) throw new BridgeCloudError("Revoked devices can only report previously acknowledged physical history.", 401);

    if (["UPDATE_ROOT_PERMISSIONS", "START_WATCHING", "PAUSE_WATCHING", "RESUME_WATCHING", "STOP_WATCHING"].includes(command.commandType)) {
      const { persistBridgeControlCommandReport } = await import("@/lib/bridge/cloud-command-results");
      return Response.json({ command: await persistBridgeControlCommandReport(deviceId, submittedReport, authenticated.publicKey), ok: true });
    }
    let report: BridgeCommandReport;

    if (
      (command.commandType === "SCAN_LIBRARY" ||
        command.commandType === "RECONCILE_LIBRARY") &&
      command.connectedLibraryId &&
      command.bridgeRootId
    ) {
      const authority = command.authorizationContext && typeof command.authorizationContext === "object" && !Array.isArray(command.authorizationContext) ? command.authorizationContext : {};
      const importedResult = (await importRemoteBridgeScanReport({
        bridgeDeviceId: deviceId,
        bridgeRootId: command.bridgeRootId,
        commandPayload: command.payload,
        connectedLibraryId: command.connectedLibraryId,
        report: submittedReport,
        expectedRootRevision: typeof authority.rootConnectionRevision === "number" ? authority.rootConnectionRevision : 0,
        expectedDeviceKeyFingerprint: typeof authority.deviceKeyFingerprint === "string" ? authority.deviceKeyFingerprint : undefined,
      })) as BridgeJson | null;
      report = {
        ...submittedReport,
        result: importedResult ?? submittedReport.result,
      };
    } else {
      report = await prepareBridgeCommandReportForPersistence(
        deviceId,
        submittedReport,
      );
    }

    return Response.json({
      command: await completeBridgeCloudCommand(deviceId, report),
      ok: true,
    });
  } catch (error) {
    if (error instanceof BridgeCloudError) {
      return Response.json(
        { code: error.code, error: error.message, ok: false },
        { status: error.statusCode },
      );
    }


    return Response.json(
      {
        error: "The Bridge command result could not be recorded right now.",
        ok: false,
      },
      { status: 500 },
    );
  }
}
