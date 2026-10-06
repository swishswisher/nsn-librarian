import { compareNumericRevision, numericRevision, versionCoordinates } from "./document-version-index";
import { countKnowledgeWork, type KnowledgeWork } from "./knowledge-work";

type Member = {
  fileKey: string; checksum: string; observationSessionId: string;
  revisionNumber: string | null; revisionDate: string | null;
};
type Point = { numeric: number; date: number };
type Rectangle = [number, number, number, number];

type Run = { observation: string; first: number; last: number; count: number; parent?: Run; previous?: Run; next?: Run };

/** Ordered observation runs support constant-time capacity removal. When a run
 * empties, adjacent equal observations merge by size; run ownership uses path
 * compression, so a query can skip an arbitrarily large excluded observation.
 */
class OrdinaryPool {
  private head?: Run;
  private readonly owners: Run[] = [];
  private readonly previous: number[] = [];
  private readonly next: number[] = [];
  constructor(members: Member[]) {
    let run: Run | undefined;
    for (let index = 0; index < members.length; index++) {
      if (!run || run.observation !== members[index].observationSessionId) {
        const newer: Run = { observation: members[index].observationSessionId, first: index, last: index, count: 0, previous: run };
        if (run) run.next = newer; else this.head = newer;
        run = newer;
      }
      this.owners[index] = run; run.count++; run.last = index;
      this.previous[index] = index - 1; this.next[index] = index + 1 < members.length ? index + 1 : -1;
    }
  }
  private owner(run: Run): Run {
    if (run.parent) run.parent = this.owner(run.parent);
    return run.parent ?? run;
  }
  remove(index: number) {
    const run = this.owner(this.owners[index]);
    const previous = this.previous[index]; const next = this.next[index];
    if (previous >= 0) this.next[previous] = next;
    if (next >= 0) this.previous[next] = previous;
    run.count--;
    if (run.count) {
      if (run.first === index) run.first = next;
      if (run.last === index) run.last = previous;
      return;
    }
    const left = run.previous; const right = run.next;
    if (left) left.next = right; else this.head = right;
    if (right) right.previous = left;
    if (!left || !right || left.observation !== right.observation) return;
    const [small, large] = left.count <= right.count ? [left, right] : [right, left];
    small.parent = large;
    large.first = left.first; large.last = right.last;
    large.count += small.count;
    large.previous = left.previous; large.next = right.next;
    if (large.previous) large.previous.next = large; else this.head = large;
    if (large.next) large.next.previous = large;
  }
  first(observation: string, excluded: ReadonlySet<number>, work?: KnowledgeWork) {
    let run = this.head;
    while (run) {
      countKnowledgeWork(work, "poolNodeVisits");
      if (run.observation !== observation) {
        for (let index = run.first; ; index = this.next[index]) {
          countKnowledgeWork(work, "poolNodeVisits");
          if (!excluded.has(index)) return index;
          if (index === run.last) break;
        }
      }
      run = run.next;
    }
    return undefined;
  }
}

/** A constant-size certificate for the earliest member excluding one observation
 * and one checksum. A query rejecting the first member must reject its observation
 * or checksum; the two alternative branches each need at most two witnesses.
 */
function witnesses(indices: number[], members: Member[]) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  if (!sorted.length) return [];
  const a = sorted[0];
  const b = sorted.find((index) => members[index].observationSessionId !== members[a].observationSessionId);
  const c = sorted.find((index) => members[index].checksum !== members[a].checksum);
  const d = b === undefined ? undefined : sorted.find((index) =>
    members[index].observationSessionId !== members[a].observationSessionId && members[index].checksum !== members[b].checksum);
  const e = c === undefined ? undefined : sorted.find((index) =>
    members[index].checksum !== members[a].checksum && members[index].observationSessionId !== members[c].observationSessionId);
  return [...new Set([a, b, c, d, e].filter((index): index is number => index !== undefined))].sort((x, y) => x - y);
}

class DatePool {
  readonly positions: Map<number, number>;
  private readonly tree: number[][];
  private readonly size: number;
  constructor(readonly indices: number[], private readonly points: Point[], private readonly members: Member[]) {
    // Outer-node lists arrive in the same globally sorted date order.
    this.positions = new Map(indices.map((index, position) => [index, position]));
    this.size = 2 ** Math.ceil(Math.log2(Math.max(1, indices.length)));
    this.tree = Array.from({ length: this.size * 2 }, () => []);
    for (let position = 0; position < indices.length; position++) this.tree[this.size + position] = [indices[position]];
    for (let node = this.size - 1; node > 0; node--) this.pull(node);
  }
  private pull(node: number) {
    this.tree[node] = witnesses([...this.tree[node * 2], ...this.tree[node * 2 + 1]], this.members);
  }
  set(index: number, active: boolean) {
    let node = this.size + this.positions.get(index)!;
    this.tree[node] = active ? [index] : [];
    while ((node >>= 1) > 0) this.pull(node);
  }
  private bound(date: number) {
    let low = 0; let high = this.indices.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.points[this.indices[middle]].date < date) low = middle + 1; else high = middle;
    }
    return low;
  }
  first(lowDate: number, highDate: number, observation: string, checksum: string | undefined, work?: KnowledgeWork) {
    let low = this.bound(lowDate) + this.size;
    let high = this.bound(highDate + 1) + this.size;
    let result: number | undefined;
    const visit = (node: number) => {
      countKnowledgeWork(work, "poolNodeVisits");
      const candidate = this.tree[node].find((index) =>
        this.members[index].observationSessionId !== observation && this.members[index].checksum !== checksum);
      if (candidate !== undefined && (result === undefined || candidate < result)) result = candidate;
    };
    while (low < high) {
      if (low & 1) visit(low++);
      if (high & 1) visit(--high);
      low >>= 1; high >>= 1;
    }
    return result;
  }
}

