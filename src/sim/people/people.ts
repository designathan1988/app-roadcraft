import { m } from '@world/units';
import { FOOTWAY, KERB, NAV_RADIUS, OPEN, closestOnSegment, isZebra } from '@world/nav/navmesh';
import { findPath, funnel, type NavPath } from '@world/nav/path';
import type { NavMesh } from '@world/nav/navmesh';
import type { SidewalkEdge } from '../peds/sidewalk';
import { DT, PED, PED_CEILING, PED_DENSITY } from '../params';
import { emptyCrossingState } from '../crossings/state';
import { indexReservations, mayEnterCrossing } from '../crossings/permission';
import type { SimWorld } from '../world';
import type { Boarder, PedestrianEngine } from './engine';
import { buildWorldNav, type WorldNav } from './nav';
import { PARTY_ARCHETYPES, SIT_DOWN_SECONDS, STAND_UP_SECONDS, type GestureView, type PartyView, type PedView, type PersonAgeClass, type PersonGender } from './view';
import { planParty } from './party';
import { keepRight, orcaLine, solveOrca, wallLine, type OrcaBody, type OrcaLine } from './orca';

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
 * around it â€” those are not rules checked afterwards, they are the only way
 * the body can move.
 *
 * `docs/design/agency-architecture.md` Â§3.
 */

interface Person {
  readonly id: number;
  /** A resident's trip (city life): walks to its goal and in, and is reported when it gets there. */
  trip?: number;
  x: number;
  y: number;
  heading: number;
  /** Speed, u/s: how fast the body moves, whichever way. */
  v: number;
  /** Velocity, u/s, and the one chosen for this tick before anybody moves. */
  vx: number;
  vy: number;
  nvx: number;
  nvy: number;
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
  /** Seconds without getting on towards where it wants to go. */
  blocked: number;
  /** Seconds left of everybody giving way to it, and of walking through people. */
  urgent: number;
  ghost: number;
  /** A fresh route has been tried since it got stuck. */
  replanned: boolean;
  /** Walking: facing the way it goes (with hysteresis, so standing does not turn it). */
  facingWalk: boolean;
  /** The way it walks, smoothed: what it faces. */
  faceX: number;
  faceY: number;
  /** The way it last chose to go, and seconds left keeping to it after turning round. */
  commitDir: number;
  commitLeft: number;
  /** What it wanted last tick, for diagnosis. */
  intent: { want: number; face: number | null; tx: number; ty: number; speed: number; limit: number; tick: number; prefX?: number; prefY?: number } | null;
  /** Seconds standing in the queue for a zebra, behind somebody at its kerb, and which. */
  queued: number;
  queuedFor: number;
  /** Seconds standing still with its party, and the talk it has struck up. */
  stoodTogether: number;
  talk: GestureView | null;
  /** A bench seat it is going to or sitting on. */
  sit: Sit | null;
  /** Stopped a moment to do something (read, drink, take a photo...): the gesture, played to its end. */
  pause: GestureView | null;
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
  /**
   * Every zebra it has been let onto with that one: the zebras its route
   * crosses one after another without touching a pavement in between.
   */
  granted: number[];
  waited: number;
  /** Stopped at the kerb, facing the zebra, until it may cross; where it stopped. */
  atKerb: boolean;
  standX: number;
  standY: number;
  /** Seconds waiting for a zebra without getting any closer to the kerb. */
  waitHeld: number;
  view: PedView;
}

/** Going to a bench and sitting on it: the phases the renderer plays. */
interface Sit {
  readonly key: string;
  readonly face: number;
  /** In front of the seat, and the point of the mesh it is reached from. */
  readonly x: number;
  readonly y: number;
  readonly mx: number;
  readonly my: number;
  phase: 'approach' | 'step' | 'turn' | 'sitDown' | 'seated' | 'standUp' | 'leave';
  /** Seconds to stay seated. */
  readonly hold: number;
  readonly gesture: GestureView;
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
  /** Bench seats taken, by key, to the person on them. */
  taken: Map<string, number>;
  /** Residents' trips that ended since the city last asked. */
  arrivals: number[];
}

const STATES = new WeakMap<SimWorld, State>();

function stateOf(w: SimWorld): State {
  let s = STATES.get(w);
  if (!s) {
    s = { nav: null, people: [], byId: new Map(), nextId: 1, spawnClock: 0, footTris: [], footArea: [], taken: new Map(), arrivals: [] };
    STATES.set(w, s);
  }
  return s;
}

// ------------------------------------------------------------------ constants

const R = NAV_RADIUS;
/** Closest two bodies may ever be, centre to centre, u. */
const MIN_GAP = 2 * R;
/** A body as avoidance sees it: its radius and a hand's breadth, u. */
const BODY_RADIUS = R + m(0.03);
/** How far around, how many people, and how many seconds ahead avoidance looks. */
const ORCA_REACH = m(3);
const ORCA_NEIGHBOURS = 10;
const ORCA_HORIZON = 1.5;
const PARTY_HORIZON = 0.4;
/**
 * Setting off faster than this, the body turns to face the way it goes; it
 * keeps doing so until slower than the second. Between, and standing, it
 * keeps its facing, u/s.
 */
const FACE_START = m(0.35);
/** Seconds over which the way a body faces follows the way it walks. */
const FACE_SMOOTH = 0.25;
const FACE_STOP = m(0.15);
/** Within this of a wall or a zebra's mouth avoidance keeps off it, u; and closes on it at most over this many seconds. */
const WALL_LOOK = m(0.6);
const WALL_HORIZON = 0.4;
/** A wall's line does not hold a body within this of the wall's ends, u. */
const WALL_END = m(0.05);
/** Further than this on a wall's far side, it is not this body's wall, u. */
const WALL_SIDE = 0.01;
/** A step back and a shuffle aside, at most, u/s. */
const BACK_MAX = m(0.15);
const SIDE_MAX = m(0.35);
/** The shuffle aside a body can make walking forward at `fwd`, u/s: none to speak of at a walk. */
const sideAt = (fwd: number): number => Math.max(m(0.08), SIDE_MAX - Math.abs(fwd) * 0.3);
/** How quickly a body changes its velocity, u/sÂ². */
const BODY_ACCEL = m(2.5);
const SIDE_ACCEL = m(0.8);
/** Pushed this far off its place at a kerb, somebody waiting walks back to it, u. */
const KERB_DRIFT = m(0.7);
/** Nearer than this behind somebody waiting for the same zebra, a person queues, u. */
const QUEUE_GAP = m(0.9);
/** Seconds getting no closer to the kerb before somebody waiting for a zebra waits where it is. */
const WAIT_SETTLE = 0.5;
/** How far ahead of somebody wanting through a body standing in the way makes room, and how quickly, u, u/s. */
const ROOM_REACH = m(1.5);
const ROOM_STEP = m(0.5);
/** Seconds without progress before everybody gives way: on a zebra, elsewhere; and for how long. */
const URGENT_CROSSING = 1.5;
const URGENT_WALKING = 2;
const URGENT_HOLD = 3;
/** Seconds without progress, even so, before it walks through people; and for how long. */
const GHOST_CROSSING = 3;
const GHOST_WALKING = 8;
const GHOST_HOLD = 1.5;
const DECEL = m(1.6);
/** Braking to a stop at a bench, u/sÂ². */
const HARD_DECEL = m(4);
const TURN_RATE = 3.2;
const TURN_ACCEL = 12;
/** A corner this close is reached, u. */
const CORNER_ON = m(0.01);
/** Seconds a person keeps to a way it has turned round to take, whatever the route says meanwhile. */
const COMMIT = 0.4;
/** Pace at a corner turned through a right angle or more, u/s; a body slows into a sharp turn. */
const TURN_PACE = m(0.5);
/** How far from a kerb a person stops to wait, u. */
const KERB_STOP = m(0.3);
/** Nearer than this to the kerb, a person asks to cross; if refused, waits, u. */
const ASK_AT = m(2.5);
/** Share of a zebra's half-width to its right that somebody waiting stands aside by. */
const WAIT_ASIDE = 0.45;
/** Nearer than this to a zebra's kerb, standing still is queueing for it, u. */
const QUEUE_REACH = m(3);
/** Extra cost of walking along the kerb stone, per unit walked: routes keep to the footway. */
const KERB_COST = 2;
/** Planned wait at a zebra, as extra walking distance, u. */
const CROSS_COST = m(12);
const CELL = m(2.5);
/** Seconds a leader waits for a companion who has fallen behind before it goes its own way. */
const PARTY_PATIENCE = 5;
/** Shortest trip that ends by leaving: nobody walks out of a door and straight back in, u. */
const MIN_LEAVE = m(10);
const SPAWN_INTERVAL = 0.5;
const MIN_TRIP = m(40);
/** Chance, by age, that somebody alone goes to sit on a free bench nearby when it gets somewhere. */
const BENCH_CHANCE = { child: 0, adult: 0.16, elder: 0.45 } as const;
/** Ticks between a walker's glances for a free bench, the reach of the glance, and the chance, by age, it sits. */
const BENCH_LOOK = 60;
/**
 * How often somebody walking alone stops for a moment to do something, ticks
 * between looks; and the chance, at each look, that they do. On a square or
 * in a park (open ground) people dance, cheer, crouch to a child, take
 * photos; on a footway they read, drink, check a phone, wave to somebody.
 */
