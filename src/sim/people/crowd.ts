import { Crowd, init as initRecast, type CrowdAgent } from '@recast-navigation/core';
import type { Vec2 } from '@core/vec2';
import { m } from '@world/units';
import type { SegmentId } from '@world/ids';
import { DT, PED, PED_CEILING, PED_DENSITY } from '../params';
import { emptyCrossingState } from '../crossings/state';
import { indexReservations, mayEnterCrossing } from '../crossings/permission';
import type { SimWorld } from '../world';
import type { Boarder, PedestrianEngine } from './engine';
import { PARTY_ARCHETYPES, type PartyView, type PedView, type PersonAgeClass, type PersonGender } from './view';
import { planParty } from './party';
import { AGENT_HEIGHT, AGENT_RADIUS, buildCrowdNav, WALK_FLAG, type CrowdNav, type Narrow, type Zebra } from './crowdNav';

/**
 * THE CROWD ENGINE: pedestrians walked by Detour's crowd (Recast/Detour,
 * the navigation toolkit shipped in most game engines; recast-navigation,
 * MIT), on the walkable space of `crowdNav.ts`.
 *
 * MOVEMENT has one owner. Each person is a Detour crowd agent: Detour keeps
 * its path corridor on the navigation mesh, steers along it anticipating
 * turns, and picks each tick ONE velocity by sampling velocities against the
 * people around, the walls and obstacles, its desired direction, maximum
 * speed and acceleration; the position is that velocity integrated over the
 * fixed step and kept on the mesh. Nothing in this file moves a body.
 *
 * INTENT is all this file decides, in layers kept apart:
 *
 *  1. the DESTINATION (`goal`): where the person means to end up. Nothing
 *     below replaces it;
 *  2. the CORRIDOR: the way there, as Detour finds it, walked on the right
 *     of the footway (`laneTarget`);
 *  3. PLACES TO WAIT on the way, held until the way is open: before a zebra
 *     not yet let onto (`crossings/permission.ts`), and before a passage one
 *     person wide while people come through it the other way (`passage`) -
 *     one way at a time, as on a one-lane bridge;
 *  4. in a party, a place beside the leader.
 *
 * VISUAL ORIENTATION is not movement: the body turns towards the velocity
 * it actually moves at; standing, it keeps its facing (or faces the way it
 * waits to go). A turn never changes the velocity or the position.
 *
 * Selected with `?people=crowd`. Recast's WebAssembly must be loaded first
 * (`initCrowd`).
 */

let ready = false;
/** Loads Recast/Detour's WebAssembly; the engine does nothing until it has. */
export async function initCrowd(): Promise<void> {
  if (ready) return;
  await initRecast();
  ready = true;
}

type Mode = 'walk' | 'wait' | 'cross';
type Way = 1 | -1;

interface Walker {
  readonly id: number;
  readonly view: PedView;
  agent: CrowdAgent;
  x: number; y: number; h: number;
  prevX: number; prevY: number; prevHeading: number;
  heading: number;
  turnV: number;
  speed: number;
  age: number;
  readonly pace: number;
  readonly ageClass: PersonAgeClass;
  readonly gender: PersonGender;
  party: PartyView;
  rank: number;
  leader: Walker | null;
  /** DESTINATION: where the trip ends, and whether it ends by leaving. */
  goal: Vec2;
  /** Navigation frame of the trip, independent of the body's visual facing. */
  routeDirection: Vec2;
  leaving: boolean;
  mode: Mode;
  /** Waiting: the place it waits at, and what for - a zebra, or a narrow passage (and the way it goes through). */
  waitAt: Vec2 | null;
  zebra: Zebra | null;
  narrow: { n: Narrow; d: Way } | null;
  waited: number;
  /** Zebras let onto and not yet left, and whether it has set foot on each yet. */
  granted: Map<string, boolean>;
  /** The narrow passage it has been let into, the way it goes through it, and whether it has got in yet. */
  passage: { n: Narrow; d: Way; entered: boolean } | null;
  /** LOCAL MANEUVER of somebody standing: a step aside out of a walker's way, until when (engine seconds). Its place stays its place. */
  aside: { at: Vec2; until: number } | null;
  /** Having passed the place it meant to stand at (somebody close behind kept it going), where it comes to rest instead of turning back. */
  settle: { for: Vec2; at: Vec2 } | null;
  /** The target last passed to Detour (null: none, or withdrawn because it stands at its place). */
  asked: Vec2 | null;
  /** Standing at the place it means to stand at: no move target, Detour brings it to rest. */
  holding: Vec2 | null;
  /** Ticks to the next look at the way ahead. */
  think: number;
  /** The road under it, for the height it is drawn at. */
  segment: SegmentId | undefined;
  /** Placed by a scenario: walks to its goal and stays there. */
  scripted: boolean;
  /** Seconds wanting to move and getting nowhere (diagnosis: starvation). */
  blocked: number;
  /** Seconds at rest. */
  rest: number;
  /** Whether Detour lets it onto the zebras (its query filter: `zebraAccess`). */
  onZebras: boolean;
  /** The top speed Detour has for it now (`approach`), u/s. */
  topSpeed: number;
  /** Since when it has stopped pressing on (engine seconds; `approach`), and seconds it has since been making way at its top speed. */
  eased: number | null;
  going: number;
  onZebra: Zebra | null;
  /** Diagnosis: targets passed to Detour (each one a path search), and times it waited at a narrow passage. */
  replans: number;
  yields: number;
}

/** The traffic through one narrow passage: one way at a time. */
interface Passage {
  /** The way people are let through now (+1 along the narrow's axis), 0 when it is free. */
  dir: 0 | Way;
  /** Who has been let in (or found in it) and has not come out. */
  inside: Set<number>;
  /** Who waits to go through, each way, in the order they came, and since when (engine seconds). */
  waiting: Map<Way, { id: number; since: number }[]>;
}

interface State {
  nav: CrowdNav | null;
  crowd: Crowd | null;
  revision: number;
  walkers: Walker[];
  byId: Map<number, Walker>;
  nextId: number;
  spawnClock: number;
  /** Simulation seconds since the engine started. */
  clock: number;
  /** For each zebra and side, the waiting places taken. */
  slots: Map<string, (number | null)[]>;
  passages: Map<number, Passage>;
}

const STATES = new WeakMap<SimWorld, State>();
function stateOf(w: SimWorld): State {
  let s = STATES.get(w);
  if (!s) {
    s = { nav: null, crowd: null, revision: -1, walkers: [], byId: new Map(), nextId: 1, spawnClock: 0, clock: 0, slots: new Map(), passages: new Map() };
    STATES.set(w, s);
  }
  return s;
}

/**
 * Detour crowd update flags: anticipate turns (1), avoid obstacles by
 * velocity (2), optimise the path by sight (8) and topology (16). Not
 * separation (4): a repulsive force added to the desired velocity, pushing
 * people BACK from whoever is close in front of them, against the avoidance
 * that already keeps them apart by choosing velocities ahead of time.
 */
const FLAGS = 1 | 2 | 8 | 16;
/** The obstacle-avoidance slot configured below. */
const AVOIDANCE = 3;
/**
 * Walking acceleration, u/s² (2.5 m/s²: up to walking pace in about 0.6 s).
 * Not free to choose: Detour starts braking for the end of a corridor two
 * radii (0.54 m) before it, slowing in proportion to the distance left, so
 * a body must be able to stop from its fastest pace (1.6 m/s) within that:
 * v²/2a ≤ 0.54 m, a ≥ 2.4 m/s². At 1.6 m/s² people overshot where they
 * stopped by up to 0.8 m and walked back to it.
 */
const ACCEL = m(2.5);
/** Braking for the place it stops at: gentler than it can, so Detour's steering keeps up, u/s². */
const BRAKE = ACCEL * 0.6;
/** Getting nowhere this long a person stops pressing on, to this pace, for at least this long, until it has made way this long, s and u/s. */
const EASE_AFTER = 0.6;
const SHUFFLE = m(0.3);
const EASE_HOLD = 1.5;
const EASE_GOING = 0.4;
/**
 * Walking: above this the body faces the way it moves, u/s. Slower, a
 * person shuffles - a step aside, a step to let somebody by - facing where
 * it means to go.
 */
