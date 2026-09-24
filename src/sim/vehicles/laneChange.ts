import { laneletId, type LaneletId } from '@world/lanelets';
import type { SimWorld } from '../world';
import { m } from '@world/units';
import type { Vehicle } from './state';
import { JAM_GAP, laneChangeLength } from '../params';
import { desiredSpeed } from './driver';
import { idmAccel, type Obstacle } from './idm';

/**
 * Lane choice: the route's, and the driver's.
 *
 * ## Two kinds of change, and why they are not the same decision
 *
 * A **mandatory** change is one the route needs. Lane discipline in
 * `laneIsPlausible` makes each turn legal from exactly one lane — a right turn
 * only from the outermost, a left only from the innermost — which is what stops
 * a car crossing the carriageway to reach its turn. `planFrom` publishes
 * `desiredLane` once, when the movement is chosen, and this stage executes it.
 * It is deliberately NOT re-decided here: an earlier version re-scored lane
 * costs every link, and the whole fleet then migrated into whichever lane had
 * the cheaper turn menu — a standing queue emptied itself sideways instead of
 * discharging.
 *
 * A **discretionary** change is one the driver wants: the car in front is slow
 * and the next lane is clear. Without it every vehicle inherits the speed of
 * the slowest vehicle ahead of it for the length of the block, which is why a
 * bicycle on an avenue used to gather a silent procession of cars behind it.
 * This is what "overtake slow vehicles" means, and it is a different decision
 * with a different failure mode — oscillation rather than migration.
 *
 * ## MOBIL, and the three things that keep it from oscillating
 *
 * The incentive is the standard one: change if my acceleration improves by more
 * than a threshold, having weighted the two drivers I inconvenience by my own
 * politeness. Three guards turn it from a paper model into something shippable:
 *
 *  - a **refractory period**, because a driver sitting exactly on the threshold
 *    flips between two lanes every tick;
 *  - a **keep-to-the-kerb bias**, so the incentive is asymmetric and the fleet
 *    drains back outward instead of accumulating in the fast lane;
 *  - **no discretionary change on a junction approach**, because that is where
 *    mandatory changes need the room, and a driver weaving at a stop line is
 *    both wrong and the thing most likely to strand someone in the wrong lane.
 *
 * Both thresholds and the politeness are the DRIVER's, not constants, so one
 * car pulls out to pass where the one behind it waits.
 *
 * This stage never writes `lanelet`. It publishes `laneChange` when the move is
 * safe right now, and `integrate` — the only writer of position — performs it.
 */

/**
 * Seconds of travel needed to complete a change, floored for a standing car.
 * Matches the eased change (`laneChangeLength`, about three seconds a lane)
 * so the body has settled before it reaches the stop line.
 */
const LANE_CHANGE_TIME = 3.5;

/**
 * Least room a mandatory change needs, whatever the speed.
 *
 * Below this the vehicle is committed to the lane it is in: it keeps the route
 * it can actually drive and misses the turn, which is what a real driver does
 * and is always recoverable on the next block.
 */
const LANE_CHANGE_MIN_ROOM = 10;

/**
 * Room a DISCRETIONARY change needs — six seconds of travel, and much more than
 * the mandatory floor.
 *
 * Overtaking into the last stretch before a junction is how a driver ends up in
 * a lane that cannot serve their turn, with no room left to get back. Leaving
 * that stretch to mandatory changes only is the whole reason the two decisions
 * are separated.
 */
const OVERTAKE_TIME = 6;
const OVERTAKE_MIN_ROOM = 45;

/** Shortest interval between two discretionary changes by the same driver. */
const LANE_CHANGE_COOLDOWN = 6;

/**
 * Bias towards the kerb side, in units of acceleration.
 *
 * Lane 0 is the innermost, so a HIGHER index is nearer the kerb. Moving outward
 * earns this; moving inward has to beat it. Without the asymmetry MOBIL is
 * perfectly reversible and the fleet ends up in whichever lane it drifted into.
 */
const KEEP_SIDE_BIAS = 0.14;

