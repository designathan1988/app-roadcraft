import { Polyline } from '@core/polyline';
import { pointInPolygon } from '@core/polygon';
import { type Vec2, addScaled, dot, len, normalize, sub } from '@core/vec2';
import { GEO_EPS } from '@core/scalar';
import type { NodeId } from './ids';
import type { Network } from './network';
import { Level } from './roadTypes';
import { BODY_ENVELOPE, HEAVY, type BodyClass } from './conflictPoints';
import { HEADING_CHORD, chordHeading } from './heading';

/**
 * The path a vehicle drives through a junction, as open as the kerbs allow.
 *
 * A turn used to be one cubic Bezier with handles of 0.65 of the chord for
 * every movement at every junction. Long handles hold the entry and exit
 * headings for most of the way and then bend hard in the middle, which is
 * what kept a bus's body off the kerb on the tightest right turn in the test
 * set - and it gave every OTHER turn the same hairpin. Measured on a crossroads
 * of avenues, the left turn's tightest radius was 7.7 m where the same chord
 * allows 17.8 m, and a right turn 5.1 m where 10.3 m fits; at a comfortable
 * lateral acceleration that is the difference between 15 and 25 km/h, and it
 * was the whole of "they slow right down to turn and crawl round the corner".
 *
 * Each movement now takes the SHORTEST handle (the widest, most circular
 * curve) for which the largest body in the fleet, swept along it, stays on the
 * carriageway or the kerb of this junction and its legs. Smaller bodies are
 * nested inside the largest at every centre position, so one sweep answers
 * for all of them. When nothing shorter fits, the old 0.65 is kept, so no
 * movement can come out tighter than it was.
 */

/** Handle lengths tried, as a fraction of the chord, widest curve first. */
const HANDLES = [0.39, 0.44, 0.49, 0.54, 0.59, 0.65] as const;
const FALLBACK_HANDLE = 0.65;
/** Tried only when even the fallback overruns. */
const SQUARER = [0.72, 0.8] as const;
/** Samples per turn path, cosine-spaced. */
const STEPS = 48;
/** Body-centre spacing of the containment sweep, world units. */
const SWEEP_STEP = 1.5;

type Poly = readonly Vec2[];
interface Box { minX: number; minY: number; maxX: number; maxY: number }
interface Area { readonly poly: Poly; readonly box: Box }

/** The drivable surface around one node: its junction plate and its legs. */
export class JunctionSurface {
  private readonly areas: Area[] = [];
  readonly centre: Vec2;
  /** Digest of every ring point, for `turnPath`'s memo. */
  readonly key: string;

  constructor(net: Network, node: NodeId) {
    const at = net.doc.node(node);
    this.centre = { x: at?.x ?? 0, y: at?.y ?? 0 };
    const add = (points: Poly): void => {
      if (points.length < 3) return;
      const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const p of points) {
        box.minX = Math.min(box.minX, p.x); box.maxX = Math.max(box.maxX, p.x);
        box.minY = Math.min(box.minY, p.y); box.maxY = Math.max(box.maxY, p.y);
      }
      this.areas.push({ poly: points, box });
    };
    for (const level of [Level.Asphalt, Level.Curb] as const) {
      const junction = net.junctions.get(node)?.get(level);
      for (const ring of junction?.rings ?? []) if (!ring.isEmpty) add(ring.flatten());
      for (const segment of net.doc.node(node)?.incident ?? []) {
        const ring = net.ribbons.get(segment)?.rings[level];
        if (ring && !ring.isEmpty) add(ring.flatten());
      }
    }
    const digest = new Digest();
    digest.point(this.centre);
    for (const a of this.areas) {
      digest.add(a.poly.length);
      for (const p of a.poly) digest.point(p);
    }
    this.key = digest.value();
  }

  get empty(): boolean {
    return this.areas.length === 0;
  }

  contains(p: Vec2): boolean {
    for (const a of this.areas) {
      if (p.x < a.box.minX || p.x > a.box.maxX || p.y < a.box.minY || p.y > a.box.maxY) continue;
      if (pointInPolygon(p, a.poly)) return true;
    }
    return false;
  }
}