const WALKING = m(0.4);
/** Desired speed below which a person means to go nowhere, u/s. */
const MEANS = m(0.05);
/** Below this a body has come to rest, u/s. */
const STILL = m(0.12);
/** Fastest turn of the body walking and on the spot, rad/s, and the time it takes to settle on a new facing, s. */
const TURN_RATE = 4;
const PIVOT_RATE = 2 * Math.PI;
const TURN_TIME = 0.25;
/** Ticks between looks at the way ahead (staggered across people). */
const THINK_EVERY = 15;
/** A zebra this close along the way ahead is asked for, u. */
const ASK_AT = m(6);
/** Waiting places stand this far back from the kerb's edge, apart, and in rows this far apart, u. */
// The zebra's closed area begins a body's radius before the kerb and Detour
// keeps a body's radius off it: the front row stands two radii back, and a
// hand's breadth more.
const WAIT_BACK = 2 * AGENT_RADIUS + m(0.1);
const WAIT_GAP = m(0.65);
/**
 * A person at rest stands at its place within this of it, u; and within
 * `STAND_AT` when it has been at rest that long without getting closer (a
 * queue in front of it), s.
 */
const REACHED = m(0.2);
const STAND_AT = m(0.6);
const SETTLE = 1;
/** A place to go to is passed on again when it moved this much, u. */
const RETARGET = m(0.3);
/** Within this of its destination a person has arrived, u. */
const ARRIVED = m(1);
/** Shortest trip, u. */
const MIN_TRIP = m(40);
/** Share of trips that end by leaving (off the map, a door). */
const LEAVE_SHARE = 0.5;
const SPAWN_INTERVAL = 0.5;
/** A companion's place: beside its leader this far apart, or behind it this far, u. */
const BESIDE = m(0.65);
const BEHIND = m(0.9);
/**
 * The corridor is walked towards a point this far along it, this far to its
 * right; the point is renewed once half of the way to it is walked, u.
 */
const AHEAD = m(4);
const RIGHT = m(0.35);
/** Getting nowhere: moving along the desired direction slower than this share of the pace. */
const PROGRESS_SHARE = 0.3;
/** A narrow passage this far along the way ahead is asked for, u. */
const NARROW_ASK = m(4);
/** Waiting for a narrow passage: this far before its end, this far to the right, in a queue this far apart, u. */
const NARROW_BACK = m(1.2);
const NARROW_SIDE = m(0.35);
const NARROW_GAP = m(0.75);
/** Once people have waited this long the other way, no more are let in this way: it is their turn, s. */
const TURN_AFTER = 8;
/** Somebody getting nowhere this long with a person standing in its way asks that person to make way, s. */
const MAKE_WAY_AFTER = 1;
/** How near in front the person standing is, u; how long it stands aside before going back to its place, s. */
const MAKE_WAY_REACH = 2 * AGENT_RADIUS + m(0.4);
const MAKE_WAY_HOLD = 4;
/** Two people face to face getting nowhere this long are locked: one gives way (`unlock`), s. */
const DEADLOCK_AFTER = 4;
/** Reach of a car's hail, u. */
const HAIL_REACH = m(8);

export function createCrowdEngine(): PedestrianEngine {
  return {
    kind: 'people',
    beginTick(w) {
      for (const p of stateOf(w).walkers) { p.prevX = p.x; p.prevY = p.y; p.prevHeading = p.heading; }
    },
    dispatch(w, enabled) {
      if (!ready || !enabled) return;
      const s = stateOf(w);
      ensureNav(w, s);
      if (!s.nav) return;
      const target = peopleTarget(w);
      if (s.walkers.length === 0) {
        for (let i = 0; i < target * 4 && s.walkers.length < target; i++) spawn(w, s, true);
        return;
      }
      s.spawnClock += DT;
      if (s.spawnClock < SPAWN_INTERVAL) return;
      s.spawnClock = 0;
      for (let i = 0; i < 2 && s.walkers.length < target; i++) spawn(w, s, false);
    },
    step(w) { if (ready) step(w, stateOf(w)); },
    rebind(w) {
      if (!ready) return;
      const s = stateOf(w);
      s.revision = -1;
      ensureNav(w, s);
    },
    publish(w) { publish(w, stateOf(w)); },
    audit() {},
    reset(w) {
      const s = STATES.get(w);
      s?.crowd?.destroy();
      STATES.delete(w);
    },
    bridge: {
      hailable(w, lanelet, s0, s1, exclude = new Set()) {
        const s = stateOf(w);
        const lane = w.lanelet(lanelet);
        if (!lane) return null;
        let best: { id: number; s: number } | null = null;
        for (const p of s.walkers) {
          if (p.mode !== 'walk' || p.party.size !== 1 || p.ageClass === 'child' || exclude.has(p.id) || p.onZebra) continue;
          if (p.segment !== lane.segment) continue;
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
        if (!ready) return;
        const s = stateOf(w);
        ensureNav(w, s);
        if (!s.nav || s.byId.has(person.seed)) return;
        const p = create(w, s, person.seed, { x: person.footX, y: person.footY }, person.footHeading, { ageClass: person.ageClass, gender: person.gender });
        if (p && !pickGoal(w, s, p)) remove(s, p);
      },
      anyoneWithin(w, x, y, radius, except) {
        for (const p of stateOf(w).walkers) if (p.id !== except && Math.hypot(p.x - x, p.y - y) < radius) return true;
        return false;
      },
    },
  };
}

// ------------------------------------------------------------- the space

function ensureNav(w: SimWorld, s: State): void {
  if (s.nav && s.revision === w.net.revision) return;
  // The map changed: a new space, and everybody re-seated on it where they stand.
  const people = s.walkers.map((p) => ({ p, at: { x: p.x, y: p.y } }));
  s.crowd?.destroy();
  s.nav = buildCrowdNav(w);
  s.revision = w.net.revision;
  s.slots.clear();
  s.passages.clear();
  s.walkers = [];
  s.byId.clear();
  if (!s.nav) { s.crowd = null; return; }
  s.crowd = new Crowd(s.nav.navMesh, { maxAgents: PED_CEILING + 50, maxAgentRadius: AGENT_RADIUS * 1.5 });
  configureAvoidance(s.crowd);
  // Filter 1: the footways only - the zebras are walls (`crowdNav.ts` `ZEBRA_FLAG`).
  s.crowd.getFilter(1).includeFlags = WALK_FLAG;
  for (const { p, at } of people) {
    const agent = addAgent(s, at, p.pace);
    if (!agent) continue;
    p.agent = agent;
    p.asked = null; p.holding = null; p.zebra = null; p.narrow = null; p.passage = null; p.waitAt = null; p.mode = 'walk'; p.granted.clear();
    s.walkers.push(p);
    s.byId.set(p.id, p);
  }
  for (const p of s.walkers) if (p.leader && !s.byId.has(p.leader.id)) p.leader = null;
  for (const p of [...s.walkers]) if (!p.leader && !pickGoal(w, s, p)) remove(s, p);
}

/**
 * ONE avoidance preset for every situation: Detour's own high-quality
 * preset (its demo's "high": adaptive sampling, 7 divisions, 3 rings, depth
 * 3, with Detour's default weights). People see each other 2.5 s ahead, as
 * far as they walk in that time; the side weight makes two people meeting
 * pass on complementary sides.
 */
function configureAvoidance(crowd: Crowd): void {
  const raw = crowd.raw as unknown as {
    getObstacleAvoidanceParams(i: number): { velBias: number; weightDesVel: number; weightCurVel: number; weightSide: number; weightToi: number; horizTime: number; gridSize: number; adaptiveDivs: number; adaptiveRings: number; adaptiveDepth: number };
    setObstacleAvoidanceParams(i: number, p: unknown): void;
  };
  const p = raw.getObstacleAvoidanceParams(AVOIDANCE);
  p.velBias = 0.5;
  p.weightDesVel = 2;
  p.weightCurVel = 0.75;
  p.weightSide = 0.75;
  p.weightToi = 2.5;
  p.horizTime = 2.5;
  p.gridSize = 33;
  p.adaptiveDivs = 7;
  p.adaptiveRings = 3;
  p.adaptiveDepth = 3;
  raw.setObstacleAvoidanceParams(AVOIDANCE, p);
}

function onMesh(s: State, at: Vec2, reach = m(3)): { x: number; h: number; y: number } | null {
  const nav = s.nav!;
  const h = nav.elevation.at(at.x, at.y);
  const r = nav.query.findClosestPoint({ x: at.x, y: h, z: at.y }, { halfExtents: { x: reach, y: m(6), z: reach } });
  if (!r.success || r.polyRef === 0) return null;
  return { x: r.point.x, h: r.point.y, y: r.point.z };
}

function addAgent(s: State, at: Vec2, pace: number): CrowdAgent | null {
  const p = onMesh(s, at);
  if (!p) return null;
  return s.crowd!.addAgent({ x: p.x, y: p.h, z: p.y }, {
    radius: AGENT_RADIUS,
    height: AGENT_HEIGHT,
    maxSpeed: pace,
    maxAcceleration: ACCEL,
    // Neighbours and walls within what is walked in the avoidance horizon.
    collisionQueryRange: AGENT_RADIUS * 12,
    pathOptimizationRange: AGENT_RADIUS * 30,
    separationWeight: 0,
    updateFlags: FLAGS,
    obstacleAvoidanceType: AVOIDANCE,
  });
}

/** Same population as the other engines: one person per 90 m of road, scaled by the city's settings. */
function peopleTarget(w: SimWorld): number {
  let total = 0;
  for (const ribbon of w.net.ribbons.values()) total += ribbon.full.length;
  const ceiling = Math.floor(PED_CEILING * w.populationShare);
  return Math.min(ceiling, Math.floor(total * PED_DENSITY * w.pedestrianIntensity * w.demandMultiplier));
}

// ------------------------------------------------------------- people in, out

interface Traits {
  ageClass?: PersonAgeClass;
  gender?: PersonGender;
  pace?: number;
  party?: PartyView;
  rank?: number;
  leader?: Walker | null;
}

function create(w: SimWorld, s: State, id: number, at: Vec2, heading: number, traits: Traits = {}): Walker | null {
  const rng = w.rng.people;
  const cls: PersonAgeClass = traits.ageClass ?? (rng.float() < 0.1 ? 'child' : rng.float() < 0.15 ? 'elder' : 'adult');
  const sex: PersonGender = traits.gender ?? (rng.float() < 0.5 ? 'f' : 'm');
  const base = Math.max(PED.minSpeed, Math.min(PED.maxSpeed, PED.meanSpeed + (rng.float() - 0.5) * 2 * PED.speedSd));
  const pace = traits.pace ?? (cls === 'elder' ? base * 0.8 : cls === 'child' ? base * 0.9 : base);
  const agent = addAgent(s, at, pace);
  if (!agent) return null;
  const pos = agent.position();
  const party: PartyView = traits.party ?? { id, size: 1, archetype: PARTY_ARCHETYPES[0]!, hasChild: false };
  const view: PedView = {
    id, x: pos.x, y: pos.z, heading, prev: { x: pos.x, y: pos.z, heading }, v: 0, turnV: 0, age: 0,
    ageClass: cls, gender: sex, party, rank: traits.rank ?? 0,
    ground: 'footway', segment: undefined, stretch: '', walking: false, kerbWait: 0, waitingFor: null, gesture: null,
  };
  const p: Walker = {
    id, view, agent, x: pos.x, y: pos.z, h: pos.y, prevX: pos.x, prevY: pos.z, prevHeading: heading, heading, turnV: 0, speed: 0, age: 0,
    pace, ageClass: cls, gender: sex, party, rank: traits.rank ?? 0, leader: traits.leader ?? null,
    goal: { x: pos.x, y: pos.z }, routeDirection: { x: 1, y: 0 }, leaving: false, mode: 'walk', waitAt: null, zebra: null, narrow: null, waited: 0, granted: new Map(),
    passage: null, aside: null, settle: null, asked: null, holding: null, think: id % THINK_EVERY, segment: undefined, onZebra: null, scripted: false,
    blocked: 0, rest: 0, onZebras: true, topSpeed: pace, eased: null, going: 0, replans: 0, yields: 0,
  };
  s.walkers.push(p);
  s.walkers.sort((a, b) => a.id - b.id);
  s.byId.set(id, p);
  s.nextId = Math.max(s.nextId, id + 1);
  return p;
}

function remove(s: State, p: Walker): void {
  freeSlot(s, p);
  leavePassage(s, p);
  stopWaitingNarrow(s, p);
  s.crowd?.removeAgent(p.agent);
  s.byId.delete(p.id);
  const i = s.walkers.indexOf(p);
  if (i >= 0) s.walkers.splice(i, 1);
  for (const q of s.walkers) if (q.leader === p) q.leader = null;
}

function randomSpot(w: SimWorld, s: State): Vec2 | null {
  const nav = s.nav!;
  if (!nav.footways.length) return null;
  const total = nav.footLength[nav.footLength.length - 1]!;
  const pick = w.rng.people.float() * total;
  let lo = 0, hi = nav.footLength.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (nav.footLength[mid]! < pick) lo = mid + 1; else hi = mid; }
  const way = nav.graph.ways[nav.footways[lo]!]!;
  return way.path.sampleAt(m(1) + w.rng.people.float() * Math.max(0, way.path.length - m(2))).p;
}