/** Hardest braking a discretionary change may impose on the car behind. */
const SAFE_BRAKE_SHARE = 0.55;

/** An obstacle far enough away to be no obstacle at all. */
const CLEAR_ROAD: Obstacle = { gap: 1e6, speed: 1e6, kind: 'vehicle' };

/**
 * Seconds a driver signals before moving across.
 *
 * Road codes ask for the indicator in good time before a change (CTB art. 35
 * and 196); two to three flashes is what drivers actually give. A mandatory
 * change in a crawling queue gets a shorter lead, because the gap it is
 * signalling for is moving at walking pace and will not wait.
 */
const SIGNAL_LEAD = 1.4;
const SIGNAL_LEAD_CRAWLING = 0.8;

export function stepLaneChange(w: SimWorld): void {
  for (const v of w.vehiclesInIdOrder()) {
    v.laneChange = null;

    const lane = w.lanelet(v.lanelet);
    if (!lane || lane.kind !== 'link') {
      v.laneIntent = null;
      continue;
    }

    // The body still occupies the space between lanes until the previous
    // manoeuvre finishes. Starting another transfer here compounds the lateral
    // offset and can put the entire vehicle beyond the carriageway edge.
    if (Math.abs(v.lateral) > 0.02) continue;

    // A granted movement pins the lane: the claim was arbitrated for this
    // lanelet's connector, and moving would abandon it mid-transaction. A rear
    // still inside a junction pins it for the same reason.
    if (v.admittedConnector || v.clearingConnectors.length > 0) {
      v.laneIntent = null;
      continue;
    }
    // Pulling in to the kerb, or standing there with a door open: the car
    // stays where the errand put it (`kerbStops.ts`).
    if (v.kerbStop) {
      v.laneIntent = null;
      continue;
    }

    const target = v.desiredLane;
    let wanted: LaneletId | null = null;
    let mandatoryMove = false;
    if (target !== null && target !== lane.id) {
      wanted = mandatory(w, v, target);
      mandatoryMove = wanted !== null;
    } else if (target !== lane.id) {
      // Keep a discretionary intent alive while the move is still worth
      // making, so the indicator does not flicker with the incentive.
      wanted = discretionary(w, v, lane.id, lane.length, v.laneIntent);
    }

    if (wanted === null) {
      v.laneIntent = null;
      continue;
    }
    if (wanted !== v.laneIntent) {
      v.laneIntent = wanted;
      v.laneIntentSince = v.age;
    }

    // Signal first; move once the lead has run and the gap is still there.
    const lead = mandatoryMove && v.v < CRAWL * 2 ? SIGNAL_LEAD_CRAWLING : SIGNAL_LEAD;
    if (v.age - v.laneIntentSince < lead) continue;
    if (!gapIsSafe(w, v, wanted)) continue;
    v.laneChange = wanted;
    v.laneIntent = null;
    v.lastLaneChangeAge = v.age;
  }
}

/**
 * The adjacent lane the route asks for, or null when there is no longer room
 * to get there (the vehicle keeps the route it can drive and misses the turn,
 * which is always recoverable on the next block).
 */
function mandatory(w: SimWorld, v: Vehicle, target: LaneletId): LaneletId | null {
  const lane = w.lanelet(v.lanelet);
  const to = w.lanelet(target);
  if (!lane || !to || to.kind !== 'link' || w.rt(target).ghost || to.length < v.s ||
      lane.segment !== to.segment || lane.from !== to.from || lane.to !== to.to ||
      lane.laneIndex === undefined || to.laneIndex === undefined) {
    v.desiredLane = null;
    v.movementIntent = null;
    return null;
  }

  const steps = Math.abs(to.laneIndex - lane.laneIndex);
  const adjacent = laneletId(lane.segment!, lane.from!, lane.to!,
    lane.laneIndex + Math.sign(to.laneIndex - lane.laneIndex));
  if (steps === 0 || !w.lanelet(adjacent) || w.rt(adjacent).ghost) {
    v.desiredLane = null;
    v.movementIntent = null;
    return null;
  }
  // Give up only when even easing off to a crawl would not make it; short of
  // that the driver slows down to fit (`positioningSpeedCap`).
  if (lane.length - v.s < roomNeeded(w, v, adjacent, steps, Math.min(v.v, CRAWL))) {
    v.desiredLane = null;
    v.movementIntent = null;
    return null;
  }
  return adjacent;
}

