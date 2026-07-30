import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import { getRelatedKnowledgeForNotebookEntry } from "@/lib/knowledge/queries";
import {
  getOrganizationPlanRoute,
  getNotebookEntryRoute,
  getRecommendationExamineRoute,
  getRecommendationsRoute,
  getScannedFileExamineRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";
import type {
  NotebookEntry,
  NotebookEntryDetail,
  NotebookEntryStatus,
  NotebookEntryType,
  NotebookRevisionAction,
  NotebookSourceLink,
  NotebookPageData,
} from "@/types/library";

type NotebookEntryDraft = {
  approvedForMemory?: boolean;
  body: string;
  createdAt?: Date;
  entryType: NotebookEntryType;
  executionRunId?: string | null;
  history?: string[];
  memoryItemId?: string | null;
  observationSessionId?: string | null;
  organizationPlanId?: string | null;
  provenanceSummary: string;
  recommendationId?: string | null;
  relatedEntryKeys?: string[];
  requiresAttention?: boolean;
  scanSessionId?: string | null;
  scannedFileId?: string | null;
  sourceId: string;
  sourceKey?: string;
  sourceType: string;
  status?: NotebookEntryStatus;
  summary: string;
  title: string;
  undoRunId?: string | null;
};

type NotebookRevisionInput = {
  actionType: NotebookRevisionAction;
  note?: string | null;
  revisedBody?: string | null;
  revisedSummary?: string | null;
  revisedTitle?: string | null;
};

type StoredNotebookEntry = {
  approvedForMemory: boolean;
  archivedAt: Date | null;
  body: string;
  createdAt: Date;
  entryType: string;
  executionRunId: string | null;
  history: Prisma.JsonValue;
  id: string;
  memoryItemId: string | null;
  observationSessionId: string | null;
  organizationPlanId: string | null;
  provenanceSummary: string;
  recommendationId: string | null;
  relatedEntryKeys: Prisma.JsonValue;
  requiresAttention: boolean;
  scanSessionId: string | null;
  scannedFileId: string | null;
  sourceId: string;
  sourceKey: string;
  sourceType: string;
  status: string;
  summary: string;
  title: string;
  undoRunId: string | null;
  updatedAt: Date;
};

type StoredNotebookEntryRevision = {
  actionType: string;
  createdAt: Date;
  id: string;
  note: string | null;
  revisedBody: string | null;
  revisedSummary: string | null;
  revisedTitle: string | null;
};

const backfillLimit = 80;
let notebookBackfillPromise: Promise<void> | null = null;

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function asStringArray(value: Prisma.JsonValue) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function notebookSourceKey(draft: NotebookEntryDraft) {
  return draft.sourceKey ?? `${draft.entryType}:${draft.sourceType}:${draft.sourceId}`;
}

function entryTypeLabel(type: string) {
  return type
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
  }).format(value);
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function confidencePercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function historyFor(draft: NotebookEntryDraft) {
  return [
    `Created from ${draft.provenanceSummary}.`,
    ...(draft.history ?? []),
  ];
}

function sourceLinksFor(entry: StoredNotebookEntry): NotebookSourceLink[] {
  const links: NotebookSourceLink[] = [];

  if (entry.scanSessionId) {
    links.push({
      href: getScanSessionRoute(entry.scanSessionId),
      kind: "Scan Session",
      label: "View Scan Session",
    });
    links.push({
      href: getRecommendationsRoute(entry.scanSessionId),
      kind: "Recommendations",
      label: "Review Recommendations",
    });
  }

  if (entry.scannedFileId && entry.scanSessionId) {
    links.push({
      href: getScannedFileExamineRoute(entry.scanSessionId, entry.scannedFileId),
      kind: "Examined File",
      label: "View Examined File",
    });
  }

  if (entry.observationSessionId) {
    links.push({
      href: `/admin/library/review/${encodeURIComponent(
        entry.observationSessionId,
      )}`,
      kind: "Observation",
      label: "View Observation Review",
    });
  }

  if (entry.recommendationId && entry.scanSessionId) {
    links.push({
      href: getRecommendationExamineRoute(
        entry.scanSessionId,
        entry.recommendationId,
      ),
      kind: "Recommendation",
      label: "View Recommendation",
    });
  }

  if (entry.organizationPlanId && entry.scanSessionId) {
    links.push({
      href: getOrganizationPlanRoute(entry.scanSessionId),
      kind: "Organization Plan",
      label: "View Organization Plan",
    });
  }

  if (entry.memoryItemId) {
    links.push({
      href: "/admin/library/memory",
      kind: "Memory",
      label: "View Memory",
    });
  }

  return links;
}

async function relatedEntriesFor(entry: StoredNotebookEntry) {
  const prisma = getPrismaClient();
  const relatedKeys = asStringArray(entry.relatedEntryKeys);
  const where: Prisma.NotebookEntryWhereInput[] = [];

  if (entry.scanSessionId) {
    where.push({ scanSessionId: entry.scanSessionId });
  }

  if (entry.observationSessionId) {
    where.push({ observationSessionId: entry.observationSessionId });
  }

  if (entry.organizationPlanId) {
    where.push({ organizationPlanId: entry.organizationPlanId });
  }

  if (entry.memoryItemId) {
    where.push({ memoryItemId: entry.memoryItemId });
  }

  if (relatedKeys.length > 0) {
    where.push({ sourceKey: { in: relatedKeys } });
  }

  if (where.length === 0) {
    return [];
  }

  const related = await prisma.notebookEntry.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      entryType: true,
      title: true,
    },
    take: 8,
    where: {
      AND: [
        { id: { not: entry.id } },
        {
          OR: where,
        },
      ],
    },
  });

  return related.map((item) => ({
    href: getNotebookEntryRoute(item.id),
    kind: entryTypeLabel(item.entryType),
    label: item.title,
  }));
}

