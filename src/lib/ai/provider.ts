import { runOpenAIObservation } from "./openai-observer";
import { runOpenAIReflection } from "./openai-reflection";
import type { AIProvider } from "./types";

export function createOpenAIProvider(): AIProvider {
  return {
    name: "openai",
    observe: runOpenAIObservation,
    reflect: runOpenAIReflection,
  };
}

export function getDefaultAIProvider(): AIProvider {
  return createOpenAIProvider();
}

export type {
  AIEvidenceReference,
  AIJsonValue,
  AINotebookReflection,
  AIObservation,
  AIObservationInput,
  AIObservationResult,
  AIPossibleRelationship,
  AIPossibleTheme,
  AIPriorityRanking,
  AIProvider,
  AIProviderName,
  AIProviderOptions,
  AIReflectionHumanDecision,
  AIReflectionInput,
  AIReflectionMemoryEntry,
  AIReflectionObservationSession,
  AIReflectionResult,
  AIReviewQuestion,
  AIRelatedKnowledge,
} from "./types";
