import { readFile } from "node:fs/promises";

import type { DocumentReader } from "@/lib/reading-room/types";
import { buildReadingResult, firstReadableLine } from "@/lib/reading-room/utils";

function markdownTitle(value: string) {
  const heading = value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "));

  return heading?.replace(/^#+\s*/, "").trim() || firstReadableLine(value);
}

export const readMarkdown: DocumentReader = async (input) => {
  const extractedText = await readFile(input.filePath, "utf8");

  return buildReadingResult({
    success: true,
    extractedText,
    title: markdownTitle(extractedText),
    readerType: "markdown",
  });
};