const PAUSE_LOOK = 45;
const PAUSE_CHANCE = { child: 0.03, adult: 0.05, elder: 0.04 } as const;
const PAUSE_STREET: readonly [GestureView['kind'], number, number][] = [
  // [what, shortest, longest] seconds
  ['phone', 8, 20], ['read', 10, 25], ['drink', 8, 16], ['headphones', 8, 18], ['wave', 5, 6],
  ['photo', 8, 9], ['bag', 6, 12], ['crouch', 7, 12], ['umbrella', 8, 14],
];
/** Share of the stops on a footway that are a trip and a fall instead. */
const FALL_SHARE = 0.03;
const PAUSE_OPEN: readonly [GestureView['kind'], number, number][] = [
  ['photo', 8, 9], ['dance', 10, 22], ['cheer', 8, 15], ['crouch', 8, 14], ['read', 12, 30], ['drink', 8, 16],
  ['laugh', 6, 10], ['wave', 5, 6],
];
const BENCH_PASS_REACH = m(8);
const BENCH_PASS = { child: 0, adult: 0.05, elder: 0.2 } as const;
/** Pace of the few steps between the footway and a seat, u/s. */
const STEP_PACE = m(0.75);
/** Farthest a bench is walked to, u; and how long people sit, s. */
const BENCH_REACH = m(60);
const SIT_RANGE = [14, 48] as const;
/** Seconds a party stands together before it talks. */
const TALK_AFTER = 1.5;
/** Farthest from a lane's centre somebody on the footway can be hailed, u. */
const HAIL_REACH = m(8);
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
/** This close to its goal a person is there, whatever way round the route still goes, u. */
const ARRIVED = m(0.15);
/** Seconds of getting nowhere before a person looks for another way. */
const REPLAN_AFTER = 2;

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
      // A city with residents has only their walks (`sim/city`): nobody else
      // comes in at the doors or the map's edges.
      if (!enabled || !s.nav || !w.edgeTraffic) return;
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
    walkTrip(w, trip) {
      const s = stateOf(w);
      const mesh = s.nav?.mesh;
      if (!mesh) return null;
      const from = mesh.nearest(trip.fromX, trip.fromY, m(6));
      const to = mesh.nearest(trip.toX, trip.toY, m(6));
      if (!from || !to) return null;
      const p = create(w, s, s.nextId, from.x, from.y, from.t, Math.atan2(to.y - from.y, to.x - from.x),
        { ageClass: trip.ageClass, gender: trip.seed % 2 ? 'f' : 'm' });
      p.goalX = to.x; p.goalY = to.y; p.goalTri = to.t;
      p.leaving = true;
      if (!plan(s, p)) { s.byId.delete(p.id); s.people.splice(s.people.indexOf(p), 1); return null; }
      p.trip = trip.trip;
      const first = p.path?.corners[0];
      if (first) p.heading = p.prevHeading = p.view.heading = Math.atan2(first.y - p.y, first.x - p.x);
      return p.id;
    },
    takeArrivals(w) {
      const s = stateOf(w);
      const out = s.arrivals;
      s.arrivals = [];
      return out;
    },
    bridge: {
      // Somebody a car could stop for: alone, not a child, walking on the
      // footway along that side of the lane, nearest the front first.
      hailable(w, lanelet, s0, s1, exclude = new Set()) {
        const s = stateOf(w);
        const lane = w.lanelet(lanelet);
        if (!lane || !s.nav) return null;
        let best: { id: number; s: number } | null = null;
        for (const p of s.people) {
          if (p.mode !== 'walk' || p.party.size !== 1 || p.ageClass === 'child' || exclude.has(p.id)) continue;
          if (isZebra(s.nav.mesh.region[p.tri]!) || s.nav.segment[p.tri] !== lane.segment) continue;
          const hit = lane.centre.closestPoint({ x: p.x, y: p.y });
          if (hit.s < s0 || hit.s > s1 || hit.distance > HAIL_REACH) continue;
          const f = lane.centre.sampleAt(hit.s);
          if ((p.x - f.p.x) * f.t.y - (p.y - f.p.y) * f.t.x <= 0) continue;
          if (!best || hit.s < best.s) best = { id: p.id, s: hit.s };
        }
        return best;
      },
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
    id, x, y, heading, v: 0, vx: 0, vy: 0, nvx: 0, nvy: 0, turnV: 0, prevX: x, prevY: y, prevHeading: heading, age: 0, tri,
    pace, ageClass: cls, gender: sex, party, rank, leader: traits.leader ?? null, waitingForParty: 0,
    blocked: 0, urgent: 0, ghost: 0, replanned: false, facingWalk: false, commitDir: NaN, commitLeft: 0, faceX: 0, faceY: 0, intent: null, queued: 0, queuedFor: -1, stoodTogether: 0, talk: null, sit: null, pause: null,
    goalX: x, goalY: y, goalTri: tri, leaving: false, path: null, ci: 0,
    mode: 'walk', crossing: -1, granted: [], waited: 0, atKerb: false, standX: x, standY: y, waitHeld: 0, view,
  };
  s.people.push(p);
  s.people.sort((a, b) => a.id - b.id);
  s.byId.set(id, p);
  s.nextId = Math.max(s.nextId, id + 1);
  return p;
}

function remove(s: State, p: Person): void {
  standUp(s, p);
  // A resident's walk ends here, wherever that is: the city is told.
  if (p.trip !== undefined) s.arrivals.push(p.trip);
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
  standUp(s, p);
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
    (from, to, length) => (isZebra(mesh.region[to]!) && mesh.region[from] !== mesh.region[to] ? CROSS_COST : 0) +
      (mesh.region[to] === KERB ? length * KERB_COST : 0));
  if (path) easeCorners(mesh, path);
  p.path = path;
  p.ci = 0;
  return path !== null;
}

/** Room a route keeps from the edge of the ground - the kerb, a wall - where it turns, u. */
const CORNER_ROOM = m(0.8);

/**
 * Moves each turning point of a route off the edge of the ground.
 *
 * The shortest line through the mesh turns exactly on its corners, and the
 * corners of a footway are the kerb's edge: between two turns on the same
 * side of a street the route ran along the kerb stone itself, and everybody
 * walking that way walked in single file on the very edge of the pavement,
 * the outer ones spilling onto the road. People keep clear of a kerb and of
 * a wall, so the turns are pushed in by `CORNER_ROOM` (as far as the ground
 * allows), and the straight runs between them come off the edge with them.
 * The goal stays where it is (a door, a seat), and nothing is moved on or
 * next to a zebra, whose way across is fixed.
 */
