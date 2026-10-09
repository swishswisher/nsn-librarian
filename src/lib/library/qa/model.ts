import { OpenAIProviderError, requestOpenAIJson } from "@/lib/ai/openai-client";
import { libraryAnswerInstructions } from "./prompts";
import { maxAnswerClaims, type AnswerContext, type AnswerModelResult } from "./types";

const answerSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    claims: { type: "array", maxItems: maxAnswerClaims, items: { type: "object", additionalProperties: false,
      properties: {
        text: { type: "string" },
        kind: { type: "string", enum: ["FACT", "SYNTHESIS", "INFERENCE", "CONFLICT"] },
        sourceIds: { type: "array", items: { type: "string" } },
      },
      required: ["text", "kind", "sourceIds"],
    } },
  },
  required: ["claims"],
};

export async function runLibraryAnswerModel(question: string, context: AnswerContext,
  request: typeof requestOpenAIJson = requestOpenAIJson): Promise<AnswerModelResult> {
  const input = JSON.stringify({
    question: question.slice(0, 500),
    scope: context.route.kind,
    sources: context.sources.map((source) => ({
      id: source.id, sourceType: source.sourceType, title: source.title,
      root: source.rootName, relativePath: source.relativePath,
      trustState: source.trustState, timeState: source.timeState,
      sourceRange: source.sourceRange, text: source.text,
    })),
    relationships: context.relationships,
    versions: context.versions,
    indexIncomplete: context.indexIncomplete,
  });
  const response = await request({
    model: process.env.OPENAI_QA_MODEL?.trim() || undefined,
    instructions: libraryAnswerInstructions,
    input, maxOutputTokens: 700, schema: answerSchema,
    schemaName: "library_answer", schemaDescription: "Grounded claims with source IDs",
  });
  if (!response.completed) {
    throw new OpenAIProviderError("Answer generation was incomplete.", response.httpAttempts);
  }
  return { output: response.output, model: response.model,
    inputTokens: response.inputTokens, outputTokens: response.outputTokens,
    httpAttempts: response.httpAttempts };
}
