import { createHash } from "node:crypto";
import { verifiedSourceExcerpts } from "@/lib/ai/source-evidence";

export const documentSignalVersion = "document-signals-v1";

export type DocumentSignalKind =
  | "FILE_ANCHOR"
  | "CLIENT"
  | "PERSON"
  | "ORGANIZATION"
  | "PROJECT"
  | "WORKSHOP"
  | "DOCUMENT_FAMILY"
  | "UNRESOLVED_CLIENT"
  | "UNRESOLVED_PROJECT";

export type SourceRange = { start: number; end: number };

export type ExtractedDocumentSignal = {
  kind: DocumentSignalKind;
  identityHash: string;
  supportHash: string | null;
  revisionNumber: string | null;
  revisionDate: string | null;
  sourceRanges: SourceRange[];
};

type Field = { value: string; range: SourceRange };

function hash(...values: string[]) {
  return createHash("sha256").update(values.join("\0")).digest("hex");
}

function normalized(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function individualEmail(field: Field | undefined) {
  if (!field || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(field.value)) return false;
  return !/^(info|contact|admin|support|team|office|hello|mail|reception)\b/.test(field.value.split("@")[0]);
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function extractFields(sourceEvidenceText: string) {
  const fields = new Map<string, Field>();
  const conflicts = new Map<string, SourceRange[]>();
  const excerpts = verifiedSourceExcerpts(sourceEvidenceText).slice(0, 24);
  for (const excerpt of excerpts) {
    const range = { start: excerpt.start, end: excerpt.end };
    for (const segment of excerpt.text.split(/[;\n]/)) {
      const match = segment.trim().match(/^(client id|client|person|email|organization|company|domain|project id|project|year|workshop|event|date|document id|document title|title|version|revision)\s*:\s*(.{2,100})$/i);
      if (!match) continue;
      const value = normalized(match[2]);
      const key = match[1].toLowerCase();
      const earlier = fields.get(key);
      if (value && earlier && earlier.value !== value) {
        conflicts.set(key, [...(conflicts.get(key) ?? [earlier.range]), range]);
      } else if (value && !earlier) {
        fields.set(key, { value, range });
      }
    }
  }
  return { conflicts, fields };
}

export function extractDocumentSignals(sourceEvidenceText: string, connectedLibraryId: string): ExtractedDocumentSignal[] {
  const { conflicts, fields } = extractFields(sourceEvidenceText);
  const get = (...keys: string[]) => keys.map((key) => conflicts.has(key) ? undefined : fields.get(key)).find(Boolean);
  const signals: ExtractedDocumentSignal[] = [];
  const add = (kind: DocumentSignalKind, identity: string, supporting: Array<Field | undefined>, supportHash: string | null = null, revisionNumber: string | null = null, revisionDate: string | null = null) => {
    signals.push({
      kind,
      identityHash: hash(connectedLibraryId, kind, identity),
      supportHash,
      revisionNumber,
      revisionDate,
      sourceRanges: [...new Map(supporting.filter((item): item is Field => Boolean(item)).map((item) => [`${item.range.start}:${item.range.end}`, item.range])).values()].slice(0, 4),
    });
  };
  const clientName = get("client");
  const clientId = get("client id");
  const email = get("email");
  const person = get("person");
  const organization = get("organization", "company");
  const domain = get("domain");
  const project = get("project");
  const projectId = get("project id");
  const year = get("year");
  const workshop = get("workshop", "event");
  const date = get("date");

  let clientHash: string | null = null;
  if (!conflicts.has("client id") && (clientId || (clientName && individualEmail(email)))) {
    const identity = clientId ? `id:${clientId.value}` : `email:${email?.value}`;
    add("CLIENT", identity, [clientName, clientId, email]);
    clientHash = signals.at(-1)?.identityHash ?? null;
  } else if (clientName || conflicts.has("client id")) {
    add("UNRESOLVED_CLIENT", clientName?.value ?? "conflicting-client-id", [clientName, ...((conflicts.get("client id") ?? []).map((range) => ({ value: "", range })))]);
  }
  if (person && individualEmail(email)) add("PERSON", email!.value, [person, email]);
  if (organization && domain) add("ORGANIZATION", domain.value, [organization, domain]);

  let projectHash: string | null = null;
  const supportedYear = year && /^20\d{2}$/.test(year.value) ? year.value : null;
  if (!conflicts.has("project id") && !conflicts.has("year") && (projectId || (project && supportedYear && clientHash))) {
    const identity = projectId ? `id:${projectId.value}:${supportedYear ?? ""}:${clientHash ?? ""}` : `name:${project?.value}:${supportedYear}:${clientHash}`;
    add("PROJECT", identity, [project, projectId, year, clientName, clientId], clientHash);
    projectHash = signals.at(-1)?.identityHash ?? null;
  } else if (project || conflicts.has("project id")) {
    add("UNRESOLVED_PROJECT", project?.value ?? "conflicting-project-id", [project, ...((conflicts.get("project id") ?? []).map((range) => ({ value: "", range })))]);
  }
  if (workshop && date && (projectHash || clientHash) && validDate(date.value)) {
    add("WORKSHOP", `${workshop.value}:${date.value}:${projectHash ?? clientHash}`, [workshop, date, project, clientName], projectHash ?? clientHash);
  }

  const documentId = get("document id");
  const title = get("document title", "title");
  const version = get("version", "revision");
  const parsedVersion = version?.value.match(/^v?(\d+(?:\.\d+){0,3})$/)?.[1] ?? null;
  const parsedDate = date && validDate(date.value) ? date.value : null;
  if (documentId && title && (projectHash || clientHash)) {
    add("DOCUMENT_FAMILY", `${documentId.value}:${title.value}:${projectHash ?? clientHash ?? ""}`, [documentId, title, version, date], projectHash ?? clientHash, parsedVersion, parsedDate);
  }
  return signals.slice(0, 8);
}

export function compareDocumentVersions(left: Pick<ExtractedDocumentSignal, "revisionNumber" | "revisionDate">, right: Pick<ExtractedDocumentSignal, "revisionNumber" | "revisionDate">): -1 | 0 | 1 | null {
  const numeric = left.revisionNumber && right.revisionNumber
    ? (() => {
      const a = left.revisionNumber.split(".").map(Number);
      const b = right.revisionNumber.split(".").map(Number);
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1;
      }
      return 0;
    })()
    : null;
  const dated = left.revisionDate && right.revisionDate
    ? Math.sign(left.revisionDate.localeCompare(right.revisionDate)) as -1 | 0 | 1
    : null;
  if (numeric !== null && dated !== null && numeric !== 0 && dated !== 0 && numeric !== dated) return null;
  if (numeric !== null && numeric !== 0) return numeric;
  if (dated !== null && dated !== 0) return dated;
  return null;
}