/**
 * Road a mandatory change of `steps` lanes needs at `speed`: each lane is
 * signalled for (`SIGNAL_LEAD_CRAWLING` at least) and then driven over its own
 * length (`laneChangeLength`), clear of the stop line.
 */
function roomNeeded(w: SimWorld, v: Vehicle, adjacent: LaneletId, steps: number, speed: number): number {
  return (Math.max(LANE_CHANGE_MIN_ROOM, speed * LANE_CHANGE_TIME,
    changeLength(w, v, adjacent, speed) + FINISH_MARGIN) + speed * SIGNAL_LEAD_CRAWLING) * steps;
}

/**
 * The speed a driver holds while working across to the lane the route needs.
 *
 * A driver with three lanes to cross before the turn does not accelerate to
 * the limit and then find there is no longer room: they ease off so that the
 * changes fit, and that is how the turn is kept. Infinity when no change is
 * pending or when there is room at any speed; the room check in `mandatory`
 * still gives up if even a crawl cannot make it.
 */
export function positioningSpeedCap(w: SimWorld, v: Vehicle): number {
  const target = v.desiredLane;
  if (target === null || target === v.lanelet) return Infinity;
  const lane = w.lanelet(v.lanelet);
  const to = w.lanelet(target);
  if (!lane || !to || lane.kind !== 'link' || lane.laneIndex === undefined || to.laneIndex === undefined ||
      lane.segment !== to.segment) return Infinity;
  const steps = Math.abs(to.laneIndex - lane.laneIndex);
  if (steps === 0) return Infinity;
  const adjacent = laneletId(lane.segment!, lane.from!, lane.to!,
    lane.laneIndex + Math.sign(to.laneIndex - lane.laneIndex));
  // A second of travel in hand, so the driver eases off before the room runs
  // out rather than on the tick it does.
  const left = lane.length - v.s - v.v;
  if (roomNeeded(w, v, adjacent, steps, Math.max(v.v, lane.speedLimit)) <= left) return Infinity;
  // Room falls with speed, so bisect for the fastest speed that still fits.
  let lo = 0;
  let hi = Math.max(v.v, lane.speedLimit);
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (roomNeeded(w, v, adjacent, steps, mid) <= left) lo = mid;
    else hi = mid;
  }
  // Never below a crawl: a change that needs less than that is not made.
  return Math.max(lo, CRAWL);
}

/** Kept clear of a stop line or a queue's tail when a change must be finished. */
const FINISH_MARGIN = m(6);
/** Below this a vehicle ahead is treated as standing, not as traffic to follow. */
const CRAWL = m(2);

/** Road a change into `target` from here would be driven over. */
function changeLength(w: SimWorld, v: Vehicle, target: LaneletId, speed = v.v): number {
  const lane = w.lanelet(v.lanelet);
  const other = w.lanelet(target);
  if (!lane || !other) return 0;
  const here = lane.centre.sampleAt(Math.min(Math.max(0, v.s), lane.length)).p;
  return laneChangeLength(other.centre.closestPoint(here).distance, speed, v.archetype.length);
}

/**
 * The change the driver wants: the best neighbouring lane, or none.
 *
 * Only immediate neighbours are considered. A two-lane jump is two decisions,
 * and taking it as one is how a car crosses a carriageway in a single tick.
 */
