import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { currentReadableRootWhere, isCurrentReadableRoot } from "./current-readable-root";
import { createBridgeCloudCommand } from "./cloud-coordinator";
import { lockCurrentScanPublication } from "./scan-publication-lock";

const activeScanStatuses = ["PENDING", "SCANNING", "READING", "EXAMINING", "GENERATING_SUGGESTIONS"] as const;

export type ExecutionReconciliationOwner = { runId: string; generation: string; rootRevision: number };

export async function assertInventoryAfterPhysicalOutcomes(tx: Prisma.TransactionClient, rootId: string, generation: number) {
  const root = await tx.connectedLibrary.findUniqueOrThrow({ where: { id: rootId } });
  if (generation !== root.physicalInventoryGeneration)
    throw new Error("Inventory discovery preceded an authorized filesystem outcome. Scan this root again.");
  if (await tx.executionRun.count({ where: { connectedLibraryId: rootId, status: { in: ["PENDING", "RUNNING"] } } }) ||
      await tx.undoRun.count({ where: { executionRun: { connectedLibraryId: rootId }, status: { in: ["PENDING", "RUNNING"] } } }))
    throw new Error("Inventory cannot become current while an authorized filesystem outcome remains unresolved.");
}

// Called inside the action/outcome transaction, before any source-row mutation.
export async function requireExecutionReconciliation(tx: Prisma.TransactionClient, runId: string, physicalOutcome = true) {
  const run = await tx.executionRun.findUniqueOrThrow({ where: { id: runId } });
  if (physicalOutcome) {
    const root = await tx.connectedLibrary.update({ where: { id: run.connectedLibraryId }, data: { physicalInventoryGeneration: { increment: 1 } } });
    // Cancel the old generation before settling its scan. Inventory import uses
    // the same root -> command -> scan order. Preserve completed history and
    // permission/watch controls; neither can supply a new physical inventory.
    await tx.bridgeCommand.updateMany({ where: { connectedLibraryId: root.id,
      commandType: { in: ["SCAN_LIBRARY", "RECONCILE_LIBRARY", "READ_FILE_TEMPORARILY"] }, status: { in: ["PENDING", "ACKNOWLEDGED", "RUNNING"] } },
      data: { status: "CANCELLED", safeErrorCategory: "PHYSICAL_GENERATION_CHANGED", completedAt: new Date() } });
    await tx.scanSession.updateMany({ where: { connectedFolderId: root.id, inventoryGeneration: { lt: root.physicalInventoryGeneration },
      status: { in: [...activeScanStatuses] } }, data: { status: "FAILED", completedAt: new Date(), recommendationGeneration: null, recommendationLeaseUntil: null } });
  }
  if (run.reconciliationScanSessionId) {
    await tx.bridgeCommand.updateMany({ where: { connectedLibraryId: run.connectedLibraryId, commandType: "RECONCILE_LIBRARY",
      payload: { path: ["scanSessionId"], equals: run.reconciliationScanSessionId }, status: { in: ["PENDING", "ACKNOWLEDGED", "RUNNING"] } },
      data: { status: "CANCELLED", safeErrorCategory: "PHYSICAL_GENERATION_CHANGED", completedAt: new Date() } });
    await tx.scanSession.updateMany({ where: { id: run.reconciliationScanSessionId, status: { in: [...activeScanStatuses] } },
      data: { status: "FAILED", recommendationGeneration: null, recommendationLeaseUntil: null } });
  }
  await tx.executionRun.update({ where: { id: run.id }, data: { reconciliationStatus: "REQUIRED",
    reconciliationGeneration: randomUUID(), reconciliationScanSessionId: null, reconciliationRootRevision: null } });
}

export async function lockExecutionReconciliation(tx: Prisma.TransactionClient, owner: ExecutionReconciliationOwner, rootId: string) {
  await tx.$queryRaw`SELECT id FROM "ExecutionRun" WHERE id = ${owner.runId} FOR UPDATE`;
  const run = await tx.executionRun.findUniqueOrThrow({ where: { id: owner.runId } });
  const root = await tx.connectedLibrary.findUniqueOrThrow({ where: { id: rootId } });
  if (run.connectedLibraryId !== root.id || run.reconciliationGeneration !== owner.generation || run.reconciliationScanSessionId ||
      run.reconciliationStatus !== "REQUIRED" || !isCurrentReadableRoot(root) || root.nativeConnectionRevision !== owner.rootRevision ||
      await tx.undoRun.count({ where: { executionRunId: run.id, status: { in: ["PENDING", "RUNNING"] } } }))
    throw new Error("Execution reconciliation ownership changed during inventory discovery.");
}

