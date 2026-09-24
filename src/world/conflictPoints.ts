import { segSeg } from '@core/intersect';
import type { Vec2 } from '@core/vec2';
import type { Polyline } from '@core/polyline';
import type { NodeId } from './ids';
import type { Connector, ConnectorId, Lanelet, LaneletGraph } from './lanelets';
import { m } from './units';
import { HEADING_CHORD, chordHeading } from './heading';

/**
 * `cross`: the two centrelines intersect. `merge`: both end in the same lane.
 * `swept`: the centrelines never meet, but the BODIES driven along them do —
 * opposing left turns that pass too close, a bus swinging its tail across the
 * lane beside it.
 */
export type ConflictKind = 'cross' | 'merge' | 'swept';

/**
 * Size classes a conflict zone is measured for.
 *
 * World knows nothing about the fleet, so the classes are envelopes in metres
 * and the simulation maps each archetype to the smallest one containing it
 * (`bodyClassOf`); `tests/sim/conflictZones.spec.ts` checks every archetype
 * fits. Three classes are enough to separate what matters: two cars in a pair
 * of turn lanes do not touch, two buses in the same pair do.
 */
export type BodyClass = 0 | 1 | 2;
export const BODY_CLASSES: readonly BodyClass[] = [0, 1, 2];
export const BODY_CLASS_NAMES = ['small', 'car', 'heavy'] as const;
export const BODY_ENVELOPE: readonly { readonly length: number; readonly width: number }[] = [
  { length: m(2.2), width: m(0.9) },
  { length: m(5.7), width: m(2.05) },
  { length: m(12.1), width: m(2.6) },
];
export const HEAVY: BodyClass = 2;

export function bodyClassOf(length: number, width: number): BodyClass {
  for (const c of BODY_CLASSES) {
    const e = BODY_ENVELOPE[c] as { length: number; width: number };
    if (length <= e.length && width <= e.width) return c;
  }
  return HEAVY;
}

/**
 * Centre-arc interval over which a body of one class on one movement overlaps
 * the swept area of a body of another class on the other movement.
 *
 * Arc positions are of the BODY CENTRE along the movement, measured from the
 * stop line: negative while the centre is still on the approach, beyond the
 * connector length once it is on the exit lane.
 */
export interface Zone {
  readonly enter: number;
  readonly exit: number;
}

export interface ConflictPoint {
  readonly id: number;
  readonly node: NodeId;
  readonly a: ConnectorId;
  readonly b: ConnectorId;
  /** Earliest arc position of the zone along connector `a`, body front. */
  readonly sA: number;
  /** Earliest arc position of the zone along connector `b`, body front. */
  readonly sB: number;
  readonly kind: ConflictKind;
  readonly at: Vec2;
  /**
   * Zone on `a` (or `b`) for a body of class `mine` against a body of class
   * `theirs` on the other movement, or null when those two sizes never touch.
   */
  zone(on: ConnectorId, mine: BodyClass, theirs: BodyClass): Zone | null;
}

export interface ConflictRef {
  readonly point: number;
  /** Earliest front arc position of the zone, for ordering. */
  readonly s: number;
  readonly other: ConnectorId;
  readonly kind: ConflictKind;
  /**
   * Body-centre arc position past which a vehicle of each class has cleared
   * the zone against ANY vehicle on the other movement. -Infinity when that
   * class never touches it.
   */
  readonly exit: readonly number[];
}

/** Two movements out of the same lane: resolved by car-following, not claims. */
export interface Diverge {
  readonly other: ConnectorId;
  /** Centre arc past which a body of class `mine` on the OTHER movement is clear of `theirs` on this one. */
  otherExit(mine: BodyClass, theirs: BodyClass): number;
}

/**
 * Sampling step of the body centre along a movement, world units. Each sampled
 * rectangle is lengthened by half a step at both ends, so consecutive samples
 * overlap and a thin conflict cannot fall between two of them.
 */
const SWEEP_STEP = 1;
/** Clearance kept around every body, world units (6 cm). */
const SWEEP_MARGIN = 0.15;
/** Broad-phase cell size, world units. */
const CELL = 8;