function discretionary(
  w: SimWorld,
  v: Vehicle,
  laneId: LaneletId,
  laneLength: number,
  signalling: LaneletId | null,
): LaneletId | null {
  if (v.age - v.lastLaneChangeAge < LANE_CHANGE_COOLDOWN) return null;
  if (laneLength - v.s < Math.max(OVERTAKE_MIN_ROOM, v.v * OVERTAKE_TIME)) return null;
  // The street the route turns into next. A lane that cannot reach it is no
  // overtaking lane: moving there only earns a mandatory change straight back,
  // which is the lane-to-lane oscillation measured before this at 38 % of all
  // changes (the kerb bias pulling a car out of its turning lane, the route
  // pulling it in again).
  const turnInto = nextOutSegment(w, v);

  const here = w.lanelet(laneId);
  const index = here?.laneIndex ?? 0;
  const wanted = desiredSpeed(v.driver, v.v0, v.age);

  // "Does this lane go anywhere" is asked with `exitsOf`, not with the router's
  // cost. The cost function recurses five hops over every branch, and this
  // question is asked twice per vehicle per tick: on a city that is a full route
  // search per car per frame, for an answer that only ever needed to be
  // "somewhere or nowhere".
  const onward = w.graph.exitsOf(laneId).length > 0;
  const ahead = leaderIn(w, laneId, v.s, v.id);
  const behind = followerIn(w, laneId, v.s - v.archetype.length, v.id);
  const mine = idmAccel(v.driver, v.v, wanted, ahead ?? CLEAR_ROAD);

  let bestGain = 0;
  let best: LaneletId | null = null;

  for (const candidate of w.graph.siblingLanes(laneId)) {
    const to = w.lanelet(candidate);
    if (!to || to.kind !== 'link' || w.rt(candidate).ghost) continue;
    if (Math.abs((to.laneIndex ?? 0) - index) !== 1) continue;
    if (to.length < v.s) continue;
    // Never move into a dead end — but only when the lane being left is not one
    // itself. A carriageway with no junction at either end has no onward
    // connector from ANY of its lanes, and the first version of this test
    // therefore refused every overtake on a straight road: measured at zero
    // lane changes in three minutes of a mixed fleet queued behind a bicycle.
    if (onward && w.graph.exitsOf(candidate).length === 0) continue;
    if (turnInto !== null && !w.graph.exitsOf(candidate)
      .some((id) => w.connector(id)?.outSegment === turnInto)) continue;
    // Deciding needs only a gap that could open; the move itself waits for the
    // indicator and then checks the gap again (`stepLaneChange`).
    if (candidate !== signalling && !gapIsSafe(w, v, candidate)) continue;

    const theirLeader = leaderIn(w, candidate, v.s, v.id);
    const theirFollower = followerIn(w, candidate, v.s - v.archetype.length, v.id);

    // Would the car behind me over there have to brake harder than a driver
    // reasonably can? That is the safety criterion, and it is separate from the
    // incentive: a change nobody is inconvenienced enough to veto can still be
    // one that forces an emergency stop.
    let follower = 0;
    if (theirFollower) {
      const f = theirFollower.vehicle;
      const before = idmAccel(
        f.driver,
        f.v,
        f.v0,
        leaderIn(w, candidate, f.s, f.id) ?? CLEAR_ROAD,
      );
      const after = idmAccel(f.driver, f.v, f.v0, {
        gap: Math.max(0.05, v.s - v.archetype.length - f.s),
        speed: v.v,
        kind: 'vehicle',
      });
      if (after < -f.driver.bEmergency * SAFE_BRAKE_SHARE) continue;
      follower = after - before;
    }

    // And the car behind me here, which I am about to stop blocking.
    let released = 0;
    if (behind) {
      const o = behind.vehicle;
      const before = idmAccel(o.driver, o.v, o.v0, {
        gap: Math.max(0.05, v.s - v.archetype.length - o.s),
        speed: v.v,
        kind: 'vehicle',
      });
      const after = idmAccel(o.driver, o.v, o.v0, ahead
        ? { gap: Math.max(0.05, ahead.gap + (v.s - o.s)), speed: ahead.speed, kind: 'vehicle' }
        : CLEAR_ROAD);
      released = after - before;
    }

    const theirs = idmAccel(v.driver, v.v, wanted, theirLeader ?? CLEAR_ROAD);
    const outward = (to.laneIndex ?? 0) > index;
    const bias = outward ? KEEP_SIDE_BIAS : -KEEP_SIDE_BIAS;
    const gain = theirs - mine + v.driver.politeness * (follower + released) + bias;

    // Once signalling, the driver carries on while it is still worth it at
    // all; a fresh decision needs the full threshold.
    const threshold = candidate === signalling ? v.driver.laneThreshold * 0.35 : v.driver.laneThreshold;
    if (gain > threshold && gain > bestGain) {
      bestGain = gain;
      best = candidate;
    }
  }

  return best;
}

