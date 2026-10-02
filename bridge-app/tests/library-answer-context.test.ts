import assert from "node:assert/strict";
import test from "node:test";

import { answerLibraryQuestion } from "../../src/lib/library/qa/answer";
import type { AnswerContext } from "../../src/lib/library/qa/types";

function answerContext(): AnswerContext {
  return {
    route: { kind: "BROAD", searchQuery: "orchid", wantsHistory: false, entityName: null },
    sources: [
      { id: "S1", sourceType: "SOURCE_EXCERPT", title: "one.txt", rootName: "Library",
        relativePath: "one.txt", href: "/one", trustState: "Human reviewed", timeState: "Current scan",
        text: "Orchid workshop notes", sourceRange: { start: 0, end: 21 },
        physicalIdentity: "sha256:one", corroborationKeys: ["project:orchid", "sha256:one"] },
      { id: "S2", sourceType: "SOURCE_EXCERPT", title: "two.txt", rootName: "Library",
        relativePath: "two.txt", href: "/two", trustState: "Human reviewed", timeState: "Current scan",
        text: "Orchid workshop agenda", sourceRange: { start: 0, end: 22 },
        physicalIdentity: "sha256:two", corroborationKeys: ["sha256:two"] },
    ],
    relationships: [
      { leftSourceId: "S1", rightSourceId: "S2", status: "CONFIRMED", explanation: "Same workshop" },
      { leftSourceId: "S1", rightSourceId: "S2", status: "PROVISIONAL", explanation: "Shared topic" },
    ],
    versions: [
      { leftSourceId: "S1", rightSourceId: "S2", newerSourceId: "S2", ordering: "ORDERED" },
    ],
    indexIncomplete: false,
    ambiguousEntity: false,
  };
}

test("answer context comparison ignores nondeterministic set ordering", async () => {
  const before = answerContext();
  const after = answerContext();
  after.sources.reverse();
  after.sources[1].corroborationKeys.reverse();
  after.relationships.reverse();
  after.relationships[0] = {
    ...after.relationships[0],
    leftSourceId: after.relationships[0].rightSourceId,
    rightSourceId: after.relationships[0].leftSourceId,
  };
  after.versions[0] = {
    ...after.versions[0],
    leftSourceId: after.versions[0].rightSourceId,
    rightSourceId: after.versions[0].leftSourceId,
  };
  let retrieval = 0;
  const result = await answerLibraryQuestion("orchid", {
    retrieve: async () => retrieval++ === 0 ? before : after,
    model: async () => ({ output: { claims: [{ text: "Orchid workshop notes", kind: "FACT", sourceIds: ["S1"] }] },
      model: "mock", inputTokens: 1, outputTokens: 1, httpAttempts: 1 }),
    recordUsage: async () => undefined,
  });

  assert.equal(result.state, "ANSWERED_FROM_SOURCES");
  assert.equal(result.claims.length, 1);
});

test("answer context comparison still detects review changes", async () => {
  const before = answerContext();
  const after = answerContext();
  after.relationships[0].status = "PROVISIONAL";
  let retrieval = 0;
  const result = await answerLibraryQuestion("orchid", {
    retrieve: async () => retrieval++ === 0 ? before : after,
    model: async () => ({ output: { claims: [] }, model: "mock", inputTokens: 1, outputTokens: 1, httpAttempts: 1 }),
    recordUsage: async () => undefined,
  });

  assert.equal(result.state, "SOURCE_CHANGED");
});