function toNotebookEntry(entry: StoredNotebookEntry): NotebookEntry {
  const sourceLinks = sourceLinksFor(entry);
  const history = asStringArray(entry.history);
  const sourceLabels = sourceLinks.map((link) => `${link.kind}: ${link.label}`);

  return {
    approvedForMemory: entry.approvedForMemory,
    archiveStatus: entry.status === "ARCHIVED" ? "ARCHIVED" : "CURRENT",
    archivedAt: entry.archivedAt?.toISOString() ?? null,
    body: entry.body,
    createdAt: entry.createdAt.toISOString(),
    entryType: entry.entryType as NotebookEntryType,
    evidence: {
      earlierObservations: history.slice(0, 6),
      reviewDecisions: entry.approvedForMemory
        ? ["Deanne marked this reflection as approved for Memory review."]
        : [],
      supportingMaterial: sourceLabels,
      timeline: [
        `Created: ${formatDateTime(entry.createdAt)}`,
        `Updated: ${formatDateTime(entry.updatedAt)}`,
        entry.archivedAt ? `Archived: ${formatDateTime(entry.archivedAt)}` : "",
      ].filter(Boolean),
      whyINoticedThis: [entry.provenanceSummary],
    },
    executionRunId: entry.executionRunId,
    history,
    humanDecisions: [],
    id: entry.id,
    memoryItemId: entry.memoryItemId,
    observationSessionId: entry.observationSessionId,
    organizationPlanId: entry.organizationPlanId,
    priority: entry.requiresAttention ? 100 : 50,
    provenanceSummary: entry.provenanceSummary,
    recommendationId: entry.recommendationId,
    relatedDocuments: sourceLabels,
    requiresAttention: entry.requiresAttention,
    scanSessionId: entry.scanSessionId,
    scannedFileId: entry.scannedFileId,
    sourceId: entry.sourceId,
    sourceLinks,
    sourceType: entry.sourceType,
    status: entry.status as NotebookEntryStatus,
    summary: entry.summary,
    title: entry.title,
    type: entry.entryType as NotebookEntryType,
    undoRunId: entry.undoRunId,
    updatedAt: entry.updatedAt.toISOString(),
    whyItMatters: entry.summary,
  };
}

function toNotebookRevision(revision: StoredNotebookEntryRevision) {
  return {
    actionType: revision.actionType as NotebookRevisionAction,
    createdAt: revision.createdAt.toISOString(),
    id: revision.id,
    note: revision.note,
    revisedBody: revision.revisedBody,
    revisedSummary: revision.revisedSummary,
    revisedTitle: revision.revisedTitle,
  };
}

