export type ClaudeMessageRole = "user" | "assistant";

export type ClaudeTextContentBlock = {
  type: "text";
  text: string;
};

export type ClaudeMessageContent = string | ClaudeTextContentBlock[];

export type ClaudeMessage = {
  role: ClaudeMessageRole;
  content: ClaudeMessageContent;
};

export type ClaudeMessageRequest = {
  system?: string;
  messages: ClaudeMessage[];
  max_tokens: number;
};

export type ClaudeUsage = {
  input_tokens: number;
  output_tokens: number;
};

export type ClaudeStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "refusal"
  | string
  | null;

export type ClaudeMessageResponse = {
  id: string;
  type: "message";
  role: "assistant";
  content: ClaudeTextContentBlock[];
  model: string;
  stop_reason: ClaudeStopReason;
  stop_sequence: string | null;
  usage: ClaudeUsage;
};

export type ClaudeMetadataValue =
  | string
  | number
  | boolean
  | null
  | ClaudeMetadataValue[]
  | { [key: string]: ClaudeMetadataValue };

export type ClaudeDocumentMetadata = {
  title?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  itemKind?: string | null;
  wordCount?: number | null;
  source?: string | null;
  [key: string]: ClaudeMetadataValue | undefined;
};

export type ClaudeObservation = {
  text: string;
  evidence: string[];
  whyItMatters: string;
  confidence: number;
};

export type ClaudePossibleTheme = {
  name: string;
  reason: string;
  evidence: string[];
  confidence: number;
};

export type ClaudePossibleRelationship = {
  targetHint: string;
  reason: string;
  evidence: string[];
  confidence: number;
};

export type ClaudeQuestion = {
  question: string;
  reason: string;
};

export type ClaudeObservationResult = {
  observations: ClaudeObservation[];
  possibleThemes: ClaudePossibleTheme[];
  possibleRelationships: ClaudePossibleRelationship[];
  questions: ClaudeQuestion[];
  confidence: number;
  warnings: string[];
};

export type ClaudeObservationOptions = {
  maxInputCharacters?: number;
  maxOutputTokens?: number;
};