function clearOfPeople(s: State, at: Vec2, gap: number): boolean {
  for (const p of s.walkers) if (Math.hypot(p.x - at.x, p.y - at.y) < gap) return false;
  return true;
}

/** One more party: at a source once the city is populated, anywhere along the footways when it has just opened. */
function spawn(w: SimWorld, s: State, anywhere: boolean): void {
  const nav = s.nav!;
  const rng = w.rng.people;
  for (let attempt = 0; attempt < 8; attempt++) {
    const at = !anywhere && nav.sources.length ? nav.sources[Math.floor(rng.float() * nav.sources.length)]! : randomSpot(w, s);
    if (!at || !clearOfPeople(s, at, m(1.5))) continue;
    const plan0 = planParty(rng, s.nextId, Math.max(1, peopleTarget(w) - s.walkers.length));
    const party: PartyView = { id: s.nextId, size: 1, archetype: 'solo', hasChild: false };
    const lead = create(w, s, s.nextId, at, rng.float() * Math.PI * 2, { ageClass: plan0.ages[0]!, pace: Math.min(...plan0.speeds), party, rank: 0 });
    if (!lead) continue;
    if (!pickGoal(w, s, lead)) { remove(s, lead); continue; }
    const members = [lead];
    for (let k = 1; k < plan0.size; k++) {
      const spot = { x: at.x + Math.cos(k * 2.1) * BEHIND, y: at.y + Math.sin(k * 2.1) * BEHIND };
      const q = create(w, s, s.nextId, spot, lead.heading, { ageClass: plan0.ages[k]!, pace: plan0.speeds[k]!, party, rank: k, leader: lead });
      if (q) members.push(q);
    }
    const shared: PartyView = {
      id: lead.id, size: members.length,
      archetype: members.length === 1 ? 'solo' : plan0.archetype,
      hasChild: members.some((p) => p.ageClass === 'child'),
    };
    for (const p of members) { p.party = shared; p.view.party = shared; }
    return;
  }
}

/** A new DESTINATION worth walking to that can be reached: half the time a way out, otherwise a spot along the footways. */
function pickGoal(w: SimWorld, s: State, p: Walker): boolean {
  const nav = s.nav!;
  const rng = w.rng.people;
  for (let attempt = 0; attempt < 6; attempt++) {
    const leave = nav.sources.length > 0 && rng.float() < LEAVE_SHARE;
    const spot = leave ? nav.sources[Math.floor(rng.float() * nav.sources.length)]! : randomSpot(w, s);
    if (!spot || Math.hypot(spot.x - p.x, spot.y - p.y) < MIN_TRIP) continue;
    const goal = onMesh(s, spot);
    if (!goal) continue;
    const route = nav.query.computePath({ x: p.x, y: p.h, z: p.y }, { x: goal.x, y: goal.h, z: goal.y });
    const last = route.path[route.path.length - 1];
    if (!route.success || !last || Math.hypot(last.x - goal.x, last.z - goal.y) > ARRIVED) continue;
    p.goal = { x: goal.x, y: goal.y };
    p.leaving = leave;
    p.zebra = null; p.waitAt = null; p.mode = 'walk';
    stopWaitingNarrow(s, p);
    freeSlot(s, p);
    p.asked = null;
    p.think = 0;
    return true;
  }
  return false;
}

// ------------------------------------------------------------- intent: the corridor

/** Passes a target to Detour (a path search). */
function ask(s: State, p: Walker, target: Vec2): void {
  const at = onMesh(s, target);
  if (!at) return;
  p.agent.requestMoveTarget({ x: at.x, y: at.h, z: at.y });
  p.asked = { x: at.x, y: at.y };
  p.holding = null;
  p.rest = 0;
  p.replans++;
}

/**
 * Detour lets a walker onto the zebras only while it has been let onto
 * one (`granted`); otherwise its query filter keeps it to the footways and
 * the road is a wall to it. On a change its corridor is planned again, with
 * the new filter.
 */
function zebraAccess(s: State, p: Walker): void {
  const open = p.granted.size > 0;
  if (p.onZebras === open) return;
  p.onZebras = open;
  p.agent.updateParameters({ queryFilterType: open ? 0 : 1 });
  if (p.asked) { const t = p.asked; p.asked = null; ask(s, p, t); }
}


