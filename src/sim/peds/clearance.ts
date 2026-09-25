import { type Vec2, addScaled } from '@core/vec2';
import { m } from '@world/units';
import { blocksPedestrians, streetFurniture } from '@world/streetFurniture';
import { SIGNAL_POST_RADIUS, signalPosts } from '@world/signalPosts';
import { DT } from '../params';
import { vehiclePose } from '../pose';
import type { SimWorld } from '../world';
import type { Ped, PedId } from './state';
import type { SidewalkEdge } from './sidewalk';

export interface Footprint {
  id: number; x: number; y: number; radius: number; cell: string;
  /** A person's party, while they are in a conversation with it; -1 otherwise. */
  talk?: number;
  forward?: Vec2; halfLength?: number; halfWidth?: number;
}
const CELL = m(4);
const PERSON = m(0.3);
const cell = (x: number, y: number): string => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;

/**
 * How much of their personal radius a pedestrian insists on, from 1 down to
 * `SQUEEZE_FLOOR`.
 *
 * Personal space used to be a rigid disc, and two rigid discs meeting head on
 * on a narrow footway, or a walker turning a corner into the people queued at
 * its kerb, simply stopped for good: measured on the saved player map, 27 % of
 * all pedestrian time was spent standing still while wanting to walk, some of
 * it for over fifteen seconds, and people finishing a crossing were held IN
 * the road by the queue on the far kerb. Real people turn a shoulder. The
 * radius shrinks with the time spent held up, and at once for somebody
 * clearing a carriageway, so the jam dissolves in about a second. The floor
 * keeps centres 0.4 m apart — two people passing shoulder first. Only other
 * PEOPLE are squeezed past; poles, furniture and vehicles keep their full
 * clearance, or a figure would be drawn through them.
 */
const SQUEEZE_FLOOR = 2 / 3;
export const PERSON_SQUEEZED_SPACING = 2 * PERSON * SQUEEZE_FLOOR;
/** Closest two people ever get: shoulders brushing as one turns sideways (0.3 m). */
export const PERSON_RELEASED_SPACING = m(0.3);
const SQUEEZE_SECONDS = 1.2;
/** Closest two members of one conversation come while stepping round each other into it. */
const TALK_SPACING = m(0.42);
/**
 * Seconds held up after which a pedestrian stops treating other people and
 * street furniture as solid at all, until it has moved on. A last resort, not
 * the mechanism: the squeeze above resolves nearly every jam first. What it
 * guarantees is that nobody on a footway stands frozen for good behind a knot
 * the steering cannot untie. Vehicles are never passed through.
 */
export const STUCK_RELEASE = 3;
/** Seconds held up after which the people standing in the way make room. */
const JAMMED = 1;

/**
 * Planning a way round (`clearLine`): seconds of walking looked ahead, the
 * furthest looked, the pace planned at when slower (a standing walker still
 * plans the way it will take), the clearance kept from what is passed, and
 * the closing speed below which somebody ahead is never reached, u/s.
 */
const AVOID_SECONDS = 3.5;
const AVOID_REACH = m(6);
const AVOID_PACE = m(0.9);
const AVOID_GAP = m(0.12);
const AVOID_CLOSING = m(0.15);
/** An interval of the footway's width taken by an obstruction: with the comfort gap, and its tight core. */
interface Blocked { lo: number; hi: number; meet: number; centre: number; core: number }
const BLOCKED: Blocked[] = [];

/**
 * The free point across the footway nearest `target`, against the first
 * `count` blocked intervals, or null when there is none. Ties go to the side
 * the walker is already on.
 */
