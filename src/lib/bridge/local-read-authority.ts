import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { resolveConnectedLibraryFile } from "./connected-library-file-resolver";
import { claimObservationLease, withOwnedObservationLease } from "./observation-authority";
import type { BridgeReadFileApiSuccess, BridgeReadPreview } from "./types";

type ReadScope = { fileId: string; owner: Date; checksum: string; relativePath: string; client: PrismaClient };
const scopes = new AsyncLocalStorage<ReadScope>();
const writes = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const delegates: Record<string, string> = { ScannedFile: "scannedFile", AudioRecordingMetadata: "audioRecordingMetadata",
  ImageAssetMetadata: "imageAssetMetadata", VideoRecordingMetadata: "videoRecordingMetadata" };

export class LocalSourceIdentityError extends Error {
  readonly category = "FILE_CHANGED_SINCE_SCAN";
  readonly statusCode = 409;
  constructor() { super("This file changed since it was scanned. Scan it again before processing it."); }
}

export async function verifiedLocalChecksum(fileId: string, expected?: string) {
  const file = await getPrismaClient().scannedFile.findUniqueOrThrow({ where: { id: fileId }, select: { checksum: true } });
  const checksum = expected ?? file.checksum;
  if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum)) throw new LocalSourceIdentityError();
  const resolved = await resolveConnectedLibraryFile({ scannedFileId: fileId });
  const handle = await open(resolved.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new LocalSourceIdentityError();
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || hash.digest("hex") !== checksum.toLowerCase()) throw new LocalSourceIdentityError();
    return checksum.toLowerCase();
  } finally { await handle.close(); }
}

// Only reader modules use this scoped client. Their existing metadata and stage
// writes each acquire the same short ownership transaction. Async context keeps
// late timed-out promises bound to their old owner instead of a newer request.
export function getLocalReadClient() { return scopes.getStore()?.client ?? getPrismaClient(); }

export async function withLocalReadAuthority(fileId: string, run: () => Promise<BridgeReadFileApiSuccess>, owner?: Date): Promise<BridgeReadFileApiSuccess> {
  const nested = scopes.getStore();
  if (nested) {
    if (nested.fileId !== fileId) throw new Error("A reader cannot switch its owned source file.");
    return run();
  }
  const claimedAt = owner ?? await claimObservationLease(fileId);
  const base = getPrismaClient();
  try {
    const checksum = await verifiedLocalChecksum(fileId);
    const source = await base.scannedFile.findUniqueOrThrow({ select: { relativePath: true }, where: { id: fileId } });
    const client = base.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
      if (!writes.has(operation)) return query(args);
      const delegate = delegates[model];
      if (!delegate) throw new Error("Reader attempted a write outside its derived file state.");
      const data = (args as { data?: { extractionStatus?: string } }).data;
      if (model !== "ScannedFile" || data?.extractionStatus === "COMPLETED") await verifiedLocalChecksum(fileId, checksum);
      return withOwnedObservationLease(fileId, claimedAt, async (tx) => {
        const current = await tx.scannedFile.findUniqueOrThrow({ select: { checksum: true, relativePath: true }, where: { id: fileId } });
        if (current.checksum?.toLowerCase() !== checksum || current.relativePath !== source.relativePath) throw new LocalSourceIdentityError();
        const target = tx as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>>;
        return target[delegate][operation](args);
      });
    } } } }) as unknown as PrismaClient;
    return await scopes.run({ fileId, owner: claimedAt, checksum, relativePath: source.relativePath, client }, async () => {
      const result = await run();
      await verifiedLocalChecksum(fileId, checksum);
      result.preview.sourceChecksum = checksum;
      return result;
    });
  } catch (error) {
    if (error instanceof LocalSourceIdentityError) await withOwnedObservationLease(fileId, claimedAt, async (tx) => {
      await tx.scannedFile.update({ data: { processingStage: "FAILED", extractionStatus: "FAILED", readingStatus: "FAILED",
        processedAt: new Date(), processingErrorCategory: error.category, extractionErrorCategory: error.category,
        scanError: error.message }, where: { id: fileId } });
    }).catch(() => undefined);
    throw error;
  } finally {
    if (!owner) await base.scannedFile.updateMany({ where: { id: fileId, observationClaimedAt: claimedAt }, data: { observationClaimedAt: null } });
  }
}

export async function withVerifiedLocalRead(fileId: string, run: () => Promise<BridgeReadPreview>) {
  const checksum = await verifiedLocalChecksum(fileId);
  const result = await run();
  await verifiedLocalChecksum(fileId, checksum);
  result.sourceChecksum = checksum;
  return result;
}
