import { createReadStream } from "node:fs";

import OpenAI from "openai";

import type { AIJsonValue } from "./types";

export const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";
export const OPENAI_DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

type OpenAIJsonRequest = {
  instructions: string;
  input: string;
  schemaName: string;
  schemaDescription: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
};

type OpenAIAudioTranscriptionRequest = {
  filePath: string;
};

export type OpenAIJsonResponse = {
  responseId: string;
  model: string;
  output: AIJsonValue;
  warnings: string[];
};

export type OpenAIAudioTranscriptionResponse = {
  model: string;
  text: string;
  warnings: string[];
};

export class OpenAIProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIProviderConfigurationError";
  }
}

export class OpenAIProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIProviderError";
  }
}

function readOpenAIConfig() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new OpenAIProviderConfigurationError("OPENAI_API_KEY is not configured.");
  }

  return {
    apiKey,
    model: process.env.OPENAI_MODEL?.trim() || OPENAI_DEFAULT_MODEL,
  };
}

function readOpenAIAudioConfig() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new OpenAIProviderConfigurationError("OPENAI_API_KEY is not configured.");
  }

  return {
    apiKey,
    model:
      process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() ||
      OPENAI_DEFAULT_TRANSCRIPTION_MODEL,
  };
}

function parseJsonOutput(value: string): AIJsonValue {
  const trimmed = value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (!trimmed) {
    throw new OpenAIProviderError("OpenAI returned an empty response.");
  }

  try {
    return JSON.parse(trimmed) as AIJsonValue;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");

    if (firstBrace < 0 || lastBrace <= firstBrace) {
      throw new OpenAIProviderError("OpenAI did not return parseable JSON.");
    }

    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as AIJsonValue;
  }
}

export async function requestOpenAIJson({
  instructions,
  input,
  maxOutputTokens,
  schema,
  schemaDescription,
  schemaName,
}: OpenAIJsonRequest): Promise<OpenAIJsonResponse> {
  const config = readOpenAIConfig();
  const client = new OpenAI({ apiKey: config.apiKey });
  const response = await client.responses.create({
    model: config.model,
    instructions,
    input,
    max_output_tokens: maxOutputTokens,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        description: schemaDescription,
        strict: true,
        schema,
      },
    },
  });
  const warnings: string[] = [];

  if (response.status && response.status !== "completed") {
    warnings.push(`OpenAI response status was ${response.status}.`);
  }

  if (response.incomplete_details?.reason) {
    warnings.push(`OpenAI response was incomplete: ${response.incomplete_details.reason}.`);
  }

  if (response.error?.message) {
    throw new OpenAIProviderError(response.error.message);
  }

  return {
    responseId: response.id,
    model: response.model ?? config.model,
    output: parseJsonOutput(response.output_text),
    warnings,
  };
}

export async function requestOpenAIAudioTranscription({
  filePath,
}: OpenAIAudioTranscriptionRequest): Promise<OpenAIAudioTranscriptionResponse> {
  const config = readOpenAIAudioConfig();
  const client = new OpenAI({ apiKey: config.apiKey });
  const response = await client.audio.transcriptions.create({
    file: createReadStream(filePath),
    model: config.model,
  });
  const text =
    typeof response === "string"
      ? response
      : typeof response.text === "string"
        ? response.text
        : "";

  if (!text.trim()) {
    throw new OpenAIProviderError("OpenAI did not return usable audio text.");
  }

  return {
    model: config.model,
    text,
    warnings: [],
  };
}