async function createOrUpdateNotebookEntry(draft: NotebookEntryDraft) {
  const prisma = getPrismaClient();
  const sourceKey = notebookSourceKey(draft);
  const existing = await prisma.notebookEntry.findUnique({
    where: { sourceKey },
  });
  const nextData = {
    approvedForMemory: draft.approvedForMemory ?? false,
    body: draft.body,
    entryType: draft.entryType,
    executionRunId: draft.executionRunId ?? null,
    history: toJsonInput(historyFor(draft)),
    memoryItemId: draft.memoryItemId ?? null,
    observationSessionId: draft.observationSessionId ?? null,
    organizationPlanId: draft.organizationPlanId ?? null,
    provenanceSummary: draft.provenanceSummary,
    recommendationId: draft.recommendationId ?? null,
    relatedEntryKeys: toJsonInput(draft.relatedEntryKeys ?? []),
    requiresAttention: draft.requiresAttention ?? false,
    scanSessionId: draft.scanSessionId ?? null,
    scannedFileId: draft.scannedFileId ?? null,
    sourceId: draft.sourceId,
    sourceKey,
    sourceType: draft.sourceType,
    summary: draft.summary,
    title: draft.title,
    undoRunId: draft.undoRunId ?? null,
  };

  if (!existing) {
    try {
      return await prisma.notebookEntry.create({
        data: {
          ...nextData,
          createdAt: draft.createdAt,
          status: draft.status ?? "CURRENT",
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      return createOrUpdateNotebookEntry(draft);
    }
  }

  const existingHistory = JSON.stringify(existing.history);
  const nextHistory = JSON.stringify(nextData.history);
  const existingRelated = JSON.stringify(existing.relatedEntryKeys);
  const nextRelated = JSON.stringify(nextData.relatedEntryKeys);
  const changed =
    existing.approvedForMemory !== nextData.approvedForMemory ||
    existing.body !== nextData.body ||
    existing.entryType !== nextData.entryType ||
    existing.executionRunId !== nextData.executionRunId ||
    existing.memoryItemId !== nextData.memoryItemId ||
    existing.observationSessionId !== nextData.observationSessionId ||
    existing.organizationPlanId !== nextData.organizationPlanId ||
    existing.provenanceSummary !== nextData.provenanceSummary ||
    existing.recommendationId !== nextData.recommendationId ||
    existing.requiresAttention !== nextData.requiresAttention ||
    existing.scanSessionId !== nextData.scanSessionId ||
    existing.scannedFileId !== nextData.scannedFileId ||
    existing.sourceId !== nextData.sourceId ||
    existing.sourceType !== nextData.sourceType ||
    existing.summary !== nextData.summary ||
    existing.title !== nextData.title ||
    existing.undoRunId !== nextData.undoRunId ||
    existingHistory !== nextHistory ||
    existingRelated !== nextRelated;

  if (!changed) {
    return existing;
  }

  return prisma.notebookEntry.update({
    data: nextData,
    where: { id: existing.id },
  });
}

export async function recordScanSessionNotebookEntry(scanSessionId: string) {
  const prisma = getPrismaClient();
  const session = await prisma.scanSession.findUnique({
    include: {
      connectedFolder: {
        select: {
          displayName: true,
        },
      },
      organizationSuggestions: {
        select: {
          id: true,
          status: true,
        },
      },
      scannedFiles: {
        select: {
          fileType: true,
          id: true,
          processingStage: true,
          readStatus: true,
        },
      },
    },
    where: { id: scanSessionId },
  });

  if (!session) {
    return null;
  }

  const examinedFiles = session.scannedFiles.filter(
    (file) => file.processingStage === "SUGGESTIONS_GENERATED",
  ).length;
  const needsAttention = session.scannedFiles.filter(
    (file) => file.processingStage === "FAILED" || file.readStatus === "FAILED",
  ).length;
  const recommendationsReady = session.organizationSuggestions.filter(
    (suggestion) => suggestion.status === "PENDING",
  ).length;
  const audioRecordings = session.scannedFiles.filter((file) =>
    file.fileType.startsWith("AUDIO_"),
  ).length;
  const videoRecordings = session.scannedFiles.filter((file) =>
    file.fileType.startsWith("VIDEO_"),
  ).length;
  const audioSentence =
    audioRecordings > 0
      ? ` I also noticed ${plural(
          audioRecordings,
          "audio recording",
        )}; those recordings remain local and need review before any label is trusted.`
      : "";
  const videoSentence =
    videoRecordings > 0
      ? ` I also found ${plural(
          videoRecordings,
          "video recording",
        )}; video summaries, chapters, and scene notes remain provisional until review.`
      : "";

  return createOrUpdateNotebookEntry({
    body:
      `I examined ${plural(session.filesScanned, "file")} in ${session.connectedFolder.displayName}. ` +
      `${plural(examinedFiles, "file")} were examined, ${plural(
        recommendationsReady,
        "recommendation",
      )} are ready for review, and ${plural(
        needsAttention,
        "file",
      )} need attention.${audioSentence}${videoSentence}`,
    createdAt: session.completedAt ?? session.startedAt,
    entryType: "SCAN_SUMMARY",
    history: [
      `Scan started: ${formatDateTime(session.startedAt)}`,
      session.completedAt
        ? `Scan completed: ${formatDateTime(session.completedAt)}`
        : "Scan has not completed yet.",
      `${plural(session.supportedFiles, "supported file")} and ${plural(
        session.unsupportedFiles,
        "unsupported file",
      )} were recorded.`,
      audioRecordings > 0
        ? `${plural(audioRecordings, "audio recording")} were summarized as a group, not as separate Notebook entries.`
        : "No audio recordings were recorded in this scan.",
      videoRecordings > 0
        ? `${plural(videoRecordings, "video recording")} were summarized as a group, not as separate Notebook entries.`
        : "No video recordings were recorded in this scan.",
    ],
    provenanceSummary:
      "The Librarian created this reflection after a folder scan completed.",
    requiresAttention: needsAttention > 0,
    scanSessionId: session.id,
    sourceId: session.id,
    sourceType: "SCAN_SESSION",
    summary:
      `${plural(examinedFiles, "file")} examined, ${plural(
        needsAttention,
        "file",
      )} needing attention, and ${plural(
        recommendationsReady,
        "recommendation",
      )} ready for review.`,
    title: `I examined ${plural(session.filesScanned, "file")} in ${session.connectedFolder.displayName}`,
  });
}

export async function recordMonitoringBatchNotebookEntry(batchId: string) {
  const prisma = getPrismaClient();
  const batch = await prisma.monitoringBatch.findUnique({
    include: {
      connectedFolder: {
        select: {
          displayName: true,
        },
      },
      events: {
        orderBy: {
          detectedAt: "asc",
        },
        select: {
          currentRelativePath: true,
          eventType: true,
          previousRelativePath: true,
          processingStatus: true,
          safeErrorCategory: true,
        },
      },
    },
    where: {
      id: batchId,
    },
  });

  if (!batch) {
    return null;
  }

  const changedFiles = batch.events.filter((event) =>
    event.eventType.startsWith("FILE_"),
  );
  const changedFolders = batch.events.filter((event) =>
    event.eventType.startsWith("FOLDER_"),
  );
  const needsAttention = batch.events.filter(
    (event) =>
      event.processingStatus === "NEEDS_ATTENTION" ||
      event.processingStatus === "FAILED",
  );
  const examples = batch.events
    .slice(0, 5)
    .map((event) => {
      const current = event.currentRelativePath ?? "no current path";
      const previous = event.previousRelativePath;

      if (previous && previous !== current) {
        return `${previous} changed to ${current}`;
      }

      return current;
    });

  return createOrUpdateNotebookEntry({
    body:
      `I noticed a batch of local folder changes in ${batch.connectedFolder.displayName}. ` +
      `${plural(changedFiles.length, "file change")} and ${plural(
        changedFolders.length,
        "folder change",
      )} were recorded. ` +
      "New or changed readable documents were examined provisionally, and any recommendations still wait for Deanne's review.",
    createdAt: batch.completedAt ?? batch.startedAt,
    entryType: "REFLECTION",
    history: [
      `Monitoring batch started: ${formatDateTime(batch.startedAt)}`,
      batch.completedAt
        ? `Monitoring batch completed: ${formatDateTime(batch.completedAt)}`
        : "Monitoring batch has not completed yet.",
      ...examples,
      needsAttention.length > 0
        ? `${plural(needsAttention.length, "change")} need attention.`
        : "No changes in this batch need attention.",
    ],
    provenanceSummary:
      "The Librarian created this reflection from a monitored folder change batch.",
    requiresAttention: needsAttention.length > 0,
    scanSessionId: batch.scanSessionId,
    sourceId: batch.id,
    sourceKey: `MONITORING_BATCH:${batch.id}`,
    sourceType: "MONITORING_BATCH",
    summary:
      `${plural(changedFiles.length, "file change")} and ${plural(
        changedFolders.length,
        "folder change",
      )} were kept in step with the local folder.`,
    title: `I noticed changes in ${batch.connectedFolder.displayName}`,
  });
}

export async function recordObservationDecisionNotebookEntry(
  observationSessionId: string,
  decisionId: string,
  memoryUpdatedCount = 0,
) {
  const prisma = getPrismaClient();
  const session = await prisma.observationSession.findUnique({
    include: {
      humanDecisions: {
        orderBy: { createdAt: "desc" },
        where: { id: decisionId },
      },
      libraryDocument: {
        select: {
          originalFileName: true,
          scannedFiles: {
            select: {
              id: true,
              sessionId: true,
            },
            take: 1,
          },
        },
      },
    },
    where: { id: observationSessionId },
  });
  const decision = session?.humanDecisions[0];

  if (!session || !decision) {
    return null;
  }

  const scannedFile = session.libraryDocument.scannedFiles[0] ?? null;
  const decisionText =
    decision.decisionType === "ACCEPT"
      ? "approved"
      : decision.decisionType === "MODIFY"
        ? "revised"
        : decision.decisionType === "REJECT"
          ? "rejected"
          : "added context to";
  const entryType: NotebookEntryType =
    decision.decisionType === "MODIFY"
      ? "HUMAN_REVISION"
      : decision.decisionType === "NOTE"
        ? "CONTEXT_NOTE"
        : "OBSERVATION";

  await createOrUpdateNotebookEntry({
    body:
      `Deanne ${decisionText} the Librarian's observation for ${session.libraryDocument.originalFileName}. ` +
      "This remains part of the Notebook record, but it does not become trusted Memory unless the Memory workflow approves it.",
    createdAt: decision.createdAt,
    entryType,
    history: [
      decision.note ? `Context added: ${decision.note}` : "",
      decision.editedSuggestion
        ? `Revision saved: ${decision.editedSuggestion}`
        : "",
      memoryUpdatedCount > 0
        ? `${plural(memoryUpdatedCount, "Memory pattern")} changed after approval.`
        : "No Memory change was made from this entry.",
    ].filter(Boolean),
    observationSessionId: session.id,
    provenanceSummary:
      "The Librarian created this reflection after Deanne reviewed an observation.",
    requiresAttention: decision.decisionType === "NOTE",
    scanSessionId: scannedFile?.sessionId ?? null,
    scannedFileId: scannedFile?.id ?? null,
    sourceId: decision.id,
    sourceType: "HUMAN_DECISION",
    summary:
      decision.decisionType === "MODIFY" && decision.editedSuggestion
        ? `Deanne revised the wording: ${decision.editedSuggestion}`
        : `Deanne ${decisionText} this observation.`,
    title:
      decision.decisionType === "MODIFY"
        ? `Deanne revised an observation for ${session.libraryDocument.originalFileName}`
        : `Deanne ${decisionText} an observation for ${session.libraryDocument.originalFileName}`,
  });

  if (memoryUpdatedCount > 0) {
    await recordMemoryLearningForApprovedSession(observationSessionId);
  }

  return true;
}

export async function recordMemoryLearningForApprovedSession(
  observationSessionId: string,
) {
  const prisma = getPrismaClient();
  const session = await prisma.observationSession.findUnique({
    select: {
      createdAt: true,
    },
    where: { id: observationSessionId },
  });
  const fallbackEntries = await prisma.memoryEntry.findMany({
    orderBy: [{ updatedAt: "desc" }],
    take: 3,
    where: {
      status: "ACTIVE",
      updatedAt: session ? { gte: session.createdAt } : undefined,
    },
  });

  if (fallbackEntries.length === 0) {
    return;
  }

  await Promise.all(fallbackEntries.map((entry) => recordMemoryNotebookEntry(entry.id)));
}

export async function recordMemoryNotebookEntry(memoryItemId: string) {
  const prisma = getPrismaClient();
  const memory = await prisma.memoryEntry.findUnique({
    where: { id: memoryItemId },
  });

  if (!memory) {
    return null;
  }

  return createOrUpdateNotebookEntry({
    approvedForMemory: memory.status === "ACTIVE",
    body:
      `I learned a durable ${memory.memoryType.toLowerCase()} from approved human decisions: ${memory.description}`,
    createdAt: memory.createdAt,
    entryType: "MEMORY_LEARNING",
    history: [
      `First seen: ${formatDate(memory.firstSeen)}`,
      `Last seen: ${formatDate(memory.lastSeen)}`,
      `${plural(memory.occurrenceCount, "occurrence")} support this Memory item.`,
      `Confidence: ${confidencePercent(memory.confidence)}`,
    ],
    memoryItemId: memory.id,
    provenanceSummary:
      "The Librarian created this learning reflection from approved Memory.",
    sourceId: memory.id,
    sourceType: "MEMORY",
    summary:
      "This is durable Memory only because it came from approved human review.",
    title: memory.title,
  });
}

export async function recordRecommendationDecisionNotebookEntry(
  recommendationId: string,
) {
  const prisma = getPrismaClient();
  const suggestion = await prisma.organizationSuggestion.findUnique({
    include: {
      revisions: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      scannedFile: {
        select: {
          relativePath: true,
        },
      },
    },
    where: { id: recommendationId },
  });

  if (!suggestion) {
    return null;
  }

  const revision = suggestion.revisions[0] ?? null;
  const statusText =
    suggestion.status === "APPROVED"
      ? "approved"
      : suggestion.status === "MODIFIED"
        ? "modified"
        : suggestion.status === "REJECTED"
          ? "rejected"
          : suggestion.status === "LEFT_UNCHANGED"
            ? "left unchanged"
            : "reviewed";

  return createOrUpdateNotebookEntry({
    body:
      `Deanne ${statusText} a recommendation for ${suggestion.scannedFile.relativePath}. ` +
      "The recommendation remains a plan only until an Organization Plan is approved and confirmed.",
    createdAt: suggestion.reviewedAt ?? suggestion.updatedAt,
    entryType:
      suggestion.status === "MODIFIED"
        ? "HUMAN_REVISION"
        : "RECOMMENDATION_SUMMARY",
    history: [
      `Recommendation: ${suggestion.title}`,
      revision?.revisedRelativePath
        ? `Human destination revision: ${revision.revisedRelativePath}`
        : "",
      revision?.context ? `Human context: ${revision.context}` : "",
    ].filter(Boolean),
    provenanceSummary:
      "The Librarian created this reflection after a recommendation was reviewed.",
    recommendationId: suggestion.id,
    scanSessionId: suggestion.scanSessionId,
    scannedFileId: suggestion.scannedFileId,
    sourceId: suggestion.id,
    sourceKey: `RECOMMENDATION_DECISION:${suggestion.id}:${suggestion.status}`,
    sourceType: "RECOMMENDATION",
    summary: `Deanne ${statusText} this recommendation.`,
    title: `A recommendation was ${statusText}`,
  });
}

export async function recordOrganizationPlanNotebookEntry(planId: string) {
  const prisma = getPrismaClient();
  const plan = await prisma.organizationPlan.findUnique({
    include: {
      scanSession: {
        include: {
          connectedFolder: {
            select: {
              displayName: true,
            },
          },
        },
      },
    },
    where: { id: planId },
  });

  if (!plan) {
    return null;
  }

  return createOrUpdateNotebookEntry({
    body:
      `I prepared an Organization Plan for ${plan.scanSession.connectedFolder.displayName}. ` +
      `It contains ${plural(plan.totalActions, "planned action")}. ` +
      "It cannot organize files until Deanne approves it, previews it, and gives final confirmation.",
    createdAt: plan.createdAt,
    entryType: "ORGANIZATION_DECISION",
    history: [
      `${plural(plan.approvedActions, "approved recommendation")} included.`,
      `${plural(plan.modifiedActions, "modified recommendation")} included.`,
      `${plural(plan.rejectedActions, "rejected recommendation")} skipped.`,
      `${plural(plan.unchangedActions, "unchanged recommendation")} skipped.`,
    ],
    organizationPlanId: plan.id,
    provenanceSummary:
      "The Librarian created this reflection after an Organization Plan was prepared.",
    requiresAttention: Array.isArray(plan.warnings) && plan.warnings.length > 0,
    scanSessionId: plan.scanSessionId,
    sourceId: plan.id,
    sourceType: "ORGANIZATION_PLAN",
    summary:
      `${plural(plan.totalActions, "action")} proposed; warnings remain visible before any organization can happen.`,
    title: `I prepared an Organization Plan for ${plan.scanSession.connectedFolder.displayName}`,
  });
}

export async function recordOrganizationPlanDecisionNotebookEntry(
  planId: string,
  action: "APPROVE" | "CANCEL",
) {
  const prisma = getPrismaClient();
  const plan = await prisma.organizationPlan.findUnique({
    include: {
      scanSession: {
        include: {
          connectedFolder: {
            select: {
              displayName: true,
            },
          },
        },
      },
    },
    where: { id: planId },
  });

  if (!plan) {
    return null;
  }

  return createOrUpdateNotebookEntry({
    body:
      action === "APPROVE"
        ? "Deanne approved the plan for a safety preview. This approval still does not move files."
        : "Deanne cancelled the plan. No filesystem action occurred.",
    createdAt: plan.updatedAt,
    entryType: "ORGANIZATION_DECISION",
    history: [`Plan status after decision: ${plan.status}`],
    organizationPlanId: plan.id,
    provenanceSummary:
      "The Librarian created this reflection after Deanne reviewed an Organization Plan.",
    scanSessionId: plan.scanSessionId,
    sourceId: `${plan.id}:${action}`,
    sourceType: "ORGANIZATION_PLAN_DECISION",
    summary:
      action === "APPROVE"
        ? "The plan is ready for preview, not execution by assumption."
        : "The plan was cancelled and preserved in history.",
    title:
      action === "APPROVE"
        ? "Deanne approved an Organization Plan for preview"
        : "Deanne cancelled an Organization Plan",
  });
}

export async function recordExecutionNotebookEntry(executionRunId: string) {
  const prisma = getPrismaClient();
  const run = await prisma.executionRun.findUnique({
    include: {
      organizationPlan: {
        include: {
          scanSession: {
            include: {
              connectedFolder: {
                select: {
                  displayName: true,
                },
              },
            },
          },
        },
      },
    },
    where: { id: executionRunId },
  });

  if (!run) {
    return null;
  }

  return createOrUpdateNotebookEntry({
    body:
      run.status === "COMPLETED"
        ? `The Bridge organized ${plural(run.completedActions, "planned action")} for ${run.organizationPlan.scanSession.connectedFolder.displayName}. No files were overwritten or deleted.`
        : `The Bridge stopped safely after ${plural(run.completedActions, "completed action")} and ${plural(run.failedActions, "failed action")}. Review is needed before trying again.`,
    createdAt: run.completedAt ?? run.startedAt,
    entryType: "ORGANIZATION_RESULT",
    executionRunId: run.id,
    history: [
      `Started: ${formatDateTime(run.startedAt)}`,
      run.completedAt ? `Completed: ${formatDateTime(run.completedAt)}` : "",
      run.safeErrorCategory ? `Safe error category: ${run.safeErrorCategory}` : "",
    ].filter(Boolean),
    organizationPlanId: run.organizationPlanId,
    provenanceSummary:
      "The Librarian created this reflection after the Bridge finished an approved organization attempt.",
    requiresAttention: run.status !== "COMPLETED",
    scanSessionId: run.organizationPlan.scanSessionId,
    sourceId: run.id,
    sourceType: "EXECUTION_RUN",
    summary:
      run.status === "COMPLETED"
        ? `${plural(run.completedActions, "action")} completed safely.`
        : `${plural(run.failedActions, "action")} need attention.`,
    title:
      run.status === "COMPLETED"
        ? "The library was reorganized successfully"
        : "The organization stopped safely",
  });
}

export async function recordUndoNotebookEntry(undoRunId: string) {
  const prisma = getPrismaClient();
  const run = await prisma.undoRun.findUnique({
    include: {
      executionRun: {
        include: {
          organizationPlan: {
            select: {
              id: true,
              scanSessionId: true,
            },
          },
        },
      },
    },
    where: { id: undoRunId },
  });

  if (!run) {
    return null;
  }

  return createOrUpdateNotebookEntry({
    body:
      run.status === "COMPLETED"
        ? `The Bridge restored ${plural(run.completedActions, "completed change")} from an earlier organization.`
        : `The Bridge stopped safely while restoring changes. ${plural(run.failedActions, "action")} need attention.`,
    createdAt: run.completedAt ?? run.startedAt,
    entryType: "UNDO_RESULT",
    executionRunId: run.executionRunId,
    history: [
      `Started: ${formatDateTime(run.startedAt)}`,
      run.completedAt ? `Completed: ${formatDateTime(run.completedAt)}` : "",
      run.safeErrorCategory ? `Safe error category: ${run.safeErrorCategory}` : "",
    ].filter(Boolean),
    organizationPlanId: run.executionRun.organizationPlanId,
    provenanceSummary:
      "The Librarian created this reflection after an undo attempt finished.",
    requiresAttention: run.status !== "COMPLETED",
    scanSessionId: run.executionRun.organizationPlan.scanSessionId,
    sourceId: run.id,
    sourceType: "UNDO_RUN",
    summary:
      run.status === "COMPLETED"
        ? `${plural(run.completedActions, "change")} restored.`
        : "One or more restore actions need attention.",
    title:
      run.status === "COMPLETED"
        ? "The organization was undone successfully"
        : "Undo stopped safely",
    undoRunId: run.id,
  });
}

async function backfillScanSessionEntries() {
  const prisma = getPrismaClient();
  const sessions = await prisma.scanSession.findMany({
    orderBy: { startedAt: "desc" },
    select: { id: true },
    take: backfillLimit,
    where: {
      status: {
        in: ["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED"],
      },
    },
  });

  for (const session of sessions) {
    await recordScanSessionNotebookEntry(session.id);
  }
}

async function backfillObservationDecisionEntries() {
  const prisma = getPrismaClient();
  const decisions = await prisma.humanDecision.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      observationSessionId: true,
    },
    take: backfillLimit,
  });

  for (const decision of decisions) {
    await recordObservationDecisionNotebookEntry(
      decision.observationSessionId,
      decision.id,
    );
  }
}

