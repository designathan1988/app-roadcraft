import type { LaneletId } from '@world/lanelets';
import type { SimWorld } from '../world';
import type { Vehicle } from './state';
import { JAM_GAP } from '../params';
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

/** Seconds of travel needed to complete a change, floored for a standing car. */
const LANE_CHANGE_TIME = 2.0;

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
const LANE_CHANGE_COOLDOWN = 4;

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

export function stepLaneChange(w: SimWorld): void {
  for (const v of w.vehiclesInIdOrder()) {
    v.laneChange = null;

    const lane = w.lanelet(v.lanelet);
    if (!lane || lane.kind !== 'link') continue;

    // A granted movement pins the lane: the claim was arbitrated for this
    // lanelet's connector, and moving would abandon it mid-transaction. A rear
    // still inside a junction pins it for the same reason.
    if (v.admittedConnector || v.clearingConnectors.length > 0) continue;

    const target = v.desiredLane;
    if (target !== null && target !== lane.id) {
      if (mandatory(w, v, target)) v.laneChange = target;
      continue;
    }
    if (target === lane.id) continue;

    const chosen = discretionary(w, v, lane.id, lane.length);
    if (chosen !== null) {
      v.laneChange = chosen;
      v.lastLaneChangeAge = v.age;
    }
  }
}

/** The change the route asked for, executed as soon as there is a gap. */
function mandatory(w: SimWorld, v: Vehicle, target: LaneletId): boolean {
  const lane = w.lanelet(v.lanelet);
  const to = w.lanelet(target);
  if (!lane || !to || to.kind !== 'link' || w.rt(target).ghost || to.length < v.s) {
    v.desiredLane = null;
    return false;
  }

  const room = Math.max(LANE_CHANGE_MIN_ROOM, v.v * LANE_CHANGE_TIME);
  if (lane.length - v.s < room) {
    v.desiredLane = null;
    return false;
  }

  if (!gapIsSafe(w, v, target)) return false;
  v.lastLaneChangeAge = v.age;
  return true;
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
): LaneletId | null {
  if (v.age - v.lastLaneChangeAge < LANE_CHANGE_COOLDOWN) return null;
  if (laneLength - v.s < Math.max(OVERTAKE_MIN_ROOM, v.v * OVERTAKE_TIME)) return null;

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
    if (!gapIsSafe(w, v, candidate)) continue;

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

    if (gain > v.driver.laneThreshold && gain > bestGain) {
      bestGain = gain;
      best = candidate;
    }
  }

  return best;
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

  for (const otherId of w.rt(target).order) {
    const other = w.veh(otherId);
    if (!other || other.id === v.id) continue;

    const otherRear = other.s - other.archetype.length;
    if (other.s <= rear) {
      const gap = rear - other.s;
      const need = Math.max(JAM_GAP, other.driver.s0) + other.v * other.driver.T * 0.5;
      if (gap < need) return false;
    } else if (otherRear >= v.s) {
      const gap = otherRear - v.s;
      const need = Math.max(JAM_GAP, v.driver.s0) + v.v * v.driver.T * 0.5;
      if (gap < need) return false;
    } else {
      // Overlapping our own body length: no room at all.
      return false;
    }
  }
  return true;
}
