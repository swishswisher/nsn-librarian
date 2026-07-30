import type {
  Connection,
  Interpretation,
  MindInput,
  Observation,
} from "./types";

export type ConnectorInput = {
  input: MindInput;
  observations: Observation[];
  interpretations: Interpretation[];
};

export function connectKnowledgeItems(context: ConnectorInput): Connection[] {
  // Placeholder only. Future relationship mapping belongs here, but this
  // milestone intentionally avoids vector search and unrelated document queries.
  void context;

  return [];
}