/** Cubic Bezier from the end of `inCentre` to the start of `outCentre`. */
export function bezierTurn(inCentre: Polyline, outCentre: Polyline, handleFraction: number): Polyline {
  const a = inCentre.sampleAt(inCentre.length).p;
  const b = outCentre.sampleAt(0).p;
  const t0 = inCentre.sampleAt(inCentre.length).t;
  const t3 = outCentre.sampleAt(0).t;
  const chord = sub(b, a);
  const d = len(chord);
  if (d < GEO_EPS) return Polyline.fromPoints([a, b]);
  // A movement already aligned with both lanes is a straight line, and forcing
  // a curve through it only adds sampling error.
  const dir = normalize(chord);
  if (dot(dir, t0) > 0.9999 && dot(dir, t3) > 0.9999) return Polyline.fromPoints([a, b]);

  const handle = handleFraction * d;
  const p1 = addScaled(a, t0, handle);
  const p2 = addScaled(b, t3, -handle);
  const pts: Vec2[] = [];
  for (let i = 0; i <= STEPS; i++) {
    // Cosine spacing: a polyline's tangent at its very end is the direction of
    // its last chord, so clustering samples at both ends keeps the entry and
    // exit headings exact without extra points.
    const t = 0.5 - 0.5 * Math.cos((Math.PI * i) / STEPS);
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    pts.push({
      x: w0 * a.x + w1 * p1.x + w2 * p2.x + w3 * b.x,
      y: w0 * a.y + w1 * p1.y + w2 * p2.y + w3 * b.y,
    });
  }
  return Polyline.fromPoints(pts);
}

/**
 * Another inbound lane - of another approach, or the one beside this
 * movement's own - where a vehicle stands waiting at its stop line.
 * A turn must not swing a body over it: nothing there has been admitted to
 * anything, so no claim can protect it (`ConflictIndex.queueIntrusions`).
 */
export interface WaitingLane {
  readonly centre: Polyline;
}

/** How far behind a stop line a waiting vehicle is looked for, world units. */
const QUEUE_REACH = BODY_ENVELOPE[HEAVY]!.length * 1.5;

interface Rect { cx: number; cy: number; ux: number; uy: number; hl: number; hw: number; r: number }

const rect = (p: Vec2, t: Vec2, length: number, width: number): Rect =>
  ({ cx: p.x, cy: p.y, ux: t.x, uy: t.y, hl: length / 2, hw: width / 2, r: Math.hypot(length, width) / 2 });

/** Separating-axis test between two oriented rectangles. */
function overlap(a: Rect, b: Rect): boolean {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  if (dx * dx + dy * dy > (a.r + b.r) * (a.r + b.r)) return false;
  for (const [ax, ay] of [[a.ux, a.uy], [-a.uy, a.ux], [b.ux, b.uy], [-b.uy, b.ux]] as const) {
    const d = Math.abs(dx * ax + dy * ay);
    const ra = a.hl * Math.abs(a.ux * ax + a.uy * ay) + a.hw * Math.abs(-a.uy * ax + a.ux * ay);
    const rb = b.hl * Math.abs(b.ux * ax + b.uy * ay) + b.hw * Math.abs(-b.uy * ax + b.ux * ay);
    if (d >= ra + rb) return false;
  }
  return true;
}

/** Car-sized bodies standing in a waiting lane, front at the line and further back. */
function waitingBodies(lane: WaitingLane): Rect[] {
  const car = BODY_ENVELOPE[1]!;
  const out: Rect[] = [];
  for (let back = car.length / 2; back <= QUEUE_REACH; back += SWEEP_STEP) {
    const f = lane.centre.sampleAt(Math.max(0, lane.centre.length - back));
    out.push(rect(f.p, f.t, car.length, car.width));
  }
  return out;
}

/**
 * Sweeps the largest body along the path. Null when it leaves the surface;
 * otherwise how far behind another approach's stop line the FRONT of a car
 * waiting there would have to stand to stay clear of it (0 when at the line
 * is clear already).
 */
function sweep(surface: JunctionSurface, inCentre: Polyline, path: Polyline, outCentre: Polyline,
  waiting: readonly Rect[][], body: BodyClass = HEAVY): number | null {
  const { length, width } = BODY_ENVELOPE[body]!;
  const half = length / 2;
  const frameAt = (c: number) =>
    c < 0 ? inCentre.sampleAt(Math.max(0, inCentre.length + c))
      : c <= path.length ? path.sampleAt(c)
        : outCentre.sampleAt(Math.min(outCentre.length, c - path.length));
  let depth = 0;
  for (let c = -half; c <= path.length + half; c += SWEEP_STEP) {
    const at = frameAt(c);
    const f = { p: at.p, t: chordHeading(frameAt(c - HEADING_CHORD).p, frameAt(c + HEADING_CHORD).p, at.t) };
    for (const along of [-0.5, 0, 0.5]) {
      for (const across of [-0.5, 0.5]) {
        const p = {
          x: f.p.x + f.t.x * along * length - f.t.y * across * width,
          y: f.p.y + f.t.y * along * length + f.t.x * across * width,
        };
        if (!surface.contains(p)) return null;
      }
    }
    // Only once the body has started to turn: behind its own line it is in its
    // own lane, and a car beside it in the next lane is lane discipline.
    if (c < 0) continue;
    const body = rect(f.p, f.t, length, width);
    for (const lane of waiting) {
      for (let i = lane.length - 1; i >= 0; i--) {
        if (!overlap(body, lane[i]!)) continue;
        depth = Math.max(depth, (i + 1) * SWEEP_STEP);
        break;
      }
    }
  }
  return depth;
}