function easeCorners(mesh: NavMesh, path: NavPath): void {
  const corners = path.corners;
  for (let i = 0; i < corners.length - 1; i++) {
    const c = corners[i]!;
    const tri = path.tris[c.tri] ?? -1;
    if (tri < 0 || isZebra(mesh.region[tri]!)) continue;
    const before = path.tris[c.tri - 1];
    if (before !== undefined && isZebra(mesh.region[before]!)) continue;
    const layer = mesh.layer[tri]!;
    let px = 0, py = 0;
    mesh.wallSegmentsNear(c.x, c.y, CORNER_ROOM, layer, (ax, ay, bx, by, nx, ny) => {
      const q = closestOnSegment(ax, ay, bx, by, c.x, c.y);
      if (Math.hypot(c.x - q.x, c.y - q.y) > CORNER_ROOM) return;
      const off = Math.max(0, (c.x - ax) * nx + (c.y - ay) * ny);
      if (off >= CORNER_ROOM) return;
      px += nx * (CORNER_ROOM - off);
      py += ny * (CORNER_ROOM - off);
    });
    const push = Math.hypot(px, py);
    if (push < 1e-6) continue;
    // Two walls meeting at the corner both push: never further than the room.
    if (push > CORNER_ROOM * 1.4) { px *= (CORNER_ROOM * 1.4) / push; py *= (CORNER_ROOM * 1.4) / push; }
    for (const k of [1, 0.6, 0.3]) {
      const x = c.x + px * k, y = c.y + py * k;
      const u = mesh.locate(x, y);
      if (u < 0 || mesh.layer[u] !== layer || isZebra(mesh.region[u]!)) continue;
      c.x = x; c.y = y;
      break;
    }
  }
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
    p.granted = p.crossing >= 0 ? [p.crossing] : [];
    const goal = mesh.locate(p.goalX, p.goalY);
    if (goal < 0 || !(p.goalTri = goal, plan(s, p))) {
      if (p.trip !== undefined || !pickGoal(w, s, p)) remove(s, p);
    }
  }
  // A city just opened is populated at once, all over; from then on people
  // only come and go through doors and the map's edges.
  if (!s.people.length && w.edgeTraffic) {
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

/** One person's decision for this tick, made before anybody moves. */
interface Decision {
  readonly p: Person;
  readonly route: NavPath;
  readonly gate: ReturnType<typeof nextGate>;
  /** The velocity it would like, u/s. */
  readonly prefX: number;
  readonly prefY: number;
  /** A way it means to face whatever it does (a zebra, its leader's way), or null. */
  readonly face: number | null;
  /** Stepping aside for somebody, not going anywhere: not a hold-up if it does not get far. */
  readonly makingRoom: boolean;
}

function step(w: SimWorld, s: State): void {
  const nav = s.nav;
  if (!nav) return;
  const mesh = nav.mesh;
  indexReservations(w);
  const g = grid(s.people);
  const near: Person[] = [];
  const arrived: Person[] = [];
  const decided: Decision[] = [];
  // Avoidance between people only where it can be seen (`SimWorld.focus`).
  const focus = w.focus;
  const watched = (p: Person): boolean =>
    !focus || (focus.detail && Math.hypot(p.x - focus.x, p.y - focus.y) <= focus.r);

  // ---- 1. everybody decides, from where everybody stands now
  for (const p of s.people) {
    p.age += DT;
    // On a bench, or turning to sit on one: the body stays where it stands.
    if (p.sit && p.sit.phase !== 'approach') {
      p.vx = 0; p.vy = 0;
      if (sitStep(w, s, p)) arrived.push(p);
      continue;
    }
    // Stopped a moment to do something: standing where they are until done.
    if (p.pause) {
      // Standing still: the speed the body is drawn at too, or it was drawn walking on the spot.
      p.vx = 0; p.vy = 0; p.v = 0;
      p.pause.t += DT;
      if (p.pause.t < (p.pause.hold ?? 0)) continue;
      p.pause = null;
    }
    // Walking alone, now and then somebody stops to do something.
    if (!p.sit && !p.leader && p.party.size === 1 && p.mode === 'walk' && p.tri >= 0 &&
        (p.id * 7 + w.clock.tick) % PAUSE_LOOK === 0 && !isZebra(mesh.region[p.tri]!) &&
        w.rng.people.float() < PAUSE_CHANCE[p.ageClass]) {
      const open = mesh.region[p.tri] === OPEN;
      const menu = open ? PAUSE_OPEN : PAUSE_STREET;
      const [kind, lo, hi] = !open && p.ageClass !== 'child' && w.rng.people.float() < FALL_SHARE ? ['fall', 6, 8] as const
        : menu[Math.floor(w.rng.people.float() * menu.length) % menu.length]!;
      p.pause = { kind, phase: 'hold', t: 0, hold: lo + (hi - lo) * w.rng.people.float() };
      p.vx = 0; p.vy = 0; p.v = 0;
      continue;
    }
    // Passing a free bench, somebody alone may sit down on it for a while.
    if (!p.sit && !p.leader && p.party.size === 1 && p.mode === 'walk' && (p.id + w.clock.tick) % BENCH_LOOK === 0 &&
        benchNearby(s, p) && w.rng.people.float() < BENCH_PASS[p.ageClass]) pickSeat(w, s, p, true);
    // A follower's goal is its place beside its leader, re-aimed a few times a second.
    if (p.leader && !s.byId.has(p.leader.id)) p.leader = null;
    const lead = p.leader;
    if (lead && (!p.path || (p.id + w.clock.tick) % FOLLOW_EVERY === 0)) {
      // Beside its leader, and stays there: switching between abreast and in
      // file whenever somebody came the other way turned companions back into
      // their own party. Passing people is the avoidance's job.
      const slot = slotBeside(mesh, lead, p, false);
      p.goalX = slot.x; p.goalY = slot.y; p.goalTri = slot.t;
      if (!plan(s, p)) { p.leader = null; p.path = null; }
    }
    if (!p.path) { if (!pickGoal(w, s, p)) { arrived.push(p); continue; } }

    // --- where to: the next corners of the route, pulled taut from where the
    // body stands through the corridor of triangles still ahead. Recomputed
    // every tick, the corner walked to is always in plain sight.
    if (!follow(mesh, p) && !plan(s, p) && !pickGoal(w, s, p)) { arrived.push(p); continue; }
    const route = p.path!;
    const eye = inside(mesh, p.tri, p.x, p.y);
    const corners = funnel(eye.x, eye.y, p.goalX, p.goalY, route.portals, p.ci, 3);
    let target = corners[0]!;
    // A corner is passed once the next is in plain sight. Passed on nearness
    // alone, the next corner of a turn round a wall's end could still lie
    // behind the wall, and the body pressed into it.
    // Standing on the corner itself, the way to it is no way at all (a
    // direction of rounding noise, pointing anywhere): on to the next.
    // Rounding a corner: the way taken aims a little past the corner, away
    // from the leg after it, so the body swings wide round the end of the
    // wall rather than cutting into it (as Detour's crowd steers), and the
    // route, pulled taut again from where it then stands, moves on by itself
    // once the corner is rounded. A corner within a hair is reached. Passed
    // by any other rule - on nearness, on sight - a body was sent on past
    // corners the route had not rounded, and pressed into walls.
    if (corners[1] && Math.hypot(target.x - p.x, target.y - p.y) < CORNER_ON) target = corners[1];
    const next = target === corners[0] ? corners[1] : corners[2];
    const toGoal = Math.hypot(p.goalX - p.x, p.goalY - p.y);
    // The last leg: the corner walked to is the goal - within a hair, for a
    // goal on the mesh's edge (a bench's approach) is also a corner of it, and
    // the corner a fraction off it never compared equal: the walker never
    // slowed, never arrived, and stood pressed against the spot for good.
    const lastLeg = Math.hypot(target.x - p.goalX, target.y - p.goalY) < m(0.02);
    if (!lead && ((lastLeg && toGoal < m(0.4)) || toGoal < ARRIVED)) {
      if (p.sit?.phase === 'approach') { p.sit.phase = 'step'; p.sit.gesture.t = 0; p.vx = 0; p.vy = 0; continue; }
      arrived.push(p);
      continue;
    }

    // --- the next zebra on the route, and whether it may be stepped onto
    let limit = Infinity;
    let face: number | null = null;
    const gate = nextGate(mesh, p, route);
    // Let onto a zebra but not on it yet, and the lamp has changed or a car
    // has taken it since: back to the kerb, not into the road.
    if (p.mode === 'cross' && gate && gate.crossing === p.crossing && !isZebra(mesh.region[p.tri]!)) {
      if (!mayCross(w, nav, gate.chain, 0)) { p.mode = 'wait'; p.granted = []; p.waited = 0; }
    }
    // Let onto one zebra, and its route has since changed to another (a
    // companion re-aims at its place by its leader every few ticks): that
    // zebra is asked for afresh at its kerb. Never asked for, it could not
    // be stepped onto, and the companion stood at the kerb for good - counted
    // as crossing, with the cars waiting for it.
    if (p.mode === 'cross' && !isZebra(mesh.region[p.tri]!) && !(gate && p.granted.includes(gate.crossing))) {
      const stillOn = gate === null && p.path?.tris.slice(p.ci).some((t) => mesh.region[t] === p.crossing);
      if (!stillOn) { p.mode = 'walk'; p.crossing = -1; p.granted = []; }
    }
    if (p.mode !== 'cross' && gate) {
      const d = Math.hypot(gate.x - p.x, gate.y - p.y);
      if (d < ASK_AT) {
        // Let off the kerb only if it may cross every zebra up to the next
        // pavement: two zebras touching (the corner of a junction, two
        // junctions close together) used to be asked for one at a time, and
        // whoever was let onto the first stood on the line to the second, in
        // the road, for good.
        if (mayCross(w, nav, gate.chain, p.mode === 'wait' ? p.waited : 0)) {
          p.mode = 'cross';
          p.crossing = gate.crossing;
          p.granted = gate.chain;
          p.waited = 0;
        } else {
          if (p.mode !== 'wait') { p.mode = 'wait'; p.crossing = gate.crossing; p.waited = 0; }
          p.waited += DT;
          face = gate.across;
        }
      }
      if (p.mode === 'wait') {
        // Walk to the place to wait at, and stop there.
        target = { x: gate.wx, y: gate.wy, tri: target.tri };
        limit = Math.sqrt(2 * DECEL * Math.max(0, Math.hypot(gate.wx - p.x, gate.wy - p.y) - m(0.05)));
      } else if (p.mode !== 'cross') limit = Math.sqrt(2 * DECEL * Math.max(0, d - KERB_STOP));
    }

    // --- the velocity it would like: towards the corner, at its pace
    let dx = target.x - p.x, dy = target.y - p.y;
    if (next && p.mode !== 'wait') {
      const d0 = Math.hypot(dx, dy);
      const ex = next.x - p.x, ey = next.y - p.y, d1 = Math.hypot(ex, ey) || 1;
      dx -= (ex / d1) * d0 * 0.5;
      dy -= (ey / d1) * d0 * 0.5;
    }
    // Kept to: having turned round to go one way, a person goes that way a
    // moment before turning round again. Right at a corner the route pulled
    // taut from one millimetre or the next says "back round it" or "on", and
    // a body that obeyed each tick turned to and fro on the spot and never
    // got the few centimetres past that settle it.
    if (p.mode !== 'wait' && (dx !== 0 || dy !== 0)) {
      const way = Math.atan2(dy, dx);
      const reverses = Math.abs(wrap(way - p.commitDir)) > Math.PI / 2;
      if (p.commitLeft > 0 && reverses) {
        const l = Math.hypot(dx, dy);
        dx = Math.cos(p.commitDir) * l; dy = Math.sin(p.commitDir) * l;
      } else {
        if (reverses && !Number.isNaN(p.commitDir)) p.commitLeft = COMMIT;
        p.commitDir = way;
      }
      p.commitLeft = Math.max(0, p.commitLeft - DT);
    }
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
      } else if (lag > PARTY_SLOW) {
        // Slows to a stroll for them - never stops dead on the pavement.
        pace *= 0.45;
      }
    }
    // Into a sharp turn a body slows down, as a walker does: at full pace it
    // overshot a corner on a sliver of kerb and hovered round it.
    let turnLimit = Infinity;
    if (next && p.mode !== 'wait') {
      const ax = target.x - p.x, ay = target.y - p.y, al = Math.hypot(ax, ay);
      const bx = next.x - target.x, by = next.y - target.y, bl = Math.hypot(bx, by);
      if (al > 1e-9 && bl > 1e-9) {
        const cos = (ax * bx + ay * by) / (al * bl);
        const atCorner = TURN_PACE + (p.pace - TURN_PACE) * Math.max(0, cos);
        turnLimit = Math.sqrt(atCorner * atCorner + 2 * DECEL * al);
      }
    }
    let speed = Math.min(pace, limit, turnLimit, lead ? Infinity : slow);

    // --- standing on purpose: at its place at a kerb, or beside a leader
    // who has stopped. Once there it stays put - a shuffle aside for somebody
    // passing is not a reason to walk back - until pushed well off it.
    const settle = (): void => { p.atKerb = true; p.standX = p.x; p.standY = p.y; };
    if (p.mode !== 'wait') { p.atKerb = false; p.waitHeld = 0; }
    else if (gate && p.v < m(0.1) && Math.hypot(gate.wx - p.x, gate.wy - p.y) < m(0.3)) settle();
    // A queue: whoever comes up behind somebody already waiting for the same
    // zebra stops there and waits too. Everybody making for the one place to
    // wait pushed at each other for as long as the lamp stayed red.
    else if (gate && !p.atKerb && waiterAhead(g, p, gate.crossing, gate.wx, gate.wy)) settle();
    // Or, in a crowd at the kerb, wherever it can get no closer: it waits
    // there, as people do. Pushing on to the one place to wait, everybody in
    // the crowd counted as held up, and once "held" pushed into the others.
    else if (gate && !p.atKerb && p.waitHeld > WAIT_SETTLE) settle();
    // Pushed well off where it settled, it goes back to the kerb.
    else if (gate && p.atKerb && Math.hypot(p.standX - p.x, p.standY - p.y) > KERB_DRIFT && !waiterAhead(g, p, gate.crossing, gate.wx, gate.wy)) p.atKerb = false;
    const besideStoppedLead = !!lead && toGoal < m(0.3) && lead.v < m(0.1);
    // Standing in the queue behind somebody waiting at the kerb is waiting too.
    if (p.mode !== 'wait' && gate && p.v < m(0.1) && Math.hypot(gate.x - p.x, gate.y - p.y) < QUEUE_REACH) {
      p.queued += DT; p.queuedFor = gate.crossing;
    } else { p.queued = 0; p.queuedFor = -1; }
    if (p.atKerb && gate) { face = gate.across; speed = 0; }
    else if (besideStoppedLead) { face = lead!.heading; speed = 0; }
    else if (p.mode === 'wait') face = null;
    // Below a stroll it would rather stand than inch along: inching made a
    // body hover between moving and not, turning its head each time.
    if (speed < m(0.15)) speed = 0;
    let prefX = (dx / dist) * speed, prefY = (dy / dist) * speed;
    // A companion walking with its leader goes at the leader's velocity, put
    // right towards its place - never back against the way the party walks:
    // walked to its place at its own pace, a companion ahead of it turned
    // round into its own party.
    // Only with its place in plain sight (the route runs straight to it):
    // with a wall between - a companion on the kerb stone, its place beside
    // the leader just across - the leader's velocity forward and the route
    // back round the wall summed into the wall, and it crept along it.
    if (lead && !besideStoppedLead && lead.v > m(0.3) && toGoal < PARTY_SLOW && lastLeg) {
      const gain = Math.min(toGoal * FOLLOW_GAIN, p.pace);
      prefX = lead.vx + (dx / dist) * gain;
      prefY = lead.vy + (dy / dist) * gain;
      const lv = Math.hypot(lead.vx, lead.vy);
      const along = (prefX * lead.vx + prefY * lead.vy) / lv;
      if (along < lv * 0.3) { prefX += (lead.vx / lv) * (lv * 0.3 - along); prefY += (lead.vy / lv) * (lv * 0.3 - along); }
      const pm = Math.hypot(prefX, prefY), cap = p.pace * 1.25;
      if (pm > cap) { prefX *= cap / pm; prefY *= cap / pm; }
    }
    // Standing on purpose (at a kerb, in a queue, by its party), it steps
    // aside for anybody who wants to come through where it stands. Avoidance
    // reads velocities: somebody stopped short by a body standing in the way
    // has none, so the one standing never saw a reason to move, and the two
    // stood there - a companion in its own leader's way most of all.
    let makingRoom = false;
    if (prefX === 0 && prefY === 0 && watched(p)) {
      for (const q of neighbours(g, p, ROOM_REACH, near)) {
        const qi = q.intent;
        if (!qi || qi.prefX === undefined || qi.prefY === undefined) continue;
        const qs = Math.hypot(qi.prefX, qi.prefY);
        if (qs < m(0.3)) continue;
        const ux = qi.prefX / qs, uy = qi.prefY / qs;
        const ox = p.x - q.x, oy = p.y - q.y;
        const ahead = ox * ux + oy * uy;
        if (ahead <= 0 || ahead > ROOM_REACH) continue;
        const lat = -ox * uy + oy * ux;
        const clear = 2 * BODY_RADIUS + m(0.1);
        if (Math.abs(lat) >= clear) continue;
        // Aside to whichever side it already is of their way; dead ahead, to
        // their left - they keep right.
        const side = Math.abs(lat) > 1e-3 ? Math.sign(lat) : 1;
        const k = Math.min(ROOM_STEP, (clear - Math.abs(lat)) * 3);
        prefX += -uy * side * k; prefY += ux * side * k;
        makingRoom = true;
      }
    }
    const intent = p.intent ??= { want: 0, face: null, tx: 0, ty: 0, speed: 0, limit: 0, tick: 0 };
    intent.want = speed; intent.face = face; intent.tx = target.x; intent.ty = target.y;
    intent.speed = speed; intent.limit = limit; intent.tick = w.clock.tick;
    decided.push({ p, route, gate, prefX, prefY, face, makingRoom });
  }

  // ---- 2. the velocities: each as near the one wanted as the people around
  // allow, sharing the avoidance between them (ORCA). Worked out for all
  // before anybody moves, so nobody reacts to where another has already gone.
  const lines: OrcaLine[] = [];
  for (const d of decided) {
    const p = d.p;
    lines.length = 0;
    // Walls, and the mouths of zebras it has not been let onto: never
    // walked into, however the people around press.
    // A wall counts where the body stands abreast of it, by its own normal:
    // a straight wall comes in pieces, and the end of the next piece, a hair
    // ahead on the same line, read as a wall across the way - everybody
    // walking along a pavement edge stopped dead.
    // And only from the side it bounds: where the footway and a zebra were
    // cut apart and joined again, a scrap of the zebra's edge lies on the
    // very line of the passage onto it, and read from the kerb it shut the
    // way onto the zebra.
    // Which side the body is on is told by its triangle, not its position:
    // a body exactly on such a scrap's line was on both sides at once.
    const own = mesh.centroid(p.tri);
    mesh.wallSegmentsNear(p.x, p.y, WALL_LOOK, mesh.layer[p.tri]!, (ax, ay, bx, by, nx, ny) => {
      const ex = bx - ax, ey = by - ay, len2 = ex * ex + ey * ey;
      if (len2 < 1e-12) return;
      // Along the wall, not at its very ends: a wall's line runs on for
      // ever, and a body at the end of one could not step round it - wedged
      // at a pinch of the kerb stone with its way round the end a few
      // centimetres off. Round an end, the ground itself holds it (`slide`).
      const t = ((p.x - ax) * ex + (p.y - ay) * ey) / len2;
      const end = WALL_END / Math.sqrt(len2);
      if (t < end || t > 1 - end) return;
      if ((own.x - ax) * nx + (own.y - ay) * ny <= 0) return;
      const off = (p.x - ax) * nx + (p.y - ay) * ny;
      if (off < -WALL_SIDE) return;
      lines.push(wallLine(nx, ny, Math.max(0, off), WALL_HORIZON, LINE_POOL[lines.length] ??= { px: 0, py: 0, dx: 0, dy: 0 }));
    });
    if (!isZebra(mesh.region[p.tri]!)) {
      mesh.mouthSegmentsNear(p.x, p.y, WALL_LOOK, mesh.layer[p.tri]!, (crossing, ax, ay, bx, by, nx, ny) => {
        if (mayStepOnto(mesh, p, crossing)) return;
        const ex = bx - ax, ey = by - ay, len2 = ex * ex + ey * ey;
        const t = len2 > 1e-12 ? ((p.x - ax) * ex + (p.y - ay) * ey) / len2 : -1;
        if (t < 0 || t > 1) return;
        const off = (p.x - ax) * nx + (p.y - ay) * ny;
        if (off < -1e-3) return;
        lines.push(wallLine(nx, ny, Math.max(0, off), WALL_HORIZON, LINE_POOL[lines.length] ??= { px: 0, py: 0, dx: 0, dy: 0 }));
      });
    }
    const hard = lines.length;
    // Somebody stuck for a while does not give way to people any more; they
    // all give way to it (`shareOf`). Still giving way itself, it stood
    // among bodies that did not move until the last resort. (Giving way only
    // enough to squeeze past held it just as long.)
    if (p.ghost <= 0 && p.urgent <= 0 && watched(p)) {
      const around = neighbours(g, p, ORCA_REACH, near)
        .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
      for (let k = 0; k < around.length && k < ORCA_NEIGHBOURS; k++) {
        const q = around[k]!;
        const line = LINE_POOL[lines.length] ??= { px: 0, py: 0, dx: 0, dy: 0 };
        // People walking together keep close: between companions avoidance
        // looks only a moment ahead, or their places side by side read as a
        // collision and pushed each out of its own place, round and round.
        const together = p.party.id === q.party.id && p.party.size > 1;
        lines.push(orcaLine(bodyOf(p, A), bodyOf(q, B), together ? PARTY_HORIZON : ORCA_HORIZON, DT, shareOf(mesh, p, q), line));
      }
    }
    const [px, py] = keepRight(d.prefX, d.prefY, lines.length > hard);
    const out = solveOrca(lines, px, py, p.pace * 1.15, VELOCITY, hard);
    p.nvx = out.x; p.nvy = out.y;
    // What it wanted is what the people around read to make room for it.
    if (p.intent) { p.intent.prefX = d.prefX; p.intent.prefY = d.prefY; }
  }

  // ---- 3. the bodies move
  for (const d of decided) {
    const p = d.p;
    const nv = Math.hypot(p.nvx, p.nvy);
    // The body faces where it walks; slower than a walk - a shuffle aside, a
    // step back for somebody - it keeps facing the way it did. Turning to
    // every small push is what swung standing people's heads to and fro.
    if (nv > FACE_START) p.facingWalk = true;
    else if (nv < FACE_STOP) p.facingWalk = false;
    let face = d.face;
    // The way walked, smoothed over a quarter of a second: a slow walker's
    // velocity wavers with the people round it, and the body turned to each
    // waver.
    const k = Math.min(1, DT / FACE_SMOOTH);
    p.faceX += (p.nvx - p.faceX) * k; p.faceY += (p.nvy - p.faceY) * k;
    if (face === null && p.facingWalk && Math.hypot(p.faceX, p.faceY) > 1e-6) face = Math.atan2(p.faceY, p.faceX);
    turn(p, face);
    // What a body can do: walk forward, shuffle aside, step back - slowly.
    const hx = Math.cos(p.heading), hy = Math.sin(p.heading);
    const fwd = Math.max(-BACK_MAX, Math.min(p.pace * 1.15, p.nvx * hx + p.nvy * hy));
    // A shuffle aside is for standing and strolling; at a walk a body turns.
    const side = sideAt(fwd);
    const lat = Math.max(-side, Math.min(side, -p.nvx * hy + p.nvy * hx));
    const tx = fwd * hx - lat * hy, ty = fwd * hy + lat * hx;
    // Speeding up and slowing down along the way it faces is quick; a shuffle
    // aside is not reversed in a blink - two people dodging each other side
    // to side, tick by tick, was the one jitter left.
    {
      const ax = tx - p.vx, ay = ty - p.vy;
      let af = ax * hx + ay * hy, al = -ax * hy + ay * hx;
      af = Math.max(-BODY_ACCEL * DT, Math.min(BODY_ACCEL * DT, af));
      al = Math.max(-SIDE_ACCEL * DT, Math.min(SIDE_ACCEL * DT, al));
      p.vx += af * hx - al * hy; p.vy += af * hy + al * hx;
    }
    // Whatever it carries from before, the body still only walks forward,
    // shuffles aside and steps back as a body can.
    {
      const f = Math.max(-BACK_MAX, Math.min(p.pace * 1.15, p.vx * hx + p.vy * hy));
      const sf = sideAt(f);
      const l = Math.max(-sf, Math.min(sf, -p.vx * hy + p.vy * hx));
      p.vx = f * hx - l * hy; p.vy = f * hy + l * hx;
    }
    const fromX = p.x, fromY = p.y;
    slide(mesh, p, p.vx * DT, p.vy * DT);
    // Its velocity is what it did: along a wall it slid by, nothing into it.
    p.vx = (p.x - fromX) / DT; p.vy = (p.y - fromY) / DT;
    p.v = Math.hypot(p.vx, p.vy);
    if (p.v < m(0.02)) { p.vx = 0; p.vy = 0; p.v = 0; }

    // --- getting on: progress towards where it wants to go. Somebody kept
    // from it by people is given way to by everybody (`urgent`), and if that
    // is not enough, walks through (`ghost`) - on a zebra soon, for the cars
    // wait while anybody stands on one. Nobody stays stuck anywhere.
    const want = Math.hypot(d.prefX, d.prefY);
    // Waiting for a zebra, not getting closer to the kerb is waiting, not
    // being held up: it settles where it is (above) instead.
    if (p.mode === 'wait') {
      const along = want > m(0.2) ? ((p.x - fromX) * d.prefX + (p.y - fromY) * d.prefY) / want : Infinity;
      p.waitHeld = along < want * DT * 0.25 ? p.waitHeld + DT : 0;
    }
    if (want > m(0.2) && !d.makingRoom && p.mode !== 'wait') {
      const along = ((p.x - fromX) * d.prefX + (p.y - fromY) * d.prefY) / want;
      if (along < want * DT * 0.25) p.blocked += DT;
      else p.blocked = Math.max(0, p.blocked - 2 * DT);
    } else p.blocked = Math.max(0, p.blocked - 2 * DT);
    const crossing = p.mode === 'cross';
    p.urgent = Math.max(0, p.urgent - DT);
    p.ghost = Math.max(0, p.ghost - DT);
    if (p.blocked > (crossing ? URGENT_CROSSING : URGENT_WALKING)) p.urgent = URGENT_HOLD;
    if (p.blocked > (crossing ? GHOST_CROSSING : GHOST_WALKING)) { p.ghost = GHOST_HOLD; p.blocked = 0; }

    // --- leaving a zebra
    if (p.mode === 'cross' && !isZebra(mesh.region[p.tri]!)) {
      const onPath = d.route.tris[p.ci] === p.tri ? p.ci : -1;
      const stillAhead = d.gate && d.gate.crossing === p.crossing && onPath >= 0 && onPath < d.gate.index;
      if (!stillAhead) { p.mode = 'walk'; p.crossing = -1; p.granted = []; }
    }

    // Getting nowhere for a while: a fresh route from where it stands (a
    // zebra already granted stays granted).
    if (p.blocked > REPLAN_AFTER && !p.replanned) {
      p.replanned = true;
      if (!plan(s, p) && p.trip === undefined) pickGoal(w, s, p);
    } else if (p.blocked === 0) p.replanned = false;
  }

  // Arrived: through the door or off the map, or on to somewhere else. When
  // a party's leader goes in, the rest follow it to the same place.
  for (const p of arrived) {
    if (!p.leaving && (pickSeat(w, s, p) || pickGoal(w, s, p))) continue;
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

const LINE_POOL: OrcaLine[] = [];

const VELOCITY = { x: 0, y: 0 };
const A: OrcaBody = { x: 0, y: 0, vx: 0, vy: 0, radius: 0 };
const B: OrcaBody = { x: 0, y: 0, vx: 0, vy: 0, radius: 0 };

/** A person as ORCA sees it: where it is and what it is doing now. */
function bodyOf(p: Person, out: OrcaBody): OrcaBody {
  out.x = p.x; out.y = p.y; out.vx = p.vx; out.vy = p.vy;
  // Somebody seated is still there, but the bench holds them: a little wider.
  out.radius = BODY_RADIUS;
  return out;
}

/**
 * Somebody waiting at its kerb for this zebra between `p` and its place to
 * wait (`wx`, `wy`), close enough to queue behind.
 */
function waiterAhead(g: Map<number, Person[]>, p: Person, crossing: number, wx: number, wy: number): boolean {
  const dx = wx - p.x, dy = wy - p.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return false;
  for (const q of neighbours(g, p, QUEUE_GAP, [])) {
    if (q.mode !== 'wait' || q.crossing !== crossing || !q.atKerb) continue;
    const ox = q.x - p.x, oy = q.y - p.y;
    const ahead = (ox * dx + oy * dy) / dist;
    if (ahead > 0 && ahead < dist + m(0.3) && Math.hypot(ox, oy) < QUEUE_GAP) return true;
  }
  return false;
}

/**
 * Who gives way to whom: the share of avoiding `q` that `p` takes. Somebody
 * on a zebra goes before anybody on a pavement (the people at its kerb make
 * room for those coming off it); somebody stuck long enough goes before
 * everybody; a companion keeps out of its leader's way; otherwise half each.
 */
function shareOf(mesh: WorldNav['mesh'], p: Person, q: Person): number {
  if (q.sit && q.sit.phase !== 'approach') return 1;
  const rp = rankOf(mesh, p), rq = rankOf(mesh, q);
  if (rp !== rq) {
    if (rp > rq) return rp >= 2 ? 0 : 0.1;
    return rq >= 2 ? 1 : 0.9;
  }
  if (q.leader === p) return 0.2;
  if (p.leader === q) return 0.8;
  return 0.5;
}

function rankOf(mesh: WorldNav['mesh'], p: Person): number {
  if (p.ghost > 0) return 3;
  if (p.urgent > 0) return 2;
  return p.mode === 'cross' && isZebra(mesh.region[p.tri]!) ? 1 : 0;
}

/**
 * Keeps the corridor in step with the body: finds its triangle a little
 * ahead or behind in the route. False when the body has strayed off it, and
 * needs a fresh route.
 */
function follow(mesh: WorldNav['mesh'], p: Person): boolean {
  const path = p.path;
  if (!path) return false;
  const tris = path.tris;
  if (tris[p.ci] === p.tri) return true;
  for (let k = p.ci + 1; k < Math.min(tris.length, p.ci + 16); k++) if (tris[k] === p.tri) { p.ci = k; return true; }
  for (let k = p.ci - 1; k >= Math.max(0, p.ci - 6); k--) if (tris[k] === p.tri) { p.ci = k; return true; }
  // Stepped just off the corridor (aside for somebody, or across the line
  // between two triangles): joined back onto the same route through the
  // triangle it is in, if that touches the corridor near where it was.
  // Planned afresh instead, from two neighbouring slivers of kerb A* found
  // routes the opposite ways round, and a body on the line between them
  // turned back and forth for ever. Never onto a corridor that already
  // passes through this triangle further on: that would visit it twice.
  if (tris.includes(p.tri)) return false;
  for (let k = Math.max(0, p.ci - 2); k < Math.min(tris.length, p.ci + 16); k++) {
    const portal = mesh.portals[p.tri]!.find((q) => q.to === tris[k]);
    if (!portal) continue;
    p.path = { tris: [p.tri, ...tris.slice(k)], portals: [portal, ...path.portals.slice(k)], corners: path.corners };
    p.ci = 0;
    return true;
  }
  return false;
}

/**
 * Where a companion walks: abreast of its leader, on alternate sides, when
 * the footway has room there; otherwise in file behind.
 */
function slotBeside(mesh: WorldNav['mesh'], lead: Person, p: Person, crowded: boolean): { x: number; y: number; t: number } {
  const hx = Math.cos(lead.heading), hy = Math.sin(lead.heading);
  // Waiting at a kerb, a party lines up along it, to the leader's right (the
  // leader stands to the right of the zebra's mouth): the footway behind and
  // the way off the zebra both stay clear for everybody else.
  if (lead.mode === 'wait') {
    const along = m(0.62) * p.rank;
    const kerb = mesh.nearest(lead.x + hy * along, lead.y - hx * along, m(0.6));
    if (kerb && !isZebra(mesh.region[kerb.t]!)) return kerb;
  }
  // Meeting people coming the other way, a party falls into file behind its
  // leader, and spreads out again once they are past.
  if (crowded) {
    const back = mesh.nearest(lead.x - hx * m(0.8) * p.rank, lead.y - hy * m(0.8) * p.rank, m(1));
    if (back) return back;
  }
  const spacing = Math.max(MIN_GAP * 1.1, m(0.62) * (p.party.hasChild ? 0.9 : 1));
  // The side it is already on: a place on the far side meant walking into
  // its own leader to get there, and giving way to it for ever.
  const lat = -(p.x - lead.x) * hy + (p.y - lead.y) * hx;
  const sign = lat > m(0.1) ? 1 : lat < -m(0.1) ? -1 : (p.rank % 2 ? 1 : -1);
  const side = sign * spacing * Math.ceil(p.rank / 2);
  const ax = lead.x - hy * side - hx * m(0.2), ay = lead.y + hx * side - hy * m(0.2);
  const abreast = mesh.nearest(ax, ay, m(0.1));
  if (abreast && isZebra(mesh.region[abreast.t]!) === isZebra(mesh.region[lead.tri]!)) return abreast;
  const back = mesh.nearest(lead.x - hx * m(0.8) * p.rank, lead.y - hy * m(0.8) * p.rank, m(1));
  return back ?? { x: lead.x, y: lead.y, t: lead.tri };
}


/**
 * Somebody alone, having got where they were going, may go and sit on a free
 * bench nearby - the old more often than the young.
 */
function pickSeat(w: SimWorld, s: State, p: Person, decided = false): boolean {
  if (p.party.size !== 1 || p.leader || !s.nav) return false;
  // Arms full of a box: on to wherever it is going.
  if (p.view.carry) return false;
  if (!decided && w.rng.people.float() >= BENCH_CHANCE[p.ageClass]) return false;
  let best: WorldNav['seats'][number] | null = null;
  let bestD = decided ? BENCH_PASS_REACH : BENCH_REACH;
  for (const seat of s.nav.seats) {
    if (s.taken.has(seat.key)) continue;
    const d = Math.hypot(seat.x - p.x, seat.y - p.y);
    if (d < bestD) { bestD = d; best = seat; }
  }
  if (!best) return false;
  standUp(s, p);
  p.goalX = best.mx; p.goalY = best.my; p.goalTri = best.t; p.leaving = false;
  if (!plan(s, p)) return false;
  const hold = SIT_RANGE[0] + w.rng.people.float() * (SIT_RANGE[1] - SIT_RANGE[0]);
  p.sit = {
    key: best.key, face: best.face, x: best.x, y: best.y, mx: best.mx, my: best.my,
    phase: 'approach', hold, gesture: { kind: 'bench', phase: 'approach', t: 0 },
  };
  s.taken.set(best.key, p.id);
  return true;
}

/** Whether a free seat is within a glance. */
function benchNearby(s: State, p: Person): boolean {
  for (const seat of s.nav?.seats ?? []) {
    if (!s.taken.has(seat.key) && Math.hypot(seat.mx - p.x, seat.my - p.y) < BENCH_PASS_REACH) return true;
  }
  return false;
}

/** Leaves the bench seat it holds, if any. */
function standUp(s: State, p: Person): void {
  if (!p.sit) return;
  if (s.taken.get(p.sit.key) === p.id) s.taken.delete(p.sit.key);
  p.sit = null;
}

/**
 * One tick at a bench: turn to face the footway, sit down, sit, stand up.
 * True when done sitting and the person should go on.
 */
function sitStep(w: SimWorld, s: State, p: Person): boolean {
  const sit = p.sit!;
  const g = sit.gesture;
  g.t += DT;
  switch (sit.phase) {
    case 'step':
    case 'leave': {
      // The few steps between the footway and the seat: turned to first,
      // then walked, forward, at an unhurried pace.
      const tx = sit.phase === 'step' ? sit.x : sit.mx, ty = sit.phase === 'step' ? sit.y : sit.my;
      const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
      if (d < m(0.03)) {
        p.v = 0;
        if (sit.phase === 'step') { sit.phase = 'turn'; g.t = 0; break; }
        standUp(s, p);
        return !pickGoal(w, s, p);
      }
      const want = Math.atan2(dy, dx);
      turn(p, want);
      const off = Math.abs(wrap(want - p.heading));
      p.v = off < 0.3 ? Math.min(STEP_PACE, d / DT) : Math.max(0, p.v - HARD_DECEL * DT);
      const step = Math.min(p.v * DT, d) * Math.max(0, Math.cos(off));
      p.x += Math.cos(p.heading) * step;
      p.y += Math.sin(p.heading) * step;
      break;
    }
    case 'turn':
      p.v = 0;
      turn(p, sit.face);
      if (Math.abs(wrap(sit.face - p.heading)) < 0.06 && Math.abs(p.turnV) < 0.25) { sit.phase = 'sitDown'; g.t = 0; }
      break;
    case 'sitDown':
      turn(p, sit.face);
      if (g.t >= SIT_DOWN_SECONDS[p.gender]) { sit.phase = 'seated'; g.t = 0; }
      break;
    case 'seated':
      turn(p, sit.face);
      if (g.t >= sit.hold) { sit.phase = 'standUp'; g.t = 0; }
      break;
    case 'standUp':
      turn(p, sit.face);
      if (g.t >= STAND_UP_SECONDS[p.gender]) { sit.phase = 'leave'; g.t = 0; }
      break;
    default:
      break;
  }
  g.phase = sit.phase;
  void w;
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
  // Turning the other way, or not at all, a body stops its turn at once:
  // carried on by the turn it had, somebody coming up to a kerb swung past
  // the zebra it was to face and back - the head going to and fro.
  if (want * p.turnV < 0 || (want === 0 && face !== null)) p.turnV = 0;
  const step = TURN_ACCEL * DT;
  p.turnV = Math.max(p.turnV - step, Math.min(p.turnV + step, want));
  // Never past the way it means to face in one step.
  if (face !== null) {
    const delta = wrap(face - p.heading);
    if (Math.abs(p.turnV * DT) > Math.abs(delta)) p.turnV = delta / DT;
  }
  p.heading = wrap(p.heading + p.turnV * DT);
}

/**
 * Moves the body by (dx, dy) as far as the ground lets it: on the mesh, and
 * off any zebra it has not been let onto. Into a wall or a zebra's edge it
 * slides along instead - the step turned towards the edge's line, shortened
 * as it turns - and only stands when there is no way along at all.
 */
function slide(mesh: WorldNav['mesh'], p: Person, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  const may = (x: number, y: number): boolean => {
    // The triangle the point is really in first; only failing that, the one
    // it is within a hair of. Taken with the hair first, a step a millimetre
    // over the line onto the next triangle counted as still on this one, was
    // put back on the line - and a body starting from rest on the line into
    // a zebra never left it.
    let t = mesh.step(p.tri, x, y, 1e-9);
    if (t < 0) t = mesh.step(p.tri, x, y, ON_MESH);
    if (t < 0) return false;
    const region = mesh.region[t]!;
    if (isZebra(region) && !mayStepOnto(mesh, p, region)) return false;
    // Accepted within a hair of the edge, placed exactly on the mesh.
    const on = mesh.clampTo(t, x, y);
    p.x = on.x;
    p.y = on.y;
    p.tri = t;
    return true;
  };
  const x = p.x + dx, y = p.y + dy;
  // Walked through the passages the step crosses - exact however thin the
  // triangles: located from the triangle it left, a step along the kerb
  // stone (a strip of slivers) found no triangle under it, and the body
  // stood on the kerb with its way clear.
  const walked = mesh.walk(p.tri, p.x, p.y, x, y);
  if (walked.share >= 1 - 1e-9) {
    const region = mesh.region[walked.tri]!;
    if (!isZebra(region) || mayStepOnto(mesh, p, region)) {
      const on = mesh.clampTo(walked.tri, x, y);
      p.x = on.x; p.y = on.y; p.tri = walked.tri;
      return;
    }
  }
  if (may(x, y)) return;
  // Off the edge: the point of the mesh nearest where it meant to go - the
  // step slid along the edge. A body standing on the edge (a bench's
  // approach is on it) refused every step that leaned out by a hair, and
  // stood wedged there for good.
  const len = Math.hypot(dx, dy);
  const near = mesh.nearest(x, y, len * 1.5 + ON_MESH);
  if (near && mesh.layer[near.t] === mesh.layer[p.tri] && Math.hypot(near.x - p.x, near.y - p.y) > 1e-7 && may(near.x, near.y)) return;
  for (const a of SLIDE_TURNS) {
    const c = Math.cos(a), s = Math.sin(a);
    if (may(p.x + (dx * c - dy * s) * c, p.y + (dx * s + dy * c) * c)) return;
  }
  // No step at all: the triangle it is filed under is not the one it stands
  // in (a vertex shared by slivers). Found again from where it stands - or
  // the nearest ground of its deck - it walks on next tick.
  const here = mesh.locate(p.x, p.y);
  if (here >= 0 && mesh.layer[here] === mesh.layer[p.tri]) { p.tri = here; return; }
  const back = mesh.nearest(p.x, p.y, m(0.5));
  if (back && mesh.layer[back.t] === mesh.layer[p.tri]) { p.x = back.x; p.y = back.y; p.tri = back.t; }
}
/** How far inside its triangle a body is kept from the triangle's edges, u. */
const INSET = 0.004;

/**
 * The point of triangle `t` nearest (x, y), a hair inside it: where questions
 * about the way on are asked from. A body is often exactly on an edge or a
 * corner of the mesh (keeping it on the mesh puts it there), and from there
 * every such question was degenerate: the route pulled taut ran along the
 * edge's line straight through a wall, and no corner ahead was ever "in
 * sight". The body itself is not moved.
 */
function inside(mesh: WorldNav['mesh'], t: number, x: number, y: number): { x: number; y: number } {
  const q = mesh.clampTo(t, x, y);
  const o = t * 6, tri = mesh.tri;
  let edge = Infinity;
  for (let e = 0; e < 3; e++) {
    const ax = tri[o + e * 2]!, ay = tri[o + e * 2 + 1]!;
    const bx = tri[o + ((e + 1) % 3) * 2]!, by = tri[o + ((e + 1) % 3) * 2 + 1]!;
    const c = closestOnSegment(ax, ay, bx, by, q.x, q.y);
    edge = Math.min(edge, Math.hypot(c.x - q.x, c.y - q.y));
  }
  if (edge >= INSET) return q;
  const c = mesh.centroid(t);
  const d = Math.hypot(c.x - q.x, c.y - q.y);
  if (d < 1e-9) return q;
  const k = Math.min(0.5, (INSET - edge) * 2 / d);
  return { x: q.x + (c.x - q.x) * k, y: q.y + (c.y - q.y) * k };
}

const SLIDE_TURNS = [0.45, -0.45, 0.9, -0.9, 1.3, -1.3];

/** The next place on the route where it steps from footway onto a zebra. */
function nextGate(mesh: WorldNav['mesh'], p: Person, path: NavPath):
  { crossing: number; chain: number[]; x: number; y: number; across: number; index: number; wx: number; wy: number } | null {
  const from = path.tris[p.ci] === p.tri ? p.ci : Math.max(0, path.tris.indexOf(p.tri));
  for (let i = from; i < path.portals.length && i < from + 60; i++) {
    const a = path.tris[i]!, b = path.tris[i + 1]!;
    if (!isZebra(mesh.region[a]!) && isZebra(mesh.region[b]!)) {
      const portal = path.portals[i]!;
      const q = closestOnSegment(portal.lx, portal.ly, portal.rx, portal.ry, p.x, p.y);
      const c = mesh.crossings[mesh.region[b]!]!;
      const toA = Math.hypot(q.x - c.ax, q.y - c.ay), toB = Math.hypot(q.x - c.bx, q.y - c.by);
      const across = toA < toB ? Math.atan2(c.by - c.ay, c.bx - c.ax) : Math.atan2(c.ay - c.by, c.ax - c.bx);
      // Where to wait: at the kerb, on the right-hand side of the zebra's
      // mouth as one faces across it, so people coming off it the other way
      // pass on the other side instead of meeting somebody standing in the
      // middle of the way out.
      const ux = Math.cos(across), uy = Math.sin(across);
      const nx = toA < toB ? c.ax : c.bx, ny = toA < toB ? c.ay : c.by;
      const along = (q.x - nx) * ux + (q.y - ny) * uy - KERB_STOP;
      const aside = Math.max(0, c.halfWidth - NAV_RADIUS) * WAIT_ASIDE;
      const wantX = nx + ux * along + uy * aside, wantY = ny + uy * along - ux * aside;
      const spot = mesh.nearest(wantX, wantY, m(0.4));
      const ok = spot && !isZebra(mesh.region[spot.t]!);
      const chain: number[] = [];
      for (let k = i + 1; k < path.tris.length && isZebra(mesh.region[path.tris[k]!]!); k++) {
        const z = mesh.region[path.tris[k]!]!;
        if (!chain.includes(z)) chain.push(z);
      }
      return {
        crossing: mesh.region[b]!, chain, x: q.x, y: q.y, across, index: i + 1,
        wx: ok ? spot.x : q.x - ux * KERB_STOP, wy: ok ? spot.y : q.y - uy * KERB_STOP,
      };
    }
  }
  return null;
}

/** Whether every zebra of `chain` may be stepped onto now. */
function mayCross(w: SimWorld, nav: WorldNav, chain: readonly number[], waited: number): boolean {
  for (const z of chain) {
    const edge = crossingEdge(w, nav, z);
    if (edge && !mayEnterCrossing(w, edge, waited)) return false;
  }
  return true;
}

/**
 * Whether `p` may step onto zebra `z`: one it has been let onto - or any, once
 * it is in the road already, for nobody is ever kept standing in the road.
 */
function mayStepOnto(mesh: WorldNav['mesh'], p: Person, z: number): boolean {
  if (p.mode === 'cross' && p.granted.includes(z)) return true;
  return isZebra(mesh.region[p.tri]!);
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
    // On a zebra, counted on the one under its feet: the cars at that one
    // must see it, whichever it was let onto first.
    const under = nav.mesh.region[p.tri]!;
    const z = p.mode === 'cross' && isZebra(under) ? under : p.crossing;
    const c = nav.mesh.crossings[z]!;
    const id = nav.crossingIds[z]!;
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
        held: p.v < m(0.3) && p.blocked > 2,
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
  const hour = (w.city.minutes(w) % 1440) / 60;
  const night = hour >= 22.5 || hour < 4;
  const day = hour >= 6 && hour < 20.5;
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
    // A party standing together talks: one speaks at a time (the renderer
    // passes the turn round), whoever waits for whatever.
    // Only while waiting at a kerb together: standing about on a pavement
    // talking read, to a player, as people frozen in place.
    const kerbParty = p.mode === 'wait' || p.leader?.mode === 'wait';
    const together = p.party.size > 1 && p.v < m(0.1) && kerbParty &&
      (p.leader ? p.leader.v < m(0.1) && Math.hypot(p.leader.x - p.x, p.leader.y - p.y) < m(2) : true);
    if (together) {
      p.stoodTogether += DT;
      if (p.stoodTogether > TALK_AFTER) {
        p.talk ??= { kind: 'talk', phase: 'hold', t: 0 };
        p.talk.t += DT;
      }
    } else { p.stoodTogether = 0; p.talk = null; }
    v.gesture = p.sit && p.sit.phase !== 'approach' ? p.sit.gesture : p.pause ?? p.talk;
    // A couple walking side by side, close: hand in hand (the hand on the
    // partner's side), worked out from the follower for both.
    v.hand = undefined;
    // Late at night, the odd adult walks home unsteadily.
    v.style = night && p.ageClass === 'adult' && p.id % 17 === 3 ? 'drunk' : undefined;
    // In the day, the odd adult on their own carries a box (a delivery, a
    // purchase, a move) in both arms.
    v.carry = day && p.ageClass === 'adult' && p.party.size === 1 && p.id % 13 === 4 ? 'box' : undefined;
    const region = nav && p.tri >= 0 ? nav.mesh.region[p.tri]! : FOOTWAY;
    v.ground = isZebra(region) ? 'crossing' : region === OPEN ? 'open' : 'footway';
    const seg = nav && p.tri >= 0 ? nav.segment[p.tri]! : -1;
    v.segment = seg >= 0 ? (seg as never) : undefined;
    v.walking = p.mode !== 'wait' && p.v > m(0.1) && !(p.sit && p.sit.phase !== 'approach');
    // A companion standing by a leader who waits at a kerb is waiting too.
    const waiter = p.mode === 'wait' ? p : p.leader && p.leader.mode === 'wait' && p.v < m(0.1) ? p.leader : null;
    v.kerbWait = waiter ? waiter.waited : p.queued;
    v.waitingFor = waiter && nav ? nav.crossingIds[waiter.crossing] ?? null
      : p.queued > 0 && nav ? nav.crossingIds[p.queuedFor] ?? null : null;
    views.push(v);
    byId.set(p.id, v);
  }
  for (const p of s.people) {
    const lead = p.leader;
    if (!lead || p.party.size !== 2 || p.party.archetype !== 'couple' || p.ageClass === 'child' || lead.ageClass === 'child') continue;
    if (p.v < m(0.3) || lead.v < m(0.3) || p.pause || lead.pause) continue;
    const dx = lead.x - p.x, dy = lead.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d > m(1.2)) continue;
    const ahead = { x: Math.cos(p.heading), y: Math.sin(p.heading) };
    // Abreast, not one behind the other.
    if (Math.abs(ahead.x * dx + ahead.y * dy) > d * 0.5) continue;
    const leftOf = ahead.x * dy - ahead.y * dx > 0;
    p.view.hand = leftOf ? 'L' : 'R';
    lead.view.hand = leftOf ? 'R' : 'L';
  }
}

