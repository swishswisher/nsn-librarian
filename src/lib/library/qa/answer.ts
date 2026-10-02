import { workingKnowledgeTerms } from "@/lib/bridge/scan-working-knowledge";
import { getPrismaClient } from "@/lib/db/prisma";
import { OpenAIProviderError } from "@/lib/ai/openai-client";
import { runLibraryAnswerModel } from "./model";
import { retrieveQuestionContext } from "./retrieve";
import { libraryAnswerVersion, type AnswerClaim, type AnswerContext,
  type AnswerModelResult, type AnswerSource, type LibraryAnswer } from "./types";

type AnswerDependencies = {
  retrieve?: typeof retrieveQuestionContext;
  model?: (question: string, context: AnswerContext) => Promise<AnswerModelResult>;
  recordUsage?: (record: {
    status: string; model: string | null; inputTokens: number | null;
    outputTokens: number | null; httpAttempts: number; sourceCount: number;
    processingVersion: string; errorCategory: string | null;
  }) => Promise<unknown>;
  permittedRootIds?: string[];
};

function publicSources(context: AnswerContext): AnswerSource[] {
  return context.sources.map((source) => ({
    id: source.id, sourceType: source.sourceType, title: source.title,
    rootName: source.rootName, relativePath: source.relativePath, href: source.href,
    trustState: source.trustState, timeState: source.timeState,
    text: source.text, sourceRange: source.sourceRange,
  }));
}

function emptyAnswer(context: AnswerContext, state: LibraryAnswer["state"], answer: string,
  notice: string | null = null, usage?: LibraryAnswer["usage"]): LibraryAnswer {
  return { state, answer, claims: [], sources: publicSources(context),
    indexIncomplete: context.indexIncomplete, notice, usage };
}

function compareKeys(left: string, right: string) {
  return left.localeCompare(right);
}

function stableSourceId(source: AnswerContext["sources"][number]) {
  // S1/S2 describe presentation order, not source identity. Search results with
  // equal ranks may be returned in either order, so use the identity that is
  // bound to the underlying file checksum (or Memory row) for comparison.
  return JSON.stringify([source.sourceType, source.physicalIdentity]);
}

function canonicalAnswerContext(context: AnswerContext): AnswerContext {
  const stableIdByOrdinal = new Map(context.sources.map((source) =>
    [source.id, stableSourceId(source)]));
  const remapSourceId = (sourceId: string) => stableIdByOrdinal.get(sourceId) ??
    JSON.stringify(["MISSING_SOURCE_REFERENCE", sourceId]);
  return {
    ...context,
    sources: context.sources.map((source) => ({
      ...source,
      id: remapSourceId(source.id),
      corroborationKeys: [...new Set(source.corroborationKeys)].sort(compareKeys),
    })).sort((left, right) => compareKeys(
      left.id,
      right.id,
    )),
    relationships: context.relationships.map((relationship) => {
      const [leftSourceId, rightSourceId] = [
        remapSourceId(relationship.leftSourceId),
        remapSourceId(relationship.rightSourceId),
      ].sort(compareKeys);
      return { ...relationship, leftSourceId, rightSourceId };
    }).sort((left, right) => compareKeys(
      `${left.leftSourceId}\u0000${left.rightSourceId}\u0000${left.status}\u0000${left.explanation}`,
      `${right.leftSourceId}\u0000${right.rightSourceId}\u0000${right.status}\u0000${right.explanation}`,
    )),
    versions: context.versions.map((version) => {
      const [leftSourceId, rightSourceId] = [
        remapSourceId(version.leftSourceId),
        remapSourceId(version.rightSourceId),
      ].sort(compareKeys);
      return { ...version, leftSourceId, rightSourceId,
        newerSourceId: version.newerSourceId === null
          ? null : remapSourceId(version.newerSourceId) };
    }).sort((left, right) => compareKeys(
      `${left.leftSourceId}\u0000${left.rightSourceId}\u0000${left.newerSourceId ?? ""}\u0000${left.ordering}`,
      `${right.leftSourceId}\u0000${right.rightSourceId}\u0000${right.newerSourceId ?? ""}\u0000${right.ordering}`,
    )),
  };
}

