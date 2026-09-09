import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildScanWorkingKnowledge,
  type ScanWorkingKnowledgeInputFile,
} from "../../src/lib/bridge/scan-working-knowledge";
import {
  currentRecommendationGenerationVersion,
  isCurrentRecommendationGeneration,
} from "../../src/lib/bridge/recommendation-generation";

function observation(
  status: "AWAITING_REVIEW" | "APPROVED" | "MODIFIED",
  summary: string,
) {
  return {
    explanation: { summary },
    interpretations: [
      {
        description: summary,
        label: "POSSIBLE_TOPIC_SIGNAL",
      },
    ],
    observations: [{ description: summary, evidence: [summary] }],
    observerType: "OPENAI",
    status,
  };
}

function file(
  id: string,
  relativePath: string,
  previewText: string,
  summary?: string,
): ScanWorkingKnowledgeInputFile {
  return {
    connectedLibraryId: "root-a",
    fileType: "TEXT",
    id,
    observationSessions: summary
      ? [observation("AWAITING_REVIEW", summary)]
      : [],
    previewText,
    relativePath,
  };
}

test("provisional observations form deterministic scan-wide semantic clusters", () => {
  const files = [
    file(
      "expenses",
      "Loose/a.pdf",
      "Office expenses and web hosting renewal.",
      "Financial operations covering expenses and payments.",
    ),
    file(
      "invoice",
      "Loose/b.pdf",
      "Invoice for an administrative consultation.",
      "Financial operations covering invoices and payments.",
    ),
    file(
      "payments",
      "Loose/c.md",
      "Payment notes for office supplies.",
      "Financial operations covering payments and expenses.",
    ),
  ];
  const forward = buildScanWorkingKnowledge({
    files,
    scanSessionId: "scan-a",
  });
  const reverse = buildScanWorkingKnowledge({
    files: [...files].reverse(),
    scanSessionId: "scan-a",
  });

  assert.equal(forward.clusters.length, 1);
  assert.deepEqual(forward.clusters[0]?.memberFileIds, [
    "expenses",
    "invoice",
    "payments",
  ]);
  assert.ok(forward.clusters[0]?.sharedTerms.includes("financial"));
  assert.ok(
    forward.relationships.every((relationship) =>
      relationship.evidenceKinds.includes("PROVISIONAL_OBSERVATION"),
    ),
  );
  assert.deepEqual(reverse, forward);
});

test("unrelated material remains outside an otherwise coherent semantic cluster", () => {
  const result = buildScanWorkingKnowledge({
    files: [
      file(
        "invoice",
        "Loose/first.bin",
        "Invoice for office supplies.",
        "Financial operations covering invoices and payments.",
      ),
      file(
        "expenses",
        "Loose/second.bin",
        "Expense record for office supplies.",
        "Financial operations covering expenses and payments.",
      ),
      file(
        "garden",
        "Loose/third.bin",
        "Seed germination dates and soil moisture notes.",
        "Gardening observations about tomato seedlings and compost.",
      ),
    ],
    scanSessionId: "scan-unrelated",
  });

  assert.equal(result.clusters.length, 1);
  assert.deepEqual(result.clusters[0]?.memberFileIds, ["invoice", "expenses"]);
  assert.ok(
    result.relationships.every(
      (relationship) =>
        relationship.leftFileId !== "garden" &&
        relationship.rightFileId !== "garden",
    ),
  );
});

test("workshop files cluster from content and provisional meaning, not filenames", () => {
  const result = buildScanWorkingKnowledge({
    files: [
      file(
        "agenda",
        "Loose/alpha.dat",
        "Facilitation agenda for a participant training session.",
        "Workshop curriculum concerning boundaries and group facilitation.",
      ),
      file(
        "outline",
        "Loose/beta.dat",
        "Participant exercises and group training notes.",
        "Workshop curriculum concerning orientation and group facilitation.",
      ),
    ],
    scanSessionId: "scan-workshop",
  });

  assert.equal(result.clusters.length, 1);
  assert.deepEqual(result.clusters[0]?.memberFileIds, ["agenda", "outline"]);
  assert.ok(result.clusters[0]?.sharedTerms.includes("workshop"));
});

test("trusted observations remain distinct and receive stronger relationship weight", () => {
  const provisionalFiles = [
    file("left", "Loose/left.txt", "Sparse note.", "Workshop facilitation"),
    file("right", "Loose/right.txt", "Sparse note.", "Workshop facilitation"),
  ];
  const trustedFiles = provisionalFiles.map((item) => ({
    ...item,
    observationSessions: item.observationSessions.map((session) => ({
      ...session,
      status: "APPROVED",
    })),
  }));
  const provisional = buildScanWorkingKnowledge({
    files: provisionalFiles,
    scanSessionId: "scan-provisional",
  });
  const trusted = buildScanWorkingKnowledge({
    files: trustedFiles,
    scanSessionId: "scan-trusted",
  });

  assert.ok(provisional.files[0]?.provisionalWorkingEvidence.length);
  assert.equal(provisional.files[0]?.trustedObservationEvidence.length, 0);
  assert.ok(trusted.files[0]?.trustedObservationEvidence.length);
  assert.equal(trusted.files[0]?.provisionalWorkingEvidence.length, 0);
  assert.ok(
    (trusted.relationships[0]?.confidence ?? 0) >
      (provisional.relationships[0]?.confidence ?? 0),
  );
});

test("filename overlap alone cannot create semantic relationships", () => {
  const result = buildScanWorkingKnowledge({
    files: [
      file("one", "Loose/project-copy-one.txt", "Blue sky."),
      file("two", "Archive/project-copy-two.txt", "Kitchen chair."),
    ],
    scanSessionId: "scan-filenames",
  });

  assert.equal(result.relationships.length, 0);
  assert.equal(result.clusters.length, 0);
});

test("sparse technical fixtures remain outside semantic clusters", () => {
  const result = buildScanWorkingKnowledge({
    files: [
      file("uppercase", "Loose/UPPERCASE.PDF", "PDF casing test."),
      file("long", "Loose/a-very-long-file-name.txt", "Path handling test."),
    ],
    scanSessionId: "scan-sparse",
  });

  assert.equal(result.relationships.length, 0);
  assert.equal(result.clusters.length, 0);
});

test("v5 is current and v4 cannot masquerade as the active generation", () => {
  assert.equal(
    currentRecommendationGenerationVersion,
    "organization-recommendations-v5",
  );
  assert.equal(
    isCurrentRecommendationGeneration("organization-recommendations-v5"),
    true,
  );
  assert.equal(
    isCurrentRecommendationGeneration("organization-recommendations-v4"),
    false,
  );
});
