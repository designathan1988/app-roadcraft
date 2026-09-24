import { clamp } from '@core/scalar';
import { m } from '@world/units';
import { blocksPedestrians, streetFurniture } from '@world/streetFurniture';
import { signalPosts } from '@world/signalPosts';
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
  /** Arc positions from `edge.from` of the street furniture standing on each footway, sorted. */
  furniture: Map<SidewalkEdgeId, number[]>;
}
const INDEX = new WeakMap<SimWorld, Index>();

/** Seat spacing either side of a bench's centre, and how far in front of the seat a sitter stands. */
const SEAT_OFFSET = m(0.45);
const STAND_IN_FRONT = m(0.48);

/** How far beyond a footway's half-width street furniture still counts as standing on it. */
const FURNITURE_REACH = m(2);

function index(w: SimWorld): Index {
  const cached = INDEX.get(w);
  if (cached && cached.net === w.net.revision && cached.doc === w.doc.revision) return cached;
  const built: Index = { net: w.net.revision, doc: w.doc.revision, benches: new Map(), road: new Map(),
    taken: new Map(), furniture: new Map() };
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
  const walks: { edge: SidewalkEdge; box: { x0: number; y0: number; x1: number; y1: number } }[] = [];
  for (const edge of w.sidewalks.edges.values()) {
    if (edge.kind !== 'walk') continue;
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let i = 0; i < edge.path.n; i++) {
      const q = edge.path.point(i);
      box.x0 = Math.min(box.x0, q.x); box.y0 = Math.min(box.y0, q.y);
      box.x1 = Math.max(box.x1, q.x); box.y1 = Math.max(box.y1, q.y);
    }
    const pad = edge.halfWidth + FURNITURE_REACH;
    box.x0 -= pad; box.y0 -= pad; box.x1 += pad; box.y1 += pad;
    walks.push({ edge, box });
  }
  // Signal posts are furniture a talking circle must keep clear of too: they
  // stand on the footway beside every signalised crossing.
  for (const post of signalPosts(w.net, w.graph)) {
    for (const { edge, box } of walks) {
      if (post.x < box.x0 || post.x > box.x1 || post.y < box.y0 || post.y > box.y1) continue;
      const hit = edge.path.closestPoint(post);
      if (hit.distance > edge.halfWidth + FURNITURE_REACH) continue;
      const list = built.furniture.get(edge.id) ?? [];
      list.push(hit.s);
      built.furniture.set(edge.id, list);
    }
  }
  let id = 0;
  for (const item of streetFurniture(w.net)) {
    if (blocksPedestrians(item)) {
      // Every footway it stands on or beside, whichever road it was placed
      // for: a lamp at a corner belongs to one road and stands on the
      // footway of the next.
      for (const { edge, box } of walks) {
        if (item.x < box.x0 || item.x > box.x1 || item.y < box.y0 || item.y > box.y1) continue;
        const hit = edge.path.closestPoint(item);
        // Generously: the walls a walker is held between are fitted to the
        // footway as drawn and can reach past `halfWidth`, and a lamp column
        // behind a bench still stands in a circle beside it.
        if (hit.distance > edge.halfWidth + FURNITURE_REACH) continue;
        const list = built.furniture.get(edge.id) ?? [];
        list.push(hit.s);
        built.furniture.set(edge.id, list);
      }
    }
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
  for (const list of built.furniture.values()) list.sort((a, b) => a - b);
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
  if (p.party.size > 1) { considerTalk(w, p, edge); return; }
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
 * footway, so every member reaches the same decision about the same place,
 * and taken for every companion walking the footway with this one at once:
 * a party used to stop member by member, each where the decision happened to
 * find them, and the one who had already passed the place walked on alone.
 */
function considerTalk(w: SimWorld, p: Ped, edge: SidewalkEdge): void {
  if (edge.length < STOP_MIN_EDGE) return;
  const h = pedHash(p.party.id ^ strHash(edge.id) ^ Math.imul(p.trip + 3, 0x85ebca6b));
  if (unit(h, 0) >= TALK_CHANCE) return;
  const room = edge.length - STOP_END_ROOM;
  const at = clearSpot(w, edge, p.entry === edge.from,
    STOP_END_ROOM + (room - STOP_END_ROOM) * (0.3 + 0.4 * unit(h, 16)), room);
  if (at === null) return;
  const party = companionsOn(w, p, edge);
  for (const q of party) if (q.s > at - m(3)) return;
  const hold = TALK_RANGE[0] + (TALK_RANGE[1] - TALK_RANGE[0]) * unit(h, 8);
  for (const q of party) {
    q.activity = start('talk', at, 0, null, null, 0, 0, hold);
    CONSIDERED.set(q, `${edge.id}#${q.trip}#${q.entry}`);
  }
}

/** This walker and every companion walking the same footway the same way, free to stop. */
function companionsOn(w: SimWorld, p: Ped, edge: SidewalkEdge): Ped[] {
  const out = [p];
  for (let k = 0; k < p.party.size; k++) {
    const q = w.peds.get(p.party.id + k);
    if (!q || q === p || q.party !== p.party || q.edge !== edge.id || q.entry !== p.entry) continue;
    if (q.state !== 'Walking' || q.activity || q.pause > 0) continue;
    out.push(q);
  }
  return out;
}

function start(kind: PedActivity['kind'], at: number, side: number, face: number | null, seat: string | null,
  spotX: number, spotY: number, hold: number): PedActivity {
  return { kind, phase: 'approach', t: 0, hold, at, side, face, seat, spotX, spotY, fromX: 0, fromY: 0, move: 0,
    slotS: at, slotLat: 0, faceX: 0, faceY: 0, slot: -1 };
}

/**
 * Starts a stop made on arriving somewhere: a party stops a step or two on
 * and stands talking, together; somebody alone looks round or reads a phone
 * where they are, for `seconds`.
 */
export function arrivalActivity(w: SimWorld, p: Ped, seconds: number): void {
  if (seconds <= 0 || p.activity) return;
  const edge = w.sidewalks.edges.get(p.edge);
  if (!edge) return;
  if (p.party.size > 1) {
    // Only on a footway proper, with room to stand clear of the corner.
    if (edge.kind !== 'walk' || p.state !== 'Walking') return;
    const party = companionsOn(w, p, edge);
    let lead = 0;
    for (const q of party) lead = Math.max(lead, q.s);
    const at = clearSpot(w, edge, p.entry === edge.from, lead + m(1.5), edge.length - ARRIVAL_END_ROOM);
    if (at === null) return;
    for (const q of party) {
      q.activity = start('talk', at, 0, null, null, 0, 0, seconds);
      CONSIDERED.set(q, `${edge.id}#${q.trip}#${q.entry}`);
    }
    return;
  }
  p.pause = seconds;
  const h = pedHash(p.party.id ^ Math.imul(p.trip + 7, 0x85ebca6b));
  p.activity = { ...start((h & 3) === 0 ? 'phone' : 'look', p.s, 0, null, null, 0, 0, seconds), phase: 'hold' };
}
/**
 * The first place at or beyond `at`, and not beyond `limit`, where a party
 * can stand talking without a lamp column, a bin or a tree in the middle of
 * it; null if there is none. Arc positions along the walker's direction.
 */
function clearSpot(w: SimWorld, edge: SidewalkEdge, forward: boolean, at: number, limit: number): number | null {
  const items = index(w).furniture.get(edge.id);
  let spot = at;
  if (items) {
    for (let moved = true, guard = 0; moved && guard < 8; guard++) {
      moved = false;
      for (const s of items) {
        const along = forward ? s : edge.length - s;
        if (Math.abs(along - spot) < TALK_CLEAR) { spot = along + TALK_CLEAR; moved = true; }
      }
    }
  }
  return spot <= limit ? spot : null;
}
/** Distance along the footway kept between a talking circle's centre and any street furniture. */
const TALK_CLEAR = m(1.6);
/** Room kept between a party stopping on arrival and the end of the footway, where a kerb or corner begins. */
const ARRIVAL_END_ROOM = m(2.5);

// ----------------------------------------------------------------- talking

/**
 * Centre-to-centre distance between two people talking face to face, and
 * between an adult and a child; and between neighbours round a circle of
 * three or more. Conversational distance is roughly 0.9 to 1.2 m between
 * people who know each other (Hall's "personal" zone). The old stop left a
 * party where it was walking — shoulder to shoulder, 0.7 m apart, three in a
 * row — and the one in the middle, whose companions averaged out to its own
 * position, faced nobody at all.
 */
const TALK_PAIR = m(1.1);
const TALK_CHILD = m(0.95);
const TALK_RING = m(1.0);
/**
 * Angle between a talking pair and the footway, radians: they stand at a
 * slant, neither squarely across the footway — blocking it — nor one
 * behind the other as if queueing.
 */
const PAIR_SKEW = 0.55;
/** Pace of the step or two that closes a circle up once standing, u/s. */
const SHUFFLE = m(0.35);
/** Lateral distance from one's place in the circle that counts as there. */
const TALK_ARRIVE_SIDE = m(0.2);
/** Seconds stood at one's place, still off it sideways, before settling for where one is. */
const TALK_SETTLE = 1.5;
/** Distance from one's place within which standing still counts as arriving, and the seconds it takes. */
const TALK_NEAR = m(2);
const TALK_GIVE_UP = 4;
/** Seconds one member may stand talking with nobody before giving up on it. */
const TALK_ALONE = 2;
/** Clearance kept between a talking circle and the edge of the footway. */
const TALK_WALL = m(0.1);

/**
 * One party talking: where on its footway the circle stands, and for how
 * long it has been talking. `cs` only ever grows — a member can step
 * forward to its place, never back (`Ped.s` is monotone).
 */
interface TalkGroup {
  edge: SidewalkEdgeId;
  entry: string;
  cs: number;
  /** Seconds at least two members have stood talking. */
  t: number;
  /** Seconds a single member has stood with nobody to talk to. */
  alone: number;
  /** Members the places were last handed out for. */
  n: number;
  members: Ped[];
}
const TALKS = new WeakMap<SimWorld, Map<number, TalkGroup>>();
const FRAME = { x: 0, y: 0, tx: 1, ty: 0, nx: 0, ny: 1 };
const WALLS = { lo: 0, hi: 0 };

/**
 * Lays every talking party out in a circle — face to face for two, an open
 * ring round a shared centre for three or four — at the side of the footway
 * away from the kerb, and ends the conversation when its time is up, for
 * every member at once. Run once per tick before anybody moves; each
 * member's place (`slotS`, `slotLat`) and the point it faces (`faceX`,
 * `faceY`) are then read by the ordinary steering.
 */
export function planTalks(w: SimWorld, peds: readonly Ped[]): void {
  let groups = TALKS.get(w);
  if (!groups) { groups = new Map(); TALKS.set(w, groups); }
  for (const g of groups.values()) g.members.length = 0;
  for (const p of peds) {
    const a = p.activity;
    if (a?.kind !== 'talk') continue;
    let g = groups.get(p.party.id);
    if (!g) {
      g = { edge: p.edge, entry: p.entry, cs: a.at, t: 0, alone: 0, n: 0, members: [] };
      groups.set(p.party.id, g);
    }
    // Carried onto another footway than the rest of the party: this one is
    // not in the conversation any more.
    if (p.edge !== g.edge || p.entry !== g.entry) { endActivity(w, p); continue; }
    g.members.push(p);
  }
  for (const [id, g] of groups) {
    if (!g.members.length) { groups.delete(id); continue; }
    const edge = w.sidewalks.edges.get(g.edge);
    if (!edge) { for (const q of g.members) endActivity(w, q); groups.delete(id); continue; }
    layoutTalk(w, g, edge);
  }
}

function layoutTalk(w: SimWorld, g: TalkGroup, edge: SidewalkEdge): void {
  const members = g.members;
  const n = members.length;
  members.sort((a, b) => a.id - b.id);
  const rev = g.entry !== edge.from;
  let holding = 0;
  for (const q of members) if (q.activity!.phase === 'hold') holding++;

  if (n === 1 || n > MAX_RING) {
    // Waiting at the place for the others, or left on one's own.
    for (const q of members) {
      const a = q.activity!;
      a.slotS = Math.max(g.cs, q.s);
      a.slotLat = q.lat;
      a.slot = -1;
    }
    g.n = 0;
    g.alone = holding > 0 ? g.alone + DT : 0;
    if (g.alone > TALK_ALONE) for (const q of members) endActivity(w, q);
    return;
  }
  g.alone = 0;

  // The circle: face to face for two, a ring for more, slanted for a pair so
  // that neither stands squarely across the footway nor behind the other.
  const child = members.some((q) => q.ageClass === 'child');
  const radius = n === 2 ? (child ? TALK_CHILD : TALK_PAIR) / 2 : TALK_RING / (2 * Math.sin(Math.PI / n));
  const first = n === 2 ? PAIR_SKEW : n === 4 ? Math.PI / 4 : 0;
  let reach = 0;
  for (let k = 0; k < n; k++) {
    const angle = first + (2 * Math.PI * k) / n;
    RING_ALONG[k] = Math.cos(angle) * radius;
    RING_ACROSS[k] = Math.sin(angle) * radius;
    reach = Math.max(reach, Math.abs(RING_ACROSS[k]!));
  }

  // Across the footway: on the side away from the kerb, clear of the wall,
  // squeezed only if the footway is narrower than the circle.
  const inward = -(index(w).road.get(edge.id) ?? 1) * (rev ? -1 : 1);
  const across = (): { centre: number; squeeze: number } => {
    edge.corridor.bounds(g.cs, rev, WALLS);
    const lo = WALLS.lo + TALK_WALL;
    const hi = WALLS.hi - TALK_WALL;
    if (hi - lo <= 2 * reach) return { centre: (lo + hi) / 2, squeeze: reach > 0 ? Math.max(0, (hi - lo) / 2) / reach : 1 };
    return { centre: inward > 0 ? hi - reach : lo + reach, squeeze: 1 };
  };
  let side = across();

  // Hand out the places. Whoever is standing keeps theirs; the rest take the
  // free ones in the order they walk up — the one in front the place furthest
  // on, companions level with each other by the side each is on — so nobody
  // is sent round, or through, a companion to reach theirs.
  const held = new Set<number>();
  if (g.n === n) for (const q of members) if (q.activity!.phase === 'hold' && q.activity!.slot >= 0) held.add(q.activity!.slot);
  if (g.n !== n) held.clear();
  const free: number[] = [];
  for (let k = 0; k < n; k++) if (!held.has(k)) free.push(k);
  free.sort((a, b) => RING_ALONG[b]! - RING_ALONG[a]! > SLOT_TIE ? 1 : RING_ALONG[a]! - RING_ALONG[b]! > SLOT_TIE ? -1
    : RING_ACROSS[b]! - RING_ACROSS[a]!);
  const walking = members.filter((q) => g.n !== n || q.activity!.phase !== 'hold' || q.activity!.slot < 0);
  walking.sort((a, b) => b.s - a.s > SLOT_TIE ? 1 : a.s - b.s > SLOT_TIE ? -1 : b.lat - a.lat);
  walking.forEach((q, i) => { q.activity!.slot = free[i]!; });
  g.n = n;
  // Only ever forward: a member already past its place moves the circle on.
  const before = g.cs;
  for (const q of members) {
    const a = q.activity!;
    const along = RING_ALONG[a.slot]!;
    if (a.phase === 'hold' || q.s > g.cs + along) g.cs = Math.max(g.cs, q.s - along);
  }
  if (g.cs !== before) side = across();

  edge.corridor.place(g.cs, side.centre, rev, FRAME);
  for (const q of members) {
    const a = q.activity!;
    a.slotS = Math.min(edge.length - m(0.3), Math.max(q.s, g.cs + RING_ALONG[a.slot]!));
    a.slotLat = clamp(side.centre + RING_ACROSS[a.slot]! * side.squeeze, WALLS.lo, WALLS.hi);
    a.faceX = FRAME.x;
    a.faceY = FRAME.y;
  }

  if (holding >= 2) g.t += DT;
  const hold = members[0]!.activity!.hold;
  if (g.t >= hold) for (const q of members) endActivity(w, q);
}

/** Largest party laid out in a ring; parties are at most four. */
const MAX_RING = 4;
const RING_ALONG = new Float64Array(MAX_RING);
const RING_ACROSS = new Float64Array(MAX_RING);
/** Difference in arc position below which two places, or two people, count as level. */
const SLOT_TIE = m(0.3);

/**
 * One tick of a member's part in a conversation: walking to its place,
 * then standing there, stepping in when the circle closes up. The speed cap
 * it returns is what the walking rules then obey.
 */
function stepTalk(w: SimWorld, p: Ped, a: PedActivity, stopWithin: (d: number) => number): number | null {
  if (a.phase === 'approach' && p.state !== 'Walking') { endActivity(w, p); return null; }
  a.t += DT;
  const remaining = a.slotS - p.s;
  if (a.phase === 'approach') {
    // Seconds stood still near the place: settled into it, or unable to get
    // any closer past whoever is in the way, and talking from where one is.
    a.move = p.v < m(0.2) && remaining < TALK_NEAR ? a.move + DT : 0;
    const there = remaining <= ARRIVE &&
      (Math.abs(a.slotLat - p.lat) < TALK_ARRIVE_SIDE || a.move > TALK_SETTLE);
    // The first to arrive waits for a companion before starting to talk: it
    // used to stand talking to nobody while the rest of the party, held up
    // behind, were still walking up.
    if (there && p.v < m(0.2) && !companionThere(w, p) && a.move <= TALK_GIVE_UP) return 0;
    if ((there && p.v < m(0.2)) || a.move > TALK_GIVE_UP) {
      a.phase = 'hold';
      a.t = 0;
      a.move = 0;
      return 0;
    }
    return remaining <= ARRIVE ? 0 : stopWithin(Math.max(0, remaining - ARRIVE * 0.5));
  }
  return remaining > m(0.12) ? Math.min(SHUFFLE, stopWithin(remaining - m(0.05))) : 0;
}

/** Whether another member of this party is at the conversation already, or arriving. */
function companionThere(w: SimWorld, p: Ped): boolean {
  for (let k = 0; k < p.party.size; k++) {
    const q = w.peds.get(p.party.id + k);
    if (!q || q === p || q.party !== p.party || q.activity?.kind !== 'talk') continue;
    if (q.activity.phase === 'hold' || q.activity.slotS - q.s <= ARRIVE) return true;
  }
  return false;
}

/**
 * The heading of the centre of this person's conversation, once they are at
 * their place in it; null while they are still walking to it.
 */
export function talkFacing(p: Ped): number | null {
  const a = p.activity;
  if (a?.kind !== 'talk' || a.slot < 0) return null;
  if (a.phase !== 'hold' && !(a.slotS - p.s < ARRIVE && p.v < m(0.25))) return null;
  const dx = a.faceX - p.x, dy = a.faceY - p.y;
  if (Math.hypot(dx, dy) < m(0.15)) return null;
  return Math.atan2(dy, dx);
}

/** The offset across the footway a talking member heads for, or null while its place is still far ahead. */
export function talkLateral(p: Ped): number | null {
  const a = p.activity;
  if (a?.kind !== 'talk' || a.slot < 0 || a.slotS - p.s > TALK_LINE_UP) return null;
  return a.slotLat;
}
/** Distance before its place at which a talking member moves across the footway to it. */
const TALK_LINE_UP = m(4);

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
  if (a.kind === 'talk') return stepTalk(w, p, a, stopWithin);
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