/**
 * Where two movements through a junction physically conflict.
 *
 * This used to be the intersection of two connector CENTRELINES, which is a
 * point on paper and nothing on the road. Measured in seeded traffic on six
 * junction layouts, it missed every conflict that is not a crossing of lines:
 * opposing left turns whose bodies brush as they pass, a bus on a right turn
 * swinging over the left turn beside it, a truck clipping a through movement
 * on a skewed leg — and it released every claim when the REAR passed the
 * crossing point, while the body was still half across the other lane.
 *
 * Each movement is now swept with the real body shape the renderer draws — a
 * rectangle centred on the path and aligned to its tangent — for three size
 * classes, and a zone is the interval of body-centre positions over which that
 * rectangle overlaps the other movement's swept area. Claims are held until
 * the vehicle's centre passes the zone exit for its own size, and a smaller
 * vehicle is only held back by what could actually touch it.
 *
 * Built once per topology version, never per frame. The nesting of the classes
 * (a smaller body at a centre is contained in a larger one at the same centre)
 * is what keeps it cheap: the heavy/heavy overlap is computed first with a
 * spatial grid, and the eight other class pairs only re-test the rectangle
 * pairs that heavy/heavy found.
 */
export class ConflictIndex {
  readonly points: ConflictPoint[] = [];
  /** References held by each connector, sorted by arc position. */
  readonly byConnector = new Map<ConnectorId, ConflictRef[]>();
  /** Sibling movements from the same lane whose bodies overlap near the split. */
  readonly diverges = new Map<ConnectorId, Diverge[]>();
  /** Movements whose zone reaches a body still waiting behind its stop line. */
  readonly queueIntrusions: { a: ConnectorId; b: ConnectorId; mine: BodyClass; theirs: BodyClass }[] = [];

  /**
   * Conflict ids are resources held by live vehicles, so their meaning must
   * survive a topology rebuild.  Array positions are deliberately never
   * recycled: a connector pair that still exists keeps its id, while a new
   * pair receives a fresh one.  `points` may therefore be sparse after edits.
   */
  private readonly idByKey = new Map<string, number>();
  private nextId = 0;

  /**
   * The zones of every pair measured by the previous build, keyed by the two
   * sweeps' sampled geometry.
   *
   * `pairZones` is two thirds of a topology rebuild, and a topology rebuild ran
   * it for every pair of movements at EVERY junction on every edit. Measured on
   * a 144-segment grid: 2.0 s per road drawn, of which the one or two junctions
   * the road actually touched were a few per cent. A pair's zones depend on
   * nothing but its two sweeps, so an unchanged junction now reads back the
   * answer it already had — the same object, so the result is identical — and
   * only the movements whose geometry moved are swept again. Each build keeps
   * exactly the pairs it used, so the cache never outgrows the map.
   */
  private pairCache = new Map<string, CachedPair>();

