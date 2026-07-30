import type { KnowledgeItemKind } from "@/types/library";

export type KnowledgeExtractionResult = {
  success: boolean;
  contentText: string;
  summary?: string;
  itemKind: KnowledgeItemKind;
  examinerType: string;
  wordCount: number;
  confidence: number;
  warnings: string[];
  metadata: Record<string, unknown>;
};

// ReadingResult is the document-specific extraction result returned by the
// Reading Room. Future examiners should return KnowledgeExtractionResult.
export type ReadingResult = {
  success: boolean;
  extractedText: string;
  title?: string;
  author?: string;
  pageCount?: number;
  wordCount: number;
  warnings: string[];
  readerType: string;
};

export type ReadDocumentInput = {
  filePath: string;
  fileName: string;
  mimeType?: string;
  extension?: string;
};

export type DocumentReader = (
  input: ReadDocumentInput,
) => Promise<ReadingResult>;