/** Segment the planned next junction movement leaves by, or null when none is planned. */
function nextOutSegment(w: SimWorld, v: Vehicle): number | null {
  const next = v.route[1] ? w.connector(v.route[1]) : undefined;
  return next && next.fromLane === v.lanelet ? next.outSegment : null;
}

interface Neighbour {
  readonly vehicle: Vehicle;
  readonly gap: number;
  readonly speed: number;
  readonly kind: 'vehicle';
}

/**
 * The nearest vehicle ahead of `s` in a lane, as an obstacle.
 *
 * The lane's occupancy list is kept sorted by arc position, so this is a binary
 * search rather than a scan: MOBIL asks for four of these per candidate lane
 * per vehicle per tick, and a linear probe would make the cost of lane changing
 * quadratic in the length of a queue — precisely when there is a queue.
 */
function leaderIn(w: SimWorld, laneId: LaneletId, s: number, self: number): Neighbour | null {
  const order = w.rt(laneId).order;
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const at = w.veh(order[mid] as number);
    if ((at?.s ?? 0) <= s) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < order.length; i++) {
    const other = w.veh(order[i] as number);
    if (!other || other.id === self) continue;
    return {
      vehicle: other,
      gap: Math.max(0.05, other.s - other.archetype.length - s),
      speed: other.v,
      kind: 'vehicle',
    };
  }
  return null;
}

/** The nearest vehicle behind `rear` in a lane. */
function followerIn(w: SimWorld, laneId: LaneletId, rear: number, self: number): Neighbour | null {
  const order = w.rt(laneId).order;
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const at = w.veh(order[mid] as number);
    if ((at?.s ?? 0) < rear) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0; i--) {
    const other = w.veh(order[i] as number);
    if (!other || other.id === self) continue;
    return {
      vehicle: other,
      gap: Math.max(0.05, rear - other.s),
      speed: other.v,
      kind: 'vehicle',
    };
  }
  return null;
}

/**
 * Whether the target lane has room beside this vehicle right now.
 *
 * Both gaps are measured bumper to bumper and both must hold: moving in front
 * of a follower that cannot brake for it is the same collision as moving into
 * the back of a leader.
 */
function gapIsSafe(w: SimWorld, v: Vehicle, target: LaneletId): boolean {
  const rear = v.s - v.archetype.length;
  // Road the change itself will take, to be free of anybody slower ahead in
  // the new lane. A change started into the tail of a standing queue ended
  // with the car stopped half across the line, holding BOTH lanes (its
  // shadow) for as long as the queue stood - measured, a car held an
  // admitted movement in the old lane through its whole green.
  const finish = v.s + changeLength(w, v, target) + FINISH_MARGIN;

  // Every BODY in the target lane, not just its occupancy list: a vehicle
  // still sliding out of it, and the tail of one whose front has already
  // entered the junction, are both physically there. Measured before this: a
  // sedan moved in beside the last ten metres of a bus that had just turned.
  for (const body of w.bodiesIn(target)) {
    const other = body.vehicle;
    if (other.id === v.id) continue;

    const otherFront = body.s;
    const otherRear = otherFront - other.archetype.length;
    if (otherFront <= rear) {
      const gap = rear - otherFront;
      const need = Math.max(JAM_GAP, other.driver.s0) + other.v * other.driver.T * 0.5;
      if (gap < need) return false;
    } else if (otherRear >= v.s) {
      const gap = otherRear - v.s;
      const need = Math.max(JAM_GAP, v.driver.s0) + v.v * v.driver.T * 0.5;
      if (gap < need) return false;
      if (otherRear < finish && other.v < Math.max(v.v, CRAWL)) return false;
    } else {
      // Overlapping our own body length: no room at all.
      return false;
    }
  }
  return true;
}