/** Stable member order with capacity removal. Version families additionally use
 * numeric/date range indexes so incomparable members are skipped as whole ranges.
 * Construction uses O(N log N) space/work; removal and version queries O(log² N).
 * Ordinary identities use observation runs with amortized constant capacity
 * removal and queries bounded by the per-file relationship cap / signal count.
 */
export class RelationshipCandidatePool<T extends Member> {
  private readonly points: Point[];
  private readonly numericCount: number;
  private readonly dateCount: number;
  private readonly revisions: number[][];
  private readonly dates: string[];
  private readonly size: number;
  private readonly pools = new Map<number, DatePool>();
  private readonly active: boolean[];
  private readonly ordinary?: OrdinaryPool;
  constructor(readonly members: T[], private readonly versions: boolean, private readonly work?: KnowledgeWork) {
    const coordinates = versions ? versionCoordinates(members) : {
      points: members.map(() => ({ numeric: 0, date: 0 })), numericCount: 0, dateCount: 0, revisions: [], dates: [],
    };
    this.points = coordinates.points; this.numericCount = coordinates.numericCount; this.dateCount = coordinates.dateCount;
    this.revisions = coordinates.revisions;
    this.dates = coordinates.dates;
    this.size = 2 ** Math.ceil(Math.log2(this.numericCount + 1));
    this.active = members.map(() => true);
    if (!versions) { this.ordinary = new OrdinaryPool(members); return; }
    const indicesByNode = new Map<number, number[]>();
    const dateOrder = members.map((_, index) => index).sort((a, b) => this.points[a].date - this.points[b].date || a - b);
    for (const index of dateOrder) {
      for (let node = this.size + this.points[index].numeric; node > 0; node >>= 1) {
        const indices = indicesByNode.get(node) ?? []; indices.push(index); indicesByNode.set(node, indices);
      }
    }
    for (const [node, indices] of indicesByNode) this.pools.set(node, new DatePool(indices, this.points, members));
  }
  set(index: number, active: boolean) {
    if (this.active[index] === active) return;
    this.active[index] = active;
    if (this.ordinary) { if (!active) this.ordinary.remove(index); return; }
    for (let node = this.size + this.points[index].numeric; node > 0; node >>= 1) this.pools.get(node)!.set(index, active);
  }
  private rectangles(current: Member): Rectangle[] {
    if (!this.versions) return [[0, 0, 0, 0]];
    // Binary-search the immutable marker axes; never rebuild them per current row.
    const bounds = <Value>(values: Value[], value: Value, compare: (a: Value, b: Value) => number) => {
      let low = 0; let high = values.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compare(values[middle], value) < 0) low = middle + 1; else high = middle;
      }
      const equal = low < values.length && compare(values[low], value) === 0;
      return { less: low, greater: low + (equal ? 1 : 0) + 1, equal: equal ? low + 1 : -1 };
    };
    const numeric = numericRevision(current.revisionNumber);
    const date = current.revisionDate;
    const nb = numeric ? bounds(this.revisions, numeric, compareNumericRevision) : { less: 0, greater: 1, equal: -1 };
    const db = date ? bounds(this.dates, date, (a, b) => a.localeCompare(b)) : { less: 0, greater: 1, equal: -1 };
    const rectangles: Rectangle[] = [];
    const add = (nl: number, nh: number, dl: number, dh: number) => { if (nl <= nh && dl <= dh) rectangles.push([nl, nh, dl, dh]); };
    const { less: nLess, greater: nGreater, equal: nd } = nb;
    const { less: dLess, greater: dGreater, equal: dd } = db;
    if (!numeric) {
      if (date) { add(0, this.numericCount, 1, dLess); add(0, this.numericCount, dGreater, this.dateCount); }
    } else if (!date) {
      add(1, nLess, 0, this.dateCount); add(nGreater, this.numericCount, 0, this.dateCount);
    } else {
      add(1, nLess, 0, Math.max(dLess, dd));
      add(nGreater, this.numericCount, 0, 0);
      add(nGreater, this.numericCount, dd >= 0 ? dd : dGreater, this.dateCount);
      for (const numeric of [0, nd]) if (numeric >= 0) {
        add(numeric, numeric, 1, dLess); add(numeric, numeric, dGreater, this.dateCount);
      }
    }
    return rectangles;
  }
  first(current: Member, excluded: ReadonlySet<number> = new Set()) {
    if (this.ordinary) return this.ordinary.first(current.observationSessionId, excluded, this.work);
    const temporarilyRemoved = [...excluded].filter((index) => this.active[index]);
    for (const index of temporarilyRemoved) this.set(index, false);
    let result: number | undefined;
    for (const [nl, nh, dl, dh] of this.rectangles(current)) {
      let low = nl + this.size; let high = nh + this.size + 1;
      const visit = (node: number) => {
        const index = this.pools.get(node)?.first(dl, dh, current.observationSessionId,
          this.versions ? current.checksum : undefined, this.work);
        if (index !== undefined && (result === undefined || index < result)) result = index;
      };
      while (low < high) {
        if (low & 1) visit(low++);
        if (high & 1) visit(--high);
        low >>= 1; high >>= 1;
      }
    }
    for (const index of temporarilyRemoved) this.set(index, true);
    return result;
  }
}
