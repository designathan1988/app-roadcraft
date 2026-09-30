import { m } from '@world/units';
import { FOOTWAY, NAV_RADIUS, OPEN, closestOnSegment, isZebra } from '@world/nav/navmesh';
import { findPath, funnel, type NavPath } from '@world/nav/path';
import type { SidewalkEdge } from '../peds/sidewalk';
import { DT, PED, PED_CEILING, PED_DENSITY } from '../params';
import { emptyCrossingState } from '../crossings/state';
import { indexReservations, mayEnterCrossing } from '../crossings/permission';
import type { SimWorld } from '../world';
import type { Boarder, PedestrianEngine } from './engine';
import { buildWorldNav, type WorldNav } from './nav';
import { PARTY_ARCHETYPES, type PartyView, type PedView, type PersonAgeClass, type PersonGender } from './view';
import { planParty } from './party';

/**
 * THE PEOPLE ENGINE: pedestrians as agents on a walkable mesh.
 *
 * Each person has a place to go, a route to it (A* over the mesh, pulled
 * taut through its portals), and a body that walks it: it turns towards
 * where it is heading and steps FORWARD, at a person's pace, with at most a
 * slow sideways shuffle. It anticipates the people around it (time to
 * collision, Karamouzas, Skinner & Guy 2014) and eases round them early; it
 * never pushes anyone and is never pushed. A move that would leave the mesh,
 * step onto a zebra it has not been allowed onto or into somebody is not
 * made: the body stops. So a person can not be dragged backwards, slide
 * sideways, jump, stand in the road or inside a lamp post, whatever happens
 * around it — those are not rules checked afterwards, they are the only way
 * the body can move.
 *
 * `docs/design/agency-architecture.md` §3.
 */

interface Person {
  readonly id: number;
  x: number;
  y: number;
  heading: number;
  /** Forward speed along the heading, u/s, never negative. */
  v: number;
  turnV: number;
  prevX: number;
  prevY: number;
  prevHeading: number;
  age: number;
  tri: number;
  readonly pace: number;
  readonly ageClass: PersonAgeClass;
  readonly gender: PersonGender;
  party: PartyView;
  /** Place in the party; 0 leads. */
  rank: number;
  /** Who this person walks with and keeps beside; null for a leader or somebody alone. */
  leader: Person | null;
  /** Seconds a leader has stood waiting for a companion. */
  waitingForParty: number;
  /** Seconds other people have kept this body from getting on. */
  held: number;
  goalX: number;
  goalY: number;
  goalTri: number;
  /** The goal is a way out: the person goes when they get there. */
  leaving: boolean;
  path: NavPath | null;
  /** Where in the route's corridor the body is: `path.tris[ci]` is its triangle. */
  ci: number;
  /** Walking, waiting at a kerb for a zebra, or on one. */
  mode: 'walk' | 'wait' | 'cross';
  /** The zebra (mesh crossing index) waited for or being crossed; -1 for none. */
  crossing: number;
  waited: number;
  /** Seconds wanting to move without getting anywhere. */
  stuck: number;
  /** Stopped at the kerb, facing the zebra, until it may cross. */
  atKerb: boolean;
  /** Seconds left giving way to somebody in the way. */
  yielding: number;
  view: PedView;
}

/** Everything the engine keeps for one world. */
interface State {
  nav: WorldNav | null;
  people: Person[];
  byId: Map<number, Person>;
  nextId: number;
  spawnClock: number;
  /** Footway triangles and their cumulative areas, for picking places. */
  footTris: number[];
  footArea: number[];
}

const STATES = new WeakMap<SimWorld, State>();

function stateOf(w: SimWorld): State {
  let s = STATES.get(w);
  if (!s) {
    s = { nav: null, people: [], byId: new Map(), nextId: 1, spawnClock: 0, footTris: [], footArea: [] };
    STATES.set(w, s);
  }
  return s;
}

// ------------------------------------------------------------------ constants

