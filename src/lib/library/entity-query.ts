const entityStopWords = "and|with|about|have|in|on|for|from|documents?|files?|invoices?|versions?|pdf|docx?|html?|markdown|images?|audio|video|older|earlier|previous|history";
const entityPattern = /\b(client|project)\s+(?:named\s+)?([\p{L}\p{N}][\p{L}\p{N} .'’-]{0,70})/iu;
const grammaticalPossessive = new RegExp(
  `[\\u2019']s(?=\\s+(?:documents?|files?|invoices?|versions?|pdf|docx?|html?|markdown|images?|audio|video)\\b)`,
  "giu",
);
const entityDelimiter = new RegExp(`\\b(?:${entityStopWords})\\b`, "iu");

export function parseExplicitEntityQuery(value: string) {
  const match = entityPattern.exec(value);
  const phrase = match?.[2]?.replace(grammaticalPossessive, "");
  const entityName = phrase?.split(entityDelimiter)[0]?.trim() || null;
  return {
    entityKind: match?.[1]?.toLowerCase() === "client" ? "CLIENT" as const :
      match?.[1]?.toLowerCase() === "project" ? "PROJECT" as const : null,
    entityName,
  };
}