async function backfillRecommendationDecisionEntries() {
  const prisma = getPrismaClient();
  const recommendations = await prisma.organizationSuggestion.findMany({
    orderBy: { updatedAt: "desc" },
    select: { id: true },
    take: backfillLimit,
    where: {
      status: {
        in: ["APPROVED", "MODIFIED", "REJECTED", "LEFT_UNCHANGED"],
      },
    },
  });

  for (const recommendation of recommendations) {
    await recordRecommendationDecisionNotebookEntry(recommendation.id);
  }
}

async function backfillOrganizationPlanEntries() {
  const prisma = getPrismaClient();
  const plans = await prisma.organizationPlan.findMany({
    orderBy: { updatedAt: "desc" },
    select: { id: true },
    take: backfillLimit,
  });

  for (const plan of plans) {
    await recordOrganizationPlanNotebookEntry(plan.id);
  }
}

async function backfillExecutionEntries() {
  const prisma = getPrismaClient();
  const runs = await prisma.executionRun.findMany({
    orderBy: { startedAt: "desc" },
    select: { id: true },
    take: backfillLimit,
    where: {
      status: {
        in: ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"],
      },
    },
  });

  for (const run of runs) {
    await recordExecutionNotebookEntry(run.id);
  }
}

async function backfillUndoEntries() {
  const prisma = getPrismaClient();
  const runs = await prisma.undoRun.findMany({
    orderBy: { startedAt: "desc" },
    select: { id: true },
    take: backfillLimit,
    where: {
      status: {
        in: ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "BLOCKED"],
      },
    },
  });

  for (const run of runs) {
    await recordUndoNotebookEntry(run.id);
  }
}

