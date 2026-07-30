import path from "node:path";

import type { ReadingResult } from "@/lib/reading-room/types";

type BuildReadingResultInput = {
  success: boolean;
  extractedText?: string;
  title?: string;
  author?: string;
  pageCount?: number;
  warnings?: string[];
  readerType: string;
};

export function normalizeExtractedText(value: string) {
  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function countWords(value: string) {
  const words = normalizeExtractedText(value).match(/\S+/g);

  return words?.length ?? 0;
}

export function buildReadingResult({
  success,
  extractedText = "",
  title,
  author,
  pageCount,
  warnings = [],
  readerType,
}: BuildReadingResultInput): ReadingResult {
  const normalizedText = normalizeExtractedText(extractedText);

  return {
    success,
    extractedText: normalizedText,
    title,
    author,
    pageCount,
    wordCount: countWords(normalizedText),
    warnings: warnings.map(sanitizeReadingWarning),
    readerType,
  };
}

export function sanitizeReadingWarning(error: unknown) {
  const fallback = "The Librarian could not read this file.";

  if (typeof error !== "string" && !(error instanceof Error)) {
    return fallback;
  }

  const message = typeof error === "string" ? error : error.message;
  const normalizedMessage = message.replace(/\s+/g, " ").trim();
  const lowerMessage = normalizedMessage.toLowerCase();

  if (lowerMessage.startsWith("the pdf opened")) {
    return normalizedMessage;
  }

  if (
    lowerMessage.includes("pdf") ||
    lowerMessage.includes("worker") ||
    lowerMessage.includes("password") ||
    lowerMessage.includes("protected") ||
    lowerMessage.includes("encrypted")
  ) {
    return "The Librarian could not read this PDF. The file may be damaged or protected.";
  }

  if (
    lowerMessage.includes(".next") ||
    lowerMessage.includes("node_modules") ||
    lowerMessage.includes("cannot find module") ||
    lowerMessage.includes("stack") ||
    /[a-z]:[\\/]/i.test(normalizedMessage)
  ) {
    return fallback;
  }

  return normalizedMessage || fallback;
}

export function normalizeExtension(fileName: string, extension?: string) {
  const source = extension || path.extname(fileName);
  const normalized = source.trim().toLowerCase().replace(/^\./, "");

  return normalized || undefined;
}

export function firstReadableLine(value: string) {
  return normalizeExtractedText(value)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}
