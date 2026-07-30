import { readFile } from "node:fs/promises";

import type { DocumentReader } from "@/lib/reading-room/types";
import { buildReadingResult, normalizeExtractedText } from "@/lib/reading-room/utils";

const htmlEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeHtmlEntities(value: string) {
  return value.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (entity, token) => {
    const normalizedToken = String(token).toLowerCase();
    const decodeCodePoint = (codePoint: number) =>
      Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;

    if (normalizedToken.startsWith("#x")) {
      return decodeCodePoint(Number.parseInt(normalizedToken.slice(2), 16));
    }

    if (normalizedToken.startsWith("#")) {
      return decodeCodePoint(Number.parseInt(normalizedToken.slice(1), 10));
    }

    return htmlEntities[normalizedToken] ?? entity;
  });
}

function textFromHtml(value: string) {
  return decodeHtmlEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|h[1-6]|li)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function titleFromHtml(value: string) {
  const title = value.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const heading = value.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];

  return normalizeExtractedText(textFromHtml(title || heading || ""));
}

export const readHtml: DocumentReader = async (input) => {
  const html = await readFile(input.filePath, "utf8");
  const extractedText = textFromHtml(html);
  const title = titleFromHtml(html);

  return buildReadingResult({
    success: true,
    extractedText,
    title: title || undefined,
    readerType: "html",
  });
};
