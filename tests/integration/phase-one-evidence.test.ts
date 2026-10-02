import assert from "node:assert/strict";
import { test } from "node:test";

import {
  groundObservationResult,
  groundedEvidence,
  sampleDocumentText,
  verifiedSourceText,
  verifiedSourceExcerpts,
} from "../../src/lib/ai/source-evidence";
import { boundedSourceExcerpts } from "../../src/lib/library/search-index";
import { extractDocumentSignals } from "../../src/lib/bridge/document-signals";
import { buildScanWorkingKnowledge } from "../../src/lib/bridge/scan-working-knowledge";
import { sourceLocationsForRecommendation } from "../../src/lib/bridge/organization-suggestions";

for (const quote of ["Invoice payment records", "Invoice payment\nOffice expense", 'Invoice "payment" records', 'Invoice "payment"\nOffice expense']) {
  test(`verified evidence round-trips exact text: ${JSON.stringify(quote)}`, () => {
    const source = `Preamble. ${quote} End.`;
    const stored = groundedEvidence(quote, source)!;
    const excerpts = [{ start: 10, end: 10 + quote.length, text: quote }];
    assert.equal(verifiedSourceText(stored), quote);
    assert.deepEqual(verifiedSourceExcerpts(stored), excerpts);
    assert.deepEqual(boundedSourceExcerpts(stored), excerpts);
    assert.equal(source.slice(excerpts[0].start, excerpts[0].end), quote);
    assert.equal(sourceLocationsForRecommendation(stored, ["payment"]).length, 1);
    const legacy = `Source characters 10-${10 + quote.length}: "${quote}"`;
    assert.deepEqual(verifiedSourceExcerpts(legacy), excerpts);
    assert.equal(verifiedSourceText(legacy), quote);
  });
}

test("encoded multiline identity evidence retains document signals and exact source ranges", () => {
  const quote = 'Client: Alice Smith\nClient ID: C-001\nProject: North "Star"\nProject ID: P-001';
  const source = `   ${quote}`;
  const stored = groundedEvidence(quote, source)!;
  const signals = extractDocumentSignals(stored, "synthetic-root");
  assert.ok(signals.some((signal) => signal.kind === "CLIENT"));
  assert.ok(signals.some((signal) => signal.kind === "PROJECT"));
  for (const signal of signals) {
    assert.ok(signal.sourceRanges.every((range) => source.slice(range.start, range.end) === quote));
  }
  assert.deepEqual(extractDocumentSignals(`Source characters 3-${3 + quote.length}: "${quote}"`, "synthetic-root"), signals);
});

test("invalid ranges and unverified trailing claims cannot become verified evidence", () => {
  assert.deepEqual(verifiedSourceExcerpts('Source characters 10-12: "invoice payment"'), []);
  assert.deepEqual(verifiedSourceExcerpts('Source characters 99-4: "invoice payment"'), []);
  assert.equal(verifiedSourceText('Source characters 0-15: "invoice payment" extra claim'), null);
  assert.deepEqual(verifiedSourceExcerpts(`Source characters 0-241: "${"x".repeat(241)}"`), []);
});

test("bounded observation samples reach beyond the old prefix limit", () => {
  const source = `${"Routine introduction. ".repeat(7_000)}Workshop facilitation schedule and seminar materials.`;
  const sample = sampleDocumentText(source, 120_000);

  assert.equal(sample.partial, true);
  assert.ok(sample.text.length <= 120_000);
  assert.match(sample.text, /Workshop facilitation schedule/);
  assert.ok(sample.text.includes("Source characters"));
  assert.ok(!source.slice(0, 120_000).includes("Workshop facilitation schedule"));
});

test("a small transient evidence budget can sample the end without retaining full text", () => {
  const source = `${"Routine introduction. ".repeat(1_000)}Invoice and payment records belong in Finance.`;
  const sample = sampleDocumentText(source, 2_000);

  assert.ok(sample.text.length <= 2_000);
  assert.match(sample.text, /Invoice and payment records/);
  assert.ok(!source.slice(0, 2_000).includes("Invoice and payment records"));
});

test("bounded sampling selects distinct subjects from separate regions and marks oversized sources partial", () => {
  const source = [
    "Routine introduction. ".repeat(1_000),
    "Workshop facilitation agenda for participants and seminar leaders.",
    "Routine introduction. ".repeat(1_000),
    "Invoice payment accounting expense record for the office.",
    "Routine introduction. ".repeat(1_000),
  ].join("\n");
  const sample = sampleDocumentText(source, 2_000);

  assert.match(sample.text, /Workshop facilitation agenda/);
  assert.match(sample.text, /Invoice payment accounting/);
  assert.ok(sample.text.length <= 2_000);
  assert.equal(sampleDocumentText("a".repeat(2_000_001), 120_000).partial, true);
});

test("purported source evidence must match the original text", () => {
  const source = "The workshop outline includes facilitation exercises.";
  const evidence = groundedEvidence("facilitation exercises", source);

  assert.equal(evidence, "Source characters 30-52: \"facilitation exercises\"");
  assert.equal(verifiedSourceText(evidence ?? ""), "facilitation exercises");
  assert.equal(groundedEvidence("this file contains a diagnosis", source), null);
});

test("source locations preserve leading whitespace offsets in extracted text", () => {
  assert.equal(
    groundedEvidence("facilitation exercises", "\n  facilitation exercises"),
    'Source characters 3-25: "facilitation exercises"',
  );
});