const R = NAV_RADIUS;
/** Personal space kept on top of two bodies' radii when anticipating, u. */
const PERSONAL = m(0.1);
/** Closest two bodies may ever be, centre to centre, u. */
const MIN_GAP = 2 * R;
const ACCEL = m(1.1);
const DECEL = m(1.6);
/** Braking for somebody suddenly in the way, u/s². */
const HARD_DECEL = m(4);
const TURN_RATE = 3.2;
const TURN_ACCEL = 12;
/** A corner this close is reached, u. */
const CORNER_ON = 0.05;
/** How far from a kerb a person stops to wait, u. */
const KERB_STOP = m(0.3);
/** Nearer than this to the kerb, a person asks to cross; if refused, waits, u. */
const ASK_AT = m(2.5);
/** Planned wait at a zebra, as extra walking distance, u. */
const CROSS_COST = m(12);
const NEIGHBOUR_REACH = m(5);
const CELL = m(2.5);
/** Time-to-collision force (Karamouzas et al. 2014), in metres and seconds. */
const TTC_K = 1.5;
const TTC_TAU0 = 3;
const TTC_M = 2;
const TTC_MAX_FORCE = 8;
/** Seconds held up by people before a body squeezes past them, and how close it then may come, u. */
const SQUEEZE_AFTER = 3;
const SQUEEZE_GAP = m(0.45);
/** Below this pace somebody counts as standing, to be walked round, u/s. */
const STANDING = m(0.1);
/** How far ahead somebody standing is stepped round, u; and how firmly, m/s². */
const PASS_AHEAD = m(1.5);
const PASS_PUSH = 3;
/** Nearer than this to somebody, a person would rather be further apart, u; and how much, m/s². */
const KEEP_APART = m(0.8);
const KEEP_APART_PUSH = 2;
/** Seconds a leader waits for a companion who has fallen behind before it goes its own way. */
const PARTY_PATIENCE = 5;
/** Shortest trip that ends by leaving: nobody walks out of a door and straight back in, u. */
const MIN_LEAVE = m(10);
/** Within this of a wall a body is pushed off it, u; and how hard at the wall, m/s². */
const WALL_REACH = m(0.12);
const WALL_PUSH = 0.5;
/** Nearer a wall than this, a body does not walk into it, u. */
const WALL_HUG = m(0.15);
/** Seconds over which a person closes on the velocity they want. */
const RELAX = 0.54;
const SPAWN_INTERVAL = 0.5;
const MIN_TRIP = m(40);
/** Ticks between a follower re-aiming at its place beside its leader. */
const FOLLOW_EVERY = 15;
/** How much faster than its leader a follower walks per unit it is behind its place, 1/s. */
const FOLLOW_GAIN = 0.8;
/** Beyond these, a leader slows for a companion dropping back, then waits, u. */
const PARTY_SLOW = m(2);
const PARTY_WAIT = m(4);
/** Share of trips that end by leaving (a door, the map's edge). */
const LEAVE_SHARE = 0.5;
/** How far past the edge of the mesh a step may land and still count as on it (rounding), u; the body is then placed exactly on the mesh. */
const ON_MESH = 0.002;
/** Seconds a body stands giving way before trying again. */
const YIELD_HOLD = 0.4;
/** Seconds of getting nowhere before a person looks for another way. */
const REPLAN_AFTER = 0.6;

// --------------------------------------------------------------------- engine

export function createPeopleEngine(): PedestrianEngine {
  return {
    kind: 'people',
    beginTick(w) {
      for (const p of stateOf(w).people) {
        p.prevX = p.x;
        p.prevY = p.y;
        p.prevHeading = p.heading;
      }
    },
    dispatch(w, enabled) {
      const s = stateOf(w);
      if (!enabled || !s.nav) return;
      s.spawnClock += DT;
      if (s.spawnClock < SPAWN_INTERVAL) return;
      s.spawnClock = 0;
      const target = peopleTarget(w);
      for (let i = 0; i < 2 && s.people.length < target; i++) spawn(w, s);
    },
    step(w) { step(w, stateOf(w)); },
    rebind(w) { rebind(w, stateOf(w)); },
    publish(w) { publishViews(w, stateOf(w)); },
    audit() {},
    // The world forces a topology rebuild after a reset, which rebinds (and
    // so rebuilds the mesh); here everybody simply leaves.
    reset(w) { STATES.delete(w); },
    bridge: {
      hailable: () => null,
      board(w, id, door, reach) {
        const s = stateOf(w);
        const p = s.byId.get(id);
        if (!p || p.mode !== 'walk' || p.party.size > 1 || Math.hypot(p.x - door.x, p.y - door.y) > reach) return null;
        remove(s, p);
        return { seed: p.id, gender: p.gender, ageClass: p.ageClass, footX: p.x, footY: p.y, footHeading: p.heading };
      },
      alight(w, person: Boarder) {
        const s = stateOf(w);
        if (!s.nav || s.byId.has(person.seed)) return;
        const at = s.nav.mesh.nearest(person.footX, person.footY, m(3));
        if (!at || isZebra(s.nav.mesh.region[at.t]!)) return;
        const p = create(w, s, person.seed, at.x, at.y, at.t, person.footHeading, { ageClass: person.ageClass, gender: person.gender });
        pickGoal(w, s, p);
      },
      anyoneWithin(w, x, y, radius, except) {
        for (const p of stateOf(w).people) if (p.id !== except && Math.hypot(p.x - x, p.y - y) < radius) return true;
        return false;
      },
    },
  };
}

/** Same population as the legacy model: one person per 90 m of road, scaled by the city's settings. */
function peopleTarget(w: SimWorld): number {
  let total = 0;
  for (const ribbon of w.net.ribbons.values()) total += ribbon.full.length;
  const ceiling = Math.floor(PED_CEILING * w.populationShare);
  return Math.min(ceiling, Math.floor(total * PED_DENSITY * w.pedestrianIntensity * w.demandMultiplier));
}

// ------------------------------------------------------------ people in, out

interface Traits {
  ageClass?: PersonAgeClass;
  gender?: PersonGender;
  pace?: number;
  party?: PartyView;
  rank?: number;
  leader?: Person | null;
}

