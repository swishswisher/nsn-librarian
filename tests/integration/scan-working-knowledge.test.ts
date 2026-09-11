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
    productionFile(
      "large-notes",
      "Mixed_Loose/large-notes-200kb.txt",
      "A long collection of generic notes about weather, travel, and household tasks.",
      "The Librarian may compare this with workshop material as part of a broad review.",
      "AI assistance suggests workshop review, but provides no file-specific workshop evidence.",
    ),
    productionFile(
      "resume",
      "Mixed_Loose/Résumé - Café Notes.txt",
      "Résumé notes about café work experience and menu planning.",
      "The Librarian may compare this with workshop material as part of a broad review.",
      "AI assistance suggests workshop review, but provides no file-specific workshop evidence.",
    ),
    productionFile(
      "watch-created",
      "Mixed_Loose/WATCH_CREATED_AFTER_CONNECT.txt",
      "A watcher fixture created after a connected folder was registered.",
      "The Librarian may compare this with workshop material as part of a broad review.",
      "AI assistance suggests workshop review, but provides no file-specific workshop evidence.",
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
      [
        "client",
        "Clients/Loose/client-intake.docx",
        "Client intake form about personal boundaries and appointment details.",
      ],
      [
        "boundary-notes",
        "Mixed/boundary-notes.txt",
        "General notes about boundaries and personal reflections.",
      ],
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
  const workshopOnly = buildScanWorkingKnowledge({
    files: files.filter((file) => ["outline", "proposal"].includes(file.id)),
    scanSessionId: "scan-production-shaped-workshops-only",
  });

  assert.equal(files.length, 24);
  const financeCluster = result.clusters.find((cluster) =>
    cluster.semanticTopics.includes("operations-finance"),
  );
  const workshopCluster = result.clusters.find((cluster) =>
    cluster.semanticTopics.includes("workshops"),
  );
  assert.deepEqual(financeCluster?.memberFileIds, [
    "expenses",
    "invoice",
    "payments",
  ]);
  assert.deepEqual(workshopCluster?.memberFileIds, ["outline", "proposal"]);
  assert.equal(
    workshopCluster?.confidence,
    workshopOnly.clusters.find((cluster) =>
      cluster.semanticTopics.includes("workshops"),
    )?.confidence,
  );
  assert.ok(financeCluster?.sharedTerms.includes("finance"));
  assert.ok(workshopCluster?.sharedTerms.includes("workshop"));
  assert.equal(
    result.clusters.some((cluster) =>
      ["client", "boundary-notes"].some((id) =>
        cluster.memberFileIds.includes(id),
      ),
    ),
    false,
  );
  assert.ok(
    ["large-notes", "resume", "watch-created"].every(
      (id) => !workshopCluster?.memberFileIds.includes(id),
    ),
  );
  assert.ok(result.clusters.every((cluster) => cluster.semanticTopics.length === 1));
  assert.ok(
    result.clusters.every((cluster) =>
      cluster.sharedTerms.every(
        (term) => !["docu", "assistanc", "cautiou", "observ", "suggest"].includes(term),
      ),
    ),
  );
  const boundaryRelation = result.relationships.find(
    (relationship) =>
      relationship.leftFileId === "client" &&
      relationship.rightFileId === "proposal",
  );
  assert.ok(boundaryRelation?.sharedTopics.includes("workshops"));
  assert.equal(boundaryRelation?.supportingTopics.includes("workshops"), false);
  assert.deepEqual(reverse, result);
});

test("a multi-subject bridge cannot leak one subject into another cluster", () => {
  const result = buildScanWorkingKnowledge({
    files: [
      file("finance-a", "Loose/invoice.txt", "Invoice planning."),
      file("finance-b", "Loose/expenses.txt", "Payment planning."),
      file(
        "bridge",
        "Loose/bridge.txt",
        "Expense planning workshop facilitation training.",
      ),
      file("workshop-a", "Loose/workshop.txt", "Workshop facilitation training."),
      file("workshop-b", "Loose/facilitation.txt", "Workshop facilitation training."),
    ],
    scanSessionId: "scan-subject-bridge",
  });
  assert.ok(
    result.clusters.some(
      (cluster) =>
        cluster.semanticTopics.length === 1 &&
        cluster.semanticTopics.includes("operations-finance") &&
        cluster.memberFileIds.includes("finance-a") &&
        cluster.memberFileIds.includes("finance-b"),
    ),
  );
  assert.ok(
    result.clusters.some(
      (cluster) =>
        cluster.semanticTopics.length === 1 &&
        cluster.semanticTopics.includes("workshops") &&
        cluster.memberFileIds.includes("workshop-a") &&
        cluster.memberFileIds.includes("workshop-b"),
    ),
  );
  assert.ok(result.clusters.every((cluster) => cluster.semanticTopics.length === 1));
});

test("cluster confidence reflects relationship strength rather than member count", () => {
  const files = [
    file("one", "Loose/one.txt", "Invoice payment expense."),
    file("two", "Loose/two.txt", "Invoice payment expense."),
  ];
  const twoFileResult = buildScanWorkingKnowledge({
    files,
    scanSessionId: "scan-confidence-two",
  });
  const threeFileResult = buildScanWorkingKnowledge({
    files: [...files, file("three", "Loose/three.txt", "Invoice payment expense.")],
    scanSessionId: "scan-confidence-three",
  });
  const twoFileCluster = twoFileResult.clusters.find((cluster) =>
    cluster.semanticTopics.includes("operations-finance"),
  );
  const threeFileCluster = threeFileResult.clusters.find((cluster) =>
    cluster.semanticTopics.includes("operations-finance"),
  );

  assert.equal(twoFileCluster?.confidence, threeFileCluster?.confidence);
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

test("v10 is current and v9 cannot masquerade as the active generation", () => {
  assert.equal(
    currentRecommendationGenerationVersion,
    "organization-recommendations-v10",
  );
  assert.equal(
    isCurrentRecommendationGeneration("organization-recommendations-v10"),
    true,
  );
  assert.equal(
    isCurrentRecommendationGeneration("organization-recommendations-v9"),
    false,
  );
});
