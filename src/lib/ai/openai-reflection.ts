import { requestOpenAIJson } from "./openai-client";
import {
  AI_REFLECTION_SYSTEM_PROMPT,
  AI_REFLECTION_USER_PROMPT_TEMPLATE,
} from "./prompts";
import type {
  AIEvidenceReference,
  AINotebookReflection,
  AIPriorityRanking,
  AIProviderOptions,
  AIReflectionInput,
  AIReflectionResult,
  AIReviewQuestion,
} from "./types";

const defaultMaxInputCharacters = 120_000;
const defaultMaxOutputTokens = 2_400;

const stringArraySchema = {
  type: "array",
  items: { type: "string" },
} as const;

const evidenceReferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "sourceIds", "summary"],
  properties: {
    label: { type: "string" },
    sourceIds: stringArraySchema,
    summary: { type: "string" },
  },
} as const;

const reflectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["notebookReflections", "questions", "evidenceReferences", "rankings", "warnings"],
  properties: {
    notebookReflections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "reflection",
          "whyItMatters",
          "evidenceReferences",
          "relatedDocuments",
          "humanDecisions",
          "priority",
          "usefulness",
          "status",
        ],
        properties: {
          title: { type: "string" },
          reflection: { type: "string" },
          whyItMatters: { type: "string" },
          evidenceReferences: {
            type: "array",
            items: evidenceReferenceSchema,
          },
          relatedDocuments: stringArraySchema,
          humanDecisions: stringArraySchema,
          priority: { type: "number" },
          usefulness: { type: "number" },
          status: {
            type: "string",
            enum: ["CURRENT", "ARCHIVE_CANDIDATE", "QUESTION"],
          },
        },
      },
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "reason"],
        properties: {
          question: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    evidenceReferences: {
      type: "array",
      items: evidenceReferenceSchema,
    },
    rankings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "reason", "priority"],
        properties: {
          title: { type: "string" },
          reason: { type: "string" },
          priority: { type: "number" },
        },
      },
    },
    warnings: stringArraySchema,
  },
};

function fillReflectionPrompt(input: AIReflectionInput) {
  return AI_REFLECTION_USER_PROMPT_TEMPLATE.replace(
    "{{MEMORY_ENTRIES_JSON}}",
    JSON.stringify(input.memoryEntries, null, 2),
  )
    .replace(
      "{{OBSERVATION_SESSIONS_JSON}}",
      JSON.stringify(input.observationSessions, null, 2),
    )
    .replace(
      "{{HUMAN_DECISIONS_JSON}}",
      JSON.stringify(input.humanDecisions, null, 2),
    )
    .replace(
      "{{RELATED_KNOWLEDGE_JSON}}",
      JSON.stringify(input.relatedKnowledge, null, 2),
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringFrom(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringsFrom(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function boundedNumber(value: unknown, fallback = 0.5) {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(Math.min(1, Math.max(0, value)).toFixed(2))
    : fallback;
}

function evidenceReferencesFrom(value: unknown): AIEvidenceReference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item, index) => ({
      label: stringFrom(item.label, `Evidence ${index + 1}`),
      sourceIds: stringsFrom(item.sourceIds),
      summary: stringFrom(item.summary, "Supporting material needs review."),
    }));
}

function reflectionsFrom(value: unknown): AINotebookReflection[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item, index) => ({
      title: stringFrom(item.title, `Reflection ${index + 1}`),
      reflection: stringFrom(
        item.reflection,
        "I noticed a possible pattern that needs human review.",
      ),
      whyItMatters: stringFrom(
        item.whyItMatters,
        "This may be useful for deciding what deserves attention next.",
      ),
      evidenceReferences: evidenceReferencesFrom(item.evidenceReferences),
      relatedDocuments: stringsFrom(item.relatedDocuments),
      humanDecisions: stringsFrom(item.humanDecisions),
      priority: boundedNumber(item.priority),
      usefulness: boundedNumber(item.usefulness),
      status:
        item.status === "ARCHIVE_CANDIDATE" || item.status === "QUESTION"
          ? item.status
          : "CURRENT",
    }));
}

function questionsFrom(value: unknown): AIReviewQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item, index) => ({
      question: stringFrom(item.question, `Review question ${index + 1}`),
      reason: stringFrom(
        item.reason,
        "This question may help Deanne decide what matters.",
      ),
    }));
}

function rankingsFrom(value: unknown): AIPriorityRanking[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item, index) => ({
      title: stringFrom(item.title, `Priority ${index + 1}`),
      reason: stringFrom(
        item.reason,
        "This appears useful enough to review.",
      ),
      priority: boundedNumber(item.priority),
    }));
}

function normalizeReflectionResult(
  value: unknown,
  providerWarnings: string[],
  model: string,
): AIReflectionResult {
  if (!isRecord(value)) {
    return {
      provider: "openai",
      model,
      notebookReflections: [],
      questions: [],
      evidenceReferences: [],
      rankings: [],
      warnings: [...providerWarnings, "OpenAI returned an unexpected reflection shape."],
    };
  }

  return {
    provider: "openai",
    model,
    notebookReflections: reflectionsFrom(value.notebookReflections),
    questions: questionsFrom(value.questions),
    evidenceReferences: evidenceReferencesFrom(value.evidenceReferences),
    rankings: rankingsFrom(value.rankings),
    warnings: [...providerWarnings, ...stringsFrom(value.warnings)],
  };
}

export async function runOpenAIReflection(
  input: AIReflectionInput,
  options: AIProviderOptions = {},
): Promise<AIReflectionResult> {
  const maxInputCharacters =
    options.maxInputCharacters ?? defaultMaxInputCharacters;
  const prompt = fillReflectionPrompt(input);
  const promptForOpenAI = prompt.slice(0, maxInputCharacters);
  const wasTruncated = promptForOpenAI.length < prompt.length;
  const response = await requestOpenAIJson({
    instructions: AI_REFLECTION_SYSTEM_PROMPT,
    input: promptForOpenAI,
    maxOutputTokens: options.maxOutputTokens ?? defaultMaxOutputTokens,
    schema: reflectionSchema,
    schemaDescription:
      "Possible NSN Notebook reflections that preserve evidence and require human authority.",
    schemaName: "nsn_ai_reflection",
  });
  const warnings = [...response.warnings];

  if (wasTruncated) {
    warnings.push(
      `Only the first ${maxInputCharacters.toLocaleString()} characters were sent to OpenAI for reflection.`,
    );
  }

  return normalizeReflectionResult(response.output, warnings, response.model);
}
