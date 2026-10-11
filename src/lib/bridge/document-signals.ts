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

export function extractDocumentFields(sourceEvidenceText: string, humanReviewed = false, legacyNameLabels = false) {
  const fields = new Map<string, Field>();
  const conflicts = new Map<string, SourceRange[]>();
  const candidates: Array<Field & { key: string }> = [];
  const legacyFields: Array<{ key: string; value: string; range: SourceRange }> = [];
  const verified = verifiedSourceExcerpts(sourceEvidenceText).slice(0, 24);
  const excerpts = verified.length || !humanReviewed ? verified : [{ start: 0, end: sourceEvidenceText.length, text: sourceEvidenceText }];
  for (const excerpt of excerpts) {
    for (const segment of excerpt.text.matchAll(/[^;\n]+/g)) {
      const text = segment[0].trim();
      const match = text.match(/^(client id|client|person|email|organization|company|domain|project id|project|year|workshop|event|date|document id|document title|title|version|revision)\s*:\s*(.{2,100})$/i);
      const start = excerpt.start + segment.index! + segment[0].indexOf(text);
      const range = { start, end: start + text.length };
      if (!match) {
        const legacy = legacyNameLabels ? text.match(/^(client|project)\s+(.{2,100})$/i) : null;
        if (legacy) legacyFields.push({ key: legacy[1].toLowerCase(), value: normalized(legacy[2]), range });
        continue;
      }
      const value = normalized(match[2]);
      const key = match[1].toLowerCase();
      candidates.push({ key, value, range });
      const earlier = fields.get(key);
      if (value && earlier && earlier.value !== value) {
        conflicts.set(key, [...(conflicts.get(key) ?? [earlier.range]), range]);
      } else if (value && !earlier) {
        fields.set(key, { value, range });
      }
    }
  }
  // Legacy name-only signals used colonless labels. An explicit field always
  // wins over narrative text such as "project files are current".
  const explicitKeys = new Set(fields.keys());
  for (const field of legacyFields) {
    if (explicitKeys.has(field.key)) continue;
    candidates.push(field);
    const earlier = fields.get(field.key);
    if (earlier && earlier.value !== field.value) conflicts.set(field.key, [earlier.range, field.range]);
    else if (!earlier) fields.set(field.key, field);
  }
  return { conflicts, fields, candidates };
}

/** Canonical semantic interpretation; retrieval/display excerpt bounds do not apply here. */
export function resolveDocumentEvidence(sourceEvidenceText: string, connectedLibraryId: string, humanReviewed = false) {
  const { conflicts, fields, candidates } = extractDocumentFields(sourceEvidenceText, humanReviewed);
  const get = (...keys: string[]) => keys.map((key) => conflicts.has(key) ? undefined : fields.get(key)).find(Boolean);
  const signals: ExtractedDocumentSignal[] = [];
  const add = (kind: DocumentSignalKind, identity: string, supporting: Array<Field | undefined>, supportHash: string | null = null, revisionNumber: string | null = null, revisionDate: string | null = null) => {
    signals.push({
      kind,
      identityHash: hash(connectedLibraryId, kind, identity),
      supportHash,
      revisionNumber,
      revisionDate,
      sourceRanges: humanReviewed ? [] : [...new Map(supporting.filter((item): item is Field => Boolean(item)).map((item) => [`${item.range.start}:${item.range.end}`, item.range])).values()].slice(0, 4),
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
  const resolvedSignals = signals.slice(0, 8);
  const entities = resolvedSignals.flatMap((signal) => {
    if (!["CLIENT", "PROJECT", "UNRESOLVED_CLIENT", "UNRESOLVED_PROJECT"].includes(signal.kind)) return [];
    const label = signal.kind.replace(/^UNRESOLVED_/, "").toLowerCase();
    return [{ kind: signal.kind, identityHash: signal.identityHash,
      nameConflicting: conflicts.has(label),
      labels: [`${label} id`, label].flatMap((key) => {
        const field = conflicts.has(key) ? undefined : fields.get(key);
        return field ? [field.value] : [];
      }) }];
  });
  return { connectedLibraryId, sourceEvidenceText, humanReviewed, fields, conflicts, candidates, signals: resolvedSignals, entities };
}

export function extractDocumentSignals(sourceEvidenceText: string, connectedLibraryId: string, humanReviewed = false): ExtractedDocumentSignal[] {
  return resolveDocumentEvidence(sourceEvidenceText, connectedLibraryId, humanReviewed).signals;
}

/** Use the resolver's fields, never an overlapping excerpt, to bind names/IDs.
 * Old ranged, name-only signals can describe separate entities on one file.
 * Explicit IDs and human edits instead require a unique name in the full evidence.
 */
export function documentSignalEntityLabels(resolution: ReturnType<typeof resolveDocumentEvidence>, kind: "CLIENT" | "PROJECT",
  sourceRanges: unknown, allowUnranged: boolean, identity?: { connectedLibraryId: string; identityHash: string }) {
  const { sourceEvidenceText, humanReviewed } = resolution;
  let parsed = { fields: resolution.fields, conflicts: resolution.conflicts, candidates: resolution.candidates };
  const label = kind.toLowerCase();
  if (!parsed.fields.has(label) && !parsed.conflicts.has(label) &&
      !parsed.fields.has(`${label} id`) && !parsed.conflicts.has(`${label} id`)) {
    parsed = extractDocumentFields(sourceEvidenceText, humanReviewed, true);
  }
  if (identity) {
    if (identity.connectedLibraryId !== resolution.connectedLibraryId) return [];
    const resolved = resolution.entities.find((signal) => signal.kind === kind);
    if (resolved && resolved.identityHash !== identity.identityHash) return [];
    if (humanReviewed && !resolution.entities.some((signal) =>
      signal.identityHash === identity.identityHash && [kind, `UNRESOLVED_${kind}`].includes(signal.kind))) return [];
    const explicitIdentity = parsed.fields.has(`${label} id`) || parsed.conflicts.has(`${label} id`) ||
      parsed.fields.has(kind === "CLIENT" ? "email" : "year");
    if (!resolved && explicitIdentity && !resolution.entities.some((signal) =>
      signal.kind === `UNRESOLVED_${kind}` && signal.identityHash === identity.identityHash)) return [];
    if (resolved) {
      if (!humanReviewed && (!Array.isArray(sourceRanges) || !sourceRanges.length) && !allowUnranged) return [];
      return resolved.labels;
    }
  }
  if (!humanReviewed && !parsed.fields.has(`${label} id`) && !parsed.conflicts.has(`${label} id`) &&
      Array.isArray(sourceRanges) && sourceRanges.length) {
    // Legacy independent name-only signals need exact field containment, never
    // reparsing an overlapping/clipped quotation into a new name.
    const labels = new Set(parsed.candidates.filter((field) => field.key === label && sourceRanges.some((range) =>
      range && typeof range === "object" && typeof range.start === "number" && typeof range.end === "number" &&
      range.start <= field.range.start && range.end >= field.range.end)).map((field) => field.value));
    return labels.size === 1 ? [...labels] : [];
  } else if (!humanReviewed && (!Array.isArray(sourceRanges) || !sourceRanges.length) && !allowUnranged) return [];
  // A non-conflicting ID remains searchable even when its optional names clash.
  // Each label comes from the same fields used to resolve the exact identity.
  return [`${label} id`, label].flatMap((key) => {
    const field = parsed.conflicts.has(key) ? undefined : parsed.fields.get(key);
    return field ? [field.value] : [];
  });
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
