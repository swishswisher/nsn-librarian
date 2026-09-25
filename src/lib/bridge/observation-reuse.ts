import { getPrismaClient } from "@/lib/db/prisma";
import { observationFingerprint } from "@/lib/ai/observation-processing";

const reusableStages = ["EXAMINED", "SUGGESTIONS_GENERATED", "RECOMMENDATIONS_READY"] as const;

export async function reuseCompletedObservationsForScan(input: {
  bridgeDeviceId: string;
  bridgeRootId: string;
  connectedLibraryId: string;
  scanSessionId: string;
}) {
  const prisma = getPrismaClient();
  const device = await prisma.bridgeDevice.findUnique({
    select: { appVersion: true },
    where: { bridgeDeviceId: input.bridgeDeviceId },
  });

  if (!device) {
    return 0;
  }

  const files = await prisma.scannedFile.findMany({
    select: {
      checksum: true,
      fileType: true,
      id: true,
      localPath: true,
      relativePath: true,
      sizeBytes: true,
    },
    where: {
      readStatus: "SUPPORTED",
      sessionId: input.scanSessionId,
    },
  });
  const eligible = files.flatMap((file) => {
    const fingerprint = observationFingerprint({
      bridgeDeviceId: input.bridgeDeviceId,
      bridgeRootId: input.bridgeRootId,
      bridgeVersion: device.appVersion,
      checksum: file.checksum,
      connectedLibraryId: input.connectedLibraryId,
      fileType: file.fileType,
      relativePath: file.relativePath,
    });

    return fingerprint && !/^(?:IMAGE|AUDIO|VIDEO)_/.test(file.fileType)
      ? [{ ...file, fingerprint }]
      : [];
  });
  let reused = 0;

  for (let offset = 0; offset < eligible.length; offset += 500) {
    const batch = eligible.slice(offset, offset + 500);
    const candidates = await prisma.scannedFile.findMany({
      include: {
        libraryDocument: {
          select: {
            observationSessions: {
              select: { observerType: true, status: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      where: {
        extractionStatus: "COMPLETED",
        libraryDocumentId: { not: null },
        observationFingerprint: { in: batch.map((file) => file.fingerprint) },
        observationOrigin: { in: ["NEW_AI", "REUSED_AI"] },
        processingStage: { in: [...reusableStages] },
        readingStatus: "READ",
        readStatus: "SUPPORTED",
        scanSession: { connectedFolderId: input.connectedLibraryId },
        sessionId: { not: input.scanSessionId },
        sourceUnavailableAt: null,
      },
    });
    const latestByFingerprint = new Map<string, (typeof candidates)[number]>();

    for (const candidate of candidates) {
      if (candidate.observationFingerprint && !latestByFingerprint.has(candidate.observationFingerprint)) {
        latestByFingerprint.set(candidate.observationFingerprint, candidate);
      }
    }

    for (const file of batch) {
      const candidate = latestByFingerprint.get(file.fingerprint);
      const hasUsableObservation = candidate?.libraryDocument?.observationSessions.some(
        (session) => session.observerType === "OPENAI" &&
          ["AWAITING_REVIEW", "APPROVED", "MODIFIED"].includes(session.status),
      );

      if (!candidate || !hasUsableObservation || !candidate.libraryDocumentId ||
          candidate.localPath !== file.localPath || candidate.sizeBytes !== file.sizeBytes ||
          !candidate.previewText || candidate.characterCount === null) {
        continue;
      }

      const updated = await prisma.scannedFile.updateMany({
        data: {
          aiModel: candidate.aiModel,
          characterCount: candidate.characterCount,
          extractedAt: candidate.extractedAt,
          extractionStatus: "COMPLETED",
          libraryDocumentId: candidate.libraryDocumentId,
          observationFingerprint: file.fingerprint,
          observationVersion: candidate.observationVersion,
          observationOrigin: "REUSED_AI",
          previewText: candidate.previewText,
          processedAt: new Date(),
          processingStage: "EXAMINED",
          readingStatus: "READ",
        },
        where: {
          id: file.id,
          libraryDocumentId: null,
          readingStatus: "NOT_READ",
          sessionId: input.scanSessionId,
        },
      });
      reused += updated.count;
    }
  }

  return reused;
}
