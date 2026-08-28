import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  buildOrganizationPlanScanSessionSelectorData,
  type OrganizationPlanSelectorRootInput,
} from "../../src/lib/bridge/organization-plan-selector";
import {
  getOrganizationPlanRoute,
  getOrganizationPlanSessionSelectorRoute,
  getRecommendationsRoute,
  getScanSessionRoute,
} from "../../src/lib/library/routes";

function root(
  id: string,
  displayName: string,
  scanSessions: OrganizationPlanSelectorRootInput["scanSessions"],
): OrganizationPlanSelectorRootInput {
  return {
    displayName,
    id,
    isEnabled: true,
    platform: "MACOS",
    scanSessions,
    status: "CONNECTED",
  };
}

function session(
  id: string,
  statuses: string[],
  overrides: Partial<OrganizationPlanSelectorRootInput["scanSessions"][number]> = {},
): OrganizationPlanSelectorRootInput["scanSessions"][number] {
  return {
    completedAt: "2026-08-28T10:15:00.000Z",
    filesScanned: 12,
    id,
    organizationSuggestions: statuses.map((status) => ({ status })),
    startedAt: "2026-08-28T10:00:00.000Z",
    status: "COMPLETED",
    ...overrides,
  };
}

describe("Organization Plan navigation workflow", () => {
  it("exposes a clickable scan-session selector from Organization Plans", () => {
    const migrationSource = readFileSync(
      "src/app/admin/library/migration/page.tsx",
      "utf8",
    );
    const selectorSource = readFileSync(
      "src/app/admin/library/migration/scan-sessions/page.tsx",
      "utf8",
    );

    assert.equal(
      getOrganizationPlanSessionSelectorRoute(),
      "/admin/library/migration/scan-sessions",
    );
    assert.match(migrationSource, /getOrganizationPlanSessionSelectorRoute/);
    assert.match(migrationSource, /Choose a Scan Session to Build a Plan/);
    assert.doesNotMatch(migrationSource, /disabled/);
    assert.match(selectorSource, /getOrganizationPlanRoute\(session\.id\)/);
    assert.match(selectorSource, /aria-labelledby/);
  });

  it("keeps two connected roots and their completed scan sessions separate", () => {
    const data = buildOrganizationPlanScanSessionSelectorData([
      root("root-a", "SCAN_ROOT_A_GENERAL_INBOX", [
        session("session-a-completed", [
          "PENDING",
          "APPROVED",
          "MODIFIED",
          "REJECTED",
        ]),
        session("session-a-active", ["APPROVED"], { status: "SCANNING" }),
      ]),
      root("root-b", "SCAN_ROOT_B_WEBSITE_AND_MEDIA", [
        session("session-b-completed", []),
      ]),
    ]);

    assert.equal(data.roots.length, 2);
    assert.equal(data.totalCompletedSessions, 2);
    assert.equal(data.eligibleCompletedSessions, 1);
    assert.deepEqual(
      data.roots.map((item) => item.displayName),
      ["SCAN_ROOT_A_GENERAL_INBOX", "SCAN_ROOT_B_WEBSITE_AND_MEDIA"],
    );

    const rootA = data.roots[0];
    const rootB = data.roots[1];

    assert.equal(rootA.completedScanSessions.length, 1);
    assert.equal(rootB.completedScanSessions.length, 1);
    assert.equal(rootA.completedScanSessions[0]?.connectedLibraryId, "root-a");
    assert.equal(rootB.completedScanSessions[0]?.connectedLibraryId, "root-b");
    assert.notEqual(
      getOrganizationPlanRoute(rootA.completedScanSessions[0]?.id ?? ""),
      getOrganizationPlanRoute(rootB.completedScanSessions[0]?.id ?? ""),
    );
  });

  it("shows pending recommendations without marking them eligible for a plan", () => {
    const data = buildOrganizationPlanScanSessionSelectorData([
      root("root-a", "SCAN_ROOT_A_GENERAL_INBOX", [
        session("session-a-pending", ["PENDING", "PENDING"]),
      ]),
    ]);
    const option = data.roots[0]?.completedScanSessions[0];

    assert.ok(option);
    assert.equal(option.recommendationCounts.pending, 2);
    assert.equal(option.recommendationCounts.eligibleForPlanning, 0);
    assert.equal(option.eligibleForPlanning, false);
  });

  it("makes approved and edited recommendations eligible but excludes rejected ones", () => {
    const data = buildOrganizationPlanScanSessionSelectorData([
      root("root-a", "SCAN_ROOT_A_GENERAL_INBOX", [
        session("session-a-reviewed", [
          "APPROVED",
          "MODIFIED",
          "REJECTED",
          "LEFT_UNCHANGED",
        ]),
      ]),
    ]);
    const option = data.roots[0]?.completedScanSessions[0];

    assert.ok(option);
    assert.equal(option.recommendationCounts.approved, 1);
    assert.equal(option.recommendationCounts.modified, 1);
    assert.equal(option.recommendationCounts.rejected, 1);
    assert.equal(option.recommendationCounts.leftUnchanged, 1);
    assert.equal(option.recommendationCounts.eligibleForPlanning, 2);
    assert.equal(option.eligibleForPlanning, true);
  });

  it("keeps empty recommendation sessions honest and recoverable", () => {
    const data = buildOrganizationPlanScanSessionSelectorData([
      root("root-a", "SCAN_ROOT_A_GENERAL_INBOX", [
        session("session-a-empty", []),
      ]),
    ]);
    const option = data.roots[0]?.completedScanSessions[0];
    const planPageSource = readFileSync(
      "src/app/admin/library/scan-sessions/[sessionId]/organization-plan/page.tsx",
      "utf8",
    );
    const recommendationsPageSource = readFileSync(
      "src/app/admin/library/scan-sessions/[sessionId]/recommendations/page.tsx",
      "utf8",
    );

    assert.ok(option);
    assert.equal(option.recommendationCounts.total, 0);
    assert.equal(option.eligibleForPlanning, false);
    assert.match(
      planPageSource,
      /This scan session has no organization recommendations yet/,
    );
    assert.match(
      recommendationsPageSource,
      /Generate Recommendations for This Scan/,
    );
  });

  it("routes review and planning through the selected scan session", () => {
    const scanSessionId = "session-a-completed";
    const planPageSource = readFileSync(
      "src/app/admin/library/scan-sessions/[sessionId]/organization-plan/page.tsx",
      "utf8",
    );
    const recommendationsPageSource = readFileSync(
      "src/app/admin/library/scan-sessions/[sessionId]/recommendations/page.tsx",
      "utf8",
    );

    assert.equal(
      getRecommendationsRoute(scanSessionId),
      "/admin/library/scan-sessions/session-a-completed/recommendations",
    );
    assert.equal(
      getScanSessionRoute(scanSessionId),
      "/admin/library/scan-sessions/session-a-completed",
    );
    assert.match(planPageSource, /getRecommendationsRoute\(session\.id\)/);
    assert.match(recommendationsPageSource, /getScanSessionRoute\(data\.session\.id\)/);
    assert.match(
      recommendationsPageSource,
      /This page is limited to this selected root\s+and this selected scan session/,
    );
    assert.match(recommendationsPageSource, /Build Organization Plan/);
    assert.match(
      recommendationsPageSource,
      /Approve or edit at least one recommendation/,
    );
  });

  it("keeps selector and recommendation browsing read-only and path-safe", () => {
    const source = [
      readFileSync("src/lib/bridge/organization-plan-selector.ts", "utf8"),
      readFileSync("src/app/admin/library/migration/page.tsx", "utf8"),
      readFileSync("src/app/admin/library/migration/scan-sessions/page.tsx", "utf8"),
      readFileSync(
        "src/app/admin/library/scan-sessions/[sessionId]/recommendations/page.tsx",
        "utf8",
      ),
      readFileSync(
        "src/app/admin/library/scan-sessions/[sessionId]/organization-plan/page.tsx",
        "utf8",
      ),
    ].join("\n");

    assert.doesNotMatch(source, /\blocalPath\b/);
    assert.doesNotMatch(source, /\b(unlink|rename|writeFile|mkdir|rm)\s*\(/);
    assert.match(source, /\[overflow-wrap:anywhere\]/);
    assert.match(source, /min-w-0/);
  });
});