/** Asks for a place to stand at, unless that is already where it goes or stands. */
function askPlace(s: State, p: Walker, place: Vec2): void {
  const near = (q: Vec2 | null): boolean => q !== null && Math.hypot(q.x - place.x, q.y - place.y) < RETARGET;
  if (near(p.holding) || near(p.asked)) return;
  ask(s, p, place);
}

/** Stops to wait at `place`. */
function waitThere(s: State, p: Walker, place: Vec2): void {
  p.mode = 'wait';
  p.waitAt = place;
  askPlace(s, p, standFor(p, place));
}

/** No longer waiting: back to the corridor at once. */
function stopWaiting(s: State, p: Walker): void {
  if (p.mode !== 'wait') return;
  freeSlot(s, p);
  stopWaitingNarrow(s, p);
  p.mode = 'walk'; p.zebra = null; p.waitAt = null; p.waited = 0;
  p.asked = null;
  p.holding = null;
}

function decide(w: SimWorld, s: State, p: Walker): void {
  // Standing aside for somebody runs its course. Then, standing at the end
  // of its trip, it stays where it stepped to (still at its destination):
  // stepping back into the way only to step aside again for the next
  // walker was the back-and-forth at every place people stand. In a queue
  // (a zebra, a narrow passage) it goes back to its place in the queue.
  if (p.aside) {
    if (s.clock < p.aside.until) { askPlace(s, p, p.aside.at); return; }
    const at = p.aside.at;
    p.aside = null;
    if (p.mode !== 'wait' && p.scripted && !p.leader && Math.hypot(at.x - p.goal.x, at.y - p.goal.y) < ARRIVED) {
      p.settle = { for: { x: p.goal.x, y: p.goal.y }, at: { x: at.x, y: at.y } };
      return;
    }
    p.holding = null;
    p.asked = null;
  }
  const lead = p.leader && s.byId.has(p.leader.id) ? p.leader : null;
  if (!lead) p.leader = null;
  if (lead) { follow(s, p, lead); return; }
  // The way ahead from here to the destination, as Detour would walk it.
  const route = s.nav!.query.computePath({ x: p.x, y: p.h, z: p.y }, { x: p.goal.x, y: s.nav!.elevation.at(p.goal.x, p.goal.y), z: p.goal.y });
  const path = route.success ? route.path : [];
  // Keep the trip's frame within its arrival radius, so the final approach
  // to a stopping place does not turn the whole party around that place.
  if (Math.hypot(p.goal.x - p.x, p.goal.y - p.y) > ARRIVED) {
    for (let i = 1; i < path.length; i++) {
      const dx = path[i]!.x - path[0]!.x, dy = path[i]!.z - path[0]!.z;
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) continue;
      p.routeDirection = { x: dx / length, y: dy / length };
      break;
    }
  }
  // A zebra ahead not yet let onto: let on, or wait at the kerb.
  const zebra = zebraAhead(s, p, path);
  if (zebra && Math.hypot(zebra.entry.x - p.x, zebra.entry.y - p.y) < ASK_AT) {
    if (mayEnterCrossing(w, zebra.zebra.edge, p.waited)) {
      // Let on: the zebra is this walker's until it has left it.
      p.granted.set(zebra.zebra.id, false);
      if (p.zebra) stopWaiting(s, p);
    } else {
      if (p.narrow) stopWaitingNarrow(s, p);
      p.zebra = zebra.zebra;
      waitThere(s, p, waitSlot(s, p, zebra.zebra, zebra.entry));
      return;
    }
  }
  // A passage one person wide ahead: let in, or wait before it.
  const narrow = narrowAhead(s, p, path);
  if (narrow && p.passage?.n !== narrow.n && narrow.distance < NARROW_ASK) {
    if (admit(s, p, narrow.n, narrow.d)) {
      if (p.narrow) stopWaiting(s, p);
    } else {
      if (p.zebra) { freeSlot(s, p); p.zebra = null; }
      queueFor(s, p, narrow.n, narrow.d);
      waitThere(s, p, narrowSlot(s, p, narrow.n, narrow.d));
      return;
    }
  }
  stopWaiting(s, p);
  p.mode = p.onZebra ? 'cross' : 'walk';
  // A scenario's walker at its destination (or come to rest just past it) stays.
  const stand = standFor(p, p.goal);
  if (p.scripted && (p.holding || stand !== p.goal) && Math.hypot(stand.x - p.x, stand.y - p.y) < STAND_AT) return;
  const lane = path.length ? laneTarget(s, p, path) : p.goal;
  // The point steered for is renewed once half of the way to it is walked,
  // or when the corridor no longer leads past it; once the end of the way is
  // in reach, it is the destination itself. (A point of the corridor kept
  // as the target to the end was reached short of the destination, and
  // Detour circled it at a few cm/s for good.)
  const stale = !p.asked || (lane === p.goal
    ? Math.hypot(p.asked.x - p.goal.x, p.asked.y - p.goal.y) > RETARGET
    : Math.hypot(p.asked.x - p.x, p.asked.y - p.y) < AHEAD / 2 || Math.hypot(p.asked.x - lane.x, p.asked.y - lane.y) > AHEAD);
  if (stale) ask(s, p, lane);
}

/** A companion: beside its leader (alternately right and left), a little behind when there are several; waiting where it waits. */
function follow(s: State, p: Walker, lead: Walker): void {
  // Let onto a zebra with its leader.
  for (const id of lead.granted.keys()) if (!p.granted.has(id)) p.granted.set(id, false);
  if (lead.mode === 'wait' && lead.zebra && lead.waitAt) {
    p.zebra = lead.zebra;
    waitThere(s, p, waitSlot(s, p, lead.zebra, lead.waitAt));
    return;
  }
  const { x: hx, y: hy } = lead.routeDirection;
  // Beside its leader; in single file behind it where there is no room
  // beside it - the leader waiting for, or going through, a passage one
  // person wide, or no walkable ground at the place beside it (a place
  // snapped to the nearest ground in a narrow way crowded the leader and
  // shut its way: a party of four stuck 40 s by a door).
  const lined = (lead.mode === 'wait' && lead.narrow !== null) || lead.passage !== null;
  // In single file a companion already ahead of its leader stays ahead,
  // leading the way: swapping places in a passage one person wide was a
  // lock between the two (traced).
  const ahead = (p.x - lead.x) * hx + (p.y - lead.y) * hy > 0;
  const beside = (single: boolean): Vec2 => {
    const side = single ? 0 : (p.rank % 2 ? -1 : 1) * Math.ceil(p.rank / 2) * BESIDE;
    const back = single ? BEHIND * p.rank * (ahead ? -1 : 1) : p.rank > 2 ? BEHIND : 0;
    return { x: at.x - hy * side - hx * back, y: at.y + hx * side - hy * back };
  };
  // By where the leader is - or, once it is coming to the place it will
  // stand at, by that place: companions that kept aiming at the moving
  // leader came up behind it at pace and carried it on past its place
  // (traced: 2.7 m), and their place moved with it.
  const stop = placeOf(lead);
  const at = stop && Math.hypot(stop.x - lead.x, stop.y - lead.y) < m(4) ? stop : lead;
  const ground = (q: Vec2): Vec2 | null => {
    const on = onMesh(s, q, m(1));
    return on && Math.hypot(on.x - q.x, on.y - q.y) < m(0.25) ? { x: on.x, y: on.y } : null;
  };
  const place = (lined ? null : ground(beside(false))) ?? ground(beside(true)) ?? { x: lead.x, y: lead.y };
  // The leader standing: so does the companion, at its place by the leader.
  if (lead.holding) {
    if (!p.waitAt || Math.hypot(p.waitAt.x - place.x, p.waitAt.y - place.y) > RETARGET) waitThere(s, p, place);
    return;
  }
  if (p.mode === 'wait' && p.zebra) p.granted.set(p.zebra.id, false);
  stopWaiting(s, p);
  if (!p.asked || Math.hypot(p.asked.x - place.x, p.asked.y - place.y) > RETARGET) ask(s, p, place);
}

/**
 * The point of the corridor a walker steers for: a few metres along the way
 * Detour found, to the RIGHT of it - people keep right on a footway, and in
 * a flow both ways the two directions settle into lanes (the lane formation
 * of pedestrian research, SUMO's stripes keeping right). Near the end of
 * the way, the destination itself.
 */
function laneTarget(s: State, p: Walker, path: readonly { x: number; y: number; z: number }[]): Vec2 {
  let left = AHEAD;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!, b = path[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < left) { left -= len; continue; }
    const ux = (b.x - a.x) / len, uy = (b.z - a.z) / len;
    const at = { x: a.x + ux * left, y: a.z + uy * left };
    // The right of the way walked is (uy, -ux).
    const aside = { x: at.x + uy * RIGHT, y: at.y - ux * RIGHT };
    const on = onMesh(s, aside, RIGHT);
    // Kept on the ground; where the right is wall, the way itself.
    return on ? { x: on.x, y: on.y } : at;
  }
  return p.goal;
}