function create(w: SimWorld, s: State, id: number, x: number, y: number, tri: number, heading: number,
  traits: Traits = {}): Person {
  const rng = w.rng.people;
  const cls: PersonAgeClass = traits.ageClass ?? (rng.float() < 0.1 ? 'child' : rng.float() < 0.15 ? 'elder' : 'adult');
  const sex: PersonGender = traits.gender ?? (rng.float() < 0.5 ? 'f' : 'm');
  const base = Math.max(PED.minSpeed, Math.min(PED.maxSpeed, PED.meanSpeed + (rng.float() - 0.5) * 2 * PED.speedSd));
  const pace = traits.pace ?? (cls === 'elder' ? base * 0.8 : cls === 'child' ? base * 0.9 : base);
  const party: PartyView = traits.party ?? { id, size: 1, archetype: PARTY_ARCHETYPES[0]!, hasChild: false };
  const rank = traits.rank ?? 0;
  const view: PedView = {
    id, x, y, heading, prev: { x, y, heading }, v: 0, turnV: 0, age: 0,
    ageClass: cls, gender: sex, party, rank,
    ground: 'footway', segment: undefined, stretch: '', walking: false, kerbWait: 0, waitingFor: null, gesture: null,
  };
  const p: Person = {
    id, x, y, heading, v: 0, turnV: 0, prevX: x, prevY: y, prevHeading: heading, age: 0, tri,
    pace, ageClass: cls, gender: sex, party, rank, leader: traits.leader ?? null, waitingForParty: 0, held: 0,
    goalX: x, goalY: y, goalTri: tri, leaving: false, path: null, ci: 0,
    mode: 'walk', crossing: -1, waited: 0, stuck: 0, atKerb: false, yielding: 0, view,
  };
  s.people.push(p);
  s.people.sort((a, b) => a.id - b.id);
  s.byId.set(id, p);
  s.nextId = Math.max(s.nextId, id + 1);
  return p;
}

function remove(s: State, p: Person): void {
  s.byId.delete(p.id);
  const i = s.people.indexOf(p);
  if (i >= 0) s.people.splice(i, 1);
}

/** A random point of the footway, area-weighted. */
function randomSpot(w: SimWorld, s: State): { x: number; y: number; t: number } | null {
  const nav = s.nav;
  if (!nav || !s.footTris.length) return null;
  const rng = w.rng.people;
  const total = s.footArea[s.footArea.length - 1]!;
  const pick = rng.float() * total;
  let lo = 0, hi = s.footArea.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (s.footArea[mid]! < pick) lo = mid + 1; else hi = mid; }
  const t = s.footTris[lo]!;
  let a = rng.float(), b = rng.float();
  if (a + b > 1) { a = 1 - a; b = 1 - b; }
  const o = t * 6, tri = nav.mesh.tri;
  const x = tri[o]! + a * (tri[o + 2]! - tri[o]!) + b * (tri[o + 4]! - tri[o]!);
  const y = tri[o + 1]! + a * (tri[o + 3]! - tri[o + 1]!) + b * (tri[o + 5]! - tri[o + 1]!);
  return { x, y, t };
}

function clearOfPeople(s: State, x: number, y: number, gap: number): boolean {
  for (const p of s.people) if (Math.hypot(p.x - x, p.y - y) < gap) return false;
  return true;
}

/**
 * One more person. Once the city is populated they come in at a source - out
 * of a door, or walking in along a road that runs off the map - and nobody
 * appears in the middle of a pavement; `anywhere` fills a city just opened.
 */
function spawn(w: SimWorld, s: State, anywhere = false): void {
  const sources = s.nav?.sources ?? [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const source = !anywhere && sources.length ? sources[Math.floor(w.rng.people.float() * sources.length)]! : null;
    const at = source ?? randomSpot(w, s);
    if (!at || !clearOfPeople(s, at.x, at.y, m(1.2))) continue;
    const plan0 = planParty(w.rng.people, s.nextId, Math.max(1, peopleTarget(w) - s.people.length));
    const party: PartyView = { id: s.nextId, size: 1, archetype: 'solo', hasChild: false };
    const lead = create(w, s, s.nextId, at.x, at.y, at.t, w.rng.people.float() * Math.PI * 2,
      { ageClass: plan0.ages[0]!, pace: Math.min(...plan0.speeds), party, rank: 0 });
    if (!pickGoal(w, s, lead)) { remove(s, lead); continue; }
    // Born facing the way it is going: nobody starts with a pivot.
    const first = lead.path?.corners[0];
    if (first) lead.heading = lead.prevHeading = lead.view.heading = Math.atan2(first.y - lead.y, first.x - lead.x);
    // The rest of the party just behind, where there is room for them.
    const members = [lead];
    for (let k = 1; k < plan0.size; k++) {
      const back = m(0.9) * Math.ceil(k / 2), side = (k % 2 ? 1 : -1) * m(0.35);
      const hx = Math.cos(lead.heading), hy = Math.sin(lead.heading);
      const spot = s.nav!.mesh.nearest(lead.x - hx * back - hy * side, lead.y - hy * back + hx * side, m(0.6));
      if (!spot || !clearOfPeople(s, spot.x, spot.y, MIN_GAP * 1.05) || isZebra(s.nav!.mesh.region[spot.t]!)) break;
      members.push(create(w, s, s.nextId, spot.x, spot.y, spot.t, lead.heading,
        { ageClass: plan0.ages[k]!, pace: plan0.speeds[k]!, party, rank: k, leader: lead }));
    }
    const shared: PartyView = {
      id: lead.id,
      size: members.length,
      archetype: members.length === 1 ? 'solo' : plan0.archetype,
      hasChild: members.some((p) => p.ageClass === 'child'),
    };
    for (const p of members) { p.party = shared; p.view.party = shared; }
    return;
  }
}

/**
 * Somewhere worth walking to, and the route there: half the time a way out
 * (a door, or off the map), otherwise a place along the pavements. False when
 * none was found.
 */
function pickGoal(w: SimWorld, s: State, p: Person): boolean {
  const sources = s.nav?.sources ?? [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const leave = sources.length > 0 && w.rng.people.float() < LEAVE_SHARE;
    const at = leave ? sources[Math.floor(w.rng.people.float() * sources.length)]! : randomSpot(w, s);
    if (!at || Math.hypot(at.x - p.x, at.y - p.y) < (leave ? MIN_LEAVE : MIN_TRIP)) continue;
    p.goalX = at.x; p.goalY = at.y; p.goalTri = at.t;
    p.leaving = leave;
    if (plan(s, p)) return true;
  }
  return false;
}

