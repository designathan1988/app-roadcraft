import type { LaneletId } from '@world/lanelets';
import { m } from '@world/units';
import { DT, PED } from '../params';
import type { SimWorld } from '../world';
import type { Vehicle } from './state';
import { createPed, pedSnapshot, type Ped, type PedAgeClass, type PedGender } from '../peds/state';
import type { SidewalkEdge } from '../peds/sidewalk';
import { pedHash } from '../peds/behaviour';

/**
 * Somebody getting out of a car at the kerb, or getting in.
 *
 * Every occupant used to be born inside a vehicle at the edge of the map and
 * to vanish with it at another edge: nobody was ever seen getting in or out,
 * and no door ever moved. A car now sometimes carries an ERRAND - drop a
 * passenger off, or pick somebody up - and runs it the way a driver does:
 *
 *   1. it picks a place in the kerb lane, well clear of junctions and
 *      crossings, where a footway runs beside the road;
 *   2. it brakes to a stop there (`kerbStopObstacle`, an ordinary obstacle,
 *      so traffic behind simply follows it down or overtakes);
 *   3. it waits until the swing of the door and the spot on the footway are
 *      clear of people - a door is not opened into somebody;
 *   4. the kerb-side door opens, the person moves between the seat and the
 *      footway, the door closes, and the car pulls away.
 *
 * A passenger dropped off becomes a pedestrian on the footway, walking on
 * from where they stood. A pick-up takes a real pedestrian walking alone near
 * the stop: they walk to the door and get in, and are removed from the
 * crowd when they sit down.
 *
 * A bus runs the same machinery as a SERVICE: at a stop, passengers alight
 * through the middle door and people waiting nearby board at the front, one
 * after another with the doors held open. A truck makes a DELIVERY: its mate
 * gets out on the kerb side, is gone for a few seconds with the load, and
 * gets back in. Each person is one task of the stop's queue.
 *
 * Doors and seats are indexed as the renderer's body model numbers them:
 * the driver's (left) side first, front to back, then the kerb (right) side;
 * each door serves the seat behind it. Only kerb-side doors are used here,
 * which in right-hand traffic is the side away from the traffic.
 */

export type ErrandKind = 'drop' | 'pick' | 'service' | 'deliver';
/** What one task of a stop does: somebody gets out, or somebody gets in. */
export type TaskKind = 'drop' | 'pick';

export type KerbStopPhase = 'approach' | 'halt' | 'hold' | 'fetch' | 'open' | 'transfer' | 'close';

/** The person moving between the seat and the footway. */
export interface KerbPerson {
  readonly seed: number;
  readonly gender: PedGender;
  readonly ageClass: PedAgeClass;
  /** Where they stand on the footway (drop) or come from (pick), world units. */
  readonly footX: number;
  readonly footY: number;
  /** Heading they face while standing on the footway. */
  readonly footHeading: number;
}

export interface KerbStop {
  readonly kind: TaskKind;
  readonly lanelet: LaneletId;
  /** Arc position of the FRONT of the vehicle where it stops. */
  readonly at: number;
  readonly door: number;
  readonly seat: number;
  phase: KerbStopPhase;
  /** Seconds in the phase. */
  t: number;
  /** Seconds the whole stop has taken, for the give-up guard. */
  elapsed: number;
  /** For a pick-up, the pedestrian to collect until they are taken in. */
  pedId: number | null;
  person: KerbPerson | null;
  /** Seconds the transfer takes, fixed when it starts. */
  transferTime: number;
  /** A pick-up: seconds the person needs to walk to the door, and has walked. */
  fetchTime: number;
  walked: number;
  /** A drop-off that does not become a pedestrian: the truck's mate, who comes back. */
  keep: boolean;
  /** Seconds the person stands on the footway before walking back (a delivery). */
  hold: number;
  /** Whether the person moves between a seat and the door (cars, cabs) or just steps in or out (buses). */
  seatStage: boolean;
}