function contextStillCurrent(before: AnswerContext, after: AnswerContext) {
  return JSON.stringify(canonicalAnswerContext(before)) ===
    JSON.stringify(canonicalAnswerContext(after));
}

function independentSupport(sourceIds: string[], context: AnswerContext) {
  const sources = sourceIds.flatMap((id) => context.sources.find((source) => source.id === id) ?? []);
  for (let i = 0; i < sources.length; i += 1) {
    for (let j = i + 1; j < sources.length; j += 1) {
      const left = sources[i].corroborationKeys;
      const right = sources[j].corroborationKeys;
      if (left.length && right.length && left.every((key) => !right.includes(key))) return true;
    }
  }
  return false;
}

function explicitConflict(sources: AnswerContext["sources"]) {
  const opposites: Array<[RegExp, RegExp]> = [
    [/\bapproved\b/i, /\brejected\b/i],
    [/\baccepted\b/i, /\bdeclined\b/i],
    [/\bpaid\b/i, /\bunpaid\b/i],
    [/\bcomplete(?:d)?\b/i, /\bincomplete\b/i],
    [/\bincluded\b/i, /\bexcluded\b/i],
  ];
  return sources.some((left, index) => sources.slice(index + 1).some((right) =>
    opposites.some(([positive, negative]) =>
      positive.test(left.text) && negative.test(right.text) ||
      negative.test(left.text) && positive.test(right.text))));
}

function latestVersionClaims(context: AnswerContext): { claims: AnswerClaim[]; representedFamilies: number } {
  if (context.versionAssessmentComplete === false) return { claims: [], representedFamilies: 0 };
  const remaining = new Set(context.versions.flatMap((version) =>
    [version.leftSourceId, version.rightSourceId]));
  const claims: AnswerClaim[] = [];
  const supplemental: AnswerClaim[] = [];
  let representedFamilies = 0;
  while (remaining.size) {
    const first = remaining.values().next().value as string;
    const component = new Set([first]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const version of context.versions) {
        if (!component.has(version.leftSourceId) && !component.has(version.rightSourceId)) continue;
        for (const id of [version.leftSourceId, version.rightSourceId]) {
          if (!component.has(id)) { component.add(id); changed = true; }
        }
      }
    }
    for (const id of component) remaining.delete(id);
    const family = context.versions.filter((version) =>
      component.has(version.leftSourceId) && component.has(version.rightSourceId));
    // A tie or incomparable pair means the actual maximum is not established.
    // Abstain rather than turning partial lineage into a "latest" assertion.
    if (family.some((version) => version.ordering !== "ORDERED" || !version.newerSourceId)) continue;
    const olderIds = new Set(family.map((version) => version.newerSourceId === version.leftSourceId
      ? version.rightSourceId : version.leftSourceId));
    const maxima = [...component].filter((id) => !olderIds.has(id));
    if (maxima.length !== 1) continue;
    const newestId = maxima[0];
    const comparisons = family.filter((version) => version.newerSourceId === newestId)
      .sort((left, right) => {
        const leftOlder = left.leftSourceId === newestId ? left.rightSourceId : left.leftSourceId;
        const rightOlder = right.leftSourceId === newestId ? right.rightSourceId : right.leftSourceId;
        return leftOlder.localeCompare(rightOlder);
      });
    const familyClaims: AnswerClaim[] = [];
    for (const version of comparisons) {
      const newer = context.sources.find((source) => source.id === newestId);
      const olderId = version.leftSourceId === newestId ? version.rightSourceId : version.leftSourceId;
      const older = context.sources.find((source) => source.id === olderId);
      if (newer && older) familyClaims.push({ kind: "FACT",
        text: `${newer.title} is newer than ${older.title} according to recorded version markers.`,
        sourceIds: [newer.id, older.id] });
    }
    if (familyClaims.length) {
      if (claims.length < 3) {
        claims.push(familyClaims[0]);
        representedFamilies += 1;
      }
      supplemental.push(...familyClaims.slice(1));
    }
  }
  claims.push(...supplemental.slice(0, Math.max(0, 3 - claims.length)));
  return { claims, representedFamilies };
}

