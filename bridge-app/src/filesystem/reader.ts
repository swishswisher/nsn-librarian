import { readFile } from "node:fs/promises";
import path from "node:path";

import mammoth from "mammoth";

import { BridgeAppError, type BridgeReadResult } from "../types";
import { resolveBridgeRootFile } from "./resolver";

const previewableExtensions = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".pdf",
  ".docx",
]);

function htmlToText(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function fileTypeForExtension(extension: string) {
  if (extension === ".txt") {
    return "TEXT";
  }

  if (extension === ".md" || extension === ".markdown") {
    return "MARKDOWN";
  }

  if (extension === ".html" || extension === ".htm") {
    return "HTML";
  }

  if (extension === ".pdf") {
    return "PDF";
  }

  if (extension === ".docx") {
    return "DOCX";
  }

  return "UNSUPPORTED";
}

async function extractText(filePath: string, extension: string) {
  if (extension === ".txt" || extension === ".md" || extension === ".markdown") {
    try {
      return {
        text: await readFile(filePath, "utf8"),
        warnings: [] as string[],
      };
    } catch {
      throw new BridgeAppError(
        "This file could not be read safely.",
        "FILE_UNREADABLE",
        422,
      );
    }
  }

  if (extension === ".html" || extension === ".htm") {
    try {
      return {
        text: htmlToText(await readFile(filePath, "utf8")),
        warnings: [] as string[],
      };
    } catch {
      throw new BridgeAppError(
        "This file could not be read safely.",
        "FILE_UNREADABLE",
        422,
      );
    }
  }

  if (extension === ".pdf") {
    let parser: {
      destroy: () => Promise<void>;
      getText: () => Promise<{ text: string }>;
    } | null = null;

    try {
      // Keep the PDF runtime out of the Vercel web application's startup path.
      // It is needed only by the local Bridge when Deanne explicitly reads a PDF.
      const [{ CanvasFactory }, { PDFParse }] = await Promise.all([
        import("pdf-parse/worker"),
        import("pdf-parse"),
      ]);
      const buffer = await readFile(filePath);
      parser = new PDFParse({
        CanvasFactory,
        data: new Uint8Array(buffer),
        isEvalSupported: false,
        useWorkerFetch: false,
      });
      const pdf = await parser.getText();

      return {
        text: pdf.text,
        warnings: [] as string[],
      };
    } catch (error) {
      if (error instanceof BridgeAppError) {
        throw error;
      }

      throw new BridgeAppError(
        "This PDF appears damaged or could not be read safely.",
        "PDF_PARSE_FAILED",
        422,
      );
    } finally {
      await parser?.destroy().catch(() => undefined);
    }
  }

  if (extension === ".docx") {
    let result;

    try {
      result = await mammoth.extractRawText({ path: filePath });
    } catch {
      throw new BridgeAppError(
        "This file appears damaged or could not be read safely.",
        "FILE_CORRUPT",
        422,
      );
    }

    return {
      text: result.value,
      warnings: result.messages.map((message) => message.message),
    };
  }

  throw new BridgeAppError(
    "Unsupported for reading.",
    "UNSUPPORTED_FILE_TYPE",
    409,
  );
}

export async function readBridgeRootFile(
  rootId: string,
  relativePath: string,
): Promise<BridgeReadResult> {
  const safeFile = await resolveBridgeRootFile(rootId, relativePath);
  const extension = path.posix.extname(safeFile.relativePath).toLowerCase();

  if (!previewableExtensions.has(extension)) {
    throw new BridgeAppError(
      "Unsupported for reading.",
      "UNSUPPORTED_FILE_TYPE",
      409,
    );
  }

  const result = await extractText(safeFile.localPath, extension);
  const extractedText = result.text.trim();

  if (!extractedText) {
    const emptyFile = safeFile.sizeBytes === BigInt(0);

    throw new BridgeAppError(
      emptyFile
        ? "This file is empty."
        : "The Bridge could not find readable text in this file.",
      emptyFile ? "FILE_EMPTY" : "FILE_UNREADABLE",
      422,
    );
  }

  return {
    characterCount: extractedText.length,
    extractedText,
    fileName: safeFile.fileName,
    fileType: fileTypeForExtension(extension),
    relativePath: safeFile.relativePath,
    warnings: result.warnings,
  };
}
