import { workingKnowledgeTerms } from "@/lib/bridge/scan-working-knowledge";
import { parseExplicitEntityQuery } from "@/lib/library/entity-query";
import type { QuestionRoute } from "./types";

const leadWords = /\b(?:what|which|where|when|who|how|do|does|did|we|have|the|a|an|about|for|of|in|on|are|is|there|these|those|documents?|files?|information|tell|me|summarize|explain|relate|related|main|themes?|across|anything|some|between)\b/giu;

export function routeLibraryQuestion(value: string): QuestionRoute {
  const question = value.trim().slice(0, 500);
  const entity = parseExplicitEntityQuery(question);
  // Historical list words alone request retained files, not a structured
  // document-family comparison. Comparative wording remains VERSION.
  const version = /\b(changed|changes|different|difference|versions?|revision|newer|compare|comparison|timeline)\b/iu.test(question) ||
    (/\blatest\b/iu.test(question) && /\b(proposal|draft|document|file|version)\b/iu.test(question));
  const history = /\b(history|historical|earlier|previous|older)\b/iu.test(question);
  const memory = /\b(decid(?:e|ed|ing)|approved|memory|preference)\b/iu.test(question);
  const document = /\b[\w .()-]+\.(?:txt|md|markdown|docx|pdf|html|htm)\b/iu.test(question);
  const kind: QuestionRoute["kind"] = version ? "VERSION" : history ? "HISTORY" :
    entity.entityKind === "CLIENT" ? "CLIENT" :
    entity.entityKind === "PROJECT" ? "PROJECT" :
    document ? "DOCUMENT" : memory ? "MEMORY" :
    /\b(topic|theme|subject|workshop|finance|invoice|training)\b/iu.test(question) ? "TOPIC" : "BROAD";
  const entityName = entity.entityName;
  const entityKind = entity.entityKind;
  const stripped = question.replace(leadWords, " ").replace(/[?.,:;]+/g, " ").replace(/\s+/g, " ").trim();
  const query = entityName && (kind === "CLIENT" || kind === "PROJECT")
    ? `${kind.toLowerCase()} ${entityName}` : stripped;
  const tokens = workingKnowledgeTerms(query);
  const searchQuery = (tokens.length ? query : question).slice(0, 120);
  return { kind, entityKind, searchQuery: version || history ? `older ${searchQuery} versions` : searchQuery,
    wantsHistory: version || history, entityName };
}
