import { getPrismaClient } from "@/lib/db/prisma";

import { organizationSuggestionCounts } from "./scan-sessions";
import { currentRecommendationGenerationVersion } from "./recommendation-generation";
import type {
  BridgeScanSessionStatus,
  ConnectedLibraryPlatform,
  ConnectedLibraryStatus,
  OrganizationSuggestionCounts,
} from "./types";

type StatusRecord = {
  status: string;
};

export type OrganizationPlanSelectorSessionInput = {
  id: string;
  startedAt: Date | string;
  completedAt: Date | string | null;
  status: string;
  filesScanned: number;
  organizationSuggestions: StatusRecord[];
};

export type OrganizationPlanSelectorRootInput = {
  id: string;
  displayName: string;
  platform: string;
  status: string;
  isEnabled: boolean;
  scanSessions: OrganizationPlanSelectorSessionInput[];
};

export type OrganizationPlanScanSessionOption = {
  id: string;
  connectedLibraryId: string;
  rootName: string;
  startedAt: string;
  completedAt: string | null;
  status: BridgeScanSessionStatus;
  fileCount: number;
  recommendationCounts: OrganizationSuggestionCounts;
  eligibleForPlanning: boolean;
};

export type OrganizationPlanSelectorRoot = {
  id: string;
  displayName: string;
  platform: ConnectedLibraryPlatform;
  status: ConnectedLibraryStatus;
  isEnabled: boolean;
  completedScanSessions: OrganizationPlanScanSessionOption[];
};

export type OrganizationPlanScanSessionSelectorData = {
  roots: OrganizationPlanSelectorRoot[];
  totalCompletedSessions: number;
  eligibleCompletedSessions: number;
};

const completedScanSessionStatuses = new Set(["COMPLETED", "COMPLETED_WITH_ERRORS"]);

function toIsoString(value: Date | string | null) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}

function scanSessionStatus(value: string): BridgeScanSessionStatus {
  if (
    value === "PENDING" ||
    value === "SCANNING" ||
    value === "READING" ||
    value === "EXAMINING" ||
    value === "GENERATING_SUGGESTIONS" ||
    value === "COMPLETED" ||
    value === "COMPLETED_WITH_ERRORS" ||
    value === "FAILED"
  ) {
    return value;
  }

  return "FAILED";
}

function connectedLibraryPlatform(value: string): ConnectedLibraryPlatform {
  if (
    value === "WINDOWS" ||
    value === "MACOS" ||
    value === "LINUX" ||
    value === "UNKNOWN"
  ) {
    return value;
  }

  return "UNKNOWN";
}

function connectedLibraryStatus(value: string): ConnectedLibraryStatus {
  if (
    value === "CONNECTED" ||
    value === "PAUSED" ||
    value === "NEEDS_ATTENTION" ||
    value === "DISCONNECTED" ||
    value === "MERGED" ||
    value === "HIDDEN_FROM_ACTIVE_LIST"
  ) {
    return value;
  }

  return "NEEDS_ATTENTION";
}

export function buildOrganizationPlanScanSessionSelectorData(
  roots: OrganizationPlanSelectorRootInput[],
): OrganizationPlanScanSessionSelectorData {
  let totalCompletedSessions = 0;
  let eligibleCompletedSessions = 0;

  const selectorRoots = roots.map((root) => {
    const completedScanSessions = root.scanSessions
      .filter((session) => completedScanSessionStatuses.has(session.status))
      .map((session) => {
        const recommendationCounts = organizationSuggestionCounts(
          session.organizationSuggestions,
        );
        const option: OrganizationPlanScanSessionOption = {
          completedAt: toIsoString(session.completedAt),
          connectedLibraryId: root.id,
          eligibleForPlanning: recommendationCounts.eligibleForPlanning > 0,
          fileCount: session.filesScanned,
          id: session.id,
          recommendationCounts,
          rootName: root.displayName,
          startedAt: toIsoString(session.startedAt) ?? new Date(0).toISOString(),
          status: scanSessionStatus(session.status),
        };

        totalCompletedSessions += 1;

        if (option.eligibleForPlanning) {
          eligibleCompletedSessions += 1;
        }

        return option;
      });

    return {
      completedScanSessions,
      displayName: root.displayName,
      id: root.id,
      isEnabled: root.isEnabled,
      platform: connectedLibraryPlatform(root.platform),
      status: connectedLibraryStatus(root.status),
    };
  });

  return {
    eligibleCompletedSessions,
    roots: selectorRoots,
    totalCompletedSessions,
  };
}

export async function getOrganizationPlanScanSessionSelectorData(): Promise<OrganizationPlanScanSessionSelectorData> {
  const prisma = getPrismaClient();
  const connectedLibraries = await prisma.connectedLibrary.findMany({
    orderBy: [{ displayName: "asc" }],
    select: {
      displayName: true,
      id: true,
      isEnabled: true,
      platform: true,
      scanSessions: {
        orderBy: {
          startedAt: "desc",
        },
        select: {
          completedAt: true,
          filesScanned: true,
          id: true,
          organizationSuggestions: {
            select: {
              status: true,
            },
            where: {
              invalidatedAt: null,
              recommendationGenerationVersion: currentRecommendationGenerationVersion,
            },
          },
          startedAt: true,
          status: true,
        },
        where: {
          status: {
            in: ["COMPLETED", "COMPLETED_WITH_ERRORS"],
          },
        },
      },
      status: true,
    },
    where: {
      hiddenFromActiveListAt: null,
      mergedAt: null,
      status: {
        notIn: ["MERGED", "HIDDEN_FROM_ACTIVE_LIST"],
      },
    },
  });

  return buildOrganizationPlanScanSessionSelectorData(connectedLibraries);
}
