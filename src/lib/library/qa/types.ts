export const libraryAnswerVersion = "library-answer-v1";
export const maxAnswerSources = 8;
export const maxAnswerExcerptsPerFile = 1;

export type QuestionRoute = {
  kind: "BROAD" | "CLIENT" | "PROJECT" | "DOCUMENT" | "VERSION" | "TOPIC" | "MEMORY" | "HISTORY";
  entityKind: "CLIENT" | "PROJECT" | null;
  searchQuery: string;
  wantsHistory: boolean;
  historyList?: boolean;
  entityName: string | null;
};

export type AnswerSource = {
  id: string;
  sourceType: "SOURCE_EXCERPT" | "FILE_METADATA" | "APPROVED_MEMORY";
  title: string;
  rootName: string;
  relativePath: string | null;
  href: string;
  trustState: string;
  timeState: string;
  text: string;
  sourceRange: { start: number; end: number } | null;
};

export type AnswerContextSource = AnswerSource & {
  physicalIdentity: string;
  corroborationKeys: string[];
};

export type AnswerRelationship = {
  leftSourceId: string;
  rightSourceId: string;
  status: "CONFIRMED" | "PROVISIONAL";
  explanation: string;
};

export type AnswerVersion = {
  leftSourceId: string;
  rightSourceId: string;
  newerSourceId: string | null;
  ordering: "ORDERED" | "AMBIGUOUS";
};

export type AnswerContext = {
  route: QuestionRoute;
  sources: AnswerContextSource[];
  relationships: AnswerRelationship[];
  versions: AnswerVersion[];
  /** Number of complete document-family components found before source truncation. */
  versionFamilyCount?: number;
  /** False when a family cannot be safely ordered or represented from verified evidence. */
  versionAssessmentComplete?: boolean;
  indexIncomplete: boolean;
  ambiguousEntity: boolean;
};

export type AnswerClaim = {
  text: string;
  kind: "FACT" | "SYNTHESIS" | "INFERENCE" | "CONFLICT";
  sourceIds: string[];
};

export type AnswerState = "ANSWERED_FROM_SOURCES" | "PARTIALLY_ANSWERED" |
  "CONFLICTING_SOURCES" | "INSUFFICIENT_EVIDENCE" | "NO_AUTHORIZED_MATCH" |
  "SEARCH_INDEX_INCOMPLETE" | "MODEL_UNAVAILABLE" | "AMBIGUOUS_ENTITY" | "SOURCE_CHANGED";

export type LibraryAnswer = {
  state: AnswerState;
  answer: string;
  claims: AnswerClaim[];
  sources: AnswerSource[];
  indexIncomplete: boolean;
  notice: string | null;
  usage?: {
    requests: number;
    httpAttempts: number;
    inputTokens: number | null;
    outputTokens: number | null;
  };
};

export type AnswerModelResult = {
  output: unknown;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  httpAttempts: number;
};