function plan(s: State, p: Person): boolean {
  const mesh = s.nav!.mesh;
  const path = findPath(mesh, p.x, p.y, p.tri, p.goalX, p.goalY, p.goalTri,
    (from, to) => (isZebra(mesh.region[to]!) && mesh.region[from] !== mesh.region[to] ? CROSS_COST : 0));
  p.path = path;
  p.ci = 0;
  return path !== null;
}

// -------------------------------------------------------------------- rebind

function rebind(w: SimWorld, s: State): void {
  s.nav = buildWorldNav(w);
  const mesh = s.nav.mesh;
  s.footTris = [];
  s.footArea = [];
  let acc = 0;
  for (let t = 0; t < mesh.count; t++) {
    if (mesh.region[t] !== FOOTWAY) continue;
    acc += mesh.area(t);
    s.footTris.push(t);
    s.footArea.push(acc);
  }
  for (const p of [...s.people]) {
    // The map changed under them: each person stands where they stood, or on
    // the nearest walkable ground if that was built over.
    const t = mesh.locate(p.x, p.y);
    if (t >= 0) p.tri = t;
    else {
      const at = mesh.nearest(p.x, p.y, m(6));
      if (!at) { remove(s, p); continue; }
      p.x = p.prevX = at.x; p.y = p.prevY = at.y; p.tri = at.t;
    }
    p.mode = isZebra(mesh.region[p.tri]!) ? 'cross' : 'walk';
    p.crossing = isZebra(mesh.region[p.tri]!) ? mesh.region[p.tri]! : -1;
    const goal = mesh.locate(p.goalX, p.goalY);
    if (goal < 0 || !(p.goalTri = goal, plan(s, p))) {
      if (!pickGoal(w, s, p)) remove(s, p);
    }
  }
  // A city just opened is populated at once, all over; from then on people
  // only come and go through doors and the map's edges.
  if (!s.people.length) {
    const target = peopleTarget(w);
    for (let i = 0; i < target * 4 && s.people.length < target; i++) spawn(w, s, true);
  }
  publishCrossings(w, s);
  publishViews(w, s);
}

// ---------------------------------------------------------------------- step

/** Where each person stood at the start of the tick, bucketed, for neighbour queries. */
function grid(people: readonly Person[]): Map<number, Person[]> {
  const g = new Map<number, Person[]>();
  for (const p of people) {
    const key = cellKey(Math.floor(p.x / CELL), Math.floor(p.y / CELL));
    const list = g.get(key);
    if (list) list.push(p);
    else g.set(key, [p]);
  }
  return g;
}
const cellKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

function neighbours(g: Map<number, Person[]>, p: Person, reach: number, out: Person[]): Person[] {
  out.length = 0;
  const r = Math.ceil(reach / CELL);
  const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (const q of g.get(cellKey(cx + dx, cy + dy)) ?? []) {
        if (q !== p && Math.hypot(q.x - p.x, q.y - p.y) < reach) out.push(q);
      }
    }
  }
  return out;
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const UNIT = m(1);

