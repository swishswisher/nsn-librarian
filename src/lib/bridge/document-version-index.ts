import { countKnowledgeWork, type KnowledgeWork } from "./knowledge-work";
import { compareDocumentVersions } from "./document-signals";

export type IndexedVersion = {
  connectedLibraryId: string; identityHash: string; fileKey: string; checksum: string;
  revisionNumber: string | null; revisionDate: string | null;
};

export function versionEndpoint(signal: Pick<IndexedVersion, "connectedLibraryId" | "fileKey" | "checksum">) {
  return `${signal.connectedLibraryId}\0${signal.fileKey}\0${signal.checksum}`;
}

export function numericRevision(value: string | null) {
  if (!value) return null;
  const parts = value.split(".").map(Number);
  while (parts.length > 1 && parts.at(-1) === 0) parts.pop();
  return parts;
}

/** Collapse physical copies only for semantic assessment, after root/family
 * discovery and separation checks. Contradictory metadata on identical bytes
 * invalidates the assessment instead of being hidden by deduplication. */
export function semanticVersionMembers<T extends IndexedVersion>(family: T[]) {
  const copies = new Map<string, { markers: string; signal: T }>();
  for (const signal of family) {
    const revision = numericRevision(signal.revisionNumber);
    if (revision?.some((part) => !Number.isFinite(part))) return null;
    const key = `${signal.connectedLibraryId}\0${signal.identityHash}\0${signal.checksum}`;
    const markers = JSON.stringify([revision, signal.revisionDate]);
    const copy = copies.get(key);
    if (copy && copy.markers !== markers) return null;
    if (!copy || versionEndpoint(signal).localeCompare(versionEndpoint(copy.signal)) < 0) {
      copies.set(key, { markers, signal });
    }
  }
  return [...copies.values()].map((copy) => copy.signal);
}

export function compareNumericRevision(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0);
  }
  return 0;
}

export function versionCoordinates(signals: Pick<IndexedVersion, "revisionNumber" | "revisionDate">[]) {
  const numericValues = new Map(signals.flatMap((signal) => {
    const parts = numericRevision(signal.revisionNumber);
    return parts ? [[JSON.stringify(parts), parts] as const] : [];
  }));
  const revisions = [...numericValues.values()].sort(compareNumericRevision);
  const dates = [...new Set(signals.flatMap((signal) => signal.revisionDate ? [signal.revisionDate] : []))].sort();
  const numericRank = new Map(revisions.map((value, index) => [JSON.stringify(value), index + 1]));
  const dateRank = new Map(dates.map((value, index) => [value, index + 1]));
  return { revisions, dates, numericCount: revisions.length, dateCount: dates.length,
    points: signals.map((signal) => ({
      numeric: numericRank.get(JSON.stringify(numericRevision(signal.revisionNumber))) ?? 0,
      date: dateRank.get(signal.revisionDate ?? "") ?? 0,
    })) };
}

/** Count strict comparable dominators without constructing a pairwise graph.
 * Numeric order wins unless both date markers contradict it; equal/missing
 * numeric markers require distinct dates. Reversing both axes counts older rows.
 */
