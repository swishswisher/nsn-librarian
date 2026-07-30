import type {
  ClaudeMessageRequest,
  ClaudeMessageResponse,
  ClaudeTextContentBlock,
} from "./types";

const claudeMessagesUrl = "https://api.anthropic.com/v1/messages";
const anthropicApiVersion = "2023-06-01";

type ClaudeClientConfig = {
  apiKey: string;
  model: string;
};

type ClaudeWireRequest = ClaudeMessageRequest & {
  model: string;
};

export class ClaudeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeConfigurationError";
  }
}

export class ClaudeClientError extends Error {
  readonly status?: number;
  readonly responseText?: string;

  constructor(message: string, status?: number, responseText?: string) {
    super(message);
    this.name = "ClaudeClientError";
    this.status = status;
    this.responseText = responseText;
  }
}

function readClaudeClientConfig(): ClaudeClientConfig {
  const apiKey = process.env.CLAUDE_API_KEY?.trim();
  const model = process.env.CLAUDE_MODEL?.trim();

  if (!apiKey) {
    throw new ClaudeConfigurationError("CLAUDE_API_KEY is not configured.");
  }

  if (!model) {
    throw new ClaudeConfigurationError("CLAUDE_MODEL is not configured.");
  }

  return {
    apiKey,
    model,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextContentBlock(value: unknown): value is ClaudeTextContentBlock {
  return (
    isRecord(value) &&
    value.type === "text" &&
    typeof value.text === "string"
  );
}

function readUsage(value: unknown) {
  if (!isRecord(value)) {
    throw new ClaudeClientError("Claude returned a response without usage data.");
  }

  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;

  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    throw new ClaudeClientError("Claude returned malformed usage data.");
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

function normalizeClaudeMessageResponse(value: unknown): ClaudeMessageResponse {
  if (!isRecord(value)) {
    throw new ClaudeClientError("Claude returned a malformed response.");
  }

  const content = Array.isArray(value.content)
    ? value.content.filter(isTextContentBlock)
    : [];

  if (
    typeof value.id !== "string" ||
    value.type !== "message" ||
    value.role !== "assistant" ||
    typeof value.model !== "string"
  ) {
    throw new ClaudeClientError("Claude returned an unexpected response shape.");
  }

  return {
    id: value.id,
    type: "message",
    role: "assistant",
    content,
    model: value.model,
    stop_reason:
      typeof value.stop_reason === "string" || value.stop_reason === null
        ? value.stop_reason
        : null,
    stop_sequence:
      typeof value.stop_sequence === "string" || value.stop_sequence === null
        ? value.stop_sequence
        : null,
    usage: readUsage(value.usage),
  };
}

export async function createClaudeMessage(
  request: ClaudeMessageRequest,
): Promise<ClaudeMessageResponse> {
  const config = readClaudeClientConfig();
  const body: ClaudeWireRequest = {
    ...request,
    model: config.model,
  };

  const response = await fetch(claudeMessagesUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": anthropicApiVersion,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseText = await response.text();

    throw new ClaudeClientError(
      `Claude request failed with status ${response.status}.`,
      response.status,
      responseText,
    );
  }

  return normalizeClaudeMessageResponse(await response.json());
}
