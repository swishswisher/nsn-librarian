import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildScanWorkingKnowledge,
  workingKnowledgeTerms,
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
  assert.ok(forward.clusters[0]?.sharedTerms.includes("finance"));
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

test("different finance terms reinforce a cluster through semantic normalization", () => {
  const result = buildScanWorkingKnowledge({
    files: [
      file("invoice", "Loose/alpha.dat", "Invoice issued for office supplies."),
      file("payment", "Loose/beta.dat", "Payment received for office supplies."),
      file("expense", "Loose/gamma.dat", "Monthly expenses for office supplies."),
    ],
    scanSessionId: "scan-finance-normalization",
  });

  assert.equal(result.clusters.length, 1);
  assert.deepEqual(result.clusters[0]?.memberFileIds, [
    "invoice",
    "payment",
    "expense",
  ]);
  assert.ok(result.clusters[0]?.semanticTopics.includes("operations-finance"));
  assert.ok(
    result.clusters[0]?.sharedSubjects.includes("finance and office operations"),
  );
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

test("normalization removes generic observer language before clustering", () => {
  assert.deepEqual(
    workingKnowledgeTerms(
      "This document is a cautious provisional observation. The assistant suggests possible related material.",
    ),
    [],
  );
  assert.deepEqual(workingKnowledgeTerms("Invoice payment expenses"), [
    "invoic",
    "payment",
    "expens",
  ]);
});

test("generic observer boilerplate does not create an edge", () => {
  const makeBoilerplateFile = (id: string, relativePath: string) =>
    file(
      id,
      relativePath,
      "Sparse unrelated material.",
      "This document is a cautious provisional observation. The Librarian suggests possible related material.",
    );
  const result = buildScanWorkingKnowledge({
    files: [
      makeBoilerplateFile("one", "Loose/one.txt"),
      makeBoilerplateFile("two", "Loose/two.txt"),
    ],
    scanSessionId: "scan-boilerplate",
  });

  assert.equal(result.relationships.length, 0);
  assert.equal(result.clusters.length, 0);
});

test("production-shaped mixed scans keep meaningful clusters separate", () => {
  const boilerplate =
    "This document is a cautious provisional observation. The Librarian suggests possible related material. The working subject may be useful, but human review is required.";
  const productionFile = (
    id: string,
    relativePath: string,
    previewText: string,
    observationText: string,
    interpretationText: string,
  ): ScanWorkingKnowledgeInputFile => ({
    connectedLibraryId: "root-a",
    fileType: "TEXT",
    id,
    observationSessions: [
      {
        explanation: {
          summary: `${boilerplate} ${observationText}`,
          uncertainty: "This is provisional and requires human review.",
        },
        interpretations: [
          {
            description: interpretationText,
            label: "POSSIBLE_TOPIC_SIGNAL",
          },
        ],
        observations: [
          {
            description: observationText,
            evidence: [previewText],
          },
        ],
        observerType: "OPENAI",
        status: "AWAITING_REVIEW",
      },
    ],
    previewText,
    relativePath,
  });
  const files = [
    productionFile(
      "invoice",
      "Operations_Mess/invoice.final.v3.pdf",
      "Invoice DA-TEST-1042 for website consultation and workflow planning.",
      "The file concerns an invoice for administrative services.",
      "It may belong with office finance and payment records.",
    ),
    productionFile(
      "payments",
      "Operations_Mess/Payment_Notes.md",
      "Payment notes for website hosting, design consultation, and office supplies.",
      "The file lists payment and office supply records.",
      "It may belong with finance and operational payment material.",
    ),
    productionFile(
      "expenses",
      "Operations_Mess/August_Office_Expenses.pdf",
      "August office expenses for printer paper and an office plant.",
      "The file records office expenses and finance categorization.",
      "It may belong with expense and payment records.",
    ),
    productionFile(
      "proposal",
      "Workshops_Unsorted/Workshop_Proposal.pdf",
      "Workshop proposal for boundaries and communication practice.",
      "The file outlines a boundaries communication workshop.",
      "It may belong with workshop facilitation material.",
    ),
    productionFile(
      "outline",
      "Workshops_Unsorted/Boundaries_Workshop_Outline.docx",
      "Boundaries and communication workshop outline for adults.",
      "The file describes workshop exercises for healthy boundaries.",
      "It may belong with workshop and facilitation material.",
    ),
    ...[
      ["research", "Research/source-notes.txt", "Research citations about coastal ecology."],
      ["garden", "Personal/garden-log.txt", "Seed germination dates and soil moisture."],
      ["photo", "Images/family-photo.jpg", "A family photograph from a holiday."],
      ["audio", "Audio/interview.m4a", "Interview recording about a community project."],
      ["video", "Video/ceramic-demo.mp4", "Video demonstration of ceramic restoration."],
      ["recipe", "Personal/recipe.txt", "Recipe for vegetable soup and bread."],
      ["travel", "Travel/packing-list.md", "Packing list for a coastal holiday."],
      ["legal", "Archive/lease-summary.txt", "Lease renewal dates and property terms."],
      ["health", "Private/appointment-note.txt", "Appointment schedule and private reminders."],
      ["code", "Projects/test-fixture.txt", "Path handling fixture for local development."],
      ["art", "Images/ceramic-glaze.png", "Colour palette for a ceramic glaze."],
      ["music", "Audio/piano-recital.m4a", "Piano recital recording from the evening."],
      ["school", "Archive/history-reading.txt", "History reading list about early cities."],
      ["inventory", "Operations_Mess/office-inventory.csv", "Inventory of desks and storage boxes."],
      ["garden-two", "Personal/compost-notes.txt", "Compost temperature observations."],
      ["archive", "Archive/old-correspondence.txt", "Correspondence about a community event."],
    ].map(([id, relativePath, previewText]) =>
      productionFile(
        id,
        relativePath,
        previewText,
        `The file contains ${previewText.toLowerCase()}`,
        "The material may have a distinct subject for later review.",
      ),
    ),
  ];
  const result = buildScanWorkingKnowledge({
    files,
    scanSessionId: "scan-production-shaped",
  });
  const reverse = buildScanWorkingKnowledge({
    files: [...files].reverse(),
    scanSessionId: "scan-production-shaped",
  });

  assert.equal(files.length, 21);
  assert.equal(result.clusters.length, 2);
  assert.deepEqual(
    result.clusters.map((cluster) => cluster.memberFileIds),
    [
      ["expenses", "invoice", "payments"],
      ["outline", "proposal"],
    ],
  );
  assert.ok(result.clusters[0]?.sharedTerms.includes("finance"));
  assert.ok(result.clusters[1]?.sharedTerms.includes("workshop"));
  assert.ok(
    result.clusters.every((cluster) =>
      cluster.sharedTerms.every(
        (term) => !["docu", "assistanc", "cautiou", "observ", "suggest"].includes(term),
      ),
    ),
  );
  assert.deepEqual(reverse, result);
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

test("v6 is current and v5 cannot masquerade as the active generation", () => {
  assert.equal(
    currentRecommendationGenerationVersion,
    "organization-recommendations-v6",
  );
  assert.equal(
    isCurrentRecommendationGeneration("organization-recommendations-v6"),
    true,
  );
  assert.equal(
    isCurrentRecommendationGeneration("organization-recommendations-v5"),
    false,
  );
});