function step(w: SimWorld, s: State): void {
  const nav = s.nav;
  if (!nav) return;
  const mesh = nav.mesh;
  indexReservations(w);
  const g = grid(s.people);
  const near: Person[] = [];
  const arrived: Person[] = [];

  for (const p of s.people) {
    p.age += DT;
    // A follower's goal is its place beside its leader, re-aimed a few times a second.
    if (p.leader && !s.byId.has(p.leader.id)) p.leader = null;
    const lead = p.leader;
    if (lead && (!p.path || (p.id + w.clock.tick) % FOLLOW_EVERY === 0)) {
      const slot = slotBeside(mesh, lead, p, oncoming(g, lead, Math.cos(lead.heading), Math.sin(lead.heading), m(6)));
      p.goalX = slot.x; p.goalY = slot.y; p.goalTri = slot.t;
      if (!plan(s, p)) { p.leader = null; p.path = null; }
    }
    if (!p.path) { if (!pickGoal(w, s, p)) { arrived.push(p); continue; } }

    // --- where to: the next corners of the route, pulled taut from where the
    // body stands through the corridor of triangles still ahead. Recomputed
    // every tick, the corner walked to is always in plain sight: no rule
    // about when a corner counts as passed, and nothing to skip wrongly.
    if (!follow(mesh, p) && !plan(s, p) && !pickGoal(w, s, p)) { arrived.push(p); continue; }
    const route = p.path!;
    const corners = funnel(p.x, p.y, p.goalX, p.goalY, route.portals, p.ci, 3);
    let target = corners[0]!;
    if (Math.hypot(target.x - p.x, target.y - p.y) < CORNER_ON && corners[1]) target = corners[1];
    const toGoal = Math.hypot(p.goalX - p.x, p.goalY - p.y);
    const lastLeg = target.x === p.goalX && target.y === p.goalY;
    if (!lead && lastLeg && toGoal < m(0.4)) { arrived.push(p); continue; }

    // --- the next zebra on the route, and whether it may be stepped onto
    let limit = Infinity;
    let face: number | null = null;
    const gate = nextGate(mesh, p, route);
    if (p.mode !== 'cross' && gate) {
      const d = Math.hypot(gate.x - p.x, gate.y - p.y);
      if (d < ASK_AT) {
        const edge = crossingEdge(w, nav, gate.crossing);
        const allowed = !edge || mayEnterCrossing(w, edge, p.mode === 'wait' ? p.waited : 0);
        if (allowed) {
          p.mode = 'cross';
          p.crossing = gate.crossing;
          p.waited = 0;
        } else {
          if (p.mode !== 'wait') { p.mode = 'wait'; p.crossing = gate.crossing; p.waited = 0; }
          p.waited += DT;
          face = gate.across;
        }
      }
      if (p.mode !== 'cross') limit = Math.sqrt(2 * DECEL * Math.max(0, d - KERB_STOP));
    }

    // --- the velocity it would like: towards the corner, at its pace
    const dx = target.x - p.x, dy = target.y - p.y;
    const dist = Math.hypot(dx, dy) || 1;
    const slow = lastLeg ? Math.sqrt(2 * DECEL * toGoal) : Infinity;
    // A follower keeps its leader's pace, a little quicker when behind its
    // place; a leader waits for anybody dropping back.
    let pace = p.pace;
    if (lead) pace = Math.min(p.pace * 1.25, lead.v + toGoal * FOLLOW_GAIN);
    else if (p.party.size > 1) {
      let lag = 0;
      for (const q of s.people) if (q.leader === p) lag = Math.max(lag, Math.hypot(q.x - p.x, q.y - p.y));
      p.waitingForParty = lag > PARTY_WAIT ? p.waitingForParty + DT : 0;
      if (p.waitingForParty > PARTY_PATIENCE) {
        // Held up too long: whoever is behind goes the rest of the way alone.
        for (const q of s.people) {
          if (q.leader !== p || Math.hypot(q.x - p.x, q.y - p.y) <= PARTY_WAIT) continue;
          q.leader = null;
          q.goalX = p.goalX; q.goalY = p.goalY; q.goalTri = p.goalTri; q.leaving = p.leaving;
          if (!plan(s, q)) q.path = null;
        }
        p.waitingForParty = 0;
      } else if (lag > PARTY_WAIT) pace = 0;
      else if (lag > PARTY_SLOW) pace *= 0.5;
    }
    const speed = Math.min(pace, limit, lead ? Infinity : slow);
    const prefX = (dx / dist) * speed, prefY = (dy / dist) * speed;

    // --- anticipation: what the people around will do, in metres
    // The velocity the goal pull and the avoidance forces balance at: the
    // pace towards the corner, bent by what the people around are about to
    // do. Integrating towards it from the body's own velocity instead left
    // anyone starting from rest wanting a few centimetres a second - too
    // little to turn or step for - and slow walkers never set off at all.
    let fx = 0, fy = 0;
    for (const q of neighbours(g, p, NEIGHBOUR_REACH, near)) {
      if (q.v < STANDING) {
        // Somebody standing in the way is walked round, on whichever side
        // they are not: time-to-collision against a body that does not
        // move pushed straight back, and a walker leaving a zebra past
        // somebody waiting at its kerb turned back and forth in front of them.
        const ux = dx / dist, uy = dy / dist;
        const ox = q.x - p.x, oy = q.y - p.y;
        const ahead = ox * ux + oy * uy, across = -ox * uy + oy * ux;
        const reach = 2 * R + PERSONAL;
        if (ahead > 0 && ahead < PASS_AHEAD && Math.abs(across) < reach) {
          const away = across === 0 ? (p.id % 2 ? 1 : -1) : -Math.sign(across);
          const k = PASS_PUSH * (1 - Math.abs(across) / reach);
          fx += -uy * away * k; fy += ux * away * k;
        }
      } else {
        const [ax, ay] = ttcForce(p, q);
        fx += ax; fy += ay;
      }
      // Close by, a wish to keep apart: two people heading the same way
      // side by side walk on in parallel instead of both closing on the one
      // line between them, where each refused the other's step for ever.
      const sx = p.x - q.x, sy = p.y - q.y, d = Math.hypot(sx, sy);
      if (d > 1e-6 && d < KEEP_APART) {
        const push = KEEP_APART_PUSH * (1 - d / KEEP_APART);
        fx += (sx / d) * push; fy += (sy / d) * push;
      }
    }
    // Walls push back gently inside arm's reach: a body pressed to one by
    // somebody passing got stuck on its line, walking along it forever.
    let wallD = Infinity, wallNx = 0, wallNy = 0;
    mesh.wallsNear(p.x, p.y, WALL_HUG, (qx, qy, d) => {
      if (d < 1e-6 || d >= wallD) return;
      wallD = d; wallNx = (p.x - qx) / d; wallNy = (p.y - qy) / d;
    });
    // A nudge off the nearest wall only: summed over every piece of a wall
    // (edges are split every few units) it outweighed the walk itself and
    // turned a body walking along a pavement into the far side of it.
    if (wallD < WALL_REACH) {
      const push = WALL_PUSH * (1 - wallD / WALL_REACH);
      fx += wallNx * push;
      fy += wallNy * push;
    }
    const fm = Math.hypot(fx, fy);
    if (fm > TTC_MAX_FORCE) { fx *= TTC_MAX_FORCE / fm; fy *= TTC_MAX_FORCE / fm; }
    // Beside a wall, the part of the avoidance that points into it is
    // dropped: stepping aside for somebody coming the other way pinned
    // walkers to the side of a zebra, facing a wall they could not step
    // through. The pull towards the route is left alone - its corner may lie
    // close to that very wall.
    if (wallD < WALL_HUG) {
      const into = -(fx * wallNx + fy * wallNy);
      if (into > 0) { fx += into * wallNx; fy += into * wallNy; }
    }
    let wantX = prefX + fx * UNIT * RELAX, wantY = prefY + fy * UNIT * RELAX;
    const wm = Math.hypot(wantX, wantY);
    const vmax = Math.min(p.pace * 1.15, Math.max(limit, 0), slow * 1.15 + m(0.05));
    if (wm > vmax) { wantX *= vmax / wm; wantY *= vmax / wm; }
    let wantSpeed = Math.min(Math.hypot(wantX, wantY), vmax);

    // --- the body: turn towards where it wants to go, step forward
    // Stopped at the kerb it faces the zebra and holds there until it may
    // cross; it used to swing between the zebra and the way it came as its
    // wanted speed hovered round the threshold for turning to it.
    if (p.mode !== 'wait') p.atKerb = false;
    else if (gate && p.v < m(0.05) && Math.hypot(gate.x - p.x, gate.y - p.y) < KERB_STOP + m(0.3)) p.atKerb = true;
    // In its place beside a leader who has stopped, a companion stops too and
    // looks the same way: at the zebra they are waiting for, or wherever.
    const besideStoppedLead = !!lead && toGoal < m(0.3) && lead.v < m(0.1);
    if (p.atKerb && gate) { face = gate.across; wantX = 0; wantY = 0; }
    else if (besideStoppedLead) { face = lead!.heading; wantX = 0; wantY = 0; }
    else if (p.yielding > 0) {
      // Giving way: stand, facing the way on.
      face = Math.atan2(target.y - p.y, target.x - p.x);
      wantX = 0; wantY = 0;
    } else if (wantSpeed > m(0.08)) face = Math.atan2(wantY, wantX);
    wantSpeed = Math.min(Math.hypot(wantX, wantY), vmax);
    turn(p, face);
    const off = face === null ? 0 : wrap(face - p.heading);
    // Walk only as fast as the heading lines up: a place behind is turned to first.
    const aligned = wantSpeed * Math.max(0, Math.cos(off)) * (Math.abs(off) > 1.2 ? 0 : 1);
    const dv = aligned - p.v;
    p.v = Math.max(0, p.v + Math.max(-DECEL * DT, Math.min(ACCEL * DT, dv)));
    // Forward only: no part of any move is sideways or backwards.
    const nx = p.x + Math.cos(p.heading) * p.v * DT, ny = p.y + Math.sin(p.heading) * p.v * DT;

    // --- hard limits: stay on the mesh, off zebras not granted, out of people
    const fromX = p.x, fromY = p.y;
    const moved = settle(mesh, p, nx, ny, near);
    const intended = Math.hypot(nx - fromX, ny - fromY);
    const progressed = intended > 1e-6 && Math.hypot(p.x - fromX, p.y - fromY) >= intended * 0.5;
    // Somebody in the way is waited for, facing the way on, as anybody gives
    // way on a narrow pavement. A wall in the way needs nothing: the body is
    // already turning towards a corner it can see, and the next step fits.
    if (!moved && wantSpeed > m(0.08) && LAST_REFUSAL === 'person') p.yielding = YIELD_HOLD;
    // How long people have kept this body from getting on, however it stood.
    if (p.yielding > 0 || (!moved && LAST_REFUSAL === 'person')) p.held += DT;
    else if (moved && progressed) p.held = Math.max(0, p.held - DT * 2);
    p.yielding = Math.max(0, p.yielding - DT);
    if (!moved) {
      // Refused: the body stands, braking hard, and tries again next tick.
      p.v = Math.max(0, p.v - HARD_DECEL * DT);
      if (p.mode !== 'wait' && wantSpeed > m(0.08)) p.stuck += DT;
    } else {
      p.stuck = Math.max(0, p.stuck - DT);
    }

    // --- leaving a zebra
    if (p.mode === 'cross' && !isZebra(mesh.region[p.tri]!)) {
      const onPath = route.tris[p.ci] === p.tri ? p.ci : -1;
      const stillAhead = gate && gate.crossing === p.crossing && onPath >= 0 && onPath < gate.index;
      if (!stillAhead) { p.mode = 'walk'; p.crossing = -1; }
    }

    // Getting nowhere, a fresh route from where the body stands - on a zebra
    // too: the crossing already granted stays granted.
    if (p.stuck > REPLAN_AFTER) {
      p.stuck = 0;
      if (!plan(s, p)) pickGoal(w, s, p);
    }
  }

  // Arrived: through the door or off the map, or on to somewhere else. When
  // a party's leader goes in, the rest follow it to the same place.
  for (const p of arrived) {
    if (!p.leaving && pickGoal(w, s, p)) continue;
    for (const q of s.people) {
      if (q.leader !== p) continue;
      q.leader = null;
      q.goalX = p.goalX; q.goalY = p.goalY; q.goalTri = p.goalTri; q.leaving = true;
      if (!plan(s, q) && !pickGoal(w, s, q)) arrived.push(q);
    }
    remove(s, p);
  }
  publishCrossings(w, s);
}