export function validateAnswerClaims(output: unknown, context: AnswerContext): AnswerClaim[] {
  if (!output || typeof output !== "object" || !Array.isArray((output as { claims?: unknown }).claims)) return [];
  const sourceById = new Map(context.sources.map((source) => [source.id, source]));
  return (output as { claims: unknown[] }).claims.slice(0, 6).flatMap((value): AnswerClaim[] => {
    if (!value || typeof value !== "object") return [];
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.text !== "string" || candidate.text.trim().length < 4 ||
      candidate.text.length > 320 || !["FACT", "SYNTHESIS", "INFERENCE", "CONFLICT"].includes(String(candidate.kind)) ||
      !Array.isArray(candidate.sourceIds)) return [];
    const sourceIds = [...new Set(candidate.sourceIds)];
    if (!sourceIds.length || sourceIds.length > 5 || sourceIds.some((id) =>
      typeof id !== "string" || !sourceById.has(id))) return [];
    const kind = candidate.kind as AnswerClaim["kind"];
    const cited = sourceIds.map((id) => sourceById.get(id as string)!);
    if ((kind === "SYNTHESIS" || kind === "CONFLICT") &&
      !independentSupport(sourceIds as string[], context)) return [];
    if (kind === "CONFLICT" && !explicitConflict(cited)) return [];
    if (cited.every((source) => source.sourceType === "APPROVED_MEMORY") &&
      (/["\u201c\u201d]/.test(candidate.text) ||
        /\b(?:document|file|source|original)\b.{0,60}\b(?:says|states|reads|quotes|contains|reports|mentions)\b/i.test(candidate.text))) return [];
    const support = cited.map((source) => `${source.text} ${source.title} ${source.relativePath ?? ""}`).join(" ");
    // Version ordering is stated from structured lineage below, never from model prose.
    if (/\b(newer|latest|older|previous|revised|revision)\b/i.test(candidate.text)) return [];
    const supportTerms = new Set(workingKnowledgeTerms(support));
    const claimTerms = workingKnowledgeTerms(candidate.text).filter((term) =>
      !["source", "document", "file", "librarian", "notic", "appear", "suggest", "infer", "newer", "older", "latest", "previous"].includes(term));
    const overlap = claimTerms.filter((term) => supportTerms.has(term)).length;
    if (claimTerms.length && overlap / claimTerms.length < (kind === "FACT" ? 0.6 : 0.5)) return [];
    const sourceNumbers = new Set((support.match(/\b\d+(?:\.\d+)?\b/g) ?? []));
    if ((candidate.text.match(/\b\d+(?:\.\d+)?\b/g) ?? []).some((number) =>
      !sourceNumbers.has(number))) return [];
    if (cited.some((source) => source.sourceType === "FILE_METADATA") &&
      /\b(says|states|reports|shows|concludes|finds|describes|contains|quotes|transcribes|transcript)\b/i.test(candidate.text)) return [];
    return [{ text: candidate.text.trim(), kind, sourceIds: sourceIds as string[] }];
  });
}

async function persistUsage(record: Parameters<NonNullable<AnswerDependencies["recordUsage"]>>[0]) {
  return getPrismaClient().libraryAnswerUsage.create({ data: record });
}

