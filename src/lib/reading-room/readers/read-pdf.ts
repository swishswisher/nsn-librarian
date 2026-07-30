import { readFile } from "node:fs/promises";

import { PDFParse } from "pdf-parse";

import type { DocumentReader } from "@/lib/reading-room/types";
import { buildReadingResult } from "@/lib/reading-room/utils";

function stringFromMetadata(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export const readPdf: DocumentReader = async (input) => {
  const buffer = await readFile(input.filePath);
  let parser: PDFParse | undefined;

  try {
    if (!buffer.subarray(0, 4).equals(Buffer.from("%PDF"))) {
      return buildReadingResult({
        success: false,
        readerType: "pdf",
        warnings: [
          "The Librarian could not read this PDF. The file may be damaged or protected.",
        ],
      });
    }

    parser = new PDFParse({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useWorkerFetch: false,
    });

    const textResult = await parser.getText();
    const infoResult = await parser.getInfo();
    const info = infoResult.info as
      | { Title?: unknown; Author?: unknown }
      | undefined;
    const warnings =
      textResult.text.trim().length === 0
        ? ["The PDF opened, but no readable text was found."]
        : [];

    return buildReadingResult({
      success: true,
      extractedText: textResult.text,
      title: stringFromMetadata(info?.Title),
      author: stringFromMetadata(info?.Author),
      pageCount: textResult.total || infoResult.total,
      warnings,
      readerType: "pdf",
    });
  } catch {
    return buildReadingResult({
      success: false,
      readerType: "pdf",
      warnings: [
        "The Librarian could not read this PDF. The file may be damaged or protected.",
      ],
    });
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
};