/**
 * Keeps the corridor in step with the body: finds its triangle a little
 * ahead or behind in the route, or, when avoidance took it into a triangle
 * beside the route, puts that triangle at the front. False when the body is
 * somewhere the route can not be joined from.
 */
function follow(mesh: WorldNav['mesh'], p: Person): boolean {
  const path = p.path;
  if (!path) return false;
  const tris = path.tris;
  if (tris[p.ci] === p.tri) return true;
  for (let k = p.ci + 1; k < Math.min(tris.length, p.ci + 16); k++) if (tris[k] === p.tri) { p.ci = k; return true; }
  for (let k = p.ci - 1; k >= Math.max(0, p.ci - 6); k--) if (tris[k] === p.tri) { p.ci = k; return true; }
  const back = mesh.portals[p.tri]!.find((q) => q.to === tris[p.ci]);
  if (!back) return false;
  tris.splice(p.ci, 0, p.tri);
  path.portals.splice(p.ci, 0, back);
  return true;
}

/**
 * Where a companion walks: abreast of its leader, on alternate sides, when
 * the footway has room there; otherwise in file behind.
 */
function slotBeside(mesh: WorldNav['mesh'], lead: Person, p: Person, crowded: boolean): { x: number; y: number; t: number } {
  const hx = Math.cos(lead.heading), hy = Math.sin(lead.heading);
  // Meeting people coming the other way, a party falls into file behind its
  // leader, and spreads out again once they are past.
  if (crowded) {
    const back = mesh.nearest(lead.x - hx * m(0.8) * p.rank, lead.y - hy * m(0.8) * p.rank, m(1));
    if (back) return back;
  }
  const spacing = Math.max(MIN_GAP * 1.1, m(0.62) * (p.party.hasChild ? 0.9 : 1));
  const side = (p.rank % 2 ? 1 : -1) * spacing * Math.ceil(p.rank / 2);
  const ax = lead.x - hy * side - hx * m(0.2), ay = lead.y + hx * side - hy * m(0.2);
  const abreast = mesh.nearest(ax, ay, m(0.1));
  if (abreast && isZebra(mesh.region[abreast.t]!) === isZebra(mesh.region[lead.tri]!)) return abreast;
  const back = mesh.nearest(lead.x - hx * m(0.8) * p.rank, lead.y - hy * m(0.8) * p.rank, m(1));
  return back ?? { x: lead.x, y: lead.y, t: lead.tri };
}

