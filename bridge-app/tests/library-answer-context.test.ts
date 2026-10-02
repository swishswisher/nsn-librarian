import assert from "node:assert/strict";
import test from "node:test";

import { answerLibraryQuestion } from "../../src/lib/library/qa/answer";
import type { AnswerContext } from "../../src/lib/library/qa/types";

function answerContext(): AnswerContext {
  return {
    route: { kind: "BROAD", entityKind: null, searchQuery: "orchid", wantsHistory: false, entityName: null },
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

function swapSourceOrdinals(context: AnswerContext) {
  const remap = new Map([["S1", "S2"], ["S2", "S1"]]);
  const sourceId = (id: string) => remap.get(id) ?? id;
  context.sources.reverse();
  for (const source of context.sources) source.id = sourceId(source.id);
  for (const relationship of context.relationships) {
    relationship.leftSourceId = sourceId(relationship.leftSourceId);
    relationship.rightSourceId = sourceId(relationship.rightSourceId);
  }
  for (const version of context.versions) {
    version.leftSourceId = sourceId(version.leftSourceId);
    version.rightSourceId = sourceId(version.rightSourceId);
    if (version.newerSourceId) version.newerSourceId = sourceId(version.newerSourceId);
  }
}

async function answerWithContexts(before: AnswerContext, after: AnswerContext,
  sourceIds: string[] = ["S1"]) {
  let retrieval = 0;
  return answerLibraryQuestion("orchid", {
    retrieve: async () => retrieval++ === 0 ? before : after,
    model: async () => ({ output: { claims: [{ text: "Orchid workshop notes", kind: "FACT", sourceIds }] },
      model: "mock", inputTokens: 1, outputTokens: 1, httpAttempts: 1 }),
    recordUsage: async () => undefined,
  });
}

test("answer context comparison remaps tied source ordinals without changing citations", async () => {
  const before = answerContext();
  before.sources[0].rootName = "Root A";
  before.sources[0].relativePath = "reports/summary.txt";
  before.sources[1].rootName = "Root B";
  before.sources[1].relativePath = "reports/summary.txt";
  const after = answerContext();
  after.sources[0].rootName = "Root A";
  after.sources[0].relativePath = "reports/summary.txt";
  after.sources[1].rootName = "Root B";
  after.sources[1].relativePath = "reports/summary.txt";
  swapSourceOrdinals(after);
  after.sources[0].corroborationKeys.reverse();
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
  const result = await answerWithContexts(before, after);

  assert.equal(result.state, "ANSWERED_FROM_SOURCES");
  assert.equal(result.claims.length, 1);
  assert.deepEqual(result.claims[0]?.sourceIds, ["S1"]);
  assert.equal(result.sources.find((source) => source.id === "S1")?.rootName, "Root A");
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

for (const [name, change] of [
  ["source checksum", (context: AnswerContext) => { context.sources[0].physicalIdentity = "sha256:changed"; }],
  ["source root", (context: AnswerContext) => { context.sources[0].rootName = "Different root"; }],
  ["source provenance", (context: AnswerContext) => { context.sources[0].corroborationKeys = ["sha256:other"]; }],
  ["relationship review", (context: AnswerContext) => { context.relationships[0].status = "PROVISIONAL"; }],
  ["version direction", (context: AnswerContext) => { context.versions[0].newerSourceId = "S1"; }],
  ["version ordering", (context: AnswerContext) => {
    context.versions[0].ordering = "AMBIGUOUS";
    context.versions[0].newerSourceId = null;
  }],
] as const) {
  test(`answer context comparison detects changed ${name} after ordinal remapping`, async () => {
    const before = answerContext();
    const after = answerContext();
    change(after);
    swapSourceOrdinals(after);

    assert.equal((await answerWithContexts(before, after)).state, "SOURCE_CHANGED");
  });
}
