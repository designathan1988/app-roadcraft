import { clamp } from '@core/scalar';
import { m } from '@world/units';
import { streetFurniture } from '@world/streetFurniture';
import { DT } from '../params';
import type { SimWorld } from '../world';
import { pedHash } from './behaviour';
import type { SidewalkEdge, SidewalkEdgeId } from './sidewalk';
import type { Ped, PedActivity } from './state';

/**
 * What people do in the street besides walking through it.
 *
 * Pedestrians used to do exactly one thing: walk to a randomly drawn kerb,
 * sometimes pause on arrival, draw another. Nobody sat on the benches along
 * the footway, nobody stopped to look at anything, and a pause was a figure
 * standing where it happened to arrive. This module gives the places in the
 * street something to be used for:
 *
 *   BENCHES   A walker on a footway with a bench ahead may go and sit on it:
 *             walk up to it, step off the walking line in front of a free
 *             seat, turn round, sit down, sit a while, stand up and step back
 *             on. Older people are far likelier to than anyone else.
 *   STOPS     A walker may stop at the side of the footway — out of the way,
 *             on the far side from the kerb — to look at the street or to
 *             read a phone, and then walk on.
 *   TALK      A party walking along a footway may stop on it together, and
 *             one stopping on arriving somewhere does too; its members turn
 *             to face one another (`crossingFsm.ts`) and the renderer has
 *             them take turns talking and listening.
 *
 * Every decision is a hash of the person, the footway and the trip, the same
 * scheme as the rest of the pedestrian traits: deterministic, and never the
 * same sequence for everybody. None of it can loosen a crossing rule — it is
 * only ever consulted on a footway, never at a kerb or on a zebra.
 */

/** One bench beside a footway, in that footway edge's own frame. */
interface Bench {
  readonly id: number;
  /** Arc position along the edge from `edge.from`. */
  readonly s: number;
  /** Signed lateral side of the bench, relative to the path from `edge.from`. */
  readonly side: number;
  /**
   * Where a sitter's hips go, one per seat, and where along the footway they
   * step off towards it: past the seat, away from the middle of the bench,
   * because the lamp column stands right behind that middle and the straight
   * way from the footway to a seat brushed past it.
   */
  readonly seats: readonly { x: number; y: number; stepOff: number }[];
  /** Heading a sitter faces: away from the backrest, towards the footway. */
  readonly face: number;
}

interface Index {
  net: number;
  doc: number;
  benches: Map<SidewalkEdgeId, Bench[]>;
  /** Signed lateral side of the carriageway, per footway edge, from `edge.from`. */
  road: Map<SidewalkEdgeId, number>;
  /** Seats taken, `bench:seat` to the person on it. */
  taken: Map<string, number>;
}
const INDEX = new WeakMap<SimWorld, Index>();

/** Seat spacing either side of a bench's centre, and how far in front of the seat a sitter stands. */
const SEAT_OFFSET = m(0.45);
const STAND_IN_FRONT = m(0.48);