test("recommendation provenance names only matching source locations without copying excerpts", () => {
  const locations = sourceLocationsForRecommendation(
    'Source characters 10-25: "invoice payment" Source characters 80-97: "workshop planning"',
    ["invoice", "payment"],
  );

  assert.deepEqual(locations, ["Source location: characters 10-25 of extracted text."]);
  assert.ok(!locations[0].includes("invoice payment"));
});

test("unmatched model claims are removed before an observation can influence recommendations", () => {
  const result = groundObservationResult({
    provider: "openai",
    model: "test-only",
    observations: [
      { text: "A workshop", evidence: ["Workshop facilitation notes"], whyItMatters: "Review", confidence: 0.8, uncertainty: "Possible" },
      { text: "A diagnosis", evidence: ["This document diagnoses a client"], whyItMatters: "Review", confidence: 0.9, uncertainty: "Possible" },
    ],
    possibleThemes: [{ name: "diagnosis", reason: "model guess", evidence: ["This document diagnoses a client"], confidence: 0.9, uncertainty: "Possible" }],
    possibleRelationships: [],
    questions: [],
    confidence: 0.8,
    uncertainty: "Possible",
    warnings: [],
  }, "Workshop facilitation notes");

  assert.equal(result.observations.length, 1);
  assert.equal(result.possibleThemes.length, 0);
  assert.match(result.observations[0].evidence[0], /Source characters 0-27/);
  assert.ok(result.warnings.some((warning) => warning.includes("could not be matched")));
});

test("unsupported provisional AI claims do not become destination support", () => {
  const knowledge = buildScanWorkingKnowledge({
    scanSessionId: "scan-a",
    files: [
      {
        connectedLibraryId: "root-a",
        fileType: "TEXT",
        id: "one",
        relativePath: "Loose/one.txt",
        previewText: "Meeting notes.",
        observationSessions: [{
          observerType: "OPENAI",
          status: "AWAITING_REVIEW",
          observations: [{ description: "A workshop proposal", evidence: ["Source characters 0-13: \"Meeting notes\""] }],
          interpretations: [],
          explanation: { summary: "This is a workshop." },
        }],
      },
      {
        connectedLibraryId: "root-a",
        fileType: "TEXT",
        id: "two",
        relativePath: "Loose/two.txt",
        previewText: "Meeting notes.",
        observationSessions: [],
      },
    ],
  });

  assert.equal(knowledge.files[0]?.supportingTopics.includes("workshops"), false);
  assert.equal(knowledge.relationships.some((item) => item.supportingTopics.includes("workshops")), false);
});

test("AI prose without verified evidence cannot become destination support", () => {
  const knowledge = buildScanWorkingKnowledge({
    scanSessionId: "scan-unverified",
    files: [{
      connectedLibraryId: "root-a",
      fileType: "TEXT",
      id: "unverified",
      relativePath: "Loose/meeting.txt",
      previewText: "Meeting notes.",
      observationSessions: [{
        observerType: "OPENAI",
        status: "AWAITING_REVIEW",
        observations: [{
          description: 'Source characters 0-8: "workshop"',
          evidence: ["unsupported workshop claim"],
        }],
        interpretations: [{ description: "Workshop facilitation agenda" }],
        explanation: { summary: "This is a workshop." },
      }],
    }],
  });

  assert.equal(knowledge.files[0]?.sourceEvidenceText, "");
  assert.equal(knowledge.files[0]?.supportingTopics.includes("workshops"), false);
  assert.equal(knowledge.files[0]?.provisionalWorkingEvidence.length, 0);
});

test("a human-modified observation replaces superseded AI subject evidence", () => {
  const knowledge = buildScanWorkingKnowledge({
    scanSessionId: "scan-correction",
    files: [{
      connectedLibraryId: "root-a",
      fileType: "TEXT",
      id: "corrected",
      relativePath: "Loose/corrected.txt",
      previewText: "Sparse notes.",
      observationSessions: [{
        observerType: "OPENAI",
        status: "MODIFIED",
        observations: [{ description: "A workshop facilitation guide", evidence: ["workshop facilitation"] }],
        interpretations: [],
        explanation: { summary: "Workshop material" },
        humanDecisions: [{ decisionType: "MODIFY", editedSuggestion: "Invoice payment accounting record" }],
      }],
    }],
  });

  assert.equal(knowledge.files[0]?.supportingTopics.includes("workshops"), false);
  assert.equal(knowledge.files[0]?.trustedObservationEvidence.includes("Invoice payment accounting record"), true);
  assert.equal(knowledge.files[0]?.trustedObservationEvidence.some((item) => item.includes("workshop")), false);
});

test("deterministic purpose terms beyond the preview reach the batch without inventing strong support", () => {
  const knowledge = buildScanWorkingKnowledge({
    scanSessionId: "scan-fallback",
    files: [{
      connectedLibraryId: "root-a",
      fileType: "TEXT",
      id: "late-workshop",
      relativePath: "Loose/notes.txt",
      previewText: "A generic introduction with no subject.",
      observationSessions: [{
        observerType: "DETERMINISTIC",
        status: "AWAITING_REVIEW",
        observations: [{
          label: "POSSIBLE_PURPOSE",
          description: "The later text appears to include educational material.",
          evidence: ["educational: workshop", "educational: guide"],
        }],
        interpretations: [],
        explanation: {},
      }],
    }],
  });

  assert.match(knowledge.files[0]?.sourceEvidenceText ?? "", /workshop guide/);
  assert.equal(knowledge.files[0]?.supportingTopics.includes("workshops"), false);
});