/** Share of cars with a passenger that drop one off somewhere on their trip. */
const DROP_SHARE = 0.18;
/** Share of cars with a free kerb-side seat that stop to pick somebody up. */
const PICK_SHARE = 0.1;
/** Share of trucks on a delivery. */
const DELIVERY_SHARE = 0.4;
/** Seconds a truck's mate is away with the load. */
const DELIVERY_TIME = 7;
/** Least time between two bus stops, seconds of the bus's own age. */
const BUS_HEADWAY = 35;
/** Kept clear of the ends of a link: junctions, stop lines, zebras. */
const END_CLEARANCE = m(30);
/** Least distance ahead a stop is planned, beyond comfortable braking. */
const PLAN_MARGIN = m(8);
/** Seconds a door takes to open and to shut. */
const DOOR_OPEN_TIME = 0.9;
const DOOR_SHUT_TIME = 0.7;
/** Seconds to step up into a bus from its door. */
const STEP_ABOARD = 0.6;
/** Seconds to get out of a seat and stand beside the car, or to sit down. */
const SEAT_TIME = 1.8;
/** A person's pace to or from the door, world units a second. */
const KERB_PACE = m(1.1);
/** Radius round the door's swing that must be free of people before it opens. */
const DOOR_CLEAR = m(1.4);
/** Longest a car will stand waiting for room before it gives up and drives on. */
const GIVE_UP = 25;
/** How far along the footway a pick-up looks for somebody walking alone. */
const PICK_REACH = m(40);
/**
 * How far the person to collect may be from the door when the car stops: they
 * see it pull in and walk to it, so they are not lost by walking on meanwhile.
 */
const PICK_FETCH = m(30);

/** How far somebody will walk to catch a bus that has stopped. */
const BUS_FETCH = m(45);

/** First id of the people who ride in vehicles, clear of any pedestrian id. */
const PERSON_BASE = 1 << 24;

/**
 * Who sits in a seat. A passenger keeps one identity from spawn to wherever
 * they get out: the renderer draws this body in the seat, and the pedestrian
 * created at the kerb takes this id, so the person who walks off is the one
 * who was sitting there. Somebody picked up keeps their pedestrian id.
 */
export function seatPerson(v: Vehicle, seat: number): { seed: number; gender: PedGender; ageClass: PedAgeClass } {
  const picked = v.people[seat];
  const seed = picked ?? PERSON_BASE + v.id * 8 + seat;
  const hash = pedHash(seed);
  const gender: PedGender = (hash >>> 3) & 1 ? 'f' : 'm';
  if (picked !== undefined) return { seed, gender, ageClass: v.peopleAge[seat] ?? 'adult' };
  // A family car: about one back seat in four carries a child, and never the
  // driver's seat or the front passenger's.
  const perSide = v.archetype.doorsPerSide;
  const back = perSide > 1 && seat % perSide !== 0;
  return { seed, gender, ageClass: back && ((hash >>> 7) & 3) === 0 ? 'child' : 'adult' };
}

/** Fixed at spawn: which seats are taken, and whether the trip has an errand. */
export function assignOccupancy(w: SimWorld, v: Vehicle): void {
  const perSide = v.archetype.doorsPerSide;
  const seats = v.archetype.seats;
  const rng = w.rng.occupancy;
  let mask = 1; // the driver
  const extra = rng.float();
  // Most cars carry the driver alone; a few are full.
  const passengers = extra < 0.55 ? 0 : extra < 0.82 ? 1 : extra < 0.94 ? 2 : 3;
  const order = passengerOrder(perSide, seats);
  for (let i = 0; i < Math.min(passengers, order.length); i++) mask |= 1 << order[i]!;
  v.seats = mask;
  if (v.archetype.shape === 'bus') {
    // A city bus is never empty and always calls at stops.
    const riders = 2 + Math.floor(rng.float() * (seats - 2));
    for (let i = 1; i <= riders && i < seats; i++) v.seats |= 1 << i;
    v.errand = 'service';
    return;
  }
  if (v.archetype.shape === 'truck') {
    // Some trucks are out on a delivery, with a mate in the cab to run it.
    if (rng.float() < DELIVERY_SHARE) {
      v.seats |= 1 << 1;
      v.errand = 'deliver';
    }
    return;
  }
  if (perSide === 0) return;
  const kerbSeats = kerbSideSeats(perSide);
  const occupiedKerb = kerbSeats.some((s) => (mask & (1 << s)) !== 0);
  const freeKerb = kerbSeats.some((s) => (mask & (1 << s)) === 0);
  const roll = rng.float();
  if (occupiedKerb && roll < DROP_SHARE) v.errand = 'drop';
  else if (freeKerb && roll > 1 - PICK_SHARE) v.errand = 'pick';
}