function index(w: SimWorld): Index {
  const cached = INDEX.get(w);
  if (cached && cached.net === w.net.revision && cached.doc === w.doc.revision) return cached;
  const built: Index = { net: w.net.revision, doc: w.doc.revision, benches: new Map(), road: new Map(),
    taken: new Map() };
  const edgesOf = new Map<number, SidewalkEdge[]>();
  for (const edge of w.sidewalks.edges.values()) {
    if (edge.kind !== 'walk' || edge.segment === undefined) continue;
    const list = edgesOf.get(edge.segment) ?? [];
    list.push(edge);
    edgesOf.set(edge.segment, list);
    // Which side of this footway the carriageway is on.
    const ribbon = w.net.ribbons.get(edge.segment);
    if (ribbon) {
      const mid = edge.path.sampleAt(edge.path.length / 2);
      const centre = ribbon.full.closestPoint(mid.p).point;
      const toRoad = (centre.x - mid.p.x) * -mid.t.y + (centre.y - mid.p.y) * mid.t.x;
      built.road.set(edge.id, toRoad >= 0 ? 1 : -1);
    }
  }
  let id = 0;
  for (const item of streetFurniture(w.net)) {
    if (item.kind !== 'bench') continue;
    let best: { edge: SidewalkEdge; s: number; distance: number; side: number } | null = null;
    for (const edge of edgesOf.get(item.segment) ?? []) {
      const hit = edge.path.closestPoint(item);
      if (best && hit.distance >= best.distance) continue;
      const t = edge.path.sampleAt(hit.s).t;
      const side = (item.x - hit.point.x) * -t.y + (item.y - hit.point.y) * t.x >= 0 ? 1 : -1;
      best = { edge, s: hit.s, distance: hit.distance, side };
    }
    // A bench beyond reach of the footway is scenery, not a seat.
    if (!best || best.distance > best.edge.halfWidth + m(3)) continue;
    const edge = best.edge;
    const seats = [-1, 1].map((k) => {
      const x = item.x + item.along.x * SEAT_OFFSET * k;
      const y = item.y + item.along.y * SEAT_OFFSET * k;
      const s = edge.path.closestPoint({ x, y }).s;
      return { x, y, stepOff: clamp(s + (s - best.s), 0, edge.length) };
    });
    const list = built.benches.get(best.edge.id) ?? [];
    list.push({ id: id++, s: best.s, side: best.side, seats, face: Math.atan2(-item.outward.y, -item.outward.x) });
    built.benches.set(best.edge.id, list);
  }
  for (const list of built.benches.values()) list.sort((a, b) => a.s - b.s);
  // Keep the seats of whoever still sits: a rebuild of the scenery for an
  // unrelated edit must not seat two people in one place.
  if (cached) {
    for (const [seat, ped] of cached.taken) if (w.peds.get(ped)?.activity?.seat === seat) built.taken.set(seat, ped);
  }
  INDEX.set(w, built);
  return built;
}

/** Seconds the Rocketbox sit-down and stand-up take, per sex; the renderer plays them to this clock. */
export const SIT_DOWN_SECONDS = { m: 2.9, f: 4.9 } as const;
export const STAND_UP_SECONDS = { m: 2.5, f: 3.33 } as const;

/** Chance a walker on a footway with a free bench ahead goes to sit on it. */
const BENCH_CHANCE = { child: 0, adult: 0.16, elder: 0.45 } as const;
/** Chance a walker stops at the side of a footway to look or read a phone. */
const STOP_CHANCE = { child: 0.04, adult: 0.12, elder: 0.08 } as const;
/** Chance a party walking along a footway stops on it to talk. */
const TALK_CHANCE = 0.16;
/** Seconds a party stands talking. */
const TALK_RANGE = [8, 24] as const;
/** Shortest footway worth stopping on, and room kept from its ends. */
const STOP_MIN_EDGE = m(24);
const STOP_END_ROOM = m(6);
/** Seconds spent sitting, and stopped at the side. */
const SIT_RANGE = [14, 48] as const;
const STOP_RANGE = [4, 11] as const;
/** Walking pace of the few steps between the footway and a seat. */
const STEP_PACE = m(0.75);
/** Distance from a stopping place at which a walker counts as arrived. */
const ARRIVE = m(0.3);

const strHash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
const unit = (h: number, shift: number): number => ((h >>> shift) & 0xffff) / 0x10000;

/**
 * Considers, on walking onto a footway, whether this walker stops somewhere
 * along it: alone, to sit on a bench or to stop at the side; in a party, to
 * stand and talk together.
 */