export async function bindExecutionReconciliation(tx: Prisma.TransactionClient, owner: ExecutionReconciliationOwner, scanId: string) {
  await tx.executionRun.update({ where: { id: owner.runId }, data: { reconciliationStatus: "IN_PROGRESS", reconciliationScanSessionId: scanId, reconciliationRootRevision: owner.rootRevision } });
}

export async function recoverExecutionReconciliations(scope: { bridgeDeviceId?: string; scanSessionId?: string } = {}) {
  const prisma = getPrismaClient();
  const candidates = await prisma.executionRun.findMany({ take: 2, select: { id: true },
    orderBy: [{ physicalRecoveryAttemptedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    where: { status: { in: ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"] }, reconciliationStatus: { in: ["REQUIRED", "IN_PROGRESS"] },
      organizationPlan: { scanSessionId: scope.scanSessionId }, undoRuns: { none: { status: { in: ["PENDING", "RUNNING"] } } },
      OR: [{ reconciliationScanSessionId: { not: null } }, { connectedLibrary: { scanSessions: { none: { status: { in: [...activeScanStatuses] } } } } }],
      connectedLibrary: { ...currentReadableRootWhere, bridgeDeviceId: scope.bridgeDeviceId } } });
  for (const candidate of candidates) {
    try {
      const admission = await prisma.$transaction(async (tx) => {
        const binding = await tx.executionRun.findUniqueOrThrow({ where: { id: candidate.id }, include: { connectedLibrary: true } });
        if (binding.connectedLibrary.bridgeDeviceId) await tx.$queryRaw`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${binding.connectedLibrary.bridgeDeviceId} FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${binding.connectedLibraryId} FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM "ExecutionRun" WHERE id = ${candidate.id} FOR UPDATE`;
        const run = await tx.executionRun.findUniqueOrThrow({ where: { id: candidate.id }, include: { connectedLibrary: true } });
        const root = run.connectedLibrary;
        if (!isCurrentReadableRoot(root) || root.bridgeDeviceId !== binding.connectedLibrary.bridgeDeviceId || !["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(run.status) || !["REQUIRED", "IN_PROGRESS"].includes(run.reconciliationStatus) ||
            await tx.executionAction.count({ where: { executionRunId: run.id, status: { in: ["PENDING", "RUNNING"] } } }) ||
            await tx.undoRun.count({ where: { executionRunId: run.id, status: { in: ["PENDING", "RUNNING"] } } })) return null;
        await tx.executionRun.update({ where: { id: run.id }, data: { physicalRecoveryAttemptedAt: new Date() } });
        if (run.reconciliationScanSessionId && run.reconciliationRootRevision !== root.nativeConnectionRevision) {
          await requireExecutionReconciliation(tx, run.id, false);
          return null;
        }
        if (run.reconciliationScanSessionId) {
          const latest = await tx.scanSession.findFirst({ where: { connectedFolderId: root.id, status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] } },
            orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
          const ownedScan = await tx.scanSession.findUniqueOrThrow({ where: { id: run.reconciliationScanSessionId } });
          if (latest && latest.id !== run.reconciliationScanSessionId && (latest.startedAt > ownedScan.startedAt ||
              (latest.startedAt.getTime() === ownedScan.startedAt.getTime() && latest.id > ownedScan.id))) {
            // A newer full inventory can satisfy the same physical obligation.
            // Verify it postdates every completed outcome before adopting it.
            try { await assertInventoryAfterPhysicalOutcomes(tx, root.id, latest.inventoryGeneration); }
            catch { return { run, root, scanId: run.reconciliationScanSessionId, owner: null }; }
            await requireExecutionReconciliation(tx, run.id, false);
            await tx.executionRun.update({ where: { id: run.id }, data: { reconciliationStatus: "IN_PROGRESS", reconciliationScanSessionId: latest.id,
              reconciliationRootRevision: root.nativeConnectionRevision } });
            return { run, root, scanId: latest.id, owner: null };
          }
          return { run, root, scanId: run.reconciliationScanSessionId, owner: null };
        }
        const generation = run.reconciliationGeneration ?? randomUUID();
        await tx.executionRun.update({ where: { id: run.id }, data: { reconciliationGeneration: generation, reconciliationStatus: "REQUIRED" } });
        const owner = { runId: run.id, generation, rootRevision: root.nativeConnectionRevision };
        if (!root.bridgeDeviceId) return { run, root, scanId: null, owner };
        const active = await tx.scanSession.count({ where: { connectedFolderId: root.id, status: { in: [...activeScanStatuses] } } });
        if (active) return null;
        await lockExecutionReconciliation(tx, owner, root.id);
        const scan = await tx.scanSession.create({ data: { connectedFolderId: root.id, inventoryGeneration: root.physicalInventoryGeneration, status: "SCANNING" } });
        await createBridgeCloudCommand({ bridgeDeviceId: root.bridgeDeviceId, bridgeRootId: root.bridgeRootId, connectedLibraryId: root.id,
          commandType: "RECONCILE_LIBRARY", idempotencyKey: `execution-reconciliation:${run.id}:${generation}`,
          authorizationContext: { initiatedBy: "Deanne", purpose: "Reconcile authorized physical outcomes against the complete current inventory." },
          payload: { scanSessionId: scan.id } }, tx);
        await bindExecutionReconciliation(tx, owner, scan.id);
        return { run, root, scanId: scan.id, owner: null };
      }, { timeout: 120_000 });
      if (!admission) continue;
      let scanId = admission.scanId;
      if (!scanId && admission.owner) {
        const { scanConnectedLibrary } = await import("./scanner");
        const inventory = await scanConnectedLibrary(admission.root.id);
        const { createBridgeScanSessionFromScan } = await import("./scan-sessions");
        const scan = await createBridgeScanSessionFromScan(inventory, { connectedLibraryId: admission.root.id,
          allowReusableSession: false, executionReconciliationOwner: admission.owner });
        scanId = scan.id;
      }
      if (!scanId) continue;
      let scan = await prisma.scanSession.findUniqueOrThrow({ where: { id: scanId } });
      if (!admission.root.bridgeDeviceId && ["READING", "EXAMINING", "GENERATING_SUGGESTIONS"].includes(scan.status)) {
        await (await import("./processing-pipeline")).processNextBridgeScanSessionFile(scanId, { recordNotebook: false });
        scan = await prisma.scanSession.findUniqueOrThrow({ where: { id: scanId } });
      }
      if (["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(scan.status)) {
        await (await import("./scan-publication")).publishScanDerivedKnowledge(scanId);
        scan = await prisma.scanSession.findUniqueOrThrow({ where: { id: scanId } });
        if (scan.knowledgePersistenceStatus === "COMPLETED" && scan.searchIndexStatus === "COMPLETED") await prisma.$transaction(async (tx) => {
          if (admission.root.bridgeDeviceId) await tx.$queryRaw`SELECT id FROM "BridgeDevice" WHERE "bridgeDeviceId" = ${admission.root.bridgeDeviceId} FOR SHARE`;
          await tx.$queryRaw`SELECT id FROM "ConnectedFolder" WHERE id = ${admission.root.id} FOR SHARE`;
          await tx.$queryRaw`SELECT id FROM "ExecutionRun" WHERE id = ${candidate.id} FOR UPDATE`;
          const current = await lockCurrentScanPublication(tx, scanId!);
          if (!current || current.knowledgePersistenceStatus !== "COMPLETED" || current.searchIndexStatus !== "COMPLETED") return;
          await assertInventoryAfterPhysicalOutcomes(tx, admission.root.id, scan.inventoryGeneration);
          await tx.executionRun.updateMany({ where: { id: candidate.id, reconciliationScanSessionId: scanId, reconciliationStatus: "IN_PROGRESS",
            reconciliationRootRevision: admission.root.nativeConnectionRevision,
            connectedLibrary: { ...currentReadableRootWhere, nativeConnectionRevision: admission.root.nativeConnectionRevision },
            undoRuns: { none: { status: { in: ["PENDING", "RUNNING"] } } } }, data: { reconciliationStatus: "COMPLETED" } });
        });
      } else if (scan.status === "FAILED") {
        await prisma.executionRun.updateMany({ where: { id: candidate.id, reconciliationScanSessionId: scanId, reconciliationStatus: "IN_PROGRESS" },
          data: { reconciliationStatus: "REQUIRED", reconciliationScanSessionId: null, reconciliationGeneration: randomUUID(), reconciliationRootRevision: null } });
      }
    } catch {
      // The exact generation/scan binding remains durable. Rotate failed owners
      // fairly and retry through the next ordinary coordinator/history poll.
      await prisma.executionRun.updateMany({ where: { id: candidate.id, reconciliationStatus: { in: ["REQUIRED", "IN_PROGRESS"] } }, data: { physicalRecoveryAttemptedAt: new Date() } });
    }
  }
}