/** Seats people take after the driver: front passenger, then behind. */
function passengerOrder(perSide: number, seats: number): number[] {
  const out: number[] = [];
  if (perSide === 0) {
    for (let i = 1; i < seats; i++) out.push(i);
    return out;
  }
  out.push(perSide); // front, kerb side
  for (let i = 1; i < perSide; i++) {
    out.push(perSide + i); // behind, kerb side
    out.push(i); // behind, driver's side
  }
  return out.filter((s) => s < seats);
}

/** Seat (and door) indices on the kerb side, front first. */
function kerbSideSeats(perSide: number): number[] {
  return Array.from({ length: perSide }, (_, i) => perSide + i);
}

/**
 * Where a door is along the body, from the front of the vehicle, as a share
 * of its length: front row and rear row. Matches the body model closely
 * enough to put a person at the door and to test the door's swing.
 */
function doorAlongFromFront(v: Vehicle, door: number): number {
  const a = v.archetype;
  if (a.shape === 'bus') return door === 0 ? m(0.9) : a.length / 2 + m(0.3);
  if (a.shape === 'truck') return m(0.3) + (a.length * a.cabinFraction - m(0.45)) / 2;
  const perSide = v.archetype.doorsPerSide;
  const row = door % Math.max(1, perSide);
  return v.archetype.length * (perSide === 1 ? 0.38 : row === 0 ? 0.42 : 0.62);
}

/** One step of every errand. The only writer of `kerbStop` and `doors`. */
export function stepKerbStops(w: SimWorld): void {
  for (const v of w.vehiclesInIdOrder()) {
    const stop = v.kerbStop;
    if (!stop) {
      if (v.errand) plan(w, v);
      continue;
    }
    stop.t += DT;
    stop.elapsed += DT;
    const lane = w.lanelet(v.lanelet);
    // Left the lane it meant to stop in (rerouted, a lane change, a rebuild)
    // before stopping: the errand is dropped, never run somewhere else.
    if (!lane || v.lanelet !== stop.lanelet) {
      if (stop.phase === 'approach') abandon(v);
      else finishDoors(v, stop);
      continue;
    }
    switch (stop.phase) {
      case 'approach':
        if (v.v < 0.05 && stop.at - v.s < m(1)) enter(stop, 'halt');
        else if (v.s > stop.at + m(2)) abandon(v);
        break;
      case 'halt':
        if (stop.elapsed > GIVE_UP) {
          abandon(v);
        } else if (stop.t > 0.4 && stop.kind === 'pick') {
          hail(w, v, stop);
        } else if (stop.t > 0.4 && roomToOpen(w, v, stop)) {
          enter(stop, 'open');
        }
        break;
      case 'hold':
        // Away with the load; then back to the door.
        if (stop.t >= stop.hold && stop.person) {
          const { door } = doorPlaces(w, v, stop);
          stop.fetchTime = Math.hypot(stop.person.footX - door.x, stop.person.footY - door.y) / KERB_PACE;
          stop.walked = 0;
          enter(stop, 'fetch');
        }
        break;
      case 'fetch':
        // The person walks to the car; the door opens as they get there.
        stop.walked += DT;
        if (stop.walked >= stop.fetchTime - DOOR_OPEN_TIME &&
            (roomToOpen(w, v, stop) || stop.elapsed > GIVE_UP)) enter(stop, 'open');
        break;
      case 'open': {
        if (stop.kind === 'pick') stop.walked += DT;
        const open = Math.max(v.doors[stop.door] ?? 0, Math.min(1, stop.t / DOOR_OPEN_TIME));
        setDoor(v, stop.door, open);
        if (open >= 1 && (stop.kind === 'drop' || stop.walked >= stop.fetchTime)) beginTransfer(w, v, stop);
        break;
      }
      case 'transfer':
        if (stop.t >= stop.transferTime) completeTransfer(w, v, stop);
        break;
      case 'close': {
        const open = Math.max(0, 1 - stop.t / DOOR_SHUT_TIME);
        for (let d = 0; d < v.doors.length; d++) v.doors[d] = Math.min(v.doors[d]!, open);
        if (open <= 0) {
          v.doors = [];
          const next = v.kerbQueue.shift();
          v.kerbStop = next ?? null;
          // The next task of the same stop, the car still standing there.
          if (next) enter(next, next.hold > 0 ? 'hold' : next.kind === 'pick' ? 'halt' : 'halt');
          if (next && next.hold > 0) next.person = stop.person;
        }
        break;
      }
    }
  }
}

