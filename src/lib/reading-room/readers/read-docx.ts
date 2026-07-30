import mammoth from "mammoth";

import type { DocumentReader } from "@/lib/reading-room/types";
import { buildReadingResult, firstReadableLine } from "@/lib/reading-room/utils";

export const readDocx: DocumentReader = async (input) => {
  const result = await mammoth.extractRawText({ path: input.filePath });
  const warnings = result.messages.map((message) => message.message);

  return buildReadingResult({
    success: true,
    extractedText: result.value,
    title: firstReadableLine(result.value),
    warnings,
    readerType: "docx",
  });
};