/**
 * A read-only look at the engine's people, for tests and diagnosis: what the
 * published views do not say (mode, leader, why a body stands).
 */
export function inspectPeople(w: SimWorld): readonly {
  readonly id: number; readonly x: number; readonly y: number; readonly mode: string; readonly leader: number | null;
  readonly blocked: number; readonly urgent: number; readonly ghost: number; readonly sit: string | null; readonly tri: number; readonly crossing: number;
  readonly nvx: number; readonly nvy: number; readonly vx: number; readonly vy: number; readonly turnV: number; readonly facingWalk: boolean;
  readonly granted: readonly number[]; readonly ahead: readonly number[];
  readonly intent: Person['intent'];
}[] {
  const s = stateOf(w);
  return s.people.map((p) => ({
    id: p.id, x: p.x, y: p.y, mode: p.mode, leader: p.leader?.id ?? null, blocked: p.blocked, urgent: p.urgent,
    ghost: p.ghost, sit: p.sit?.phase ?? null, tri: p.tri, intent: p.intent, crossing: p.crossing,
    nvx: p.nvx, nvy: p.nvy, vx: p.vx, vy: p.vy, turnV: p.turnV, facingWalk: p.facingWalk,
    granted: [...p.granted], ahead: s.nav && p.path ? p.path.tris.slice(p.ci, p.ci + 10).map((t) => s.nav!.mesh.region[t]!) : [],
  }));
}

/** The walkable mesh the engine is using, for tests and diagnosis. */
export function peopleNav(w: SimWorld): WorldNav | null {
  return stateOf(w).nav;
}