async function backfillMemoryEntries() {
  const prisma = getPrismaClient();
  const memories = await prisma.memoryEntry.findMany({
    orderBy: [{ lastSeen: "desc" }, { updatedAt: "desc" }],
    select: { id: true },
    take: backfillLimit,
  });

  for (const memory of memories) {
    await recordMemoryNotebookEntry(memory.id);
  }
}

export async function backfillNotebookEntries() {
  await backfillScanSessionEntries();
  await backfillObservationDecisionEntries();
  await backfillRecommendationDecisionEntries();
  await backfillOrganizationPlanEntries();
  await backfillExecutionEntries();
  await backfillUndoEntries();
  await backfillMemoryEntries();
}

async function ensureNotebookBackfill() {
  if (!notebookBackfillPromise) {
    notebookBackfillPromise = backfillNotebookEntries().catch((error: unknown) => {
      notebookBackfillPromise = null;
      throw error;
    });
  }

  await notebookBackfillPromise;
}

async function digestForNotebook(entries: StoredNotebookEntry[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return {
    examinedItemsToday: entries.filter(
      (entry) => entry.entryType === "SCAN_SUMMARY" && entry.createdAt >= today,
    ).length,
    growingThemesToday: entries.filter(
      (entry) => entry.entryType === "REFLECTION" && entry.updatedAt >= today,
    ).length,
    learnedPreferencesToday: entries.filter(
      (entry) =>
        (entry.entryType === "MEMORY_LEARNING" ||
          entry.entryType === "HUMAN_REVISION") &&
        entry.updatedAt >= today,
    ).length,
    possibleRelationshipsToday: entries.filter(
      (entry) =>
        (entry.entryType === "RECOMMENDATION_SUMMARY" ||
          entry.entryType === "ORGANIZATION_DECISION") &&
        entry.updatedAt >= today,
    ).length,
    waitingQuestions: entries.filter(
      (entry) =>
        entry.status !== "ARCHIVED" &&
        (entry.entryType === "QUESTION" || entry.requiresAttention),
    ).length,
  };
}

export async function getNotebookPageData(): Promise<NotebookPageData> {
  await ensureNotebookBackfill();

  const prisma = getPrismaClient();
  const storedEntries = await prisma.notebookEntry.findMany({
    orderBy: [{ requiresAttention: "desc" }, { updatedAt: "desc" }],
    take: 250,
  });
  const allEntries = storedEntries.map(toNotebookEntry);
  const currentReflections = allEntries
    .filter(
      (entry) =>
        entry.status !== "ARCHIVED" &&
        !entry.requiresAttention &&
        entry.entryType !== "QUESTION" &&
        entry.entryType !== "MEMORY_LEARNING",
    )
    .slice(0, 12);
  const needsAttention = allEntries
    .filter(
      (entry) =>
        entry.status !== "ARCHIVED" &&
        (entry.requiresAttention || entry.entryType === "QUESTION"),
    )
    .slice(0, 12);
  const recentLearning = allEntries
    .filter(
      (entry) =>
        entry.status !== "ARCHIVED" &&
        (entry.entryType === "MEMORY_LEARNING" ||
          entry.entryType === "HUMAN_REVISION" ||
          entry.entryType === "LANGUAGE_PREFERENCE" ||
          entry.entryType === "LEARNING_UPDATE"),
    )
    .slice(0, 12);
  const archiveEntries = allEntries;
  const [mostImportantObservation = null, ...otherObservations] =
    currentReflections;

  return {
    allEntries,
    archiveEntries,
    currentReflections,
    digest: await digestForNotebook(storedEntries),
    learningUpdates: recentLearning.slice(0, 4),
    mostImportantObservation,
    needsAttention,
    otherObservations: otherObservations.slice(0, 8),
    questions: needsAttention.filter((entry) => entry.entryType === "QUESTION"),
    recentLearning,
  };
}

export async function getNotebookArchivePageData(): Promise<NotebookEntry[]> {
  await ensureNotebookBackfill();

  const prisma = getPrismaClient();
  const entries = await prisma.notebookEntry.findMany({
    orderBy: [{ updatedAt: "desc" }],
  });

  return entries.map(toNotebookEntry);
}

export async function getNotebookHomepagePreview() {
  await ensureNotebookBackfill();

  const prisma = getPrismaClient();
  const [latestReflection, unresolvedQuestion, recentLearning] =
    await Promise.all([
      prisma.notebookEntry.findFirst({
        orderBy: { updatedAt: "desc" },
        where: {
          entryType: { not: "MEMORY_LEARNING" },
          status: { not: "ARCHIVED" },
        },
      }),
      prisma.notebookEntry.findFirst({
        orderBy: { updatedAt: "desc" },
        where: {
          OR: [{ requiresAttention: true }, { entryType: "QUESTION" }],
          status: { not: "ARCHIVED" },
        },
      }),
      prisma.notebookEntry.findFirst({
        orderBy: { updatedAt: "desc" },
        where: {
          entryType: "MEMORY_LEARNING",
          status: { not: "ARCHIVED" },
        },
      }),
    ]);

  return {
    latestReflection: latestReflection ? toNotebookEntry(latestReflection) : null,
    recentLearning: recentLearning ? toNotebookEntry(recentLearning) : null,
    unresolvedQuestion: unresolvedQuestion
      ? toNotebookEntry(unresolvedQuestion)
      : null,
  };
}

export async function getNotebookEntryForScanSession(scanSessionId: string) {
  const prisma = getPrismaClient();
  const entry = await prisma.notebookEntry.findFirst({
    orderBy: { updatedAt: "desc" },
    where: {
      entryType: "SCAN_SUMMARY",
      scanSessionId,
    },
  });

  return entry ? toNotebookEntry(entry) : null;
}

export async function getNotebookEntryForOrganizationPlan(planId: string) {
  const prisma = getPrismaClient();
  const entry = await prisma.notebookEntry.findFirst({
    orderBy: { updatedAt: "desc" },
    where: {
      organizationPlanId: planId,
    },
  });

  return entry ? toNotebookEntry(entry) : null;
}

export async function getNotebookEntryDetail(
  entryId: string,
): Promise<NotebookEntryDetail | null> {
  const prisma = getPrismaClient();
  const entry = await prisma.notebookEntry.findUnique({
    include: {
      revisions: {
        orderBy: { createdAt: "desc" },
      },
    },
    where: { id: entryId },
  });

  if (!entry) {
    return null;
  }

  return {
    ...toNotebookEntry(entry),
    relatedKnowledge: await getRelatedKnowledgeForNotebookEntry(entry.id),
    relatedEntries: await relatedEntriesFor(entry),
    revisions: entry.revisions.map(toNotebookRevision),
  };
}

export async function archiveNotebookEntry(entryId: string) {
  const prisma = getPrismaClient();
  const archivedAt = new Date();

  const entry = await prisma.notebookEntry.update({
    data: {
      archivedAt,
      requiresAttention: false,
      revisions: {
        create: {
          actionType: "ARCHIVE",
          note: "Moved out of Current Reflections. The archive keeps the entry permanently visible.",
        },
      },
      status: "ARCHIVED",
    },
    where: { id: entryId },
  });

  return toNotebookEntry(entry);
}

export async function restoreNotebookEntry(entryId: string) {
  const prisma = getPrismaClient();
  const entry = await prisma.notebookEntry.update({
    data: {
      archivedAt: null,
      revisions: {
        create: {
          actionType: "RESTORE",
          note: "Restored to Current Reflections.",
        },
      },
      status: "CURRENT",
    },
    where: { id: entryId },
  });

  return toNotebookEntry(entry);
}

export async function saveNotebookEntryResponse(
  entryId: string,
  input: NotebookRevisionInput,
) {
  const prisma = getPrismaClient();
  const note = input.note?.trim() || null;
  const revisedTitle = input.revisedTitle?.trim() || null;
  const revisedSummary = input.revisedSummary?.trim() || null;
  const revisedBody = input.revisedBody?.trim() || null;
  const status: Partial<{
    approvedForMemory: boolean;
    requiresAttention: boolean;
    status: NotebookEntryStatus;
  }> = {};

  if (input.actionType === "ACCEPT_REFLECTION") {
    status.status = "ACCEPTED";
    status.requiresAttention = false;
  } else if (input.actionType === "REJECT_REFLECTION") {
    status.status = "REJECTED";
    status.requiresAttention = false;
  } else if (input.actionType === "APPROVE_FOR_MEMORY") {
    status.status = "ACCEPTED";
    status.approvedForMemory = true;
    status.requiresAttention = false;
  } else if (input.actionType === "KEEP_NOTEBOOK_ONLY") {
    status.status = "NOTEBOOK_ONLY";
    status.requiresAttention = false;
  } else if (input.actionType === "ANSWER_QUESTION") {
    status.status = "ACCEPTED";
    status.requiresAttention = false;
  }

  const entry = await prisma.notebookEntry.update({
    data: {
      ...status,
      revisions: {
        create: {
          actionType: input.actionType,
          note,
          revisedBody,
          revisedSummary,
          revisedTitle,
        },
      },
    },
    where: { id: entryId },
  });

  return toNotebookEntry(entry);
}

export function searchNotebookEntries(entries: NotebookEntry[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return entries;
  }

  return entries.filter((entry) =>
    [
      entry.title,
      entry.summary ?? "",
      entry.body,
      entry.provenanceSummary ?? "",
      ...(entry.sourceLinks ?? []).map((link) => `${link.kind} ${link.label}`),
      ...entry.history,
      ...(entry.relatedDocuments ?? []),
      ...(entry.humanDecisions ?? []),
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery),
  );
}

export function entryMatchesNotebookFilter(
  entry: NotebookEntry,
  filter: string,
) {
  if (filter === "CURRENT") {
    return entry.status !== "ARCHIVED";
  }

  if (filter === "NEEDS_ATTENTION") {
    return Boolean(entry.requiresAttention) || entry.entryType === "QUESTION";
  }

  if (filter === "LEARNING") {
    return (
      entry.entryType === "MEMORY_LEARNING" ||
      entry.entryType === "HUMAN_REVISION" ||
      entry.entryType === "LANGUAGE_PREFERENCE" ||
      entry.entryType === "LEARNING_UPDATE"
    );
  }

  if (filter === "QUESTIONS") {
    return entry.entryType === "QUESTION";
  }

  if (filter === "ORGANIZATION") {
    return (
      entry.entryType === "RECOMMENDATION_SUMMARY" ||
      entry.entryType === "ORGANIZATION_DECISION" ||
      entry.entryType === "ORGANIZATION_RESULT" ||
      entry.entryType === "UNDO_RESULT"
    );
  }

  if (filter === "ARCHIVE") {
    return true;
  }

  return true;
}
