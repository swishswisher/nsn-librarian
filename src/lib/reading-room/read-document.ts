import { readDocx } from "@/lib/reading-room/readers/read-docx";
import { readHtml } from "@/lib/reading-room/readers/read-html";
import { readMarkdown } from "@/lib/reading-room/readers/read-markdown";
import { readPdf } from "@/lib/reading-room/readers/read-pdf";
import { readTxt } from "@/lib/reading-room/readers/read-txt";
import type {
  DocumentReader,
  ReadDocumentInput,
  ReadingResult,
} from "@/lib/reading-room/types";
import { buildReadingResult, normalizeExtension } from "@/lib/reading-room/utils";

const readersByExtension: Record<string, DocumentReader> = {
  docx: readDocx,
  htm: readHtml,
  html: readHtml,
  md: readMarkdown,
  pdf: readPdf,
  txt: readTxt,
};

export function isReadingSupported(input: ReadDocumentInput) {
  const extension = normalizeExtension(input.fileName, input.extension);

  return Boolean(extension && readersByExtension[extension]);
}

export async function readDocument(
  input: ReadDocumentInput,
): Promise<ReadingResult> {
  const extension = normalizeExtension(input.fileName, input.extension);
  const reader = extension ? readersByExtension[extension] : undefined;

  if (!reader) {
    return buildReadingResult({
      success: false,
      readerType: "unsupported",
      warnings: [
        extension
          ? `The Librarian cannot read .${extension} files yet.`
          : "The Librarian cannot read this file type yet.",
      ],
    });
  }

  try {
    return await reader({
      ...input,
      extension,
    });
  } catch (error) {
    return buildReadingResult({
      success: false,
      readerType: extension ?? "unknown",
      warnings: [
        error instanceof Error
          ? error.message
          : "The Librarian could not read this file.",
      ],
    });
  }
}
