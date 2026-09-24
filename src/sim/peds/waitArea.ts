import { m } from '@world/units';
import { blocksPedestrians, streetFurniture } from '@world/streetFurniture';
import { signalPosts } from '@world/signalPosts';
import type { SimWorld } from '../world';
import type { Ped } from './state';
import type { SidewalkEdge, SidewalkEdgeId, SidewalkNodeId } from './sidewalk';

/**
 * WHERE PEOPLE WAIT TO CROSS: a lattice of standing places at each kerb.
 *
 * Everybody waiting for a zebra used to be sent to one point - the end of
 * their footway, beside the mouth of the crossing - so a waiting crowd stood
 * body against body, 0.4 m apart centre to centre, in a clump round the signal
 * post. People waiting at a kerb stand in loose rows instead: the first row
 * just back from the kerb, the next behind it, each person a comfortable
 * step from the next (queuing spacing at level of service C, about 0.75 m),
 * clear of the signal post, the lamp and the bin, and leaving a way open in
 * front of the zebra for the people coming off it.
 *
 * One area per crossing end, built once per network. A walker whose next
 * edge is a crossing it may not yet enter claims the best free place - front
 * row first, nearest the middle of the zebra first - walks to it and waits
 * there facing the far kerb; on the WALK it steps off from there.
 */

export interface WaitSlot {
  readonly x: number;
  readonly y: number;
  readonly row: number;
  /** Heading across the road, towards the far kerb. */
  readonly face: number;
  /** Who stands here, or 0. */
  taken: number;
}

export interface WaitArea {
  readonly crossing: SidewalkEdgeId;
  readonly kerb: SidewalkNodeId;
  readonly slots: WaitSlot[];
}

/** Rows back from the kerb, the first row's setback, and the spacing between rows and between people. */
const ROWS = 4;
const FIRST_ROW = m(0.4);
const ROW_SPACING = m(0.75);
const SPACING = m(0.75);
/** How far the area reaches either side of the zebra's edges. */
const SPREAD = m(0.9);
/** Clear space kept round street furniture: a body's radius and a little. */
const FURNITURE_CLEAR = m(0.3 + 0.15);
/**
 * Half the aisle left open down the middle of the zebra's mouth, in every
 * row: room between two waiting bodies for one person to come off the
 * crossing (0.9 m clear). With a place in the middle of the first row the
 * waiters stood 0.15 m apart across the whole mouth, and somebody stepping
 * off the zebra stood boxed in behind them for a whole red.
 */
const AISLE = m(0.75);
/** Places in the queue back along each footway, and how far in from its walls they stand. */
const QUEUE_PLACES = 6;
const QUEUE_INSET = m(0.35);

interface Areas {
  revision: number;
  byKey: Map<string, WaitArea>;
  claims: Map<number, WaitSlot>;
}
const AREAS = new WeakMap<SimWorld, Areas>();

function areasOf(w: SimWorld): Areas {
  let areas = AREAS.get(w);
  if (!areas || areas.revision !== w.topologyRevision) {
    areas = { revision: w.topologyRevision, byKey: new Map(), claims: areas?.claims ?? new Map() };
    for (const slot of areas.claims.values()) slot.taken = 0;
    areas.claims.clear();
    AREAS.set(w, areas);
  }
  return areas;
}