export function versionDominanceCounts<T extends Pick<IndexedVersion, "revisionNumber" | "revisionDate">>(
  signals: T[], work?: KnowledgeWork, older = false,
) {
  const coordinates = versionCoordinates(signals);
  const points = coordinates.points.map((point, index) => ({ index,
    numeric: older && point.numeric ? coordinates.numericCount + 1 - point.numeric : point.numeric,
    date: older && point.date ? coordinates.dateCount + 1 - point.date : point.date,
  }));
  const groups = new Map<number, typeof points>();
  for (const point of points) {
    const group = groups.get(point.numeric) ?? [];
    group.push(point); groups.set(point.numeric, group);
  }
  const tree = new Int32Array(coordinates.dateCount + 2);
  const prefix = (rank: number) => {
    let count = 0;
    for (let index = rank; index > 0; index -= index & -index) {
      countKnowledgeWork(work, "versionVisits"); count += tree[index];
    }
    return count;
  };
  const result = new Map<T, number>();
  let numericTotal = 0;
  const missingDates = (groups.get(0) ?? []).flatMap((point) => point.date ? [point.date] : []).sort((a, b) => a - b);
  const greaterDates = (dates: number[], rank: number) => {
    let low = 0; let high = dates.length;
    while (low < high) {
      countKnowledgeWork(work, "versionVisits");
      const middle = (low + high) >>> 1;
      if (dates[middle] <= rank) low = middle + 1; else high = middle;
    }
    return dates.length - low;
  };
  for (const numeric of [...groups.keys()].filter(Boolean).sort((a, b) => b - a)) {
    const group = groups.get(numeric)!;
    const dates = group.flatMap((point) => point.date ? [point.date] : []).sort((a, b) => a - b);
    for (const point of group) {
      countKnowledgeWork(work, "versionVisits");
      // prefix excludes missing dates (rank zero), which never contradict numeric order.
      const larger = point.date ? numericTotal - prefix(point.date - 1) : numericTotal;
      result.set(signals[point.index], larger + (point.date
        ? greaterDates(dates, point.date) + greaterDates(missingDates, point.date) : 0));
    }
    for (const point of group) {
      numericTotal += 1;
      if (point.date) for (let index = point.date; index < tree.length; index += index & -index) {
        countKnowledgeWork(work, "versionVisits"); tree[index] += 1;
      }
    }
  }
  const allDates = points.flatMap((point) => point.date ? [point.date] : []).sort((a, b) => a - b);
  for (const point of groups.get(0) ?? []) {
    countKnowledgeWork(work, "versionVisits");
    result.set(signals[point.index], point.date ? greaterDates(allDates, point.date) : 0);
  }
  return result;
}

export function groupVersionSignals<T extends IndexedVersion>(signals: T[]) {
  const groups = new Map<string, T[]>();
  for (const signal of signals) {
    const key = `${signal.connectedLibraryId}\0${signal.identityHash}`;
    const group = groups.get(key) ?? []; group.push(signal); groups.set(key, group);
  }
  return groups;
}

export function buildVersionStateIndex<T extends IndexedVersion>(signals: T[],
  separated: Map<string, Set<string>>, pairKey: (left: T, right: T) => string, work?: KnowledgeWork) {
  const byEndpoint = new Map<string, T>();
  const remaining = new Map<T, number>();
  const byPairEndpoint = new Map<string, T[]>();
  for (const family of groupVersionSignals(signals).values()) {
    const counts = versionDominanceCounts(family, work);
    const copies = new Map<string, T[]>();
    for (const signal of family) {
      const group = copies.get(signal.checksum) ?? []; group.push(signal); copies.set(signal.checksum, group);
      const endpoint = versionEndpoint(signal);
      if (!byEndpoint.has(endpoint)) byEndpoint.set(endpoint, signal);
      const key = `${signal.fileKey}\0${signal.checksum}`;
      const values = byPairEndpoint.get(key) ?? []; values.push(signal); byPairEndpoint.set(key, values);
    }
    for (const copiesOfBytes of copies.values()) {
      const copyCounts = versionDominanceCounts(copiesOfBytes, work);
      for (const signal of copiesOfBytes) remaining.set(signal, counts.get(signal)! - copyCounts.get(signal)!);
    }
  }
  // Work proportional to explicit separations, not every member of every family.
  for (const key of separated.keys()) {
    const [leftKey, leftChecksum, rightKey, rightChecksum] = key.split("\0");
    const left = byPairEndpoint.get(`${leftKey}\0${leftChecksum}`) ?? [];
    const right = byPairEndpoint.get(`${rightKey}\0${rightChecksum}`) ?? [];
    for (const a of left) for (const b of right) {
      if (a.connectedLibraryId !== b.connectedLibraryId || a.identityHash !== b.identityHash || a.checksum === b.checksum || pairKey(a, b) !== key) continue;
      if (compareDocumentVersions(b, a) === 1) remaining.set(a, remaining.get(a)! - 1);
      if (compareDocumentVersions(a, b) === 1) remaining.set(b, remaining.get(b)! - 1);
      countKnowledgeWork(work, "versionVisits");
    }
  }
  return { byEndpoint, superseded: new Set([...byEndpoint].flatMap(([key, signal]) =>
    (remaining.get(signal) ?? 0) > 0 ? [key] : [])) };
}