/** Points along a route every `step` u up to `reach` u, with the distance walked to each and the direction there. */
function* along(path: readonly { x: number; z: number }[], reach: number, step = m(0.25)): Generator<{ x: number; y: number; d: number; ux: number; uy: number }> {
  let walked = 0;
  for (let i = 0; i + 1 < path.length && walked < reach; i++) {
    const a = path[i]!, b = path[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    const ux = (b.x - a.x) / len, uy = (b.z - a.z) / len;
    for (let t = 0; t < len && walked + t < reach; t += step) yield { x: a.x + ux * t, y: a.z + uy * t, d: walked + t, ux, uy };
    walked += len;
  }
}

// ------------------------------------------------------------- intent: zebras

/** Whether a point lies on a zebra's band, and how far along it from `a`. */
function onBand(z: Zebra, x: number, y: number, margin = 0): number | null {
  const lx = z.b.x - z.a.x, ly = z.b.y - z.a.y, len = Math.hypot(lx, ly) || 1;
  const ux = lx / len, uy = ly / len;
  const along = (x - z.a.x) * ux + (y - z.a.y) * uy;
  const across = -(x - z.a.x) * uy + (y - z.a.y) * ux;
  return along >= -margin && along <= len + margin && Math.abs(across) <= z.half + margin ? along : null;
}

/** Whether a point lies on the part of a zebra's band that is road (from kerb to kerb), or within `margin` of it. */
function onRoad(z: Zebra, x: number, y: number, margin = 0): boolean {
  const at = onBand(z, x, y, margin);
  const len = Math.hypot(z.b.x - z.a.x, z.b.y - z.a.y);
  return at !== null && at >= z.kerb - margin && at <= len - z.kerb + margin;
}

/** The first zebra the way ahead crosses the road on that the walker has not been let onto, and where the way reaches the road. */
function zebraAhead(s: State, p: Walker, path: readonly { x: number; z: number }[]): { zebra: Zebra; entry: Vec2 } | null {
  for (const q of along(path, ASK_AT * 3)) {
    for (const z of s.nav!.zebras) {
      if (p.granted.has(z.id) || !onRoad(z, q.x, q.y)) continue;
      return { zebra: z, entry: { x: q.x, y: q.y } };
    }
  }
  return null;
}

/** A place to wait for a zebra: along the kerb's edge on this side, then in rows behind. */
function waitSlot(s: State, p: Walker, z: Zebra, entry: Vec2): Vec2 {
  const at0 = onBand(z, entry.x, entry.y, m(1)) ?? 0;
  const lx = z.b.x - z.a.x, ly = z.b.y - z.a.y, len = Math.hypot(lx, ly) || 1;
  const side = at0 < len / 2 ? 'a' : 'b';
  const key = `${z.id}:${side}`;
  let taken = s.slots.get(key);
  if (!taken) { taken = []; s.slots.set(key, taken); }
  let index = taken.indexOf(p.id);
  if (index < 0) {
    index = taken.indexOf(null);
    if (index < 0) { index = taken.length; taken.push(p.id); } else taken[index] = p.id;
  }
  // Across the band: centre, then alternately either side; then a row back.
  const perRow = Math.max(1, Math.floor((2 * z.half) / WAIT_GAP));
  const row = Math.floor(index / perRow), col = index % perRow;
  const offset = (col % 2 ? 1 : -1) * Math.ceil(col / 2) * WAIT_GAP;
  const ux = lx / len, uy = ly / len;
  const nx = -uy, ny = ux;
  // From the kerb's edge, back onto the footway, spread along the kerb.
  const at = side === 'a' ? z.kerb - WAIT_BACK - row * WAIT_GAP : len - z.kerb + WAIT_BACK + row * WAIT_GAP;
  return { x: z.a.x + ux * at + nx * offset, y: z.a.y + uy * at + ny * offset };
}

function freeSlot(s: State, p: Walker): void {
  for (const taken of s.slots.values()) {
    const i = taken.indexOf(p.id);
    if (i >= 0) taken[i] = null;
  }
}

// ------------------------------------------------------------- intent: passages one person wide

/** Whether a point is in a narrow passage: within its reach of the axis, between its ends (and a body's width past them). */
function inNarrow(n: Narrow, x: number, y: number): boolean {
  const len = Math.hypot(n.b.x - n.a.x, n.b.y - n.a.y);
  const along = (x - n.a.x) * n.dir.x + (y - n.a.y) * n.dir.y;
  const across = -(x - n.a.x) * n.dir.y + (y - n.a.y) * n.dir.x;
  return along >= -2 * AGENT_RADIUS && along <= len + 2 * AGENT_RADIUS && Math.abs(across) <= n.reach;
}

/** The first narrow passage the way ahead goes through, the way through it, and how far along the way it begins. */
function narrowAhead(s: State, p: Walker, path: readonly { x: number; z: number }[]): { n: Narrow; d: Way; distance: number } | null {
  const near = s.nav!.narrows.filter((n) => Math.hypot((n.a.x + n.b.x) / 2 - p.x, (n.a.y + n.b.y) / 2 - p.y) < NARROW_ASK * 2 + m(4));
  if (!near.length) return null;
  for (const q of along(path, NARROW_ASK * 2)) {
    for (const n of near) {
      if (!inNarrow(n, q.x, q.y)) continue;
      return { n, d: q.ux * n.dir.x + q.uy * n.dir.y >= 0 ? 1 : -1, distance: q.d };
    }
  }
  return null;
}

function passageOf(s: State, n: Narrow): Passage {
  let st = s.passages.get(n.id);
  if (!st) { st = { dir: 0, inside: new Set(), waiting: new Map([[1, []], [-1, []]]) }; s.passages.set(n.id, st); }
  return st;
}

/** Those still waiting for a passage one way, in the order they came. */
function queueOf(s: State, n: Narrow, d: Way): { id: number; since: number }[] {
  const st = passageOf(s, n);
  const q = st.waiting.get(d)!.filter((e) => { const w = s.byId.get(e.id); return w?.narrow?.n === n && w.narrow.d === d; });
  st.waiting.set(d, q);
  return q;
}

/**
 * Whether a walker may go through a narrow passage now, one way at a time:
 * when it is free and nobody has waited longer the other way; when people
 * go through it this way already, unless those waiting the other way have
 * waited `TURN_AFTER` - then it is their turn, and this way waits for the
 * passage to empty. Let in, it is the walker's way through until it has
 * come out.
 */
function admit(s: State, p: Walker, n: Narrow, d: Way): boolean {
  const st = passageOf(s, n);
  const mine = queueOf(s, n, d).find((e) => e.id === p.id)?.since ?? s.clock;
  const theirs = queueOf(s, n, d === 1 ? -1 : 1)[0]?.since ?? Infinity;
  if (st.inside.size === 0) st.dir = 0;
  const open = st.dir === 0 ? theirs >= mine : st.dir === d && s.clock - theirs < TURN_AFTER;
  if (!open) return false;
  st.dir = d;
  st.inside.add(p.id);
  stopWaitingNarrow(s, p);
  p.passage = { n, d, entered: false };
  return true;
}

function queueFor(s: State, p: Walker, n: Narrow, d: Way): void {
  if (p.narrow?.n === n && p.narrow.d === d) return;
  stopWaitingNarrow(s, p);
  p.narrow = { n, d };
  p.yields++;
  passageOf(s, n).waiting.get(d)!.push({ id: p.id, since: s.clock });
}

function stopWaitingNarrow(s: State, p: Walker): void {
  if (!p.narrow) return;
  const st = s.passages.get(p.narrow.n.id);
  if (st) st.waiting.set(p.narrow.d, st.waiting.get(p.narrow.d)!.filter((e) => e.id !== p.id));
  p.narrow = null;
}

function leavePassage(s: State, p: Walker): void {
  if (!p.passage) return;
  const st = s.passages.get(p.passage.n.id);
  if (st) { st.inside.delete(p.id); if (st.inside.size === 0) st.dir = 0; }
  p.passage = null;
}

/**
 * Where to wait for a narrow passage: before the end it is entered by, to
 * the right of the way through, the queue running back from there - at the
 * nearest place, by the ground itself, that leaves a body's width of
 * walkable ground on its left for those coming out to pass. (A fixed place
 * beside the passage's mouth stood in the one lane left by a lamp column
 * beside it, and whoever came out could not get by.)
 */
function narrowSlot(s: State, p: Walker, n: Narrow, d: Way): Vec2 {
  const index = Math.max(0, queueOf(s, n, d).findIndex((e) => e.id === p.id));
  const end = d === 1 ? n.a : n.b;
  const fx = n.dir.x * d, fy = n.dir.y * d;
  let fallback: Vec2 | null = null;
  for (let back = NARROW_BACK + index * NARROW_GAP; back < NARROW_BACK + index * NARROW_GAP + m(6); back += m(0.25)) {
    for (const side of [NARROW_SIDE, NARROW_SIDE * 2, 0]) {
      const spot = { x: end.x - fx * back + fy * side, y: end.y - fy * back - fx * side };
      const on = onMesh(s, spot, m(0.6));
      if (!on) continue;
      fallback ??= { x: on.x, y: on.y };
      if (roomLeft(s, on, fx, fy) >= 2 * AGENT_RADIUS + m(0.1)) return { x: on.x, y: on.y };
    }
  }
  return fallback ?? end;
}

/** Walkable ground to the left of a place, across the way `(fx, fy)`, u. */
function roomLeft(s: State, at: { x: number; h: number; y: number }, fx: number, fy: number): number {
  const q = s.nav!.query;
  const from = q.findClosestPoint({ x: at.x, y: at.h, z: at.y }, { halfExtents: { x: m(0.05), y: m(1), z: m(0.05) } });
  if (!from.success || !from.polyRef) return 0;
  const span = m(3);
  const r = q.raycast(from.polyRef, from.point, { x: at.x - fy * span, y: at.h, z: at.y + fx * span });
  return r.success ? Math.min(1, r.t) * span : 0;
}

/**
 * Who is in each narrow passage: those let in, until they have been in it
 * and come out (or turned away before reaching it); and anybody found in it
 * without having asked (a companion behind its leader, somebody who started
 * there), counted in the way it moves.
 */
function trackPassages(s: State): void {
  const nav = s.nav!;
  for (const p of s.walkers) {
    if (p.passage) {
      const inside = inNarrow(p.passage.n, p.x, p.y);
      if (inside) p.passage.entered = true;
      else if (p.passage.entered) leavePassage(s, p);
      else {
        const n = p.passage.n;
        if (Math.hypot((n.a.x + n.b.x) / 2 - p.x, (n.a.y + n.b.y) / 2 - p.y) > NARROW_ASK * 2 + m(4)) leavePassage(s, p);
      }
      continue;
    }
    if (p.speed < STILL) continue;
    for (const n of nav.narrows) {
      if (!inNarrow(n, p.x, p.y)) continue;
      const vel = p.agent.velocity();
      const d: Way = vel.x * n.dir.x + vel.z * n.dir.y >= 0 ? 1 : -1;
      const st = passageOf(s, n);
      if (st.inside.size === 0) st.dir = d;
      st.inside.add(p.id);
      p.passage = { n, d, entered: true };
      break;
    }
  }
}

// ------------------------------------------------------------- intent: making way

/**
 * MAKING WAY: somebody standing (at its destination, in a queue, waiting)
 * is in the way of a walker that has been getting nowhere: avoidance cannot
 * get the walker round it - it would have to step back first, and Detour
 * samples velocities about the way it wants to go - so the one standing
 * steps aside: to the nearest place, on walkable ground it can walk
 * straight to, clear of the walker's way by two bodies. It stands there a
 * few seconds, then goes back to its place. Its destination never changes.
 */
function makeWay(s: State): void {
  for (const p of s.walkers) {
    if (p.holding) continue;
    const dv = p.agent.desiredVelocity();
    const dl = Math.hypot(dv.x, dv.z);
    if (dl < m(0.05)) continue;
    const ux = dv.x / dl, uy = dv.z / dl;
    for (const q of s.walkers) {
      if (q === p || !q.holding || q.aside || q.party.id === p.party.id) continue;
      const rx = q.x - p.x, ry = q.y - p.y;
      const d = Math.hypot(rx, ry);
      if (d > MAKE_WAY_REACH || rx * ux + ry * uy <= 0) continue;
      // Stuck behind it a moment, or already against it - pressing on, the
      // walker shoved it along (traced: a person at its place pushed at 0.9 m/s).
      if (p.blocked < MAKE_WAY_AFTER && d > 2 * AGENT_RADIUS + m(0.05)) continue;
      // The walker's way: from where it is, on past the one standing.
      const way = [{ x: p.x, y: p.y }, { x: p.x + ux * m(3), y: p.y + uy * m(3) }];
      const spot = clearSpot(s, q, way);
      if (!spot) continue;
      q.aside = { at: spot, until: s.clock + MAKE_WAY_HOLD };
      q.holding = null;
      q.yields++;
      ask(s, q, spot);
      p.blocked = 0;
      break;
    }
  }
  unlock(s);
}

/**
 * NO DEADLOCK LASTS: two people coming opposite ways, face to face, both
 * getting nowhere for `DEADLOCK_AFTER` - not a passing conflict, which
 * Detour's avoidance settles, but a lock it cannot get out of (traced: two
 * groups meeting on a zebra 1.76 m wide, stuck 30 s). The side with fewer
 * people behind it in its flow gives way (a fixed order where that is
 * even): it steps off the other's way as a person standing does, and once
 * the maneuver has run its course goes back to its corridor. Its
 * destination stays what it was.
 */
function unlock(s: State): void {
  for (const p of s.walkers) {
    if (p.aside || p.holding || p.blocked < DEADLOCK_AFTER) continue;
    const pd = wantOf(p);
    if (!pd) continue;
    for (const q of s.walkers) {
      if (q === p || q.aside || q.holding || q.blocked < DEADLOCK_AFTER) continue;
      const rx = q.x - p.x, ry = q.y - p.y;
      if (Math.hypot(rx, ry) > MAKE_WAY_REACH || rx * pd.x + ry * pd.y <= 0) continue;
      const qd = wantOf(q);
      if (!qd || qd.x * pd.x + qd.y * pd.y > -0.3) continue;
      const fp = flowBehind(s, p, pd), fq = flowBehind(s, q, qd);
      const gives = fp < fq ? p : fq < fp ? q : order(p) < order(q) ? p : q;
      const other = gives === p ? q : p;
      const od = gives === p ? qd : pd;
      const way = [{ x: other.x, y: other.y }, { x: other.x + od.x * m(3), y: other.y + od.y * m(3) }];
      const spot = clearSpot(s, gives, way);
      if (!spot) continue;
      gives.aside = { at: spot, until: s.clock + MAKE_WAY_HOLD };
      gives.yields++;
      ask(s, gives, spot);
      p.blocked = 0;
      q.blocked = 0;
      break;
    }
  }
}

/** The way a walker means to go (Detour's desired velocity), unit; null when it means to go nowhere. */
function wantOf(p: Walker): Vec2 | null {
  const dv = p.agent.desiredVelocity();
  const l = Math.hypot(dv.x, dv.z);
  return l > MEANS ? { x: dv.x / l, y: dv.z / l } : null;
}

/** People close behind a walker going its way. */
function flowBehind(s: State, p: Walker, dir: Vec2): number {
  let n = 0;
  for (const q of s.walkers) {
    if (q === p) continue;
    const rx = q.x - p.x, ry = q.y - p.y;
    const back = -(rx * dir.x + ry * dir.y);
    if (back <= 0 || back > m(4) || Math.abs(rx * dir.y - ry * dir.x) > m(1.2)) continue;
    const qd = wantOf(q);
    if (qd && qd.x * dir.x + qd.y * dir.y > 0.5) n++;
  }
  return n;
}

/** A fixed order between two people where nothing else decides (scrambled ids: no side always wins). */
const order = (p: Walker): number => Math.imul(p.id ^ 0x5bd1e995, 0x27d4eb2d) >>> 0;

/** The nearest place to `q`, reachable in a straight line on the mesh, at least two bodies (and a little) from the line `way`. */
function clearSpot(s: State, q: Walker, way: readonly Vec2[]): Vec2 | null {
  const query = s.nav!.query;
  const start = query.findClosestPoint({ x: q.x, y: q.h, z: q.y }, { halfExtents: { x: m(0.3), y: m(1), z: m(0.3) } });
  if (!start.success || !start.polyRef) return null;
  const clearance = 2 * AGENT_RADIUS + m(0.1);
  // The nearest such place; at the same distance, the one most in front of
  // the way it faces - a step to the side or forward, not backwards.
  for (const r of [m(0.3), m(0.5), m(0.8), m(1.2), m(1.8)]) {
    let best: Vec2 | null = null, bestTurn = Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const c = { x: q.x + Math.cos(a) * r, y: q.y + Math.sin(a) * r };
      if (distToLine(c, way) < clearance) continue;
      // Never out onto the road: a zebra is walkable ground, but not for somebody not let onto it.
      if (s.nav!.zebras.some((z) => !q.granted.has(z.id) && onRoad(z, c.x, c.y, AGENT_RADIUS))) continue;
      const hit = query.raycast(start.polyRef, start.point, { x: c.x, y: q.h, z: c.y });
      if (!hit.success || hit.t < 1) continue;
      const turn = Math.abs(Math.atan2(Math.sin(a - q.heading), Math.cos(a - q.heading)));
      if (turn < bestTurn) { bestTurn = turn; best = c; }
    }
    if (best) return best;
  }
  return null;
}