function enter(stop: KerbStop, phase: KerbStopPhase): void {
  stop.phase = phase;
  stop.t = 0;
}

function abandon(v: Vehicle): void {
  v.kerbStop = null;
  v.kerbQueue = [];
  // A bus keeps its service for the next stop; anything else gives up.
  if (v.errand !== 'service') v.errand = null;
  v.doors = [];
}

function finishDoors(v: Vehicle, stop: KerbStop): void {
  // Somehow moved while a door was open: shut it and forget the errand.
  if (stop.phase !== 'close') enter(stop, 'close');
  v.kerbQueue = [];
  if (v.errand !== 'service') v.errand = null;
}

function setDoor(v: Vehicle, door: number, open: number): void {
  while (v.doors.length <= door) v.doors.push(0);
  v.doors[door] = open;
}

/**
 * Chooses where to stop on the current link, or waits for a later one.
 *
 * Only in the kerb lane, only on a link long enough to stop in the middle of
 * it, only where a footway runs alongside on that side, and never where the
 * vehicle would have to brake harder than comfortably to make it.
 */
function plan(w: SimWorld, v: Vehicle): void {
  const lane = w.lanelet(v.lanelet);
  if (!lane || lane.kind !== 'link' || lane.segment === undefined || lane.laneIndex === undefined) return;
  if (v.admittedConnector || v.desiredLane || v.laneIntent || Math.abs(v.lateral) > 0.02) return;
  // The kerb lane is the outermost: no sibling beyond it.
  if (w.graph.siblingLanes(lane.id).some((id) => (w.lanelet(id)?.laneIndex ?? -1) > lane.laneIndex!)) return;
  const structure = w.doc.segment(lane.segment)?.structure ?? 'ground';
  if (structure !== 'ground') return;
  const brake = (v.v * v.v) / (2 * v.driver.b);
  const earliest = Math.max(v.s + brake + PLAN_MARGIN, END_CLEARANCE);
  const latest = lane.length - END_CLEARANCE;
  if (latest - earliest < m(10)) return;

  if (v.errand === 'service') {
    planBusStop(w, v, lane.id, earliest, latest);
    return;
  }
  if (v.errand === 'deliver') {
    const at = earliest + (latest - earliest) * 0.4;
    if (!footwayBeside(w, lane.id, at - doorAlongFromFront(v, 1))) return;
    if (queuedAhead(w, v, at)) return;
    // The mate gets out, is away with the load, and gets back in.
    const out = newStop('drop', lane.id, at, 1, 1);
    out.keep = true;
    const back = newStop('pick', lane.id, at, 1, 1);
    back.hold = DELIVERY_TIME;
    v.kerbStop = out;
    v.kerbQueue = [back];
    return;
  }
  const perSide = v.archetype.doorsPerSide;
  const kerbSeats = kerbSideSeats(perSide);
  if (v.errand === 'drop') {
    // A child is not let out on their own.
    const seat = kerbSeats.find((s) => (v.seats & (1 << s)) !== 0 && seatPerson(v, s).ageClass !== 'child');
    if (seat === undefined) {
      v.errand = null;
      return;
    }
    const at = earliest + (latest - earliest) * 0.35;
    if (!footwayBeside(w, lane.id, at - doorAlongFromFront(v, seat))) return;
    if (queuedAhead(w, v, at)) return;
    v.kerbStop = newStop('drop', lane.id, at, seat);
    return;
  }

  // A pick-up needs somebody to pick up: a person walking alone on this
  // side's footway, ahead of the car.
  const seat = kerbSeats.find((s) => (v.seats & (1 << s)) === 0);
  if (seat === undefined) {
    v.errand = null;
    return;
  }
  const person = walkerBeside(w, lane.id, earliest, Math.min(latest, earliest + PICK_REACH));
  if (!person) return;
  const at = Math.min(latest, Math.max(earliest, person.s + doorAlongFromFront(v, seat)));
  if (queuedAhead(w, v, at)) return;
  const stop = newStop('pick', lane.id, at, seat);
  stop.pedId = person.ped.id;
  v.kerbStop = stop;
}

