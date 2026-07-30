import type { BridgeCommandReport } from "../../../../../../../../../../packages/bridge-protocol/src";

import {
  BridgeCloudError,
  completeBridgeCloudCommand,
} from "@/lib/bridge/cloud-coordinator";
import { prepareBridgeCommandReportForPersistence } from "@/lib/bridge/cloud-command-results";
import { authenticateBridgeDeviceRequest } from "@/lib/bridge/device-request-auth";
import { applyRemoteExecutionReport } from "@/lib/bridge/remote-execution";
import { importRemoteBridgeScanReport } from "@/lib/bridge/remote-scan-queue";
import { getPrismaClient } from "@/lib/db/prisma";

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
    await authenticateBridgeDeviceRequest({
      bodyText,
      bridgeDeviceId: deviceId,
      request,
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

    let report: BridgeCommandReport;

    if (
      (command.commandType === "SCAN_LIBRARY" ||
        command.commandType === "RECONCILE_LIBRARY") &&
      command.connectedLibraryId &&
      command.bridgeRootId
    ) {
      const importedResult = await importRemoteBridgeScanReport({
        bridgeDeviceId: deviceId,
        bridgeRootId: command.bridgeRootId,
        commandPayload: command.payload,
        connectedLibraryId: command.connectedLibraryId,
        report: submittedReport,
      });
      report = {
        ...submittedReport,
        result: importedResult ?? submittedReport.result,
      };
    } else if (command.commandType === "EXECUTE_PLAN") {
      report = {
        ...submittedReport,
        result: await applyRemoteExecutionReport({
          commandPayload: command.payload,
          report: submittedReport,
        }),
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
        { error: error.message, ok: false },
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