function distToLine(c: Vec2, line: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!, b = line[i + 1]!;
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(c.x - a.x - dx * t, c.y - a.y - dy * t));
  }
  return best;
}

// ------------------------------------------------------------- the tick

/** The place a walker means to stand at, if any: where it waits, or a scenario's destination. */
function placeOf(p: Walker): Vec2 | null {
  if (p.aside) return p.aside.at;
  if (p.mode === 'wait' && p.waitAt) return standFor(p, p.waitAt);
  if (p.scripted && !p.leader) return standFor(p, p.goal);
  return null;
}

/** Where a walker stands for a place it means to stand at: there, or where it came to rest having passed it. */
function standFor(p: Walker, place: Vec2): Vec2 {
  return p.settle && Math.hypot(p.settle.for.x - place.x, p.settle.for.y - place.y) < RETARGET ? p.settle.at : place;
}

/**
 * Coming to the place it means to stand at, a person slows in good time:
 * its top speed is what it can still stop from before the place, braking a
 * little gentler than it can (√(2·a·d)). Detour itself slows a walker only
 * over the last two radii, in proportion to the distance left - a ramp no
 * body at walking pace can follow (it asks for 3.4-4.7 m/s²), and people
 * ran past where they meant to stop. Only the desired speed changes here;
 * Detour moves the body.
 */
