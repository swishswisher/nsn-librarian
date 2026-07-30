import { readFile } from "node:fs/promises";

import type { DocumentReader } from "@/lib/reading-room/types";
import { buildReadingResult, firstReadableLine } from "@/lib/reading-room/utils";

export const readTxt: DocumentReader = async (input) => {
  const extractedText = await readFile(input.filePath, "utf8");

  return buildReadingResult({
    success: true,
    extractedText,
    title: firstReadableLine(extractedText),
    readerType: "txt",
  });
};