/**
 * A bus stop: one or two passengers off by the middle door, and whoever is
 * walking alone nearby on by the front door, up to two, into free seats.
 */
function planBusStop(w: SimWorld, v: Vehicle, lanelet: LaneletId, earliest: number, latest: number): void {
  if (v.age - v.lastServiceAge < BUS_HEADWAY) return;
  const at = earliest + (latest - earliest) * 0.3;
  if (!footwayBeside(w, lanelet, at - doorAlongFromFront(v, 1))) return;
  if (queuedAhead(w, v, at)) return;
  const tasks: KerbStop[] = [];
  const seats = v.archetype.seats;
  const occupied = Array.from({ length: seats - 1 }, (_, i) => i + 1).filter((s) => (v.seats & (1 << s)) !== 0);
  const leaving = Math.min(occupied.length, 1 + ((v.id + Math.floor(v.age)) % 2));
  for (let i = 0; i < leaving; i++) {
    const task = newStop('drop', lanelet, at, occupied[occupied.length - 1 - i]!, 1);
    task.seatStage = false;
    tasks.push(task);
  }
  const free = Array.from({ length: seats - 1 }, (_, i) => i + 1)
    .filter((s) => (v.seats & (1 << s)) === 0 || tasks.some((t) => t.seat === s));
  const taken = new Set<number>();
  for (let i = 0; i < 2 && i < free.length; i++) {
    // Anybody walking alone along this side of the block may be waiting for
    // the bus; they walk up to it when it calls (`hail`).
    const doorAt = at - doorAlongFromFront(v, 0);
    const walker = walkerBeside(w, lanelet, doorAt - BUS_FETCH * 0.7, doorAt + BUS_FETCH * 0.7, taken);
    if (!walker) break;
    taken.add(walker.ped.id);
    const task = newStop('pick', lanelet, at, free[i]!, 0);
    task.pedId = walker.ped.id;
    task.seatStage = false;
    tasks.push(task);
  }
  v.lastServiceAge = v.age;
  if (!tasks.length) return;
  v.kerbStop = tasks.shift()!;
  v.kerbQueue = tasks;
}

function newStop(kind: TaskKind, lanelet: LaneletId, at: number, seat: number, door = seat): KerbStop {
  return { kind, lanelet, at, door, seat, phase: 'approach', t: 0, elapsed: 0,
    pedId: null, person: null, transferTime: 0, fetchTime: 0, walked: 0, keep: false, hold: 0, seatStage: true };
}

/** Somebody standing still or queued in front of the stop would make it a queue, not a stop. */
function queuedAhead(w: SimWorld, v: Vehicle, at: number): boolean {
  for (const id of w.rt(v.lanelet).order) {
    const other = w.veh(id);
    if (!other || other.id === v.id || other.s <= v.s) continue;
    if (other.s - other.archetype.length < at + m(6)) return true;
  }
  return false;
}