/**
 * Whether somebody ahead, within `reach`, is walking the other way towards
 * the path `(ux, uy)` from `p`.
 */
function oncoming(g: Map<number, Person[]>, p: Person, ux: number, uy: number, reach: number): boolean {
  for (const q of neighbours(g, p, reach, [])) {
    const dx = q.x - p.x, dy = q.y - p.y;
    const ahead = dx * ux + dy * uy;
    if (ahead <= 0) continue;
    if (Math.abs(-dx * uy + dy * ux) > m(1.2)) continue;
    const qx = Math.cos(q.heading), qy = Math.sin(q.heading);
    if (q.v > m(0.2) && qx * ux + qy * uy < -0.5) return true;
  }
  return false;
}

/** Turns the heading towards `face` at a person's rate, easing in and out. */
function turn(p: Person, face: number | null): void {
  let want = 0;
  if (face !== null) {
    const delta = wrap(face - p.heading);
    want = Math.max(-TURN_RATE, Math.min(TURN_RATE, delta / 0.25));
    if (Math.abs(delta) < 0.01) want = 0;
  }
  const step = TURN_ACCEL * DT;
  p.turnV = Math.max(p.turnV - step, Math.min(p.turnV + step, want));
  p.heading = wrap(p.heading + p.turnV * DT);
}

/**
 * Moves the body to (x, y) if it may stand there: on the mesh (walking across
 * portals from where it is), not on a zebra it has not been let onto, and no
 * closer to anybody than two bodies' radii (unless it is moving apart).
 */

/** Why the last refused step was refused: a wall (or a zebra not granted), or somebody in the way. */
let LAST_REFUSAL: 'mesh' | 'person' = 'mesh';

function settle(mesh: WorldNav['mesh'], p: Person, x: number, y: number, near: readonly Person[]): boolean {
  if (x === p.x && y === p.y) return true;
  // A step is a few centimetres, far thinner than anything a body walks
  // round, so where it lands decides: on the mesh (found from the triangle it
  // left, round a shared corner if need be), the body goes; off it, it does
  // not. Creeping part of the way instead walked bodies into walls by
  // millimetres a tick.
  const t = mesh.step(p.tri, x, y, ON_MESH);
  if (t < 0) { LAST_REFUSAL = 'mesh'; return false; }
  const region = mesh.region[t]!;
  if (isZebra(region) && !(p.mode === 'cross' && region === p.crossing)) { LAST_REFUSAL = 'mesh'; return false; }
  for (const q of near) {
    const before = Math.hypot(q.x - p.x, q.y - p.y);
    const after = Math.hypot(q.x - x, q.y - y);
    // Held up a while, a body squeezes past, shoulder to shoulder.
    const gap = p.held > SQUEEZE_AFTER ? SQUEEZE_GAP : MIN_GAP;
    if (after < gap && after < before) { LAST_REFUSAL = 'person'; return false; }
  }
  // Accepted within a centimetre of the edge, placed exactly on the mesh:
  // standing a hair outside it, every exact question asked from there
  // (can I see my corner, which way round) came back "no".
  const on = mesh.clampTo(t, x, y);
  p.x = on.x;
  p.y = on.y;
  p.tri = t;
  return true;
}

/**
 * Anticipatory force from `q` on `p`, in m/s² (Karamouzas, Skinner & Guy
 * 2014): grows as the time to their collision shrinks, pushing each out of
 * the other's way long before they meet.
 */