/** The waiting area at `kerb` for `crossing`, built on first use. */
export function waitArea(w: SimWorld, crossing: SidewalkEdge, kerb: SidewalkNodeId): WaitArea {
  const areas = areasOf(w);
  const key = `${crossing.id}@${kerb}`;
  const known = areas.byKey.get(key);
  if (known) return known;
  const here = w.sidewalks.nodes.get(kerb)!.at;
  const far = w.sidewalks.nodes.get(kerb === crossing.from ? crossing.to : crossing.from)!.at;
  const len = Math.hypot(far.x - here.x, far.y - here.y) || 1;
  const ux = (far.x - here.x) / len, uy = (far.y - here.y) / len;
  const vx = -uy, vy = ux;
  const face = Math.atan2(uy, ux);
  const scenery: { x: number; y: number; r: number }[] = [];
  for (const item of streetFurniture(w.net)) {
    if (!blocksPedestrians(item)) continue;
    if (item.halfLength !== undefined && item.halfWidth !== undefined) {
      // A bench or a post box: its long side as a row of discs.
      const count = Math.max(1, Math.ceil(item.halfLength / item.halfWidth));
      for (let i = 0; i <= count; i++) {
        const t = -item.halfLength + (2 * item.halfLength * i) / count;
        scenery.push({ x: item.x + item.along.x * t, y: item.y + item.along.y * t, r: item.halfWidth });
      }
    } else scenery.push({ x: item.x, y: item.y, r: item.radius });
  }
  for (const post of signalPosts(w.net, w.graph)) scenery.push({ x: post.x, y: post.y, r: m(0.17) });
  for (const pole of w.doc.poles.values()) scenery.push({ x: pole.x, y: pole.y, r: m(0.18) });
  const reach = crossing.halfWidth + SPREAD;
  const slots: WaitSlot[] = [];
  for (let row = 0; row < ROWS; row++) {
    const back = FIRST_ROW + row * ROW_SPACING;
    // Staggered rows, so the second looks between the shoulders of the first.
    const shift = row % 2 === 0 ? 0 : SPACING / 2;
    for (let k = -8; k <= 8; k++) {
      const offset = k * SPACING + shift;
      if (Math.abs(offset) > reach) continue;
      if (Math.abs(offset) < AISLE - 1e-6) continue;
      const x = here.x - ux * back + vx * offset;
      const y = here.y - uy * back + vy * offset;
      if (w.sidewalks.walkable && !w.sidewalks.walkable.footway(x, y)) continue;
      if (scenery.some((s) => Math.hypot(s.x - x, s.y - y) < s.r + FURNITURE_CLEAR)) continue;
      slots.push({ x, y, row, face, taken: 0 });
    }
  }
  // And a queue back along each footway that leads to this kerb, down both
  // sides of it, the middle left for people walking through or coming off the
  // zebra: a narrow footway's lattice holds five or six, and the rest of a
  // busy kerb waited on top of one another at its end.
  const frame = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };
  const walls = { lo: 0, hi: 0 };
  for (const e of w.sidewalks.edges.values()) {
    // Along footways only: a corner is the junction's walkway round the
    // island, narrow and busy both ways, and a queue on it blocked it.
    if (e.kind !== 'walk' || (e.from !== kerb && e.to !== kerb)) continue;
    const rev = e.from === kerb;
    for (let k = 0; k < QUEUE_PLACES; k++) {
      const s = e.length - (FIRST_ROW + k * ROW_SPACING);
      if (s < 0) break;
      e.corridor.bounds(s, rev, walls);
      for (const lat of [walls.hi - QUEUE_INSET, walls.lo + QUEUE_INSET]) {
        if (walls.hi - walls.lo < 4 * QUEUE_INSET) continue;
        e.corridor.place(s, lat, rev, frame);
        const x = frame.x, y = frame.y;
        const across = (x - here.x) * vx + (y - here.y) * vy;
        const back = -((x - here.x) * ux + (y - here.y) * uy);
        if (Math.abs(across) < AISLE && back < m(3)) continue;
        if (slots.some((o) => Math.hypot(o.x - x, o.y - y) < SPACING * 0.9)) continue;
        if (w.sidewalks.walkable && !w.sidewalks.walkable.footway(x, y)) continue;
        if (scenery.some((q) => Math.hypot(q.x - x, q.y - y) < q.r + FURNITURE_CLEAR)) continue;
        slots.push({ x, y, row: ROWS + k, face, taken: 0 });
      }
    }
  }
  slots.sort((a, b) => a.row - b.row ||
    Math.hypot(a.x - here.x + ux * (FIRST_ROW + a.row * ROW_SPACING), a.y - here.y + uy * (FIRST_ROW + a.row * ROW_SPACING)) -
    Math.hypot(b.x - here.x + ux * (FIRST_ROW + b.row * ROW_SPACING), b.y - here.y + uy * (FIRST_ROW + b.row * ROW_SPACING)));
  const area = { crossing: crossing.id, kerb, slots };
  areas.byKey.set(key, area);
  return area;
}

/**
 * The place this walker waits at, claiming the best free one of the area if
 * it holds none; null if every place is taken or none fits the footway it is
 * on (`accept` says which do).
 */
export function claimSlot(w: SimWorld, p: Ped, area: WaitArea, accept: (slot: WaitSlot) => boolean): WaitSlot | null {
  const areas = areasOf(w);
  const held = areas.claims.get(p.id);
  if (held && area.slots.includes(held)) return held;
  if (held) releaseSlot(w, p);
  for (const slot of area.slots) {
    if (slot.taken !== 0 && w.peds.has(slot.taken)) continue;
    if (!accept(slot)) continue;
    slot.taken = p.id;
    areas.claims.set(p.id, slot);
    return slot;
  }
  return null;
}

/** The place this walker holds, if any. */
export function heldSlot(w: SimWorld, p: Ped): WaitSlot | null {
  return areasOf(w).claims.get(p.id) ?? null;
}

/** Gives up this walker's place. */
export function releaseSlot(w: SimWorld, p: Ped): void {
  const areas = areasOf(w);
  const held = areas.claims.get(p.id);
  if (!held) return;
  if (held.taken === p.id) held.taken = 0;
  areas.claims.delete(p.id);
}