  build(graph: LaneletGraph): void {
    this.points.length = 0;
    this.byConnector.clear();
    this.diverges.clear();
    this.queueIntrusions.length = 0;
    const previous = this.pairCache;
    const next = new Map<string, CachedPair>();

    for (const junction of graph.junctions.values()) {
      const ids = junction.connectors.slice().sort();
      const sweeps = new Map<ConnectorId, Sweep>();
      const shapes = new Map<ConnectorId, SweepShape>();
      for (const id of ids) {
        const c = graph.connectors.get(id);
        if (!c) continue;
        const sweep = sweepOf(graph, c);
        if (!sweep) continue;
        sweeps.set(id, sweep);
        shapes.set(id, shapeOf(sweep));
      }

      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = graph.connectors.get(ids[i] as ConnectorId);
          const b = graph.connectors.get(ids[j] as ConnectorId);
          const sa = a && sweeps.get(a.id);
          const sb = b && sweeps.get(b.id);
          if (!a || !b || !sa || !sb) continue;

          const zones = cachedPairZones(
            previous,
            next,
            sa,
            shapes.get(a.id) as SweepShape,
            sb,
            shapes.get(b.id) as SweepShape,
          );
          if (!zones) continue;

          if (a.fromLane === b.fromLane) {
            pushDiverge(this.diverges, a.id, b.id, zones, false);
            pushDiverge(this.diverges, b.id, a.id, zones, true);
            continue;
          }

          this.recordIntrusions(a.id, b.id, zones);

          let kind: ConflictKind = 'swept';
          let at = zoneCentre(sa, zones);
          if (a.toLane === b.toLane) {
            kind = 'merge';
            at = sa.path.sampleAt(sa.crossing.length).p;
          } else {
            const hit = firstCrossing(sa.crossing.centre.toPoints(), sb.crossing.centre.toPoints());
            if (hit) {
              kind = 'cross';
              at = hit.at;
            }
          }
          this.add(junction.node, a.id, b.id, kind, at, zones);
        }
      }
    }

    this.pairCache = next;
    for (const list of this.byConnector.values()) list.sort((p, q) => p.s - q.s);
  }

  private recordIntrusions(a: ConnectorId, b: ConnectorId, zones: PairZones): void {
    for (const mine of BODY_CLASSES) {
      for (const theirs of BODY_CLASSES) {
        const onA = zones.get(mine, theirs, false);
        if (onA && onA.enter + (BODY_ENVELOPE[mine]?.length ?? 0) / 2 <= 0) {
          this.queueIntrusions.push({ a, b, mine, theirs });
        }
        const onB = zones.get(theirs, mine, true);
        if (onB && onB.enter + (BODY_ENVELOPE[theirs]?.length ?? 0) / 2 <= 0) {
          this.queueIntrusions.push({ a: b, b: a, mine: theirs, theirs: mine });
        }
      }
    }
  }

  private add(
    node: NodeId,
    a: ConnectorId,
    b: ConnectorId,
    kind: ConflictKind,
    at: Vec2,
    zones: PairZones,
  ): void {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    // The key is the connector pair: a pair changing from a line crossing to a
    // swept conflict after an edit is still the same resource.
    const key = `${node}|${lo}|${hi}`;
    let id = this.idByKey.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.idByKey.set(key, id);
    }

    const sA = earliestFront(zones, false);
    const sB = earliestFront(zones, true);
    const point: ConflictPoint = {
      id,
      node,
      a,
      b,
      sA,
      sB,
      kind,
      at,
      zone: (on, mine, theirs) =>
        on === a ? zones.get(mine, theirs, false) : on === b ? zones.get(mine, theirs, true) : null,
    };
    // Assignment rather than push preserves the stable (possibly sparse) id.
    this.points[id] = point;
    pushRef(this.byConnector, a, { point: id, s: sA, other: b, kind, exit: clearExits(zones, false) });
    pushRef(this.byConnector, b, { point: id, s: sB, other: a, kind, exit: clearExits(zones, true) });
  }

  refs(connector: ConnectorId): readonly ConflictRef[] {
    return this.byConnector.get(connector) ?? [];
  }

  divergesOf(connector: ConnectorId): readonly Diverge[] {
    return this.diverges.get(connector) ?? [];
  }

  /** True when the two connectors have at least one conflict point. */
  conflict(a: ConnectorId, b: ConnectorId): boolean {
    for (const r of this.refs(a)) if (r.other === b) return true;
    return false;
  }
}

// ------------------------------------------------------------------ sweeps

interface Sweep {
  readonly crossing: Lanelet;
  /** Approach, movement and exit joined, parametrised from the stop line. */
  readonly path: { sampleAt(c: number): { p: Vec2; t: Vec2 } };
  /** First sampled centre arc position (negative: on the approach). */
  readonly c0: number;
  readonly count: number;
  /** Per sample: centre x, y and unit tangent x, y. */
  readonly frame: Float64Array;
  /** Broad phase of the HEAVY rectangles: cell key -> sample indices. */
  readonly grid: Map<number, number[]>;
}

function sweepOf(graph: LaneletGraph, c: Connector): Sweep | null {
  const inbound = graph.lanelet(c.fromLane);
  const crossing = graph.lanelet(c.lanelet);
  const outbound = graph.lanelet(c.toLane);
  if (!inbound || !crossing || !outbound) return null;

  const path = joinedPath(inbound.centre, crossing.centre, outbound.centre);
  const heavy = BODY_ENVELOPE[HEAVY] as { length: number; width: number };
  const c0 = -heavy.length / 2;
  const c1 = crossing.length + heavy.length / 2;
  const count = Math.max(2, Math.ceil((c1 - c0) / SWEEP_STEP) + 1);
  const frame = new Float64Array(count * 4);
  const grid = new Map<number, number[]>();

  for (let i = 0; i < count; i++) {
    const c = c0 + i * SWEEP_STEP;
    const f = path.sampleAt(c);
    // Pointed along the same chord the drawn body is (`HEADING_CHORD`).
    const t = chordHeading(path.sampleAt(c - HEADING_CHORD).p, path.sampleAt(c + HEADING_CHORD).p, f.t);
    frame[i * 4] = f.p.x;
    frame[i * 4 + 1] = f.p.y;
    frame[i * 4 + 2] = t.x;
    frame[i * 4 + 3] = t.y;
    const [hl, hw] = halfExtent(HEAVY);
    const ex = Math.abs(t.x) * hl + Math.abs(t.y) * hw;
    const ey = Math.abs(t.y) * hl + Math.abs(t.x) * hw;
    for (let gx = Math.floor((f.p.x - ex) / CELL); gx <= Math.floor((f.p.x + ex) / CELL); gx++) {
      for (let gy = Math.floor((f.p.y - ey) / CELL); gy <= Math.floor((f.p.y + ey) / CELL); gy++) {
        const key = cellKey(gx, gy);
        const list = grid.get(key);
        if (list) list.push(i);
        else grid.set(key, [i]);
      }
    }
  }
  return { crossing, path, c0, count, frame, grid };
}