function approach(s: State, p: Walker, place: Vec2 | null): void {
  let top = p.pace;
  // Getting nowhere, a person stops pressing on: it shuffles until the way
  // opens. Pressing at full pace against a way shut, Detour's best velocity
  // was a slow drift backwards (its samples scale with the top speed); at a
  // shuffle that drift is a few millimetres. Held at least `EASE_HOLD`, let
  // go once it has made way again for a moment.
  if (!p.eased && p.blocked > EASE_AFTER) p.eased = s.clock;
  else if (p.eased !== null && s.clock - p.eased > EASE_HOLD && p.going > EASE_GOING) p.eased = null;
  if (p.eased !== null) top = Math.min(top, SHUFFLE);
  if (place && !p.holding) {
    const d = Math.hypot(place.x - p.x, place.y - p.y);
    top = Math.min(top, Math.max(m(0.2), Math.sqrt(2 * BRAKE * Math.max(0, d - REACHED / 2))));
  }
  if (Math.abs(top - p.topSpeed) < p.pace * 0.03 && top !== p.pace) return;
  if (top === p.topSpeed) return;
  p.topSpeed = top;
  p.agent.updateParameters({ maxSpeed: top });
}

/**
 * Passing the place it means to stand at, moving away from it - somebody
 * close behind kept it walking: Detour's avoidance shares every avoidance
 * between the two, so the one stopping is carried on by the one coming -
 * a person comes to rest where it can, a braking distance on, rather than
 * turning round to walk back to the exact spot.
 */
function overshoot(s: State, p: Walker): void {
  if (p.aside || p.holding || p.speed <= STILL) return;
  const base = p.mode === 'wait' ? p.waitAt : p.scripted && !p.leader ? p.goal : null;
  if (!base) return;
  // Carried past where it was to come to rest, too: on again, as long as it is carried.
  const place = standFor(p, base);
  const dx = place.x - p.x, dy = place.y - p.y;
  if (Math.hypot(dx, dy) > STAND_AT) return;
  const v = p.agent.velocity();
  if (v.x * dx + v.z * dy >= 0) return;
  const stop = (p.speed * p.speed) / (2 * ACCEL);
  const on = onMesh(s, { x: p.x + (v.x / p.speed) * stop, y: p.y + (v.z / p.speed) * stop }, m(0.5));
  if (!on) return;
  p.settle = { for: { x: base.x, y: base.y }, at: { x: on.x, y: on.y } };
  ask(s, p, p.settle.at);
}

/** The way a waiting walker faces: across the zebra, or into the passage it waits for. */
function waitFacing(p: Walker): number | null {
  if (p.mode !== 'wait') return null;
  if (p.zebra) {
    const z = p.zebra;
    const len = Math.hypot(z.b.x - z.a.x, z.b.y - z.a.y) || 1;
    const fromA = Math.hypot(p.x - z.a.x, p.y - z.a.y) < Math.hypot(p.x - z.b.x, p.y - z.b.y);
    return Math.atan2((z.b.y - z.a.y) / len * (fromA ? 1 : -1), (z.b.x - z.a.x) / len * (fromA ? 1 : -1));
  }
  if (p.narrow) return Math.atan2(p.narrow.n.dir.y * p.narrow.d, p.narrow.n.dir.x * p.narrow.d);
  return null;
}

function step(w: SimWorld, s: State): void {
  ensureNav(w, s);
  if (!s.nav || !s.crowd) return;
  s.clock += DT;
  indexReservations(w);
  const arrived: Walker[] = [];
  // Intent: staggered looks at the way ahead; every tick while waiting.
  for (const p of s.walkers) {
    p.age += DT;
    if (p.mode === 'wait') p.waited += DT;
    if (--p.think <= 0 || p.mode === 'wait') {
      if (p.think <= 0) p.think = THINK_EVERY;
      decide(w, s, p);
    }
  }
  // At its place and come to rest, a person stands there: its target is
  // withdrawn and nothing steers it on.
  for (const p of s.walkers) {
    p.rest = p.speed < STILL ? p.rest + DT : 0;
    overshoot(s, p);
    approach(s, p, placeOf(p));
    const place = placeOf(p);
    if (!place || p.holding || p.speed > STILL) continue;
    const d = Math.hypot(place.x - p.x, place.y - p.y);
    if (d > REACHED && (d > STAND_AT || p.rest < SETTLE)) continue;
    p.agent.resetMoveTarget();
    p.holding = { x: place.x, y: place.y };
    p.asked = null;
  }
  for (const p of s.walkers) zebraAccess(s, p);
  // Movement: Detour's crowd, one fixed step.
  s.crowd.update(DT);
  // Read back, and face the way moved.
  for (const p of s.walkers) {
    const pos = p.agent.position();
    const vel = p.agent.velocity();
    p.x = pos.x; p.y = pos.z; p.h = pos.y;
    p.speed = Math.hypot(vel.x, vel.z);
    // VISUAL ORIENTATION, which moves nothing: walking, the way it walks;
    // shuffling, the way it means to go; standing, the way it waits to go.
    const want = p.agent.desiredVelocity();
    const face = p.speed >= WALKING ? Math.atan2(vel.z, vel.x)
      : Math.hypot(want.x, want.z) > MEANS ? Math.atan2(want.z, want.x)
        : p.holding ? waitFacing(p) : null;
    if (face !== null) {
      const delta = Math.atan2(Math.sin(face - p.heading), Math.cos(face - p.heading));
      // Turning on the spot is quicker than turning while walking.
      const rate = PIVOT_RATE + (TURN_RATE - PIVOT_RATE) * Math.min(1, p.speed / WALKING);
      const turn = Math.max(-rate * DT, Math.min(rate * DT, delta * Math.min(1, DT / TURN_TIME)));
      p.turnV = turn / DT;
      p.heading = Math.atan2(Math.sin(p.heading + turn), Math.cos(p.heading + turn));
    } else p.turnV = 0;
    // Getting nowhere while wanting to move (diagnosis).
    const wanted = Math.hypot(want.x, want.z);
    p.blocked = wanted > MEANS && (vel.x * want.x + vel.z * want.z) / wanted < PROGRESS_SHARE * p.topSpeed ? p.blocked + DT : 0;
    p.going = p.speed > 0.5 * p.topSpeed ? p.going + DT : 0;
    // Zebras: which it stands on, and those it has left behind.
    p.onZebra = null;
    for (const z of s.nav.zebras) if (onRoad(z, p.x, p.y)) { p.onZebra = z; break; }
    if (p.mode === 'walk' && p.onZebra) p.mode = 'cross';
    else if (p.mode === 'cross' && !p.onZebra) p.mode = 'walk';
    // A zebra let onto stays this walker's until it has been on it and left
    // it; one it never reached is let go once it is well away from it.
    for (const [id, been] of [...p.granted]) {
      const z = s.nav.zebras.find((q) => q.id === id);
      if (!z) { p.granted.delete(id); continue; }
      if (p.onZebra === z) { p.granted.set(id, true); continue; }
      if (onBand(z, p.x, p.y, been ? m(2) : ASK_AT * 2) === null) p.granted.delete(id);
    }
    if (p.age % 0.5 < DT) p.segment = roadUnder(s, p);
    if (!p.leader && Math.hypot(p.goal.x - p.x, p.goal.y - p.y) < ARRIVED) arrived.push(p);
  }
  trackPassages(s);
  makeWay(s);
  for (const p of arrived) {
    if (!s.byId.has(p.id) || p.scripted) continue;
    const party = s.walkers.filter((q) => q.leader === p);
    if (!p.leaving && pickGoal(w, s, p)) continue;
    for (const q of party) remove(s, q);
    remove(s, p);
  }
}

