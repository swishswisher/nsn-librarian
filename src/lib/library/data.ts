import { getPrismaClient } from "@/lib/db/prisma";
import { getRelatedItemCountsByDocumentId } from "@/lib/library/knowledge-connections";
import { getObservationReviewQueueItems } from "@/lib/library/observation-sessions";
import { sanitizeReadingWarning } from "@/lib/reading-room/utils";
import type {
  DashboardMetric,
  LibraryDocumentSummary,
  MigrationQueueRow,
  ReviewQueueItem,
} from "@/types/library";

export type LibraryBatchRow = {
  id: string;
  name: string;
  sourceType: string;
  status: string;
  notes: string | null;
  documentCount: number;
  completedCount: number;
  failedOrUnsupportedCount: number;
  pendingCount: number;
  createdAt: string;
};

function safePreviewText(previewText: string | null) {
  if (!previewText) {
    return null;
  }

  if (
    previewText.includes(".next") ||
    previewText.includes("node_modules") ||
    previewText.includes("Cannot find module") ||
    /[a-z]:[\\/]/i.test(previewText)
  ) {
    return `Reading note: ${sanitizeReadingWarning(previewText)}`;
  }

  return previewText;
}

export async function getLibraryDashboardMetrics(): Promise<DashboardMetric[]> {
  const prisma = getPrismaClient();
  const [totalDocuments, readSuccessfully, needsAttention, organizationPlans] =
    await Promise.all([
      prisma.libraryDocument.count(),
      prisma.libraryDocument.count({
        where: { extractionStatus: "COMPLETED" },
      }),
      prisma.libraryDocument.count({
        where: { extractionStatus: { in: ["FAILED", "UNSUPPORTED"] } },
      }),
      prisma.migrationQueueItem.count({
        where: { status: { in: ["PENDING", "READY", "IN_PROGRESS"] } },
      }),
    ]);

  return [
    {
      label: "Library Items",
      value: totalDocuments.toString(),
      helper: "Scanned file metadata Deanne has asked the Librarian to examine.",
      tone: "sage",
    },
    {
      label: "Read Successfully",
      value: readSuccessfully.toString(),
      helper: "Supported library items the Librarian has read.",
      tone: "sand",
    },
    {
      label: "Needs Attention",
      value: needsAttention.toString(),
      helper: "Items the Librarian could not read yet.",
      tone: "review",
    },
    {
      label: "Organization Plans",
      value: organizationPlans.toString(),
      helper: "Approved plans waiting for the future Bridge.",
      tone: "aqua",
    },
  ];
}

export async function getLibraryBatches(): Promise<LibraryBatchRow[]> {
  const prisma = getPrismaClient();
  const batches = await prisma.libraryBatch.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      documents: {
        select: {
          extractionStatus: true,
        },
      },
    },
  });

  return batches.map((batch) => ({
    completedCount: batch.documents.filter(
      (document) => document.extractionStatus === "COMPLETED",
    ).length,
    id: batch.id,
    name: batch.name,
    sourceType: batch.sourceType,
    status: batch.status,
    notes: batch.notes,
    documentCount: batch.documents.length,
    failedOrUnsupportedCount: batch.documents.filter((document) =>
      ["FAILED", "UNSUPPORTED"].includes(document.extractionStatus),
    ).length,
    pendingCount: batch.documents.filter((document) =>
      ["PENDING", "EXTRACTING"].includes(document.extractionStatus),
    ).length,
    createdAt: batch.createdAt.toISOString(),
  }));
}

export async function getLibraryDocuments(): Promise<LibraryDocumentSummary[]> {
  const prisma = getPrismaClient();
  const documents = await prisma.libraryDocument.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      batch: {
        select: {
          name: true,
        },
      },
      classification: true,
    },
  });
  const relatedItemCounts = await getRelatedItemCountsByDocumentId(
    documents.map((document) => document.id),
  );

  return documents.map((document) => ({
    id: document.id,
    itemKind: document.itemKind,
    originalFileName: document.originalFileName,
    extension: document.extension,
    mimeType: document.mimeType,
    scanSessionName: document.batch.name,
    extractionStatus: document.extractionStatus,
    canObserve:
      document.extractionStatus === "COMPLETED" &&
      Boolean(document.rawText?.trim()),
    wordCount: document.wordCount,
    previewText: safePreviewText(document.previewText),
    primaryType: document.classification?.primaryType ?? "NEEDS_REVIEW",
    topicTags: [],
    classificationStatus: document.classificationStatus,
    reviewStatus: document.reviewStatus,
    suggestedDestination:
      document.classification?.suggestedDestination ?? "Awaiting classification",
    relatedItemCount: relatedItemCounts.get(document.id) ?? 0,
  }));
}

export async function getReviewQueueItems(): Promise<ReviewQueueItem[]> {
  return getObservationReviewQueueItems();
}

export async function getMigrationQueueRows(): Promise<MigrationQueueRow[]> {
  const prisma = getPrismaClient();
  const items = await prisma.migrationQueueItem.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      document: true,
    },
    take: 20,
  });

  return items.map((item) => ({
    id: item.id,
    fileName: item.document.originalFileName,
    destinationPath: item.destinationPath,
    actionType: item.actionType,
    status: item.status,
  }));
}