const cellKey = (x: number, y: number): number => (x + 32768) * 65536 + (y + 32768);

/** Everything `pairZones` reads from a sweep. Two equal shapes give equal zones. */
interface SweepShape {
  /** Hash of the fields below, for the cache key; equality is still checked in full. */
  readonly hash: string;
  readonly c0: number;
  readonly count: number;
  readonly length: number;
  readonly frame: Float64Array;
}

interface CachedPair {
  readonly a: SweepShape;
  readonly b: SweepShape;
  readonly zones: PairZones | null;
}

function shapeOf(s: Sweep): SweepShape {
  // FNV-1a over the frame's bytes. Only a key: a collision costs a recompute,
  // never a wrong answer, because a hit is confirmed by `sameShape`.
  const words = new Uint32Array(s.frame.buffer, s.frame.byteOffset, s.frame.length * 2);
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) h = Math.imul(h ^ (words[i] as number), 0x01000193);
  return {
    hash: `${(h >>> 0).toString(36)}:${s.count}:${s.c0}:${s.crossing.length}`,
    c0: s.c0,
    count: s.count,
    length: s.crossing.length,
    frame: s.frame,
  };
}

function sameShape(p: SweepShape, q: SweepShape): boolean {
  if (p.count !== q.count || p.c0 !== q.c0 || p.length !== q.length) return false;
  if (p.frame.length !== q.frame.length) return false;
  for (let i = 0; i < p.frame.length; i++) if (p.frame[i] !== q.frame[i]) return false;
  return true;
}

/** `pairZones`, answered from the previous build when neither sweep moved. */
function cachedPairZones(
  previous: Map<string, CachedPair>,
  next: Map<string, CachedPair>,
  a: Sweep,
  shapeA: SweepShape,
  b: Sweep,
  shapeB: SweepShape,
): PairZones | null {
  const key = `${shapeA.hash}|${shapeB.hash}`;
  const known = next.get(key) ?? previous.get(key);
  if (known && sameShape(known.a, shapeA) && sameShape(known.b, shapeB)) {
    next.set(key, known);
    return known.zones;
  }
  const zones = pairZones(a, b);
  next.set(key, { a: shapeA, b: shapeB, zones });
  return zones;
}

/** Half length and half width of each class's swept rectangle, built once. */
const HALF_EXTENT: readonly (readonly [number, number])[] = BODY_CLASSES.map((cls) => {
  const e = BODY_ENVELOPE[cls] as { length: number; width: number };
  return [e.length / 2 + SWEEP_STEP / 2 + SWEEP_MARGIN, e.width / 2 + SWEEP_MARGIN] as const;
});

function halfExtent(cls: BodyClass): readonly [number, number] {
  return HALF_EXTENT[cls] as readonly [number, number];
}

/** Whether sample `i` is a legal centre for a body of this class. */
function inRange(s: Sweep, i: number, cls: BodyClass): boolean {
  const half = (BODY_ENVELOPE[cls] as { length: number }).length / 2;
  const c = s.c0 + i * SWEEP_STEP;
  return c >= -half - 1e-9 && c <= s.crossing.length + half + 1e-9;
}

/**
 * The approach, the movement and the exit as one arc-length parameter.
 * Beyond either end the path continues straight along its end tangent, so a
 * very short approach still places the tail of a long body somewhere sensible.
 */