/** The road a walker stands beside: the nearest walkway's. */
function roadUnder(s: State, p: Walker): SegmentId | undefined {
  const nav = s.nav!;
  let best = -1, bd = Infinity;
  for (const way of nav.graph.ways) {
    const bb = way.path.bbox;
    if (p.x < bb.minX - m(4) || p.x > bb.maxX + m(4) || p.y < bb.minY - m(4) || p.y > bb.maxY + m(4)) continue;
    const d = way.path.closestPoint({ x: p.x, y: p.y }).distance;
    // On the deck the body stands on: a viaduct's footway passes over the
    // road below it, and by plan alone the walker was drawn under the deck.
    const road = nav.roadOf[way.id];
    const rise = road === undefined ? 0 : Math.abs(nav.elevation.onSegment(road, p.x, p.y) - p.h);
    const score = d + rise * 10;
    if (score < bd) { bd = score; best = way.id; }
  }
  return best >= 0 ? nav.roadOf[best] : undefined;
}

// ------------------------------------------------------------- what the rest of the game sees

function publish(w: SimWorld, s: State): void {
  const views = w.pedViews;
  const byId = w.pedViewById;
  views.length = 0;
  byId.clear();
  w.crossingStates.clear();
  for (const p of s.walkers) {
    const v = p.view;
    v.x = p.x; v.y = p.y; v.heading = p.heading;
    v.prev.x = p.prevX; v.prev.y = p.prevY; v.prev.heading = p.prevHeading;
    v.v = p.speed; v.turnV = p.turnV; v.age = p.age;
    v.party = p.party; v.rank = p.rank;
    v.ground = p.onZebra ? 'crossing' : 'footway';
    v.segment = p.onZebra ? (p.onZebra.edge.segment as SegmentId | undefined) : p.segment;
    v.stretch = '';
    // Walking is moving: derived from the velocity, never from the intent.
    v.walking = p.speed > STILL;
    v.kerbWait = p.mode === 'wait' ? Math.max(DT, p.waited) : 0;
    v.waitingFor = p.mode === 'wait' && p.zebra ? p.zebra.id : null;
    v.gesture = null;
    views.push(v);
    byId.set(p.id, v);
    // Who is on, or waiting for, each zebra: what the cars and the signals read.
    const z = p.onZebra ?? (p.mode === 'wait' ? p.zebra : null);
    if (!z) continue;
    const a = z.edge.path.point(0), b = z.edge.path.point(z.edge.path.n - 1);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    let state = w.crossingStates.get(z.id as never);
    if (!state) { state = emptyCrossingState(length); w.crossingStates.set(z.id as never, state); }
    const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
    const at = (p.x - a.x) * ux + (p.y - a.y) * uy;
    if (p.onZebra) {
      state.occupants.push({
        id: p.id, s: Math.max(0, Math.min(length, at)),
        forward: Math.cos(p.heading) * ux + Math.sin(p.heading) * uy >= 0,
        v: p.speed, held: p.speed < STILL && p.blocked > 2,
      });
    } else {
      if (at < length / 2) state.waitingFrom++;
      else state.waitingTo++;
      state.demand = true;
      state.longestWait = Math.max(state.longestWait, p.waited);
    }
  }
}

/** A read-only look at the walkers, for tests and diagnosis. */
export function inspectCrowd(w: SimWorld): readonly {
  id: number; x: number; y: number; h: number; heading: number; vx: number; vy: number; dvx: number; dvy: number; speed: number;
  mode: string; holding: boolean; leader: number | null; waited: number; target: Vec2 | null; goal: Vec2; zebra: string | null; state: number;
  narrow: number | null; passage: number | null; aside: Vec2 | null; blocked: number; replans: number; yields: number; granted: readonly string[]; onZebra: string | null;
  /** Detour's own view: its target, its target's state (0 none, 1 failed, 2 valid, 3 requesting, 4 waiting for queue, 5 waiting for path, 6 velocity), the corners ahead. */
  flags: number; eased: boolean; top: number; neighbours: readonly number[]; detourTarget: Vec2; targetState: number; corners: readonly Vec2[];
}[] {
  const s = stateOf(w);
  const byIndex = new Map(s.walkers.map((q) => [q.agent.agentIndex, q.id]));
  return s.walkers.map((p) => {
    const raw = p.agent.raw as unknown as { nneis: number; get_neis(i: number): { idx: number } };
    const neighbours = Array.from({ length: raw.nneis }, (_, i) => byIndex.get(raw.get_neis(i).idx) ?? -1);
    const v = p.agent.velocity(), dv = p.agent.desiredVelocity(), t = p.agent.target();
    return {
      id: p.id, x: p.x, y: p.y, h: p.h, heading: p.heading, vx: v.x, vy: v.z, dvx: dv.x, dvy: dv.z, speed: p.speed,
      mode: p.mode, holding: p.holding !== null, leader: p.leader?.id ?? null, waited: p.waited, target: p.asked, goal: p.goal,
      zebra: p.zebra?.id ?? null, state: p.agent.state(), narrow: p.narrow?.n.id ?? null, passage: p.passage?.n.id ?? null, aside: p.aside?.at ?? null, blocked: p.blocked,
      replans: p.replans, yields: p.yields, granted: [...p.granted.keys()], onZebra: p.onZebra?.id ?? null,
      flags: p.agent.parameters().updateFlags, eased: p.eased !== null, top: p.topSpeed, neighbours, detourTarget: { x: t.x, y: t.z }, targetState: (p.agent.raw as unknown as { targetState: number }).targetState,
      corners: p.agent.corners().map((c) => ({ x: c.x, y: c.z })),
    };
  });
}

/** What a scenario places: where a person starts, where it goes, how fast, and with whom. */
export interface ScriptedWalker {
  readonly x: number;
  readonly y: number;
  readonly goal: Vec2;
  /** Walking pace, u/s. */
  readonly pace?: number;
  /** The id (as returned) of the leader it walks with. */
  readonly leader?: number;
  readonly heading?: number;
}

/**
 * Places a person for a scenario (`tests/fixtures/crowdScenarios.ts`): it
 * walks to its goal through the same engine as everybody else, and stays
 * there. The city's own population should be off (`pedestrianIntensity` 0).
 * Returns its id, or null where there is no walkable ground.
 */
export function addScriptedWalker(w: SimWorld, spec: ScriptedWalker): number | null {
  if (!ready) return null;
  const s = stateOf(w);
  ensureNav(w, s);
  if (!s.nav) return null;
  const leader = spec.leader !== undefined ? s.byId.get(spec.leader) ?? null : null;
  const heading = spec.heading ?? Math.atan2(spec.goal.y - spec.y, spec.goal.x - spec.x);
  const party = leader ? leader.party : undefined;
  const rank = leader ? s.walkers.filter((q) => q.leader === leader).length + 1 : 0;
  const p = create(w, s, s.nextId, { x: spec.x, y: spec.y }, heading, {
    ageClass: 'adult', ...(spec.pace !== undefined ? { pace: spec.pace } : {}),
    ...(party ? { party, rank, leader } : {}),
  });
  if (!p) return null;
  p.scripted = true;
  const goal = onMesh(s, spec.goal);
  p.goal = goal ? { x: goal.x, y: goal.y } : spec.goal;
  if (leader) {
    const size = s.walkers.filter((q) => q.leader === leader).length + 1;
    const shared: PartyView = { id: leader.id, size, archetype: 'friends', hasChild: false };
    for (const q of [leader, ...s.walkers.filter((x) => x.leader === leader)]) { q.party = shared; q.view.party = shared; }
  }
  p.think = 0;
  return p.id;
}
