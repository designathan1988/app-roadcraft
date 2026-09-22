import { DT } from '../params';
import type { SimWorld } from '../world';
import type { Vehicle } from './state';
import { desiredSpeed } from './driver';
import { resolveSpeed } from './idm';
import { planFrom } from '../routing/router';
import { COARSE_EPS } from '@core/scalar';

const CLEARANCE_EPSILON = COARSE_EPS;

/**
 * The ONLY writer of `s`, `v` and `lanelet`.
 *
 * `ds` is unconditionally non-negative, so arc length is monotone
 * non-decreasing for the whole life of a vehicle. There is therefore no code
 * path that can move a follower backwards.
 *
 * That is the structural replacement for the V6 monolith's
 * `enforceVehicleSeparation`, which ran AFTER integration and teleported
 * followers back to fix overlaps — sometimes yanking a car that had just
 * completed a turn thirty units backwards (defect 5.5). Overlap is prevented
 * before it happens by the safe-speed cap in `resolveSpeed`, not repaired
 * afterwards.
 */
export function integrateAll(w: SimWorld): void {
  const removed: Vehicle[] = [];

  for (const v of w.vehiclesInIdOrder()) {
    const lane = w.lanelet(v.lanelet);
    if (!lane) {
      removed.push(v);
      continue;
    }

    // A lane change is a transfer between siblings at the same arc position, so
    // it must land before the step is integrated — otherwise this tick's motion
    // is measured against the lane the vehicle just left.
    const here = applyLaneChange(w, v) ?? lane;

    // The target speed wanders slowly, per driver. Nobody holds an exact speed,
    // and a fleet that does turns an open road into a conveyor belt: every car
    // at the limit, every gap constant, every platoon in step. The wander is a
    // continuous function of simulation time, so it cannot make the free-flow
    // term of IDM jump, and it is bounded well inside the speed limit.
    // Against the vehicle's OWN age, not the simulation clock: `clock.time`
    // only advances inside `SimClock.advance`/`run`, so a harness stepping the
    // pipeline directly would see a target that never wanders at all.
    const wanted = desiredSpeed(v.driver, v.v0, v.age);
    const speedCap = Math.min(wanted, here.speedLimit);
    const next = resolveSpeed(v.driver, v.v, speedCap, v.constraints.obstacles, DT);
    const ds = Math.max(0, 0.5 * (v.v + next) * DT);
    const clearancesAtStart = new Set(v.clearingConnectors);

    v.v = next;
    v.s += ds;
    v.age += DT;
    // What "held up" means, for the driver who is about to decide whether to
    // look for another way round: crawling at less than a third of what they
    // wanted. Measured against their own target rather than against a fixed
    // speed, so a bus on a residential street is not permanently frustrated.
    if (v.v < wanted * 0.34) v.heldUp += DT;
    else if (v.v > wanted * 0.6) v.heldUp = Math.max(0, v.heldUp - DT * 2);
    let travelled = ds;

    // Advance across lanelet boundaries, carrying the remainder.
    let guard = 0;
    while (guard++ < 16) {
      const current = w.lanelet(v.lanelet);
      if (!current || v.s <= current.length) break;
      const carried = v.s - current.length;
      if (!advance(w, v, carried)) {
        // Nowhere to go: hold at the end rather than vanish.
        travelled = Math.max(0, travelled - carried);
        discardUntravelledFromNewClearances(v, clearancesAtStart, carried);
        v.s = current.length;
        v.v = 0;
        break;
      }
    }

    const finalLane = w.lanelet(v.lanelet);
    if (finalLane && v.s > finalLane.length) {
      const discarded = v.s - finalLane.length;
      travelled = Math.max(0, travelled - discarded);
      discardUntravelledFromNewClearances(v, clearancesAtStart, discarded);
      v.s = finalLane.length;
      v.v = 0;
    }

    // A vehicle can span more than one junction when the link between them is
    // shorter than its body. Advance only by distance actually travelled; an
    // attempted step discarded at a red light must not release the rear early.
    advanceClearanceTokens(w, v, travelled, clearancesAtStart);

    if (finalLane?.kind === 'connector' && v.claims.length) {
      w.claims.releasePassed(
        v.id,
        finalLane.id,
        v.s - v.archetype.length,
        w.conflicts,
      );
    }

    if (travelled > 0.02) {
      v.lastMovedTick = w.clock.tick;
      v.waited = 0;
    } else {
      v.waited += DT;
    }

    // Right-on-red credit is earned by an actual full stop.
    // Credit is measured against the driver's own standstill gap.  The former
    // fixed 3-unit window was smaller than every production archetype's `s0`,
    // so a correctly stopped vehicle could never earn right-on-red credit.
    if (
      finalLane?.kind === 'link' &&
      v.v < 0.3 &&
      finalLane.length - v.s <= v.driver.s0 + 0.5
    ) {
      v.rorStopped += DT;
      if (v.rorStopped >= 1.0) v.rorCredit = true;
    } else if (v.v > 1) {
      v.rorStopped = 0;
      v.rorCredit = false;
    }
    v.claims = [...w.claims.points(v.id)];
  }

  for (const v of removed) w.removeVehicle(v);

  // Occupancy lists must stay ordered for the leader search to be O(1).
  for (const rt of w.runtime.values()) {
    if (rt.order.length > 1) w.sortLane(rt);
  }
}

/**
 * Performs a lane change the lane-change stage already cleared as safe.
 *
 * The move preserves arc position: sibling lanes of one segment are offsets of
 * the same centreline, so `s` means the same thing on both and the vehicle
 * neither gains nor loses ground by moving across. Keeping `s` is also what
 * makes the change invisible to the monotonicity invariant.
 *
 * The route is re-planned from the new lane rather than translated onto it. The
 * whole point of moving was that this lane's exits are different.
 */
