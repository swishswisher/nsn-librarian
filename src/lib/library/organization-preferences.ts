import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/db/prisma";
import { normalizePhysicalRelativePath } from "@/lib/bridge/physical-file-identity";
import { currentRecommendationGenerationVersion } from "@/lib/bridge/recommendation-generation";

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

function contentConcepts(value: Prisma.JsonValue) {
  const entry = jsonStrings(value).find((item) => item.startsWith("Content concepts: "));
  return entry
    ? [...new Set(entry.slice(18).split(",").map((term) => term.trim().toLowerCase()).filter((term) => term.length >= 4))].slice(0, 8)
    : [];
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
  const prisma = getPrismaClient();
  const library = await prisma.connectedLibrary.findUnique({
    select: { isEnabled: true, status: true },
    where: { id: connectedLibraryId },
  });
  if (!library?.isEnabled || library.status === "DISCONNECTED") return 0;

  const decisions = await prisma.organizationSuggestion.findMany({
    orderBy: { reviewedAt: "desc" },
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
  });
  const distinct = new Map<string, typeof decisions[number]>();
  for (const decision of decisions) {
    const key = normalizePhysicalRelativePath(decision.currentRelativePath);
    if (!distinct.has(key)) distinct.set(key, decision);
  }
  const byDestination = new Map<string, { destination: string; decisions: typeof decisions }>();
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
        const leftTerms = contentConcepts(group[left].whySuggested);
        const rightTerms = new Set(contentConcepts(group[right].whySuggested));
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
  const library = await prisma.connectedLibrary.findUnique({
    select: { isEnabled: true, status: true },
    where: { id: input.connectedLibraryId },
  });
  if (!library?.isEnabled || library.status === "DISCONNECTED") return [];
  const preferences = await prisma.organizationPreference.findMany({
    orderBy: { approvedAt: "desc" },
    take: 40,
    where: {
      connectedLibraryId: input.connectedLibraryId,
      disputedAt: null,
      status: "APPROVED",
    },
  });
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
  );
}

export async function disputePreferencesFromDecisions(suggestionIds: string[]) {
  if (suggestionIds.length === 0) return;
  const prisma = getPrismaClient();
  for (let start = 0; start < suggestionIds.length; start += 100) {
    await prisma.organizationPreference.updateMany({
      data: { disputedAt: new Date() },
      where: {
        disputedAt: null,
        status: { in: ["PROPOSED", "DEFERRED", "APPROVED"] },
        OR: suggestionIds.slice(start, start + 100).map((id) => ({ sourceDecisionIds: { array_contains: [id] } })),
      },
    });
  }
}

export async function getOrganizationPreferencePageData() {
  const prisma = getPrismaClient();
  const preferences = await prisma.organizationPreference.findMany({
    orderBy: { updatedAt: "desc" },
    take: 80,
    include: {
      revisions: { orderBy: { createdAt: "desc" }, take: 12 },
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
  const decisionEvents = await prisma.organizationSuggestionDecisionEvent.findMany({
    orderBy: { createdAt: "desc" },
    select: { context: true, suggestionId: true },
    take: Math.min(sourceIds.length * 4, 320),
    where: { suggestionId: { in: sourceIds } },
  });
  const contextBySuggestion = new Map<string, string>();
  for (const event of decisionEvents) {
    if (event.context && !contextBySuggestion.has(event.suggestionId)) {
      contextBySuggestion.set(event.suggestionId, event.context);
    }
  }

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