export function considerActivity(w: SimWorld, p: Ped, edge: SidewalkEdge): void {
  if (p.activity || p.pause > 0 || p.state !== 'Walking' || edge.kind !== 'walk') return;
  // Once per footway walked: the decision is taken on the first tick walking
  // it, which is usually the tick after stepping off a crossing, not the one
  // that stepped onto it.
  const key = `${edge.id}#${p.trip}#${p.entry}`;
  if (CONSIDERED.get(p) === key) return;
  CONSIDERED.set(p, key);
  if (p.party.size > 1) { considerTalk(p, edge); return; }
  if (p.trailing !== null) return;
  const h = pedHash(p.id ^ strHash(edge.id) ^ Math.imul(p.trip + 1, 0x9e3779b1));
  const forward = p.entry === edge.from;
  const along = (s: number): number => (forward ? s : edge.length - s);

  if (unit(h, 0) < BENCH_CHANCE[p.ageClass]) {
    const idx = index(w);
    for (const bench of forward ? (idx.benches.get(edge.id) ?? []) : [...(idx.benches.get(edge.id) ?? [])].reverse()) {
      const first = (h >>> 20) & 1;
      for (const k of [first, 1 - first]) {
        const key = `${bench.id}:${k}`;
        if (idx.taken.has(key)) continue;
        const seat = bench.seats[k]!;
        const at = along(seat.stepOff);
        if (at < p.s + m(4) || at > edge.length - m(2)) continue;
        idx.taken.set(key, p.id);
        p.activity = start('bench', at, (forward ? bench.side : -bench.side), bench.face, key,
          seat.x + Math.cos(bench.face) * STAND_IN_FRONT, seat.y + Math.sin(bench.face) * STAND_IN_FRONT,
          SIT_RANGE[0] + (SIT_RANGE[1] - SIT_RANGE[0]) * unit(h, 8));
        return;
      }
    }
    return;
  }
  if (unit(h, 16) < STOP_CHANCE[p.ageClass] && edge.length >= STOP_MIN_EDGE) {
    const room = edge.length - STOP_END_ROOM;
    const from = Math.max(p.s + m(6), STOP_END_ROOM);
    if (from >= room) return;
    const at = from + (room - from) * unit(h, 4);
    const roadSide = (index(w).road.get(edge.id) ?? 1) * (forward ? 1 : -1);
    // Out of the way: on the side of the footway away from the kerb.
    p.activity = start((h >>> 30) & 1 ? 'look' : 'phone', at, -roadSide, null, null, 0, 0,
      STOP_RANGE[0] + (STOP_RANGE[1] - STOP_RANGE[0]) * unit(h, 12));
  }
}

/** The footway, trip and direction each walker last decided on. */
const CONSIDERED = new WeakMap<Ped, string>();

/**
 * A party may stop along a footway to talk. Keyed on the party and the
 * footway, so every member reaches the same decision about the same place
 * and they stop there together; each keeps their own place abreast.
 */
function considerTalk(p: Ped, edge: SidewalkEdge): void {
  if (edge.length < STOP_MIN_EDGE) return;
  const h = pedHash(p.party.id ^ strHash(edge.id) ^ Math.imul(p.trip + 3, 0x85ebca6b));
  if (unit(h, 0) >= TALK_CHANCE) return;
  const room = edge.length - STOP_END_ROOM;
  const at = STOP_END_ROOM + (room - STOP_END_ROOM) * (0.3 + 0.4 * unit(h, 16));
  if (p.s > at - m(3)) return;
  p.activity = start('talk', at, 0, null, null, 0, 0, TALK_RANGE[0] + (TALK_RANGE[1] - TALK_RANGE[0]) * unit(h, 8));
}

function start(kind: PedActivity['kind'], at: number, side: number, face: number | null, seat: string | null,
  spotX: number, spotY: number, hold: number): PedActivity {
  return { kind, phase: 'approach', t: 0, hold, at, side, face, seat, spotX, spotY, fromX: 0, fromY: 0, move: 0 };
}

/** Starts a stop made on arriving somewhere: talking with the party, or looking round alone. */
export function arrivalActivity(p: Ped, seconds: number): void {
  if (seconds <= 0 || p.activity) return;
  const h = pedHash(p.party.id ^ Math.imul(p.trip + 7, 0x85ebca6b));
  const kind = p.party.size > 1 ? 'talk' : (h & 3) === 0 ? 'phone' : 'look';
  p.activity = { ...start(kind, p.s, 0, null, null, 0, 0, seconds), phase: 'hold' };
}

/** Frees whatever the activity held, and ends it. */
export function endActivity(w: SimWorld, p: Ped): void {
  const seat = p.activity?.seat;
  if (seat) {
    const idx = INDEX.get(w);
    if (idx?.taken.get(seat) === p.id) idx.taken.delete(seat);
  }
  p.activity = null;
}

/**
 * Advances the activity by one tick, before the walker's own speed is chosen.
 * Returns the largest speed the walker may have on the footway this tick,
 * or null to leave it to the ordinary rules.
 */