/**
 * The widest turn path whose swept body stays on the junction's surface.
 *
 * `surface` null (a node with no drawn plate, such as a tunnel) keeps the
 * conservative handle.
 */
export interface TurnPathResult {
  readonly path: Polyline;
  /** Largest physical body whose swept corners fit; -1 if even a small body cannot. */
  readonly maxBodyClass: BodyClass | -1;
}

export function turnPath(inCentre: Polyline, outCentre: Polyline, surface: JunctionSurface | null,
  waiting: readonly WaitingLane[] = []): TurnPathResult {
  if (!surface || surface.empty) return {
    path: bezierTurn(inCentre, outCentre, FALLBACK_HANDLE), maxBodyClass: HEAVY,
  };
  // Every rebuild re-derives every movement of every junction, and nearly all
  // of them are unchanged by an edit elsewhere. The chosen handle depends only
  // on the geometry the sweep reads - the approach and exit near the junction,
  // the waiting lanes, the surface - so it is memoised on a digest of exactly
  // that, and the path rebuilt from it is the same one a cold build makes.
  const key = `${laneEndKey(inCentre, true)}|${laneEndKey(outCentre, false)}|${surface.key}|` +
    waiting.map((lane) => laneEndKey(lane.centre, true, QUEUE_REACH)).join(',');
  const known = memo.get(key);
  if (known !== undefined) return {
    path: makeChoice(inCentre, outCentre, known.choice), maxBodyClass: known.maxBodyClass,
  };
  if (memo.size > MEMO_LIMIT) memo.clear();
  const choice = chooseTurn(inCentre, outCentre, surface, waiting);
  const path = makeChoice(inCentre, outCentre, choice);
  const maxBodyClass = ([HEAVY, 1, 0] as const).find((body) =>
    turnFits(inCentre, path, outCentre, surface, body)) ?? -1;
  memo.set(key, { choice, maxBodyClass });
  return { path, maxBodyClass };
}

/** Whether the selected movement contains a body of this size on its drawn surface. */
export function turnFits(inCentre: Polyline, path: Polyline, outCentre: Polyline,
  surface: JunctionSurface, body: BodyClass): boolean {
  return sweep(surface, inCentre, path, outCentre, [], body) !== null;
}

type TurnChoice = number | { x: number; y: number; share: number };
const memo = new Map<string, { choice: TurnChoice; maxBodyClass: BodyClass | -1 }>();
const MEMO_LIMIT = 50_000;
const makeChoice = (a: Polyline, b: Polyline, choice: TurnChoice): Polyline =>
  typeof choice === 'number' ? bezierTurn(a, b, choice) :
    twoPieceTurn(a, b, { x: choice.x, y: choice.y }, choice.share);

/** Two tangent-continuous cubics through a point inside the junction. */
function twoPieceTurn(inCentre: Polyline, outCentre: Polyline, middle: Vec2, share: number): Polyline {
  const start = inCentre.sampleAt(inCentre.length);
  const end = outCentre.sampleAt(0);
  const sum = { x: start.t.x + end.t.x, y: start.t.y + end.t.y };
  const tangent = normalize(len(sum) > GEO_EPS ? sum : sub(end.p, start.p));
  const cubic = (a: Vec2, b: Vec2, t0: Vec2, t1: Vec2): Vec2[] => {
    const reach = len(sub(b, a)) * share;
    const c0 = addScaled(a, t0, reach), c1 = addScaled(b, t1, -reach);
    const points: Vec2[] = [];
    for (let i = 0; i <= STEPS / 2; i++) {
      const t = i / (STEPS / 2), u = 1 - t;
      points.push({
        x: u * u * u * a.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * b.y,
      });
    }
    return points;
  };
  const first = cubic(start.p, middle, start.t, tangent);
  const second = cubic(middle, end.p, tangent, end.t);
  return Polyline.fromPoints([...first, ...second.slice(1)]);
}
/** Reach of the sweep along the approach and exit: half the largest body plus the heading chord. */
const LANE_REACH = BODY_ENVELOPE[HEAVY]!.length / 2 + HEADING_CHORD + SWEEP_STEP * 2;
/** Spacing of the samples a lane's digest is taken from, world units. */
const KEY_STEP = 1;
const laneKeys = new WeakMap<Polyline, Map<string, string>>();