export async function answerLibraryQuestion(question: string, dependencies: AnswerDependencies = {}): Promise<LibraryAnswer> {
  const safeQuestion = question.trim().slice(0, 500);
  const retrieve = dependencies.retrieve ?? retrieveQuestionContext;
  const context = await retrieve(safeQuestion, dependencies.permittedRootIds);
  if (!context.sources.length) {
    return emptyAnswer(context, context.indexIncomplete ? "SEARCH_INDEX_INCOMPLETE" : "NO_AUTHORIZED_MATCH",
      "There isn't enough authorized indexed information to answer this.");
  }
  if (context.ambiguousEntity) {
    return emptyAnswer(context, "AMBIGUOUS_ENTITY",
      "Several distinct identities may match. Please name the connected library or a more specific file.");
  }
  if (context.route.kind === "VERSION" && !context.versions.length) {
    return emptyAnswer(context, "INSUFFICIENT_EVIDENCE",
      "The available source records do not establish a version relationship.");
  }
  if (context.route.kind === "VERSION" && context.versions.every((version) => version.ordering === "AMBIGUOUS")) {
    return emptyAnswer(context, "PARTIALLY_ANSWERED",
      "The available version evidence does not establish which document is newer.");
  }
  const record = dependencies.recordUsage ?? persistUsage;
  let response: AnswerModelResult;
  try {
    response = await (dependencies.model ?? runLibraryAnswerModel)(safeQuestion, context);
  } catch (error) {
    const usage = { requests: 1,
      httpAttempts: error instanceof OpenAIProviderError ? error.httpAttempts : 0,
      inputTokens: null, outputTokens: null };
    await record({ status: "FAILED", model: null, inputTokens: null,
      outputTokens: null, httpAttempts: usage.httpAttempts,
      sourceCount: context.sources.length, processingVersion: libraryAnswerVersion,
      errorCategory: "MODEL_UNAVAILABLE" });
    const current = await retrieve(safeQuestion, dependencies.permittedRootIds);
    if (!contextStillCurrent(context, current)) return emptyAnswer(current, "SOURCE_CHANGED",
      "The library information changed while I was answering. Please ask again.", null, usage);
    return emptyAnswer(current, "MODEL_UNAVAILABLE",
      "Answering is temporarily unavailable. The source results are still available.", null, usage);
  }
  const usage = { requests: 1, httpAttempts: response.httpAttempts,
    inputTokens: response.inputTokens, outputTokens: response.outputTokens };
  await record({ status: "COMPLETED", model: response.model.slice(0, 100),
    inputTokens: response.inputTokens, outputTokens: response.outputTokens,
    httpAttempts: response.httpAttempts, sourceCount: context.sources.length,
    processingVersion: libraryAnswerVersion, errorCategory: null });
  const current = await retrieve(safeQuestion, dependencies.permittedRootIds);
  if (!contextStillCurrent(context, current)) return emptyAnswer(current, "SOURCE_CHANGED",
    "The library information changed while I was answering. Please ask again.", null, usage);
  const modelClaims = validateAnswerClaims(response.output, context);
  const lineage = context.route.kind === "VERSION"
    ? latestVersionClaims(context) : { claims: [], representedFamilies: 0 };
  const lineageClaims = lineage.claims;
  const claims = [...lineageClaims, ...modelClaims];
  if (!claims.length) return emptyAnswer(context, "INSUFFICIENT_EVIDENCE",
    "The available source evidence is not strong enough for a supported answer.",
    context.indexIncomplete ? "Search preparation is incomplete for part of this library." : null, usage);
  const submittedClaims = Array.isArray((response.output as { claims?: unknown }).claims)
    ? (response.output as { claims: unknown[] }).claims.length : 0;
  const incompleteVersionCoverage = context.route.kind === "VERSION" &&
    (context.versionAssessmentComplete === false ||
      (context.versionFamilyCount ?? lineage.representedFamilies) > lineage.representedFamilies);
  const state: LibraryAnswer["state"] = claims.some((claim) => claim.kind === "CONFLICT")
    ? "CONFLICTING_SOURCES" : context.indexIncomplete || modelClaims.length < submittedClaims ||
      incompleteVersionCoverage ||
      (context.route.kind === "VERSION" && !modelClaims.length && /\b(changed|difference|different)\b/i.test(safeQuestion))
      ? "PARTIALLY_ANSWERED" : "ANSWERED_FROM_SOURCES";
  return { state, answer: claims.map((claim) => claim.text).join(" "), claims,
    sources: publicSources(context), indexIncomplete: context.indexIncomplete,
    notice: context.indexIncomplete ? "Search preparation is incomplete for part of this library." : null,
    usage };
}
