import { requestOpenAIJson } from "./openai-client";
import {
  AI_OBSERVER_SYSTEM_PROMPT,
  AI_OBSERVER_USER_PROMPT_TEMPLATE,
} from "./prompts";
import type {
  AIObservation,
  AIObservationInput,
  AIObservationResult,
  AIProviderOptions,
  AIPossibleRelationship,
  AIPossibleTheme,
  AIReviewQuestion,
} from "./types";

const defaultMaxInputCharacters = 120_000;
const defaultMaxOutputTokens = 1_800;

const stringArraySchema = {
  type: "array",
  items: { type: "string" },
} as const;

const observationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["observations", "possibleThemes", "possibleRelationships", "questions", "confidence", "uncertainty", "warnings"],
  properties: {
    observations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "evidence", "whyItMatters", "confidence", "uncertainty"],
        properties: {
          text: { type: "string" },
          evidence: stringArraySchema,
          whyItMatters: { type: "string" },
          confidence: { type: "number" },
          uncertainty: { type: "string" },
        },
      },
    },
    possibleThemes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "reason", "evidence", "confidence", "uncertainty"],
        properties: {
          name: { type: "string" },
          reason: { type: "string" },
          evidence: stringArraySchema,
          confidence: { type: "number" },
          uncertainty: { type: "string" },
        },
      },
    },
    possibleRelationships: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["targetHint", "reason", "evidence", "confidence", "uncertainty"],
        properties: {
          targetHint: { type: "string" },
          reason: { type: "string" },
          evidence: stringArraySchema,
          confidence: { type: "number" },
          uncertainty: { type: "string" },
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
    confidence: { type: "number" },
    uncertainty: { type: "string" },
    warnings: stringArraySchema,
  },
};

function fillObserverPrompt(input: AIObservationInput, contentText: string) {
  return AI_OBSERVER_USER_PROMPT_TEMPLATE.replace(
    "{{DOCUMENT_TITLE}}",
    input.title ?? "Untitled item",
  )
    .replace("{{ITEM_KIND}}", String(input.itemKind))
    .replace("{{DOCUMENT_METADATA_JSON}}", JSON.stringify(input.metadata, null, 2))
    .replace("{{PREVIEW_TEXT}}", input.previewText ?? "")
    .replace("{{CONTENT_TEXT}}", contentText);
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

function confidenceFrom(value: unknown, fallback = 0.5) {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(Math.min(1, Math.max(0, value)).toFixed(2))
    : fallback;
}

function observationsFrom(value: unknown): AIObservation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item, index) => ({
      text: stringFrom(item.text, `Observation ${index + 1}`),
      evidence: stringsFrom(item.evidence),
      whyItMatters: stringFrom(
        item.whyItMatters,
        "This may matter during human review.",
      ),
      confidence: confidenceFrom(item.confidence),
      uncertainty: stringFrom(
        item.uncertainty,
        "This is only a proposed observation.",
      ),
    }));
}

function themesFrom(value: unknown): AIPossibleTheme[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item, index) => ({
      name: stringFrom(item.name, `Possible theme ${index + 1}`),
      reason: stringFrom(item.reason, "The language may point to this theme."),
      evidence: stringsFrom(item.evidence),
      confidence: confidenceFrom(item.confidence),
      uncertainty: stringFrom(
        item.uncertainty,
        "This theme needs human review before it can be trusted.",
      ),
    }));
}

function relationshipsFrom(value: unknown): AIPossibleRelationship[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item, index) => ({
      targetHint: stringFrom(item.targetHint, `Possible relationship ${index + 1}`),
      reason: stringFrom(
        item.reason,
        "The item may relate to another part of the library.",
      ),
      evidence: stringsFrom(item.evidence),
      confidence: confidenceFrom(item.confidence),
      uncertainty: stringFrom(
        item.uncertainty,
        "This relationship is only a suggestion.",
      ),
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
        "This question may help Deanne decide what the item means.",
      ),
    }));
}

function normalizeObservationResult(
  value: unknown,
  providerWarnings: string[],
  model: string,
): AIObservationResult {
  if (!isRecord(value)) {
    return {
      provider: "openai",
      model,
      observations: [],
      possibleThemes: [],
      possibleRelationships: [],
      questions: [],
      confidence: 0,
      uncertainty: "OpenAI returned an unexpected observation shape.",
      warnings: [...providerWarnings, "OpenAI returned an unexpected observation shape."],
    };
  }

  return {
    provider: "openai",
    model,
    observations: observationsFrom(value.observations),
    possibleThemes: themesFrom(value.possibleThemes),
    possibleRelationships: relationshipsFrom(value.possibleRelationships),
    questions: questionsFrom(value.questions),
    confidence: confidenceFrom(value.confidence),
    uncertainty: stringFrom(
      value.uncertainty,
      "These are AI-proposed observations and require human review.",
    ),
    warnings: [...providerWarnings, ...stringsFrom(value.warnings)],
  };
}

export async function runOpenAIObservation(
  input: AIObservationInput,
  options: AIProviderOptions = {},
): Promise<AIObservationResult> {
  const readableText = (input.contentText || input.previewText || "").trim();

  if (!readableText) {
    return {
      provider: "openai",
      model: "",
      observations: [],
      possibleThemes: [],
      possibleRelationships: [],
      questions: [],
      confidence: 0,
      uncertainty: "There is no readable text for OpenAI to observe.",
      warnings: ["OpenAI observation was not run because no readable text was provided."],
    };
  }

  const maxInputCharacters =
    options.maxInputCharacters ?? defaultMaxInputCharacters;
  const textForOpenAI = readableText.slice(0, maxInputCharacters);
  const wasTruncated = textForOpenAI.length < readableText.length;
  const response = await requestOpenAIJson({
    instructions: AI_OBSERVER_SYSTEM_PROMPT,
    input: fillObserverPrompt(input, textForOpenAI),
    maxOutputTokens: options.maxOutputTokens ?? defaultMaxOutputTokens,
    schema: observationSchema,
    schemaDescription:
      "Cautious NSN Librarian observations that require human review.",
    schemaName: "nsn_ai_observation",
  });
  const warnings = [...response.warnings];

  if (wasTruncated) {
    warnings.push(
      `Only the first ${maxInputCharacters.toLocaleString()} characters were sent to OpenAI for observation.`,
    );
  }

  return normalizeObservationResult(response.output, warnings, response.model);
}