/** Right of a lane: the side a footway must be on, as a unit normal. */
function kerbSide(w: SimWorld, lanelet: LaneletId, s: number): { p: { x: number; y: number }; t: { x: number; y: number }; right: { x: number; y: number } } | null {
  const lane = w.lanelet(lanelet);
  if (!lane) return null;
  const f = lane.centre.sampleAt(Math.min(Math.max(0, s), lane.length));
  return { p: f.p, t: f.t, right: { x: f.t.y, y: -f.t.x } };
}

/** The nearest point of a walking footway on the kerb side at `s`, if one runs there. */
function footwayBeside(w: SimWorld, lanelet: LaneletId, s: number): { x: number; y: number; t: { x: number; y: number } } | null {
  const lane = w.lanelet(lanelet);
  const side = kerbSide(w, lanelet, s);
  if (!lane || !side) return null;
  let best: { x: number; y: number; t: { x: number; y: number } } | null = null;
  let bestDistance = m(9);
  for (const edge of w.sidewalks.edges.values()) {
    if (edge.kind !== 'walk' || edge.segment !== lane.segment) continue;
    const hit = edge.path.closestPoint(side.p);
    const dx = hit.point.x - side.p.x;
    const dy = hit.point.y - side.p.y;
    if (dx * side.right.x + dy * side.right.y <= 0) continue;
    if (hit.distance < bestDistance) {
      bestDistance = hit.distance;
      best = { x: hit.point.x, y: hit.point.y, t: edge.path.sampleAt(hit.s).t };
    }
  }
  return best;
}

/** A pedestrian walking alone on the kerb-side footway between `s0` and `s1` of the lane. */
function walkerBeside(w: SimWorld, lanelet: LaneletId, s0: number, s1: number,
  exclude: ReadonlySet<number> = new Set()): { ped: Ped; s: number } | null {
  const lane = w.lanelet(lanelet);
  if (!lane) return null;
  let best: { ped: Ped; s: number } | null = null;
  for (const ped of w.pedsInIdOrder()) {
    if (ped.state !== 'Walking' || ped.party.size !== 1 || ped.ageClass === 'child' || ped.activity) continue;
    // Somebody another member of a party is pacing would be left behind.
    if (ped.trailing !== null || exclude.has(ped.id)) continue;
    const edge = w.sidewalks.edges.get(ped.edge);
    if (edge?.kind !== 'walk' || edge.segment !== lane.segment) continue;
    const hit = lane.centre.closestPoint({ x: ped.x, y: ped.y });
    if (hit.s < s0 || hit.s > s1) continue;
    const f = lane.centre.sampleAt(hit.s);
    if ((ped.x - f.p.x) * f.t.y - (ped.y - f.p.y) * f.t.x <= 0) continue;
    if (!best || hit.s < best.s) best = { ped, s: hit.s };
  }
  return best;
}

/** World position of a kerb-side door's opening and of the spot beside it on the footway. */
function doorPlaces(w: SimWorld, v: Vehicle, stop: KerbStop) {
  const lane = w.lanelet(v.lanelet)!;
  const s = v.s - doorAlongFromFront(v, stop.door);
  const f = lane.centre.sampleAt(Math.min(Math.max(0, s), lane.length));
  const right = { x: f.t.y, y: -f.t.x };
  const half = v.archetype.width / 2;
  const door = { x: f.p.x + right.x * (half + m(0.5)), y: f.p.y + right.y * (half + m(0.5)) };
  const foot = footwayBeside(w, v.lanelet, s);
  return { door, foot, heading: Math.atan2(f.t.y, f.t.x) };
}