function freePoint(blocked: readonly Blocked[], count: number, target: number, lat: number,
  usable: number): number | null {
  const clear = (x: number): boolean => {
    if (x < -usable - 1e-6 || x > usable + 1e-6) return false;
    for (let i = 0; i < count; i++) if (x > blocked[i]!.lo && x < blocked[i]!.hi) return false;
    return true;
  };
  const at = Math.max(-usable, Math.min(usable, target));
  if (clear(at)) return at;
  let best: number | null = null;
  let cost = Infinity;
  const consider = (x: number): void => {
    if (!clear(x)) return;
    const c = Math.abs(x - target) + STAY_SIDE * Math.abs(x - lat);
    if (c < cost) { cost = c; best = x; }
  };
  for (let i = 0; i < count; i++) {
    consider(blocked[i]!.lo - 1e-3);
    consider(blocked[i]!.hi + 1e-3);
  }
  consider(-usable);
  consider(usable);
  return best;
}
/** Weight of staying near where one already is, against going where one wanted to be. */
const STAY_SIDE = 0.5;
function squeezeOf(p: Ped): number {
  // Clearing a carriageway, or stepping off a kerb together with the others
  // who were waiting there: people go shoulder to shoulder.
  if (p.state === 'Crossing' || p.state === 'WaitAtKerb') return SQUEEZE_FLOOR;
  return Math.max(SQUEEZE_FLOOR, 1 - (1 - SQUEEZE_FLOOR) * Math.min(1, p.stuck / SQUEEZE_SECONDS));
}

/** World-space clearance shared across sidewalk edges and crossing nodes. */
export class PedestrianClearance {
  private readonly grid = new Map<string, Footprint[]>();
  private readonly people = new Map<number, Footprint>();
  private scenery: Footprint[] = [];
  private builtRevision = -1;
  private builtDocumentRevision = -1;
  private builtUtilityRevision = -1;

  begin(w: SimWorld): void {
    if (this.builtRevision !== w.net.revision || this.builtDocumentRevision !== w.doc.revision ||
      this.builtUtilityRevision !== w.doc.utilityRevision) {
      this.buildScenery(w);
      this.builtRevision = w.net.revision;
      this.builtDocumentRevision = w.doc.revision;
      this.builtUtilityRevision = w.doc.utilityRevision;
    }
    this.grid.clear();
    this.people.clear();
    for (const obstacle of this.scenery) this.insert(obstacle);
    for (const p of w.pedsInIdOrder()) {
      const at = this.at(w, p);
      if (!at) continue;
      const footprint = { id: p.id, x: at.x, y: at.y, radius: PERSON, cell: '',
        talk: p.activity?.kind === 'talk' ? p.party.id : -1 };
      this.people.set(p.id, footprint);
      this.insert(footprint);
    }
    // Vehicles retain their own lane physics, but pedestrians also need their
    // physical footprint while entering a zebra or clearing a junction.
    for (const vehicle of w.vehiclesInIdOrder()) {
      const pose = vehiclePose(w, vehicle, 1);
      if (!pose) continue;
      const archetype = vehicle.archetype;
      const halfLength = archetype.length / 2, halfWidth = archetype.width / 2;
      const radius = Math.hypot(halfLength, halfWidth);
      this.insert({ id: -vehicle.id, x: pose.p.x, y: pose.p.y, radius, cell: '',
        forward: { x: Math.cos(pose.angle), y: Math.sin(pose.angle) }, halfLength, halfWidth });
    }
  }

  at(w: SimWorld, p: Ped): Vec2 | null {
    const edge = w.sidewalks.edges.get(p.edge);
    if (!edge) return null;
    return this.point(w, edge, p.entry, p.s, p.lat);
  }

  point(w: SimWorld, edge: SidewalkEdge, entry: string, s: number, lat: number): Vec2 {
    const frame = w.sidewalks.orientedPath(edge, entry).sampleAt(s);
    return addScaled(frame.p, frame.n, lat);
  }