/** Digest of a lane near its end (`atEnd`) or its start, over `reach`. */
function laneEndKey(lane: Polyline, atEnd: boolean, reach = LANE_REACH): string {
  let byReach = laneKeys.get(lane);
  const tag = `${atEnd ? 'e' : 's'}${reach}`;
  const cached = byReach?.get(tag);
  if (cached) return cached;
  const digest = new Digest();
  digest.add(lane.length);
  for (let d = 0; d <= reach; d += KEY_STEP) {
    const f = lane.sampleAt(atEnd ? Math.max(0, lane.length - d) : Math.min(lane.length, d));
    digest.point(f.p);
  }
  const end = lane.sampleAt(atEnd ? lane.length : 0).t;
  digest.point(end);
  const value = digest.value();
  if (!byReach) laneKeys.set(lane, (byReach = new Map()));
  byReach.set(tag, value);
  return value;
}

/** FNV-1a over numbers quantised to 1e-5, as two 32-bit lanes. */
class Digest {
  private a = 0x811c9dc5;
  private b = 0x01000193;
  add(n: number): void {
    const q = Math.round(n * 1e5);
    this.a = Math.imul(this.a ^ (q & 0xffff), 0x01000193) >>> 0;
    this.a = Math.imul(this.a ^ ((q >>> 16) & 0xffff), 0x01000193) >>> 0;
    this.b = Math.imul(this.b ^ q, 0x5bd1e995) >>> 0;
    this.b = (this.b ^ (this.b >>> 13)) >>> 0;
  }
  point(p: Vec2): void {
    this.add(p.x);
    this.add(p.y);
  }
  value(): string {
    return `${this.a.toString(36)}${this.b.toString(36)}`;
  }
}

/** The handle `turnPath` settles on, by sweeping the candidates. */
function chooseTurn(inCentre: Polyline, outCentre: Polyline, surface: JunctionSurface,
  waiting: readonly WaitingLane[]): TurnChoice {
  const fallback = bezierTurn(inCentre, outCentre, FALLBACK_HANDLE);
  // The fallback is also the shape every movement was built with before, so a
  // movement that fits at no shorter handle is exactly as it was - and no
  // rounder path may swing a body further over a waiting queue than it did.
  const queues = waiting.map(waitingBodies);
  const base = sweep(surface, inCentre, fallback, outCentre, queues);
  if (base === null) {
    // Even the old shape overruns (a bus round a tight bend): a squarer path
    // holds the lane longer before it turns, which is how a long vehicle is
    // actually driven round such a corner.
    for (const handle of SQUARER) {
      const path = bezierTurn(inCentre, outCentre, handle);
      if (sweep(surface, inCentre, path, outCentre, queues) !== null) return handle;
    }
    // One cubic cannot thread every acute two-leg mouth: in a seeded 72-degree
    // bend even the motorcycle's centreline left the asphalt by 2.7 units.
    // Search a small, deterministic grid of interior waypoints only for those
    // otherwise impossible movements. Every candidate retains the inlet and
    // outlet tangents; the same swept-heavy-body test decides if it is safe.
    let alternate: { choice: TurnChoice; depth: number } | null = null;
    const offsets: Vec2[] = [];
    for (const dx of [-10, -5, 0, 5, 10]) for (const dy of [-10, -5, 0, 5, 10])
      offsets.push({ x: dx, y: dy });
    offsets.sort((a, b) => a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y || a.x - b.x || a.y - b.y);
    for (const offset of offsets) {
      const point = { x: surface.centre.x + offset.x, y: surface.centre.y + offset.y };
      if (!surface.contains(point)) continue;
      for (const share of [0.3, 0.4]) {
        const candidate = twoPieceTurn(inCentre, outCentre, point, share);
        const depth = sweep(surface, inCentre, candidate, outCentre, queues);
        if (depth === null) continue;
        const choice = { ...point, share };
        if (depth === 0) return choice;
        if (!alternate || depth < alternate.depth) alternate = { choice, depth };
      }
    }
    return alternate?.choice ?? FALLBACK_HANDLE;
  }
  for (const handle of HANDLES) {
    if (handle === FALLBACK_HANDLE) return FALLBACK_HANDLE;
    const path = bezierTurn(inCentre, outCentre, handle);
    const depth = sweep(surface, inCentre, path, outCentre, queues);
    if (depth !== null && depth <= base) return handle;
  }
  return FALLBACK_HANDLE;
}