/** The door's swing and the footway spot are free of people. */
function roomToOpen(w: SimWorld, v: Vehicle, stop: KerbStop): boolean {
  const { door, foot } = doorPlaces(w, v, stop);
  if (!foot) return false;
  for (const ped of w.peds.values()) {
    if (ped.id === stop.pedId) continue;
    if (Math.hypot(ped.x - door.x, ped.y - door.y) < DOOR_CLEAR) return false;
    if (stop.kind === 'drop' && Math.hypot(ped.x - foot.x, ped.y - foot.y) < m(0.9)) return false;
  }
  // Nothing in the lane beside the door either: a cyclist or a motorcycle
  // squeezing past on the kerb side would ride into it.
  for (const other of w.vehicles.values()) {
    if (other.id === v.id) continue;
    const o = w.lanelet(other.lanelet);
    if (!o) continue;
    const p = o.centre.sampleAt(Math.min(Math.max(0, other.s - other.archetype.length / 2), o.length)).p;
    if (Math.hypot(p.x - door.x, p.y - door.y) < DOOR_CLEAR + other.archetype.length / 2) return false;
  }
  return true;
}

function beginTransfer(w: SimWorld, v: Vehicle, stop: KerbStop): void {
  const { door, foot, heading } = doorPlaces(w, v, stop);
  if (!foot) {
    enter(stop, 'close');
    return;
  }
  if (stop.kind === 'drop') {
    const who = seatPerson(v, stop.seat);
    stop.person = {
      seed: who.seed,
      gender: who.gender,
      ageClass: who.ageClass,
      footX: foot.x,
      footY: foot.y,
      footHeading: heading,
    };
    stop.transferTime = (stop.seatStage ? SEAT_TIME : 0) + Math.hypot(foot.x - door.x, foot.y - door.y) / KERB_PACE;
    enter(stop, 'transfer');
    return;
  }
  // A pick-up: they have walked to the open door; now they sit down, or on
  // a bus simply step aboard.
  stop.transferTime = stop.seatStage ? SEAT_TIME : STEP_ABOARD;
  enter(stop, 'transfer');
}

/**
 * The car has stopped for somebody: they see it and walk over. Taken out of
 * the crowd here, where they stand, and walked to the door by the car's own
 * errand, so nothing about pedestrian steering can send them off elsewhere.
 * Somebody who has gone too far, or who is busy, is not collected.
 */
function hail(w: SimWorld, v: Vehicle, stop: KerbStop): void {
  const { door } = doorPlaces(w, v, stop);
  const ped = stop.pedId !== null ? w.peds.get(stop.pedId) : undefined;
  const reach = v.archetype.shape === 'bus' ? BUS_FETCH : PICK_FETCH;
  if (!ped || ped.state !== 'Walking' || ped.activity || ped.trailing !== null ||
      Math.hypot(ped.x - door.x, ped.y - door.y) > reach) {
    abandon(v);
    return;
  }
  stop.person = {
    seed: ped.id,
    gender: ped.gender,
    ageClass: ped.ageClass,
    footX: ped.x,
    footY: ped.y,
    footHeading: ped.heading,
  };
  w.peds.delete(ped.id);
  stop.fetchTime = Math.hypot(ped.x - door.x, ped.y - door.y) / KERB_PACE;
  stop.walked = 0;
  enter(stop, 'fetch');
}

function completeTransfer(w: SimWorld, v: Vehicle, stop: KerbStop): void {
  if (stop.kind === 'drop') {
    v.seats &= ~(1 << stop.seat);
    if (stop.person && !stop.keep) spawnAlighted(w, stop.person);
    if (!stop.keep) {
      delete v.people[stop.seat];
      delete v.peopleAge[stop.seat];
    }
  } else {
    v.seats |= 1 << stop.seat;
    if (stop.person && !v.people[stop.seat] && stop.person.seed < PERSON_BASE) {
      v.people[stop.seat] = stop.person.seed;
      v.peopleAge[stop.seat] = stop.person.ageClass;
    }
  }
  // A bus's next passenger uses the doors already open; anything that waits
  // (a delivery) shuts them first.
  const next = v.kerbQueue[0];
  if (next && next.hold === 0) {
    v.kerbQueue.shift();
    v.kerbStop = next;
    enter(next, next.kind === 'pick' ? 'halt' : 'open');
    return;
  }
  if (!next && v.errand !== 'service') v.errand = null;
  enter(stop, 'close');
}

