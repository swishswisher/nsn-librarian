import { createClaudeMessage } from "./client";
import {
  CLAUDE_OBSERVER_SYSTEM_PROMPT,
  CLAUDE_OBSERVER_USER_PROMPT_TEMPLATE,
} from "./prompts";
import type {
  ClaudeDocumentMetadata,
  ClaudeObservation,
  ClaudeObservationOptions,
  ClaudeObservationResult,
  ClaudePossibleRelationship,
  ClaudePossibleTheme,
  ClaudeQuestion,
} from "./types";

const defaultMaxInputCharacters = 120_000;
const defaultMaxOutputTokens = 1_800;

export class ClaudeObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeObservationError";
  }
}

function buildObserverPrompt(rawText: string, metadata: ClaudeDocumentMetadata) {
  return CLAUDE_OBSERVER_USER_PROMPT_TEMPLATE.replace(
    "{{DOCUMENT_METADATA_JSON}}",
    JSON.stringify(metadata, null, 2),
  ).replace("{{RAW_TEXT}}", rawText);
}

function responseTextFrom(content: { text: string }[]) {
  return content.map((block) => block.text).join("\n").trim();
}

function parseJsonObject(value: string): unknown {
  const trimmed = value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new ClaudeObservationError(
        "Claude did not return a JSON observation response.",
      );
    }

    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringFrom(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringsFrom(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function confidenceFrom(value: unknown, fallback = 0.5) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Number(Math.min(1, Math.max(0, value)).toFixed(2));
}

function normalizeObservations(value: unknown): ClaudeObservation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (typeof item === "string") {
        return {
          text: item,
          evidence: [],
          whyItMatters: "This may be useful during human review.",
          confidence: 0.5,
        };
      }

      if (!isRecord(item)) {
        return null;
      }

      return {
        text: stringFrom(item.text, `Observation ${index + 1}`),
        evidence: stringsFrom(item.evidence),
        whyItMatters: stringFrom(
          item.whyItMatters,
          "This may be useful during human review.",
        ),
        confidence: confidenceFrom(item.confidence),
      };
    })
    .filter((item): item is ClaudeObservation => item !== null);
}

function normalizeThemes(value: unknown): ClaudePossibleTheme[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (typeof item === "string") {
        return {
          name: item,
          reason: "Claude noticed language that may point to this theme.",
          evidence: [],
          confidence: 0.5,
        };
      }

      if (!isRecord(item)) {
        return null;
      }

      return {
        name: stringFrom(item.name, `Possible theme ${index + 1}`),
        reason: stringFrom(
          item.reason,
          "Claude noticed language that may point to this theme.",
        ),
        evidence: stringsFrom(item.evidence),
        confidence: confidenceFrom(item.confidence),
      };
    })
    .filter((item): item is ClaudePossibleTheme => item !== null);
}

function normalizeRelationships(value: unknown): ClaudePossibleRelationship[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (typeof item === "string") {
        return {
          targetHint: item,
          reason: "Claude noticed a possible relationship that needs review.",
          evidence: [],
          confidence: 0.5,
        };
      }

      if (!isRecord(item)) {
        return null;
      }

      return {
        targetHint: stringFrom(item.targetHint, `Possible relationship ${index + 1}`),
        reason: stringFrom(
          item.reason,
          "Claude noticed a possible relationship that needs review.",
        ),
        evidence: stringsFrom(item.evidence),
        confidence: confidenceFrom(item.confidence),
      };
    })
    .filter((item): item is ClaudePossibleRelationship => item !== null);
}

function normalizeQuestions(value: unknown): ClaudeQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (typeof item === "string") {
        return {
          question: item,
          reason: "This may help Deanne decide what the item means.",
        };
      }

      if (!isRecord(item)) {
        return null;
      }

      return {
        question: stringFrom(item.question, `Review question ${index + 1}`),
        reason: stringFrom(
          item.reason,
          "This may help Deanne decide what the item means.",
        ),
      };
    })
    .filter((item): item is ClaudeQuestion => item !== null);
}

function normalizeObservationResult(value: unknown): ClaudeObservationResult {
  if (!isRecord(value)) {
    throw new ClaudeObservationError("Claude returned an invalid observation shape.");
  }

  return {
    observations: normalizeObservations(value.observations),
    possibleThemes: normalizeThemes(value.possibleThemes),
    possibleRelationships: normalizeRelationships(value.possibleRelationships),
    questions: normalizeQuestions(value.questions),
    confidence: confidenceFrom(value.confidence),
    warnings: stringsFrom(value.warnings),
  };
}

export async function runClaudeObservation(
  rawText: string,
  metadata: ClaudeDocumentMetadata,
  options: ClaudeObservationOptions = {},
): Promise<ClaudeObservationResult> {
  const observedText = rawText.trim();

  if (!observedText) {
    return {
      observations: [],
      possibleThemes: [],
      possibleRelationships: [],
      questions: [],
      confidence: 0,
      warnings: ["Claude Observer received no readable text to observe."],
    };
  }

  const maxInputCharacters =
    options.maxInputCharacters ?? defaultMaxInputCharacters;
  const textForClaude = observedText.slice(0, maxInputCharacters);
  const wasTruncated = observedText.length > textForClaude.length;
  const response = await createClaudeMessage({
    system: CLAUDE_OBSERVER_SYSTEM_PROMPT,
    max_tokens: options.maxOutputTokens ?? defaultMaxOutputTokens,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildObserverPrompt(textForClaude, metadata),
          },
        ],
      },
    ],
  });
  const result = normalizeObservationResult(
    parseJsonObject(responseTextFrom(response.content)),
  );
  const warnings = [...result.warnings];

  if (wasTruncated) {
    warnings.push(
      `Only the first ${maxInputCharacters.toLocaleString()} characters were sent to Claude for observation.`,
    );
  }

  if (response.stop_reason && response.stop_reason !== "end_turn") {
    warnings.push(`Claude stopped with reason: ${response.stop_reason}.`);
  }

  return {
    ...result,
    warnings,
  };
}
