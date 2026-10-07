import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import { normalizePhysicalRelativePath } from "@/lib/bridge/physical-file-identity";
import { currentRecommendationGenerationVersion } from "@/lib/bridge/recommendation-generation";
import { organizationConceptsFromEvidence } from "@/lib/bridge/organization-concepts";
import { currentReadableRootWhere, currentReadableRootSql } from "@/lib/bridge/current-readable-root";

const maxReviewedDecisions = 200;
const maxProposalsPerReview = 4;

export class OrganizationPreferenceError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

function jsonStrings(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizedFolder(value: string) {
  const normalized = normalizePhysicalRelativePath(value, false);
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(0, -1).join("/");
}

function proposalKey(libraryId: string, destination: string, terms: string[]) {
  return createHash("sha256")
    .update([libraryId, destination.toLowerCase(), ...terms].join("\0"))
    .digest("hex");
}

export async function proposeOrganizationPreferences(connectedLibraryId: string) {
  return getPrismaClient().$transaction(async (prisma) => {
    const library = await prisma.connectedLibrary.findFirst({
      select: { id: true }, where: { id: connectedLibraryId, ...currentReadableRootWhere },
    });
    if (!library) return 0;

    const distinct = new Map<string, Awaited<ReturnType<typeof loadPage>>[number]>();
    function loadPage(cursor?: string) { return prisma.organizationSuggestion.findMany({
      orderBy: [{ reviewedAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        currentRelativePath: true,
        id: true,
        proposedRelativePath: true,
        revisions: { orderBy: { createdAt: "desc" }, select: { revisedRelativePath: true }, take: 1 },
        scannedFileId: true,
        scanSessionId: true,
        suggestionType: true,
        status: true,
        whySuggested: true,
      },
      take: maxReviewedDecisions,
      where: {
        invalidatedAt: null,
        recommendationGenerationVersion: currentRecommendationGenerationVersion,
        scanSession: { connectedFolderId: connectedLibraryId },
        status: { in: ["APPROVED", "MODIFIED"] },
        suggestionType: { in: ["MOVE_FILE", "GROUP_WITH_FILES"] },
      },
    }); }
    let cursor: string | undefined;
    do {
      const page = await loadPage(cursor);
      for (const decision of page) {
        const proposed = decision.status === "MODIFIED" ? decision.revisions[0]?.revisedRelativePath : decision.proposedRelativePath;
        if (!proposed || !normalizedFolder(proposed)) continue;
        const key = normalizePhysicalRelativePath(decision.currentRelativePath);
        if (!distinct.has(key)) distinct.set(key, decision);
        if (distinct.size === maxReviewedDecisions) break;
      }
      cursor = page.length === maxReviewedDecisions ? page.at(-1)?.id : undefined;
    } while (distinct.size < maxReviewedDecisions && cursor);
    const byDestination = new Map<string, { destination: string; decisions: Array<Awaited<ReturnType<typeof loadPage>>[number]> }>();
    for (const decision of distinct.values()) {
      const proposed = decision.status === "MODIFIED"
        ? decision.revisions[0]?.revisedRelativePath
        : decision.proposedRelativePath;
      if (!proposed) continue;
      const folder = normalizedFolder(proposed);
      if (!folder) continue;
      const key = folder.toLowerCase();
      const group = byDestination.get(key);
      byDestination.set(key, {
        destination: group?.destination ?? folder,
        decisions: [...(group?.decisions ?? []), decision],
      });
    }

    let proposedCount = 0;
    for (const { destination, decisions: group } of byDestination.values()) {
      if (proposedCount >= maxProposalsPerReview) break;
      for (let left = 0; left < group.length; left += 1) {
        for (let right = left + 1; right < group.length; right += 1) {
          if (proposedCount >= maxProposalsPerReview) break;
          const leftTerms = organizationConceptsFromEvidence(group[left].whySuggested);
          const rightTerms = new Set(organizationConceptsFromEvidence(group[right].whySuggested));
          const scopeTerms = leftTerms.filter((term) => rightTerms.has(term)).sort();
          if (scopeTerms.length < 2) continue;
          const key = proposalKey(connectedLibraryId, destination, scopeTerms);
          const existing = await prisma.organizationPreference.findUnique({ where: { proposalKey: key } });
          if (existing) continue;
          await prisma.organizationPreference.upsert({
            create: {
              connectedLibraryId,
              destinationRelativePath: destination,
              evidence: [group[left], group[right]].map((decision) => ({
                scannedFileId: decision.scannedFileId,
                scanSessionId: decision.scanSessionId,
                suggestionId: decision.id,
              })),
              proposalKey: key,
              scopeTerms,
              sourceDecisionIds: [group[left].id, group[right].id],
            },
            update: {},
            where: { proposalKey: key },
          });
          proposedCount += 1;
        }
      }
    }
    return proposedCount;
  }, { isolationLevel: "Serializable", timeout: 120_000 });
}

export type PreferenceAction = "APPROVE" | "EDIT" | "REJECT" | "DEFER" | "ARCHIVE";

export async function reviewOrganizationPreference(
  id: string,
  input: { action: PreferenceAction; destination?: string; scopeTerms?: string[]; note?: string },
) {
  const prisma = getPrismaClient();
  const preference = await prisma.organizationPreference.findUnique({ where: { id } });
  if (!preference) throw new OrganizationPreferenceError("The preference could not be found.", 404);
  const allowed: PreferenceAction[] = ["APPROVE", "EDIT", "REJECT", "DEFER", "ARCHIVE"];
  if (!allowed.includes(input.action)) throw new OrganizationPreferenceError("Choose a review action.");
  if (preference.status === "ARCHIVED" || preference.status === "REJECTED") {
    throw new OrganizationPreferenceError("This preference is historical and cannot be changed.", 409);
  }

  let destination = preference.destinationRelativePath;
  let scopeTerms = jsonStrings(preference.scopeTerms);
  if (input.action === "EDIT") {
    if (typeof input.destination === "string") {
      const value = input.destination.trim().replace(/\\/g, "/");
      if (!value || value.startsWith("/") || value.includes("..") || /^[a-z]:/i.test(value)) {
        throw new OrganizationPreferenceError("Choose a folder inside the connected library.");
      }
      destination = normalizePhysicalRelativePath(value, false);
      if (!destination || destination === ".") {
        throw new OrganizationPreferenceError("Choose a folder inside the connected library.");
      }
    }
    if (input.scopeTerms) {
      scopeTerms = [...new Set(input.scopeTerms.map((term) => term.trim().toLowerCase()).filter((term) => /^[\p{L}\p{N} -]{4,40}$/u.test(term)))].slice(0, 5);
    }
    if (scopeTerms.length < 2) throw new OrganizationPreferenceError("Use at least two specific scope terms.");
  }
  const nextStatus = input.action === "APPROVE" ? "APPROVED" :
    input.action === "EDIT" ? "PROPOSED" :
    input.action === "DEFER" ? "DEFERRED" :
    input.action === "ARCHIVE" ? "ARCHIVED" : "REJECTED";

  return prisma.$transaction(async (tx) => {
    if (!await tx.connectedLibrary.findFirst({ select: { id: true }, where: {
      id: preference.connectedLibraryId, ...currentReadableRootWhere,
    } })) throw new OrganizationPreferenceError("This library is not available for preference review.", 409);
    if (input.action === "APPROVE") {
      if (preference.disputedAt) throw new OrganizationPreferenceError("A supporting decision changed. Review or edit this proposal first.", 409);
      const decisionIds = jsonStrings(preference.sourceDecisionIds);
      const supportingDecisions = await tx.organizationSuggestion.findMany({
        select: { id: true },
        where: {
          id: { in: decisionIds },
          invalidatedAt: null,
          recommendationGenerationVersion: currentRecommendationGenerationVersion,
          scanSession: { connectedFolderId: preference.connectedLibraryId },
          status: { in: ["APPROVED", "MODIFIED"] },
        },
      });
      if (supportingDecisions.length !== decisionIds.length) {
        throw new OrganizationPreferenceError("One or more supporting decisions are no longer current. Review this proposal again.", 409);
      }
      const active = await tx.organizationPreference.findMany({
        select: { id: true, destinationRelativePath: true, scopeTerms: true },
        where: { connectedLibraryId: preference.connectedLibraryId, status: "APPROVED", disputedAt: null },
      });
      if (active.some((item) => item.id !== id &&
        JSON.stringify(jsonStrings(item.scopeTerms).sort()) === JSON.stringify(scopeTerms.slice().sort()) &&
        item.destinationRelativePath !== destination)) {
        throw new OrganizationPreferenceError("Another approved preference has the same scope but a different destination. Resolve that conflict first.", 409);
      }
    }
    const changed = await tx.organizationPreference.updateMany({
      data: {
        approvedAt: nextStatus === "APPROVED" ? new Date() : null,
        destinationRelativePath: destination,
        disputedAt: input.action === "EDIT" ? null : preference.disputedAt,
        scopeTerms,
        status: nextStatus,
        version: { increment: 1 },
      },
      where: { id, status: preference.status, version: preference.version },
    });
    if (changed.count !== 1) throw new OrganizationPreferenceError("This proposal changed during review. Refresh and try again.", 409);
    await tx.organizationPreferenceRevision.create({
      data: {
        action: input.action,
        nextDestination: destination,
        nextScopeTerms: scopeTerms,
        nextStatus,
        note: input.note?.trim().slice(0, 500) || null,
        preferenceId: id,
        previousDestination: preference.destinationRelativePath,
        previousScopeTerms: jsonStrings(preference.scopeTerms),
        previousStatus: preference.status,
      },
    });
    return tx.organizationPreference.findUniqueOrThrow({ where: { id } });
  }, { isolationLevel: "Serializable" }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2034") {
      throw new OrganizationPreferenceError("This preference changed during review. Refresh and try again.", 409);
    }
    throw error;
  });
}