function applyLaneChange(w: SimWorld, v: Vehicle): ReturnType<SimWorld['lanelet']> {
  const target = v.laneChange;
  v.laneChange = null;
  if (target === null || target === v.lanelet) return undefined;

  const lane = w.lanelet(target);
  if (!lane || lane.kind !== 'link') return undefined;
  // The verdict was computed a stage ago. Anything that could have invalidated
  // it since — a grant, a rear still in a junction — refuses the move rather
  // than trusting the stale answer.
  if (v.admittedConnector || v.clearingConnectors.length > 0) return undefined;
  if (v.s > lane.length) return undefined;

  w.exitLanelet(v, v.lanelet);
  v.lanelet = target;
  w.enterLanelet(v, target, false);
  v.desiredLane = null;
  v.route = [target];
  planFrom(w, v);
  return lane;
}

/** Removes overshoot that the next stop line rejected from newly-created tokens. */
function discardUntravelledFromNewClearances(
  v: Vehicle,
  clearancesAtStart: ReadonlySet<Vehicle['clearingConnectors'][number]>,
  distance: number,
): void {
  if (distance <= 0) return;
  for (const token of v.clearingConnectors) {
    if (!clearancesAtStart.has(token)) {
      token.distanceBeyondExit = Math.max(0, token.distanceBeyondExit - distance);
    }
  }
}

/** Advances rear-clearance ownership without consuming the next admission. */
function advanceClearanceTokens(
  w: SimWorld,
  v: Vehicle,
  distance: number,
  clearancesAtStart: ReadonlySet<Vehicle['clearingConnectors'][number]>,
): void {
  if (!v.clearingConnectors.length) return;

  const keep: Vehicle['clearingConnectors'] = [];
  for (const token of v.clearingConnectors) {
    const connector = w.connector(token.connector);
    if (!connector) continue;

    if (clearancesAtStart.has(token)) token.distanceBeyondExit += distance;
    if (token.distanceBeyondExit + CLEARANCE_EPSILON >= v.archetype.length) {
      w.claims.releaseConnector(v.id, connector.id, w.conflicts);
      continue;
    }

    const rearOnConnector =
      connector.length + token.distanceBeyondExit - v.archetype.length;
    w.claims.releasePassed(v.id, connector.id, rearOnConnector, w.conflicts);
    keep.push(token);
  }
  v.clearingConnectors = keep;
}

/**
 * Moves a vehicle onto the next lanelet on its route.
 * Returns false when there is none, in which case the caller holds position.
 */
function advance(w: SimWorld, v: Vehicle, carried: number): boolean {
  const current = w.lanelet(v.lanelet);
  let nextId = v.route[1];

  // Admission and integration share one token.  Once a vehicle has been
  // granted a connector, no route repair or congestion-driven replanning may
  // substitute another movement underneath that grant.
  if (current?.kind === 'link' && v.admittedConnector) {
    const admitted = w.connector(v.admittedConnector);
    if (!admitted || admitted.fromLane !== v.lanelet) return false;
    nextId = admitted.id;
    if (v.route[1] !== nextId) {
      const pinned = [v.lanelet, nextId, admitted.toLane];
      let expected = admitted.toLane;
      for (const reservedId of v.reservedConnectors) {
        const reserved = w.connector(reservedId);
        if (!reserved || reserved.fromLane !== expected) break;
        pinned.push(reserved.id, reserved.toLane);
        expected = reserved.toLane;
      }
      v.route = pinned;
    }
  }

  const next = nextId === undefined ? undefined : w.lanelet(nextId);

  if (!next || w.rt(next.id).ghost) {
    // The route is stale or the lanelet retired. Re-plan rather than freeze.
    //
    // The V6 monolith had exactly this situation and handled it by doing
    // nothing: `next` came back undefined, its whole approach block was
    // skipped, `wait` never grew, so neither re-route trigger could ever fire,
    // and the vehicle sat pinned on the stop line with a green light and no
    // recovery path — invisible even to its own audit (defect 2.1).
    if (v.admittedConnector) return false;
    planFrom(w, v);
    // A freshly planned connector has not passed admission yet.  Hold at the
    // line and let the next tick arbitrate it instead of entering on a route
    // that was never reserved.
    return false;
  }

  if (next.kind === 'connector' && v.admittedConnector !== next.id) return false;

  return advanceTo(w, v, next.id, carried);
}

function advanceTo(w: SimWorld, v: Vehicle, target: string, carried: number): boolean {
  const lane = w.lanelet(target);
  if (!lane) return false;

  const current = w.lanelet(v.lanelet);
  if (
    current?.kind === 'connector' &&
    lane.kind === 'link'
  ) {
    const existing = v.clearingConnectors.find((token) => token.connector === current.id);
    if (existing) existing.distanceBeyondExit = Math.max(existing.distanceBeyondExit, carried);
    else {
      v.clearingConnectors.push({
        connector: current.id,
        distanceBeyondExit: carried,
      });
    }
    // Admission now describes only the movement the front is about to enter.
    // The previous junction remains protected by `clearingConnectors`.
    if (v.admittedConnector === current.id) v.admittedConnector = null;
  }

  w.exitLanelet(v, v.lanelet);
  v.lanelet = target;
  // Keep the full carried distance. The boundary loop owns propagation across
  // any additional compact lanelets and will clamp only if the next connector
  // is not admitted. Clamping here silently discarded real overshoot.
  v.s = carried;
  w.enterLanelet(v, target);

  if (v.route[1] === target) v.route.shift();
  else v.route = [target, ...v.route.slice(1)];

  if (lane.kind === 'link') {
    if (v.reservedConnectors.length === 0) v.firstRequestTick = null;
  }
  return true;
}