function joinedPath(inbound: Polyline, crossing: Polyline, outbound: Polyline) {
  return {
    sampleAt(c: number): { p: Vec2; t: Vec2 } {
      if (c < 0) {
        const s = inbound.length + c;
        if (s >= 0) return inbound.sampleAt(s);
        const f = inbound.sampleAt(0);
        return { p: { x: f.p.x + f.t.x * s, y: f.p.y + f.t.y * s }, t: f.t };
      }
      if (c <= crossing.length) return crossing.sampleAt(c);
      const s = c - crossing.length;
      if (s <= outbound.length) return outbound.sampleAt(s);
      const f = outbound.sampleAt(outbound.length);
      const over = s - outbound.length;
      return { p: { x: f.p.x + f.t.x * over, y: f.p.y + f.t.y * over }, t: f.t };
    },
  };
}

function overlap(
  a: Sweep, i: number, ca: BodyClass,
  b: Sweep, j: number, cb: BodyClass,
): boolean {
  const [ahl, ahw] = halfExtent(ca);
  const [bhl, bhw] = halfExtent(cb);
  const ax = a.frame[i * 4] as number, ay = a.frame[i * 4 + 1] as number;
  const aux = a.frame[i * 4 + 2] as number, auy = a.frame[i * 4 + 3] as number;
  const bx = b.frame[j * 4] as number, by = b.frame[j * 4 + 1] as number;
  const bux = b.frame[j * 4 + 2] as number, buy = b.frame[j * 4 + 3] as number;
  const dx = bx - ax, dy = by - ay;
  // The four edge normals of the two rectangles, unrolled: this runs millions
  // of times per rebuild, and an array of axes per call was a large share of
  // the garbage the rebuild made.
  return !separatedOn(aux, auy, dx, dy, aux, auy, ahl, ahw, bux, buy, bhl, bhw)
    && !separatedOn(-auy, aux, dx, dy, aux, auy, ahl, ahw, bux, buy, bhl, bhw)
    && !separatedOn(bux, buy, dx, dy, aux, auy, ahl, ahw, bux, buy, bhl, bhw)
    && !separatedOn(-buy, bux, dx, dy, aux, auy, ahl, ahw, bux, buy, bhl, bhw);
}

/** Whether axis (nx, ny) separates two rectangles `d = (dx, dy)` apart. */
function separatedOn(
  nx: number, ny: number, dx: number, dy: number,
  aux: number, auy: number, ahl: number, ahw: number,
  bux: number, buy: number, bhl: number, bhw: number,
): boolean {
  const d = Math.abs(dx * nx + dy * ny);
  const ra = ahl * Math.abs(aux * nx + auy * ny) + ahw * Math.abs(-auy * nx + aux * ny);
  const rb = bhl * Math.abs(bux * nx + buy * ny) + bhw * Math.abs(-buy * nx + bux * ny);
  return d >= ra + rb;
}

// ------------------------------------------------------------------- zones

interface PairZones {
  /** Zone on `a` (`onB` false) or on `b` (true) for body `mine` against `theirs`. */
  get(mine: BodyClass, theirs: BodyClass, onB: boolean): Zone | null;
}

/**
 * All nine class-pair zones of two movements, or null when even two heavy
 * bodies never touch.
 */
function pairZones(a: Sweep, b: Sweep): PairZones | null {
  // Heavy against heavy, through the grid.
  const hits: number[] = [];
  // Which of b's samples this sample of a has already tested: a stamp per
  // sample instead of a set cleared per sample.
  const seen = new Int32Array(b.count);
  const [hl, hw] = halfExtent(HEAVY);
  for (let i = 0; i < a.count; i++) {
    const x = a.frame[i * 4] as number, y = a.frame[i * 4 + 1] as number;
    const tx = a.frame[i * 4 + 2] as number, ty = a.frame[i * 4 + 3] as number;
    const ex = Math.abs(tx) * hl + Math.abs(ty) * hw;
    const ey = Math.abs(ty) * hl + Math.abs(tx) * hw;
    const stamp = i + 1;
    for (let gx = Math.floor((x - ex) / CELL); gx <= Math.floor((x + ex) / CELL); gx++) {
      for (let gy = Math.floor((y - ey) / CELL); gy <= Math.floor((y + ey) / CELL); gy++) {
        const cell = b.grid.get(cellKey(gx, gy));
        if (!cell) continue;
        for (const j of cell) {
          if (seen[j] === stamp) continue;
          seen[j] = stamp;
          if (overlap(a, i, HEAVY, b, j, HEAVY)) hits.push(i, j);
        }
      }
    }
  }
  if (!hits.length) return null;

  // 3 x 3 class pairs x [enterA, exitA, enterB, exitB]; NaN = no overlap.
  const table = new Float64Array(36).fill(Number.NaN);
  for (const ca of BODY_CLASSES) {
    for (const cb of BODY_CLASSES) {
      const at = (ca * 3 + cb) * 4;
      for (let k = 0; k < hits.length; k += 2) {
        const i = hits[k] as number;
        const j = hits[k + 1] as number;
        if (!inRange(a, i, ca) || !inRange(b, j, cb)) continue;
        if (ca !== HEAVY || cb !== HEAVY) {
          if (!overlap(a, i, ca, b, j, cb)) continue;
        }
        const cA = a.c0 + i * SWEEP_STEP;
        const cB = b.c0 + j * SWEEP_STEP;
        widen(table, at, cA);
        widen(table, at + 2, cB);
      }
    }
  }

  return {
    get(mine, theirs, onB) {
      const at = onB ? (theirs * 3 + mine) * 4 + 2 : (mine * 3 + theirs) * 4;
      const enter = table[at] as number;
      if (Number.isNaN(enter)) return null;
      // Half a step either side covers the motion between two samples.
      return { enter: enter - SWEEP_STEP / 2, exit: (table[at + 1] as number) + SWEEP_STEP / 2 };
    },
  };
}