  /** How far the next step may go before touching a person or object. */
  safeStep(w: SimWorld, p: Ped, edge: SidewalkEdge, target: number): number {
    if (target <= p.s) return p.s;
    const current = this.point(w, edge, p.entry, p.s, p.lat);
    const free = (s: number): boolean => {
      const at = this.point(w, edge, p.entry, s, p.lat);
      return !this.blocker(p, at.x, at.y, current);
    };
    if (free(target)) return target;
    let lo = p.s, hi = target;
    for (let i = 0; i < 5; i++) {
      const mid = (lo + hi) / 2;
      if (free(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  canEnter(w: SimWorld, p: Ped, edge: SidewalkEdge, entry: string, lat: number): boolean {
    const current = this.at(w, p);
    if (!current) return false;
    const at = this.point(w, edge, entry, 0, lat);
    // People waiting at a kerb for the same crossing step off it together,
    // shoulder to shoulder. Counting each other as obstacles, two of them
    // standing 0.3 m apart each found the other where they would step and
    // neither ever went — a party held at a WALK for nine seconds and more.
    const together = p.state === 'WaitAtKerb' && edge.kind === 'crossing'
      ? (id: number): boolean => {
        const q = w.peds.get(id);
        return q !== undefined && q.state === 'WaitAtKerb' && q.route[0] === edge.id;
      }
      : undefined;
    return !this.blocker(p, at.x, at.y, current, together);
  }

  /**
   * Whether a visible PERSON (not scenery, not a vehicle) is within shoulder
   * distance of a raw world point, regardless of who was there before.
   *
   * For the physical safety checks above, "an old overlap may be repaired by
   * moving away" is the right rule: it lets a genuinely stuck pair separate
   * without deadlocking. It is the wrong rule for `settlePose`'s purely
   * COSMETIC catch-up offset, which is not a physical step at all — it is a
   * straight line drawn between two positions that were each independently
   * clear. Decaying it in a straight line can sweep the drawn body through
   * whoever stands between those two points, and "moving away" never fires
   * because there was no real approach to measure. This is the strict check
   * that stops the sweep the instant it would, without caring how it began.
   */
  tooCloseToPerson(id: PedId, x: number, y: number): boolean {
    let found = false;
    this.visit(x, y, m(2.5), (other) => {
      if (found || other.id === id || other.id <= 0) return;
      if (this.distance(other, x, y) < PERSON_RELEASED_SPACING) found = true;
    });
    return found;
  }

  /**
   * The nearest person within `range` of `p` who needs the way — held up
   * trying to get past, or coming off a crossing — and is not waiting at a
   * kerb themselves; or null. A person waiting at a kerb reads this to step
   * aside for them.
   */
  jammedNear(w: SimWorld, p: Ped, range: number): Vec2 | null {
    const here = this.people.get(p.id);
    if (!here) return null;
    let best: Vec2 | null = null;
    let nearest = range;
    this.visit(here.x, here.y, range, (other) => {
      if (other.id <= 0 || other.id === p.id) return;
      const q = w.peds.get(other.id);
      // Somebody coming off a crossing has the right of way over the kerb:
      // they have to get out of the road, and a queue at a busy zebra's mouth
      // otherwise holds them on it while it waits to step on itself.
      if (!q || q.state === 'WaitAtKerb' || (q.state !== 'Crossing' && q.stuck < JAMMED)) return;
      const d = Math.hypot(other.x - here.x, other.y - here.y);
      if (d < nearest) { nearest = d; best = { x: other.x, y: other.y }; }
    });
    return best;
  }

  canShift(w: SimWorld, p: Ped, edge: SidewalkEdge, lat: number, s = p.s): boolean {
    const current = this.at(w, p);
    if (!current) return false;
    const at = this.point(w, edge, p.entry, s, lat);
    return !this.blocker(p, at.x, at.y, current);
  }

  /**
   * The line across the footway, nearest `target`, that is clear of
   * everything this walker will reach in the next few seconds: street
   * furniture, people standing, people walking the same way more slowly, and
   * people coming the other way, each where they will be when the two meet.
   *
   * The old answer looked 2.6 m ahead at the single nearest obstruction, while
   * the brakes looked three metres and more: people slowed and stopped in
   * front of a bench or a knot of pedestrians before they ever tried to go
   * round it, stood there until they counted as stuck, and were then let
   * through the bench. And shifting round one obstruction could put them in
   * front of the next. Now every obstruction within `AVOID_SECONDS` of walking
   * blocks an interval of the footway's width, and the walker takes the free
   * point nearest where they wanted to be — preferring, all else equal, to
   * stay on the side they are already on, so the choice does not flicker.
   * When the whole width is blocked the furthest obstructions are dropped
   * until it is not: the way through the near ones matters first.
   */
  clearLine(w: SimWorld, p: Ped, edge: SidewalkEdge, target: number, usable: number): number {
    const frame = w.sidewalks.orientedPath(edge, p.entry).sampleAt(p.s);
    const near = addScaled(frame.p, frame.n, p.lat);
    const pace = Math.max(p.v, AVOID_PACE);
    const reach = Math.min(AVOID_REACH, pace * AVOID_SECONDS);
    const blocked = BLOCKED;
    blocked.length = 0;
    this.visit(near.x, near.y, reach + m(2), other => {
      if (other.id === p.id) return;
      // Vehicles are the crossing rules' business, not something to walk round.
      if (other.id < 0 && other.id > -1_000_000) return;
      const dx = other.x - near.x, dy = other.y - near.y;
      const ahead = dx * frame.t.x + dy * frame.t.y;
      let across = other.radius, along = other.radius;
      if (other.forward && other.halfLength !== undefined && other.halfWidth !== undefined) {
        const c = Math.abs(other.forward.x * frame.t.x + other.forward.y * frame.t.y);
        const s = Math.abs(other.forward.x * frame.n.x + other.forward.y * frame.n.y);
        across = s * other.halfLength + c * other.halfWidth;
        along = c * other.halfLength + s * other.halfWidth;
      }
      const gap = ahead - along - PERSON;
      if (ahead + along < -m(0.2)) return;
      let meet = gap / pace;
      if (other.id > 0) {
        const q = w.peds.get(other.id);
        if (q) {
          const qAlong = ((q.x - q.prev.x) * frame.t.x + (q.y - q.prev.y) * frame.t.y) / DT;
          const closing = pace - qAlong;
          // Going the same way no slower: never reached, so never in the way.
          if (closing < AVOID_CLOSING) return;
          meet = gap / closing;
        }
      }
      if (meet > AVOID_SECONDS) return;
      const lateral = dx * frame.n.x + dy * frame.n.y + p.lat;
      const half = across + PERSON + AVOID_GAP;
      blocked.push({ lo: lateral - half, hi: lateral + half, meet: Math.max(0, meet), centre: lateral, core: across + PERSON });
    });
    if (!blocked.length) return target;
    blocked.sort((a, b) => a.meet - b.meet);
    for (let count = blocked.length; count > 0; count--) {
      const free = freePoint(blocked, count, target, p.lat, usable);
      if (free !== null) return free;
    }
    // No line clears everything with room to spare: take one that clears it
    // at all, shoulder past - the same margin the step itself is checked at.
    // Giving up here kept the walker's own line, straight at the obstruction,
    // and once furniture could no longer be walked through, a walker faced
    // with a street tree on a narrow footway stood in front of it for good.
    for (const b of blocked) { b.lo = b.centre - b.core; b.hi = b.centre + b.core; }
    for (let count = blocked.length; count > 0; count--) {
      const free = freePoint(blocked, count, target, p.lat, usable);
      if (free !== null) return free;
    }
    return target;
  }

  /**
   * How far the next step may go along a given line across the footway, as
   * `safeStep` does along the walker's own: whether a planned step aside will
   * be clear by the time it is reached.
   */
  clearAlong(w: SimWorld, p: Ped, edge: SidewalkEdge, target: number, lat: number): number {
    if (target <= p.s) return p.s;
    const current = this.point(w, edge, p.entry, p.s, p.lat);
    const free = (s: number): boolean => {
      const at = this.point(w, edge, p.entry, s, lat);
      return !this.blocker(p, at.x, at.y, current);
    };
    if (free(target)) return target;
    let lo = p.s, hi = target;
    for (let i = 0; i < 5; i++) {
      const mid = (lo + hi) / 2;
      if (free(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  update(w: SimWorld, p: Ped): void {
    const footprint = this.people.get(p.id);
    const at = this.at(w, p);
    if (!footprint || !at) return;
    const bucket = this.grid.get(footprint.cell);
    if (bucket) {
      const i = bucket.indexOf(footprint);
      if (i >= 0) bucket.splice(i, 1);
    }
    footprint.x = at.x; footprint.y = at.y;
    this.insert(footprint);
  }

  private blocker(p: Ped, x: number, y: number, current: Vec2, ignore?: (id: number) => boolean): boolean {
    let blocked = false;
    const squeeze = squeezeOf(p);
    // Somebody still in the carriageway gets off it first: they may brush
    // past people standing at the zebra's mouth at once rather than wait.
    const released = p.stuck >= STUCK_RELEASE || p.state === 'Crossing';
    const talking = p.activity?.kind === 'talk' ? p.party.id : -1;
    this.visit(x, y, m(6.5), other => {
      if (blocked || other.id === p.id) return;
      if (ignore && other.id > 0 && ignore(other.id)) return;
      // Vehicles are never squeezed past. People and street furniture are:
      // somebody held up long enough turns a shoulder and slips by.
      const vehicle = other.halfLength !== undefined && other.id < 0 && other.id > -1_000_000;
      // Released: furniture no longer blocks, and people may brush shoulder to
      // shoulder — but never pass through one another. Keeping furniture solid
      // here as well froze a walker for 145 s in `pedFlow.spec`; `clearLine`
      // is what keeps people out of it in the first place.
      if (released && !vehicle && other.id <= 0 && other.id > -1_000_000) return;
      // Friends closing up a conversation step round each other shoulder
      // to shoulder, as they would; a stranger's full space would leave the
      // last to arrive stuck outside the circle.
      const friends = talking >= 0 && other.talk === talking;
      const minimum = vehicle
        ? PERSON
        : other.id > 0
          ? released ? PERSON_RELEASED_SPACING : friends ? TALK_SPACING : (PERSON + other.radius) * squeeze
          : PERSON + (other.halfLength === undefined ? other.radius : 0);
      const next = this.distance(other, x, y);
      if (next >= minimum) return;
      // An old overlap may be repaired by moving away, never by pushing in.
      const before = this.distance(other, current.x, current.y);
      if (next + 1e-5 < before || before >= minimum) blocked = true;
    });
    return blocked;
  }

  /** Distance from a point to a footprint's centre, or to the edge of its box for furniture and vehicles. */
  distanceTo(other: Readonly<Footprint>, x: number, y: number): number {
    return this.distance(other as Footprint, x, y);
  }

  private distance(other: Footprint, x: number, y: number): number {
    const dx = x - other.x, dy = y - other.y;
    if (!other.forward || other.halfLength === undefined || other.halfWidth === undefined) {
      return Math.hypot(dx, dy);
    }
    const along = Math.abs(dx * other.forward.x + dy * other.forward.y) - other.halfLength;
    const across = Math.abs(dx * -other.forward.y + dy * other.forward.x) - other.halfWidth;
    return Math.hypot(Math.max(0, along), Math.max(0, across));
  }

  /** Everything within `range` of a point: people, vehicles, street furniture. */
  around(x: number, y: number, range: number, call: (item: Readonly<Footprint>) => void): void {
    this.visit(x, y, range, call);
  }

  private visit(x: number, y: number, range: number, call: (item: Footprint) => void): void {
    const minX = Math.floor((x - range) / CELL), maxX = Math.floor((x + range) / CELL);
    const minY = Math.floor((y - range) / CELL), maxY = Math.floor((y + range) / CELL);
    for (let ix = minX; ix <= maxX; ix++) for (let iy = minY; iy <= maxY; iy++) {
      for (const item of this.grid.get(`${ix}:${iy}`) ?? []) call(item);
    }
  }

  private insert(item: Footprint): void {
    item.cell = cell(item.x, item.y);
    const bucket = this.grid.get(item.cell);
    if (bucket) bucket.push(item);
    else this.grid.set(item.cell, [item]);
  }

  private buildScenery(w: SimWorld): void {
    const items: Footprint[] = [];
    const add = (x: number, y: number, radius: number): void => {
      items.push({ id: -1_000_000 - items.length, x, y, radius, cell: '' });
    };
    // The same list the renderer draws from (`world/streetFurniture.ts`), so
    // nothing can stand on the pavement that people walk through.
    for (const item of streetFurniture(w.net)) {
      if (!blocksPedestrians(item)) continue;
      if (item.halfLength !== undefined && item.halfWidth !== undefined) {
        items.push({ id: -1_000_000 - items.length, x: item.x, y: item.y,
          radius: item.radius, cell: '',
          forward: item.along, halfLength: item.halfLength, halfWidth: item.halfWidth });
      } else {
        add(item.x, item.y, item.radius);
      }
    }
    for (const pole of w.doc.poles.values()) add(pole.x, pole.y, m(0.18));
    // The traffic signal posts, where the renderer draws them. They stand on
    // the kerb two metres back from the zebra - where people wait to cross -
    // and used to be known only to the renderer.
    for (const post of signalPosts(w.net, w.graph)) add(post.x, post.y, SIGNAL_POST_RADIUS);
    this.scenery = items;
  }
}