function ttcForce(p: Person, q: Person): [number, number] {
  const wx = (q.x - p.x) / UNIT, wy = (q.y - p.y) / UNIT;
  const vx = (Math.cos(p.heading) * p.v - Math.cos(q.heading) * q.v) / UNIT;
  const vy = (Math.sin(p.heading) * p.v - Math.sin(q.heading) * q.v) / UNIT;
  let radius = (2 * R + PERSONAL) / UNIT;
  const dist = Math.hypot(wx, wy);
  if (dist < radius) radius = dist * 0.99;
  const a = vx * vx + vy * vy;
  const b = wx * vx + wy * vy;
  const c = wx * wx + wy * wy - radius * radius;
  let discr = b * b - a * c;
  if (discr <= 0 || Math.abs(a) < 1e-6) return [0, 0];
  discr = Math.sqrt(discr);
  const t = (b - discr) / a;
  if (t <= 0 || t > 6) return [0, 0];
  const k = -TTC_K * Math.exp(-t / TTC_TAU0) / (a * t ** TTC_M) * (TTC_M / t + 1 / TTC_TAU0);
  const fx = k * (vx - (b * vx - a * wx) / discr);
  const fy = k * (vy - (b * vy - a * wy) / discr);
  return [fx, fy];
}

/** The next place on the route where it steps from footway onto a zebra. */
function nextGate(mesh: WorldNav['mesh'], p: Person, path: NavPath):
  { crossing: number; x: number; y: number; across: number; index: number } | null {
  const from = path.tris[p.ci] === p.tri ? p.ci : Math.max(0, path.tris.indexOf(p.tri));
  for (let i = from; i < path.portals.length && i < from + 60; i++) {
    const a = path.tris[i]!, b = path.tris[i + 1]!;
    if (!isZebra(mesh.region[a]!) && isZebra(mesh.region[b]!)) {
      const portal = path.portals[i]!;
      const q = closestOnSegment(portal.lx, portal.ly, portal.rx, portal.ry, p.x, p.y);
      const c = mesh.crossings[mesh.region[b]!]!;
      const toA = Math.hypot(q.x - c.ax, q.y - c.ay), toB = Math.hypot(q.x - c.bx, q.y - c.by);
      const across = toA < toB ? Math.atan2(c.by - c.ay, c.bx - c.ax) : Math.atan2(c.ay - c.by, c.ax - c.bx);
      return { crossing: mesh.region[b]!, x: q.x, y: q.y, across, index: i + 1 };
    }
  }
  return null;
}

function crossingEdge(w: SimWorld, nav: WorldNav, crossing: number): SidewalkEdge | undefined {
  const id = nav.crossingIds[crossing];
  return id === undefined ? undefined : w.sidewalks.edges.get(w.sidewalks.crossings.get(id) ?? '');
}

// ------------------------------------------------------------------- publish

function publishCrossings(w: SimWorld, s: State): void {
  const nav = s.nav;
  w.crossingStates.clear();
  if (!nav) return;
  for (const p of s.people) {
    if (p.crossing < 0) continue;
    const c = nav.mesh.crossings[p.crossing]!;
    const id = nav.crossingIds[p.crossing]!;
    const length = Math.hypot(c.bx - c.ax, c.by - c.ay);
    let state = w.crossingStates.get(id);
    if (!state) { state = emptyCrossingState(length); w.crossingStates.set(id, state); }
    const ux = (c.bx - c.ax) / length, uy = (c.by - c.ay) / length;
    const along = (p.x - c.ax) * ux + (p.y - c.ay) * uy;
    if (p.mode === 'cross') {
      const goingB = Math.cos(p.heading) * ux + Math.sin(p.heading) * uy >= 0;
      state.occupants.push({
        id: p.id,
        s: Math.max(0, Math.min(length, along)),
        forward: goingB,
        v: p.v,
        held: p.v < m(0.3) && p.stuck > 2,
      });
    } else if (p.mode === 'wait') {
      if (along < length / 2) state.waitingFrom++;
      else state.waitingTo++;
      state.demand = true;
      state.longestWait = Math.max(state.longestWait, p.waited);
    }
  }
}

function publishViews(w: SimWorld, s: State): void {
  const views = w.pedViews;
  const byId = w.pedViewById;
  views.length = 0;
  byId.clear();
  const nav = s.nav;
  for (const p of s.people) {
    const v = p.view;
    v.x = p.x; v.y = p.y; v.heading = p.heading;
    v.prev.x = p.prevX; v.prev.y = p.prevY; v.prev.heading = p.prevHeading;
    v.v = p.v; v.turnV = p.turnV; v.age = p.age;
    v.party = p.party; v.rank = p.rank;
    const region = nav && p.tri >= 0 ? nav.mesh.region[p.tri]! : FOOTWAY;
    v.ground = isZebra(region) ? 'crossing' : region === OPEN ? 'open' : 'footway';
    const seg = nav && p.tri >= 0 ? nav.segment[p.tri]! : -1;
    v.segment = seg >= 0 ? (seg as never) : undefined;
    v.walking = p.mode !== 'wait' && p.v > m(0.1);
    // A companion standing by a leader who waits at a kerb is waiting too.
    const waiter = p.mode === 'wait' ? p : p.leader && p.leader.mode === 'wait' && p.v < m(0.1) ? p.leader : null;
    v.kerbWait = waiter ? waiter.waited : 0;
    v.waitingFor = waiter && nav ? nav.crossingIds[waiter.crossing] ?? null : null;
    views.push(v);
    byId.set(p.id, v);
  }
}