function widen(table: Float64Array, at: number, c: number): void {
  const lo = table[at] as number;
  const hi = table[at + 1] as number;
  table[at] = Number.isNaN(lo) ? c : Math.min(lo, c);
  table[at + 1] = Number.isNaN(hi) ? c : Math.max(hi, c);
}

/** Earliest body-FRONT arc position at which any class enters the zone. */
function earliestFront(zones: PairZones, onB: boolean): number {
  let best = Infinity;
  for (const mine of BODY_CLASSES) {
    const z = zones.get(mine, HEAVY, onB);
    const half = (BODY_ENVELOPE[mine] as { length: number }).length / 2;
    if (z) best = Math.min(best, z.enter + half);
  }
  return best;
}

/** Per class, the centre past which the body is clear of any other body. */
function clearExits(zones: PairZones, onB: boolean): number[] {
  return BODY_CLASSES.map((mine) => {
    let exit = -Infinity;
    for (const theirs of BODY_CLASSES) {
      const z = zones.get(mine, theirs, onB);
      if (z) exit = Math.max(exit, z.exit);
    }
    return exit;
  });
}

function zoneCentre(a: Sweep, zones: PairZones): Vec2 {
  const z = zones.get(HEAVY, HEAVY, false);
  return a.path.sampleAt(z ? (z.enter + z.exit) / 2 : 0).p;
}

function pushDiverge(
  map: Map<ConnectorId, Diverge[]>,
  self: ConnectorId,
  other: ConnectorId,
  zones: PairZones,
  selfIsB: boolean,
): void {
  const entry: Diverge = {
    other,
    otherExit: (mine, theirs) => zones.get(mine, theirs, !selfIsB)?.exit ?? -Infinity,
  };
  const list = map.get(self);
  if (list) list.push(entry);
  else map.set(self, [entry]);
}

function pushRef(
  map: Map<ConnectorId, ConflictRef[]>,
  key: ConnectorId,
  ref: ConflictRef,
): void {
  const list = map.get(key);
  if (list) list.push(ref);
  else map.set(key, [ref]);
}

/** First intersection between two polylines, with arc positions on each. */
function firstCrossing(
  a: readonly Vec2[],
  b: readonly Vec2[],
): { sA: number; sB: number; at: Vec2 } | null {
  let sA = 0;
  for (let i = 0; i + 1 < a.length; i++) {
    const a0 = a[i] as Vec2;
    const a1 = a[i + 1] as Vec2;
    const segA = Math.hypot(a1.x - a0.x, a1.y - a0.y);

    let sB = 0;
    for (let j = 0; j + 1 < b.length; j++) {
      const b0 = b[j] as Vec2;
      const b1 = b[j + 1] as Vec2;
      const segB = Math.hypot(b1.x - b0.x, b1.y - b0.y);
      const hit = segSeg(a0, a1, b0, b1);
      if (hit) {
        return { sA: sA + hit.t * segA, sB: sB + hit.u * segB, at: hit.point };
      }
      sB += segB;
    }
    sA += segA;
  }
  return null;
}