export async function applicableApprovedPreferences(input: {
  connectedLibraryId: string;
  contentText: string;
  destination?: string;
}) {
  const prisma = getPrismaClient();
  const library = await prisma.connectedLibrary.findFirst({
    select: { id: true },
    where: { id: input.connectedLibraryId, ...currentReadableRootWhere },
  });
  if (!library) return [];
  const preferences: Awaited<ReturnType<typeof prisma.organizationPreference.findMany>> = [];
  const pageSize = 200;
  let cursor: string | undefined;
  do {
    // Also fail closed for a legacy interrupted invalidation. Any changed
    // support has always disputed the rule; a missing dispute flag cannot
    // override live source authority. Empty legacy/manual manifests retain
    // the existing human-review semantics.
    const eligible = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT preference.id FROM "OrganizationPreference" preference
      JOIN "ConnectedFolder" root ON root.id = preference."connectedLibraryId"
      WHERE root.id = ${input.connectedLibraryId} AND ${currentReadableRootSql}
        AND preference.status = 'APPROVED' AND preference."disputedAt" IS NULL AND preference."supersededById" IS NULL
        AND jsonb_typeof(preference."sourceDecisionIds") = 'array'
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(preference."sourceDecisionIds") = 'array'
          THEN preference."sourceDecisionIds" ELSE '[]'::jsonb END) support(id)
          WHERE NOT EXISTS (SELECT 1 FROM "OrganizationSuggestion" decision JOIN "ScanSession" scan ON scan.id = decision."scanSessionId"
            WHERE decision.id = support.id AND scan."connectedFolderId" = root.id AND decision."invalidatedAt" IS NULL
              AND decision."recommendationGenerationVersion" = ${currentRecommendationGenerationVersion}
              AND decision.status IN ('APPROVED', 'MODIFIED')))
        AND ${cursor ? Prisma.sql`(coalesce(preference."approvedAt", 'infinity'::timestamp), preference.id) <
          (SELECT coalesce(previous."approvedAt", 'infinity'::timestamp), previous.id FROM "OrganizationPreference" previous WHERE previous.id = ${cursor})` : Prisma.sql`true`}
      ORDER BY preference."approvedAt" DESC, preference.id DESC LIMIT ${pageSize}
    `);
    const page = await prisma.organizationPreference.findMany({
      orderBy: [{ approvedAt: "desc" }, { id: "desc" }], where: { id: { in: eligible.map((item) => item.id) } },
    });
    preferences.push(...page);
    cursor = page.length === pageSize ? page.at(-1)?.id : undefined;
  } while (cursor);
  const text = input.contentText.toLowerCase();
  const matching = preferences.filter((preference) =>
    (!input.destination || preference.destinationRelativePath.toLowerCase() === input.destination.toLowerCase()) &&
    jsonStrings(preference.scopeTerms).every((term) =>
      new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "u").test(text),
    ),
  );
  const destinationsForScope = new Map<string, Set<string>>();
  for (const preference of preferences) {
    const key = jsonStrings(preference.scopeTerms).slice().sort().join("\0");
    const destinations = destinationsForScope.get(key) ?? new Set<string>();
    destinations.add(preference.destinationRelativePath.toLowerCase());
    destinationsForScope.set(key, destinations);
  }
  return matching.filter((preference) =>
    (destinationsForScope.get(jsonStrings(preference.scopeTerms).slice().sort().join("\0"))?.size ?? 0) === 1,
  ).slice(0, 40);
}

export async function disputePreferencesFromDecisions(suggestionIds: string[], tx?: Prisma.TransactionClient): Promise<void> {
  if (suggestionIds.length === 0) return;
  if (!tx) return getPrismaClient().$transaction((transaction) =>
    disputePreferencesFromDecisions(suggestionIds, transaction), { isolationLevel: "Serializable", timeout: 120_000 });
  const prisma = tx;
  for (let start = 0; start < suggestionIds.length; start += 100) {
    const preferences = await prisma.organizationPreference.findMany({
      where: {
        disputedAt: null,
        status: { in: ["PROPOSED", "DEFERRED", "APPROVED"] },
        OR: suggestionIds.slice(start, start + 100).map((id) => ({ sourceDecisionIds: { array_contains: [id] } })),
      },
    });
    for (const preference of preferences) {
      const changed = await prisma.organizationPreference.updateMany({
        data: { disputedAt: new Date(), version: { increment: 1 } },
        where: { id: preference.id, disputedAt: null, version: preference.version },
      });
      if (changed.count !== 1) throw new OrganizationPreferenceError("This preference changed during invalidation.", 409);
      await prisma.organizationPreferenceRevision.create({ data: {
        preferenceId: preference.id, action: "DISPUTE", previousStatus: preference.status, nextStatus: preference.status,
        previousDestination: preference.destinationRelativePath, nextDestination: preference.destinationRelativePath,
        previousScopeTerms: preference.scopeTerms as Prisma.InputJsonValue, nextScopeTerms: preference.scopeTerms as Prisma.InputJsonValue,
        note: "A supporting organization decision was reset or replaced. Its review remains in history.",
      } });
    }
  }
}

export async function getOrganizationPreferencePageData() {
  const prisma = getPrismaClient();
  // Independent 80-row budgets: reviewable proposals, active approved rules,
  // and disputed/terminal history. Root authority is checked before each cap.
  const categoryPredicates = [
    Prisma.sql`preference.status IN ('PROPOSED', 'DEFERRED') AND preference."disputedAt" IS NULL AND preference."supersededById" IS NULL`,
    Prisma.sql`preference.status = 'APPROVED' AND preference."disputedAt" IS NULL AND preference."supersededById" IS NULL`,
    Prisma.sql`(preference.status IN ('REJECTED', 'ARCHIVED') OR preference."disputedAt" IS NOT NULL OR preference."supersededById" IS NOT NULL)`,
  ];
  const groups = await Promise.all(categoryPredicates.map((predicate) => prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT preference.id FROM "OrganizationPreference" preference
    JOIN "ConnectedFolder" root ON root.id = preference."connectedLibraryId"
    WHERE ${currentReadableRootSql} AND ${predicate}
    ORDER BY preference."updatedAt" DESC, preference.id DESC LIMIT 80
  `)));
  const ids = groups.flat().map((row) => row.id);
  const preferences = await prisma.organizationPreference.findMany({
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    where: { id: { in: ids } },
    include: {
      revisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 12 },
    },
  });
  const libraries = await prisma.connectedLibrary.findMany({
    select: { displayName: true, id: true },
    where: { id: { in: [...new Set(preferences.map((item) => item.connectedLibraryId))] } },
  });
  const names = new Map(libraries.map((item) => [item.id, item.displayName]));
  const sourceIds = preferences.flatMap((item) => jsonStrings(item.sourceDecisionIds));
  const suggestions = await prisma.organizationSuggestion.findMany({
    select: {
      currentRelativePath: true,
      id: true,
      proposedRelativePath: true,
      revisions: { orderBy: { createdAt: "desc" }, select: { context: true, revisedRelativePath: true }, take: 1 },
      status: true,
    },
    where: { id: { in: sourceIds } },
  });
  const sources = new Map(suggestions.map((item) => [item.id, item]));
  const events = sourceIds.length ? await prisma.$queryRaw<Array<{ suggestionId: string; context: string }>>(Prisma.sql`
    SELECT DISTINCT ON ("suggestionId") "suggestionId", context FROM "OrganizationSuggestionDecisionEvent"
    WHERE "suggestionId" IN (${Prisma.join(sourceIds)}) AND context IS NOT NULL
    ORDER BY "suggestionId", "createdAt" DESC, id DESC
  `) : [];
  const contextBySuggestion = new Map(events.map((event) => [event.suggestionId, event.context]));

  return preferences.map((item) => ({
    conflictingDestinations: preferences.filter((other) =>
      other.id !== item.id && other.connectedLibraryId === item.connectedLibraryId &&
      other.status === "APPROVED" &&
      JSON.stringify(jsonStrings(other.scopeTerms).sort()) === JSON.stringify(jsonStrings(item.scopeTerms).sort()) &&
      other.destinationRelativePath !== item.destinationRelativePath,
    ).map((other) => other.destinationRelativePath),
    destinationRelativePath: item.destinationRelativePath,
    disputed: Boolean(item.disputedAt),
    id: item.id,
    libraryName: names.get(item.connectedLibraryId) ?? "Connected library",
    scopeTerms: jsonStrings(item.scopeTerms),
    sources: jsonStrings(item.sourceDecisionIds).map((id) => ({
      context: contextBySuggestion.get(id) ?? sources.get(id)?.revisions[0]?.context ?? null,
      destination: sources.get(id)?.revisions[0]?.revisedRelativePath ?? sources.get(id)?.proposedRelativePath ?? null,
      relativePath: sources.get(id)?.currentRelativePath ?? "Historical reviewed item",
      status: sources.get(id)?.status ?? "HISTORICAL",
    })),
    status: item.status,
    updatedAt: item.updatedAt.toISOString(),
    version: item.version,
    revisions: item.revisions.map((revision) => ({
      action: revision.action,
      createdAt: revision.createdAt.toISOString(),
      note: revision.note,
      previousStatus: revision.previousStatus,
      nextStatus: revision.nextStatus,
    })),
  }));
}