/** The dropped-off passenger, as a pedestrian standing where they got out. */
function spawnAlighted(w: SimWorld, person: KerbPerson): void {
  let edge: SidewalkEdge | undefined;
  let s = 0;
  let lat = 0;
  let best = Infinity;
  for (const candidate of w.sidewalks.edges.values()) {
    if (candidate.kind !== 'walk') continue;
    const hit = candidate.path.closestPoint({ x: person.footX, y: person.footY });
    if (hit.distance < best) {
      best = hit.distance;
      edge = candidate;
      s = hit.s;
      const f = candidate.path.sampleAt(hit.s);
      lat = (person.footX - f.p.x) * f.n.x + (person.footY - f.p.y) * f.n.y;
    }
  }
  // The person keeps the id they had in the seat (`seatPerson`), unless
  // somebody of that id is already walking about.
  if (!edge || w.peds.has(person.seed)) return;
  const id = person.seed;
  const speed = PED.meanSpeed;
  const ped = createPed({
    id,
    color: '#5d6b7a',
    speed,
    file: id % PED.files,
    ageClass: person.ageClass,
    gender: person.gender,
    party: { id, size: 1, pace: speed, hasChild: false },
    rank: 0,
    edge: edge.id,
    entry: edge.from,
    s,
    lat: Math.max(-edge.halfWidth * 0.8, Math.min(edge.halfWidth * 0.8, lat)),
    tick: w.clock.tick,
  });
  ped.x = person.footX;
  ped.y = person.footY;
  ped.heading = person.footHeading;
  ped.v = 0;
  ped.prev = pedSnapshot(ped);
  w.peds.set(id, ped);
}

/**
 * The stop as an obstacle: the front of the vehicle halts at `at`, and holds
 * there until the door has shut again.
 */
export function kerbStopObstacle(v: Vehicle): { gap: number; speed: number; kind: 'kerbStop' } | null {
  const stop = v.kerbStop;
  if (!stop || v.lanelet !== stop.lanelet) return null;
  if (stop.phase === 'close' && stop.t >= DOOR_SHUT_TIME) return null;
  // The car-following model stops a standstill gap short of any obstacle;
  // the stop is a PLACE, not something to keep a gap from, so the gap is
  // added back and the front comes to rest on `at` itself.
  return { gap: Math.max(0, stop.at - v.s + v.driver.s0), speed: 0, kind: 'kerbStop' };
}

/**
 * Where the moving person is, for the renderer. `seated` runs from 1 in the
 * seat to 0 standing beside the open door; `walked` from 0 at the door to 1
 * standing on the footway. A drop-off gets up and then walks; a pick-up walks
 * to the door and then sits down.
 */
export function kerbTransfer(stop: KerbStop): { seated: number; walked: number } | null {
  if (!stop.person) return null;
  if (stop.kind === 'pick') {
    if (stop.phase === 'hold') return { seated: 0, walked: 1 };
    if (stop.phase === 'fetch' || stop.phase === 'open') {
      return { seated: 0, walked: 1 - Math.min(1, stop.walked / Math.max(stop.fetchTime, 1e-6)) };
    }
    if (stop.phase === 'transfer') return { seated: Math.min(1, stop.t / Math.max(stop.transferTime, 1e-6)), walked: 0 };
    return null;
  }
  // The truck's mate stands on the footway while the door shuts behind them.
  if (stop.keep && stop.phase === 'close') return { seated: 0, walked: 1 };
  if (stop.phase !== 'transfer') return null;
  const seatShare = stop.seatStage ? Math.min(1, SEAT_TIME / Math.max(stop.transferTime, 1e-6)) : 0;
  const t = Math.min(1, stop.t / Math.max(stop.transferTime, 1e-6));
  return t < seatShare
    ? { seated: 1 - t / seatShare, walked: 0 }
    : { seated: 0, walked: (t - seatShare) / Math.max(1e-6, 1 - seatShare) };
}
