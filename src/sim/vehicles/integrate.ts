import { DT, laneChangeLength, laneChangeOffset, laneChangeSlope } from '../params';
import { curveSpeedCap } from './curvature';
import type { SimWorld } from '../world';
import type { Vehicle } from './state';
import { desiredSpeed } from './driver';
import { resolveSpeed } from './idm';
import { planFrom } from '../routing/router';
import { bodyClassOfArchetype } from './archetypes';
import { COARSE_EPS } from '@core/scalar';
import { addScaled, dot, perp, sub } from '@core/vec2';

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
    // Bends ahead are taken at a comfortable lateral acceleration, braked for
    // in advance (`curveSpeedCap`). The cap falls smoothly as a bend nears,
    // but a route change can bring one into view suddenly, so a single step
    // never demands more than an emergency stop's worth of braking.
    const curveCap = Math.max(curveSpeedCap(w, v), v.v - v.driver.bEmergency * DT);
    const speedCap = Math.min(wanted, here.speedLimit, curveCap);
    const next = resolveSpeed(v.driver, v.v, speedCap, v.constraints.obstacles, DT);
    const ds = Math.max(0, 0.5 * (v.v + next) * DT);
    const clearancesAtStart = new Set(v.clearingConnectors);

    v.v = next;
    v.s += ds;
    v.age += DT;

    // The change itself, a curve in DISTANCE eased at both ends: see
    // `laneChangeOffset`. A vehicle that stops mid-change stays put, angled.
    if (v.lateral !== 0) {
      v.lateralTravelled += ds;
      v.lateral = laneChangeOffset(v.lateralStart, v.lateralTravelled, v.lateralLength);
      v.lateralSlope = v.lateral === 0 ? 0
        : laneChangeSlope(v.lateralStart, v.lateralTravelled, v.lateralLength);
    } else {
      v.lateralSlope = 0;
    }
    if (v.shadow && (v.lateral === 0 || Math.abs(v.lateral) < v.shadow.clearAt)) w.clearShadow(v);
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
        v.s - v.archetype.length / 2,
        bodyClassOfArchetype(v.archetype),
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
  if (Math.abs(v.lateral) > 0.02) return undefined;

  const lane = w.lanelet(target);
  if (!lane || lane.kind !== 'link') return undefined;
  // The verdict was computed a stage ago. Anything that could have invalidated
  // it since — a grant, a rear still in a junction — refuses the move rather
  // than trusting the stale answer.
  if (v.admittedConnector || v.clearingConnectors.length > 0) return undefined;
  if (v.s > lane.length) return undefined;

  // Carry the SIDEWAYS distance the transfer just covered, so the renderer
  // can slide the vehicle across instead of teleporting it.
  //
  // A lane change moves the vehicle between two parallel centrelines in a
  // single tick. `vehiclePose` then had nothing to interpolate - its own
  // guard skipped interpolation entirely whenever the lanelet changed - so a
  // car crossed a full lane width in one frame. That instantaneous sideways
  // jump is what reads as the vehicle "bugging out and skipping position".
  //
  // `lateral` places the body between lane centrelines while the transfer
  // closes. The lanelet occupancy index changes immediately; complete dual-
  // lane physical occupancy remains open in the completion audit.
  const from = w.lanelet(v.lanelet);
  if (!from || from.segment !== lane.segment || from.from !== lane.from || from.to !== lane.to ||
      Math.abs((from.laneIndex ?? 0) - (lane.laneIndex ?? 0)) !== 1) return undefined;
  if (from) {
    const frame = from.centre.sampleAt(Math.min(v.s, from.length));
    // Where the vehicle is actually DRAWN, which is the centreline plus
    // whatever is left of a previous change. Anchoring to the bare centreline
    // instead means a vehicle that changes lane twice in quick succession
    // jumps by a full lane width: the first change leaves it rendered a lane
    // away from its own centreline, and the second measures from the
    // centreline as though it were already there.
    const was = { p: addScaled(frame.p, perp(frame.t), v.lateral), t: frame.t };

    // ANCHOR BY POSITION, NOT BY ARC LENGTH.
    //
    // The transfer used to keep `s` and hand it to the sibling lane. Sibling
    // lanes are parallel but they are not the same curve: each is trimmed
    // separately at each end by its own junction, and on a curve the inner and
    // outer lanes have genuinely different lengths. The same `s` is therefore
    // a different place along the road, and the vehicle jumped FORWARDS or
    // BACKWARDS along its own street at the moment it changed lane. Measured
    // here before this: 9.7 units in a single tick by a vehicle travelling at
    // under 2 units a second.
    //
    // Taking the nearest point on the new lane instead keeps the vehicle
    // physically where it already was, and leaves only the sideways part -
    // which is what `lateral` then slides out.
    const anchor = lane.centre.closestPoint(was.p);
    const sOnOld = v.s;
    v.s = anchor.s;
    const now = lane.centre.sampleAt(anchor.s);
    v.lateral = dot(sub(was.p, now.p), perp(now.t));
    v.lateralStart = v.lateral;
    v.lateralTravelled = 0;
    v.lateralLength = laneChangeLength(v.lateral, v.v, v.archetype.length);
    v.lateralSlope = 0;

    // DUAL OCCUPANCY. The body is still where it was, across the old lane, and
    // will be for most of the change. Measured before this existed: 84 body
    // overlaps in seven seeded scenarios, nearly all a vehicle entering or
    // driving on in the lane this one had "already" left.
    //
    // The shadow lasts until the change is COMPLETE. It used to be released as
    // soon as a heavy vehicle on the old CENTRELINE could pass beside, which
    // assumed whoever was there was centred. Two vehicles swapping lanes are
    // not: each is offset towards the other, both had released their shadows,
    // and neither saw the other ahead. While the change was a timed slide that
    // window closed within a second; now that it is driven (`laneChangeLength`)
    // a car stopped half across the line stays there, and the second car drove
    // into it. Until it is fully in its new lane, it is in both.
    w.addShadow(v, from.id, sOnOld - v.s, 0);
  }

  w.exitLanelet(v, v.lanelet);
  v.lanelet = target;
  w.enterLanelet(v, target, false);
  if (v.desiredLane === target) v.desiredLane = null;
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

    const centreOnConnector =
      connector.length + token.distanceBeyondExit - v.archetype.length / 2;
    w.claims.releasePassed(v.id, connector.id, centreOnConnector,
      bodyClassOfArchetype(v.archetype), w.conflicts);
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
  // A shadow is a position on a sibling of the CURRENT lane; it means nothing
  // once the front has moved on.
  w.clearShadow(v);
  if (current?.kind === 'link' && lane.kind === 'connector') {
    v.desiredLane = null;
    v.movementIntent = null;
  }
  if (current?.kind === 'connector' && lane.kind === 'link') {
    v.desiredLane = null;
    v.movementIntent = null;
  }
  if (current) v.rearPath = [current.id, ...v.rearPath].slice(0, 32);
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