export function stepActivity(w: SimWorld, p: Ped, edge: SidewalkEdge, stopWithin: (d: number) => number): number | null {
  const a = p.activity;
  if (!a) return null;
  // Carried off the footway it was planned on — a repath, a rebuilt network —
  // a stop that is no longer ahead is simply given up.
  if (a.phase === 'approach' && (edge.kind !== 'walk' || p.state !== 'Walking')) { endActivity(w, p); return null; }
  if (a.seat && INDEX.get(w)?.taken.get(a.seat) !== p.id) { endActivity(w, p); return null; }
  a.t += DT;
  switch (a.phase) {
    case 'approach': {
      const remaining = a.at - p.s;
      if (remaining < -m(1.5)) { endActivity(w, p); return null; }
      if (remaining <= ARRIVE && p.v < m(0.2)) {
        a.t = 0;
        a.fromX = p.x;
        a.fromY = p.y;
        a.phase = a.kind === 'bench' ? 'step' : 'hold';
        return 0;
      }
      return stopWithin(Math.max(0, remaining - ARRIVE * 0.5));
    }
    case 'hold':
      if (a.t >= a.hold) endActivity(w, p);
      return 0;
    case 'step':
    case 'leave': {
      const length = Math.hypot(a.spotX - a.fromX, a.spotY - a.fromY);
      a.move = STEP_PACE;
      if (a.t * STEP_PACE >= length) {
        a.t = 0;
        a.move = 0;
        if (a.phase === 'step') a.phase = 'turn';
        else endActivity(w, p);
      }
      return 0;
    }
    case 'turn': {
      const face = a.face ?? p.heading;
      const off = Math.abs(Math.atan2(Math.sin(face - p.heading), Math.cos(face - p.heading)));
      if (off < 0.06 && Math.abs(p.turnV) < 0.25) { a.t = 0; a.phase = 'sitDown'; }
      return 0;
    }
    case 'sitDown':
      if (a.t >= SIT_DOWN_SECONDS[p.gender]) { a.t = 0; a.phase = 'seated'; }
      return 0;
    case 'seated':
      if (a.t >= a.hold) { a.t = 0; a.phase = 'standUp'; }
      return 0;
    case 'standUp':
      if (a.t >= STAND_UP_SECONDS[p.gender]) { a.t = 0; a.phase = 'leave'; }
      return 0;
  }
  return null;
}

/**
 * Where the body is while the activity has taken it off the walking line,
 * and which way it wants to face; null while it is on the footway.
 */
export function activityAnchor(p: Ped): { x: number; y: number; face: number } | null {
  const a = p.activity;
  if (!a || a.kind !== 'bench') return null;
  switch (a.phase) {
    case 'step':
    case 'leave': {
      const [fx, fy, tx, ty] = a.phase === 'step'
        ? [a.fromX, a.fromY, a.spotX, a.spotY] : [a.spotX, a.spotY, a.fromX, a.fromY];
      const length = Math.hypot(tx - fx, ty - fy);
      const k = length > 1e-6 ? clamp((a.t * STEP_PACE) / length, 0, 1) : 1;
      return { x: fx + (tx - fx) * k, y: fy + (ty - fy) * k, face: Math.atan2(ty - fy, tx - fx) };
    }
    case 'turn':
    case 'sitDown':
    case 'seated':
    case 'standUp':
      return { x: a.spotX, y: a.spotY, face: a.face ?? p.heading };
    default:
      return null;
  }
}

/** Heading a person stopped at the side of a footway faces: the street, for someone looking at it. */
export function holdFacing(w: SimWorld, p: Ped, edge: SidewalkEdge): number | null {
  const a = p.activity;
  if (!a || a.phase !== 'hold' || a.kind !== 'look' || edge.kind !== 'walk' || a.side === 0) return null;
  const t = w.sidewalks.orientedPath(edge, p.entry).sampleAt(p.s).t;
  // Towards the kerb, half turned: somebody watching the street, not the wall.
  const towards = -a.side;
  const normal = Math.atan2(t.x * towards, -t.y * towards);
  return normal + Math.atan2(Math.sin(Math.atan2(t.y, t.x) - normal), Math.cos(Math.atan2(t.y, t.x) - normal)) * 0.35;
}
