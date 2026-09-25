import { workingKnowledgeTerms } from "@/lib/bridge/scan-working-knowledge";
import type { QuestionRoute } from "./types";

const leadWords = /\b(?:what|which|where|when|who|how|do|does|did|we|have|the|a|an|about|for|of|in|on|are|is|there|these|those|documents?|files?|information|tell|me|summarize|explain|relate|related|main|themes?|across|anything|some|between)\b/giu;

export function routeLibraryQuestion(value: string): QuestionRoute {
  const question = value.trim().slice(0, 500);
  const entity = /\b(client|project)\s+([\p{L}\p{N}][\p{L}\p{N} .'-]{0,70})/iu.exec(question);
  const version = /\b(changed|changes|different|difference|versions?|revision|newer|previous|older)\b/iu.test(question) ||
    (/\blatest\b/iu.test(question) && /\b(proposal|draft|document|file|version)\b/iu.test(question));
  const history = /\b(history|historical|earlier|previous|older)\b/iu.test(question);
  const memory = /\b(decid(?:e|ed|ing)|approved|memory|preference)\b/iu.test(question);
  const document = /\b[\w .()-]+\.(?:txt|md|markdown|docx|pdf|html|htm)\b/iu.test(question);
  const kind: QuestionRoute["kind"] = version ? "VERSION" : history ? "HISTORY" :
    entity?.[1]?.toLowerCase() === "client" ? "CLIENT" :
    entity?.[1]?.toLowerCase() === "project" ? "PROJECT" :
    document ? "DOCUMENT" : memory ? "MEMORY" :
    /\b(topic|theme|subject|workshop|finance|invoice|training)\b/iu.test(question) ? "TOPIC" : "BROAD";
  const entityName = entity?.[2]?.trim().split(/\b(?:and|with|about|have|in|on|for|from|documents?|files?|invoices?|versions?)\b/iu)[0]?.trim() ?? null;
  const stripped = question.replace(leadWords, " ").replace(/[?.,:;]+/g, " ").replace(/\s+/g, " ").trim();
  const query = entityName && (kind === "CLIENT" || kind === "PROJECT")
    ? `${kind.toLowerCase()} ${entityName}` : stripped;
  const tokens = workingKnowledgeTerms(query);
  const searchQuery = (tokens.length ? query : question).slice(0, 120);
  return { kind, searchQuery: version || history ? `older ${searchQuery} versions` : searchQuery,
    wantsHistory: version || history, entityName };
}
