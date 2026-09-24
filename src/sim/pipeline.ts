import { DT, STUCK_SECONDS } from './params';
import type { SimWorld } from './world';
import { stepController } from './signals/fsm';
import { longitudinalConstraints } from './vehicles/obstacles';
import {
  compactReservationChain,
  nextConnector,
  stepAdmission,
} from './intersections/admission';
import { integrateAll } from './vehicles/integrate';
import { stepDespawn, stepDispatch } from './vehicles/spawn';
import { stepLaneChange } from './vehicles/laneChange';
import { stepKerbStops } from './vehicles/kerbStops';
import { releaseCrossing, stepPedestrians } from './peds/crossingFsm';
import { stepPedDispatch } from './peds/spawn';
import { planFrom, reconsiderRoute, repairRoute } from './routing/router';
import { snapshot, type Vehicle } from './vehicles/state';
import { pedSnapshot } from './peds/state';
import { runAudit } from './invariants';
import { signalStateFor } from './signals/query';

export interface StepOptions {
  readonly traffic?: boolean;
  readonly pedestrians?: boolean;
}

/**
 * One fixed simulation step.
 *
 * Stage order matters, but not in the way it did in the V6 monolith.
 *
 * Stages 3 to 6 are PURE PRODUCERS of constraints on a set that stage 7
 * resolves with `min`. Because `min` is commutative and associative, their
 * relative order cannot change whether the result is safe — only how fresh it
 * is. That is the opposite of six serial `if (...) return false` gates, which
 * are order dependent AND non-composable, since the first `false` wins no
 * matter how mild it is and no later condition can soften it.
 *
 * Every field has exactly one writer:
 *
 *   topology, lanelets, conflicts, sidewalks   stage 0
 *   controller stage/sub/elapsed/plan          stage 1
 *   route, spawn and despawn                   stage 2
 *   pedestrian state and position              stage 3
 *   vehicle constraints (append only)          stages 4-5
 *   claims (grant)                             stage 5
 *   vehicle s, v, lanelet, lane order          stage 6
 *   claims (release), ghosts                   stages 6-7
 */
export function step(w: SimWorld, opts: StepOptions = {}): void {
  const traffic = opts.traffic ?? true;
  const pedestrians = opts.pedestrians ?? true;

  // 0. topology: the only place derived structure may change
  if (w.topologyRevision !== w.net.revision) {
    w.rebuildTopology();
    rebindAgents(w);
  }

  // snapshot for render interpolation
  for (const v of w.vehicles.values()) v.prev = snapshot(v);
  for (const p of w.peds.values()) p.prev = pedSnapshot(p);

  // 1. signals: the sole mutator of phase state
  const deps = w.signalDeps();
  for (const node of w.junctionNodesInOrder()) {
    const c = w.controllers.get(node);
    if (c) stepController(c, deps);
  }

  // 2. routing and population
  stepDispatch(w, traffic);
  stepPedDispatch(w, pedestrians);
  ensureVehicleRoutes(w);
  // Lane choice sits between routing and constraints: it must see a settled
  // route, and integration must see its verdict. It only decides — see
  // `stepLaneChange`.
  if (traffic) stepLaneChange(w);
  // Kerb stops: choosing where, and the doors and people once stopped.
  if (traffic) stepKerbStops(w);

  // 3. Pedestrians arbitrate crossings first.  A vehicle admitted on an
  // earlier tick owns an explicit connector token and keeps them at the kerb;
  // otherwise a pedestrian stepping out now is visible to admission below.
  if (pedestrians) stepPedestrians(w);

  // 4. longitudinal constraints
  for (const v of w.vehiclesInIdOrder()) {
    v.constraints = longitudinalConstraints(w, v);
  }

  // 5. intersection admission: denial appends a constraint, never a command
  if (traffic) stepAdmission(w);

  // 6. integration: the only writer of position and speed
  if (traffic) integrateAll(w);

  // 7. cleanup
  stepDespawn(w);
  collectGhosts(w);
  runWatchdog(w);
  updateStallCounters(w);

  // 8. audit
  if (w.auditEnabled) {
    for (const i of runAudit(w, w.auditLevel)) w.report(i);
  }
}

/** Re-binds agents to the rebuilt topology after a live edit. */
export function rebindAgents(w: SimWorld): void {
  for (const v of w.vehiclesInIdOrder()) {
    // A shadow is a projection onto a sibling lane that may have been rebuilt
    // with a different length; the lateral slide finishes without it.
    w.clearShadow(v);
    const lane = w.lanelet(v.lanelet);
    if (!lane) {
      // The lanelet is gone. Keep the agent alive only if something plausible
      // remains; otherwise remove it cleanly rather than leaving it frozen.
      w.removeVehicle(v);
      continue;
    }
    v.s = Math.min(v.s, lane.length);
    w.enterLanelet(v, v.lanelet, false);

    const admitted = v.admittedConnector ? w.connector(v.admittedConnector) : undefined;
    const admissionStillValid =
      !!admitted &&
      ((lane.kind === 'link' && admitted.fromLane === lane.id) ||
        (lane.kind === 'connector' && admitted.id === lane.id));
    v.clearingConnectors = v.clearingConnectors.filter((token) =>
      Boolean(w.connector(token.connector)),
    );
    if (v.admittedConnector && !admissionStillValid) {
      w.claims.releaseConnector(v.id, v.admittedConnector, w.conflicts);
      v.admittedConnector = null;
    }

    reconcileReservedChain(w, v);
    if (!pinReservedRoute(w, v)) repairRoute(w, v);
    v.claims = [...w.claims.points(v.id)];
    v.firstRequestTick = null;
  }

  for (const p of w.pedsInIdOrder()) {
    const edge = w.sidewalks.edges.get(p.edge);
    if (!edge) {
      // A pedestrian whose edge vanished is moved to the nearest surviving
      // sidewalk edge rather than being deleted mid-road.
      releaseCrossing(w, p);
      const fallback = [...w.sidewalks.edges.values()].find((e) => e.kind === 'walk');
      if (!fallback) {
        w.peds.delete(p.id);
        continue;
      }
      p.edge = fallback.id;
      p.entry = fallback.from;
      p.s = 0;
      p.state = 'Walking';
      p.route = [];
      p.occupying = null;
      continue;
    }
    p.s = Math.min(p.s, edge.length);
    p.route = p.route.filter((id) => w.sidewalks.edges.has(id));
  }

  // `Ped.occupying` is the source of truth. Reconstructing this index avoids a
  // live-but-relocated pedestrian keeping a demolished crossing occupied after
  // undo/redo or any other topology replacement.
  w.pedOccupancy.clear();
  for (const p of w.pedsInIdOrder()) {
    if (!p.occupying) continue;
    if (!w.sidewalks.crossings.has(p.occupying)) {
      p.occupying = null;
      continue;
    }
    const list = w.pedOccupancy.get(p.occupying);
    if (list) list.push(p.id);
    else w.pedOccupancy.set(p.occupying, [p.id]);
  }
}

/** Retires lanelets that no longer exist once their occupants have left. */
function collectGhosts(w: SimWorld): void {
  for (const [id, rt] of [...w.runtime]) {
    if (!w.graph.lanelets.has(id)) {
      if (rt.order.length === 0) w.runtime.delete(id);
      else if (!rt.ghost) {
        rt.ghost = true;
        rt.ghostSince = w.clock.tick;
      }
    }
  }
}

/**
 * Accumulates, per tick, how long each vehicle has stood still with a green
 * signal and nothing in its way.
 *
 * This has to be integrated rather than inferred, because "time since it last
 * moved" is large for a vehicle that has been waiting through a long red and is
 * about to pull away — inferring from it reports a wedge at the exact moment
 * the light turns green.
 */
function updateStallCounters(w: SimWorld): void {
  for (const v of w.vehicles.values()) {
    const lane = w.lanelet(v.lanelet);
    if (!lane || lane.kind !== 'link' || !lane.controlled || v.v >= 0.1) {
      // BOTH counters reset here.
      //
      // `greenDenied` used to be left untouched on this path, so a vehicle
      // that accumulated a few seconds of denial and then drove away carried
      // the number for the rest of its life. `invariants.ts` tests it with no
      // speed guard of its own, so the stale value was reported as a vehicle
      // blocked at a green while it was moving freely. The only detector for
      // "held at a green" was therefore unreliable in both directions at once:
      // false positives from here, false negatives from the exclusions below.
      v.greenStall = 0;
      v.greenDenied = 0;
      continue;
    }
    const conn = nextConnector(w, v);
    const c = conn ? w.controller(conn.node) : undefined;
    const green = conn && c ? signalStateFor(c, conn.group) === 'green' : false;
    const impeded = v.constraints.obstacles.some(
      (o) =>
        // The driver's standstill gap, as everywhere else that reads s0.
        (o.kind === 'vehicle' && o.gap < v.driver.s0 + 3) ||
        o.kind === 'yield' ||
        o.kind === 'conflict' ||
        o.kind === 'pedestrian' ||
        o.kind === 'spillback' ||
        // Stopped at the kerb on purpose, letting somebody out or in.
        o.kind === 'kerbStop',
    );
    v.greenStall = green && !impeded ? v.greenStall + DT : 0;

    // A second counter, deliberately blind to WHY the vehicle was refused.
    //
    // `greenStall` above only accumulates while nothing is in the way, because
    // a brief yield or conflict wait is ordinary. But "ordinary" has to be
    // bounded: a driver watching their green go by for fifteen seconds does
    // not care which internal predicate refused them, and neither does the
    // person reporting the bug. Measured on a 4x4 grid of four-lane avenues,
    // vehicles sat at a green for up to 17.8 s while `greenBlocked` reported
    // nothing, because `conflict` counted as legitimate impedance forever.
    //
    // Two exclusions, each because the refusal is by design:
    //
    //   - An UNSIGNALISED junction reports a permanent green, so there is no
    //     green to be denied; a vehicle there is waiting for a gap, correctly.
    //   - `spillback` is the refusal that stops the network gridlocking. Being
    //     held out of a full box is right, and its pathological form already
    //     has `spillbackWedge`.
    const signalised = conn ? w.graph.junctions.get(conn.node)?.signalised === true : false;
    // A car stopped at the kerb to let somebody out is not waiting for the
    // green either.
    const heldByDesign = v.constraints.obstacles.some((o) => o.kind === 'spillback' || o.kind === 'kerbStop');
    v.greenDenied = green && signalised && !heldByDesign ? v.greenDenied + DT : 0;
  }
}

/**
 * Diagnostic only. A passing test suite never triggers this; it exists so that
 * an unforeseen wedge surfaces as a reported issue instead of a silent stall.
 */
function runWatchdog(w: SimWorld): void {
  for (const v of w.vehicles.values()) {
    // Rear-clearance and ahead-of-route reservations can legitimately remain
    // while a vehicle waits at another signal. Only a connector already
    // admitted for immediate entry is expected to start moving promptly.
    if (!v.admittedConnector) continue;
    if (w.clock.since(v.lastMovedTick) > STUCK_SECONDS) {
      // Never release a resource while its physical holder is still present.
      // In cheap-audit mode surface the fault once; full audit reports the
      // same invariant below with richer checks.
      if (
        w.auditEnabled &&
        w.auditLevel === 'cheap' &&
        !w.issues.some((i) => i.code === 'staleClaim' && i.subject === String(v.id))
      ) {
        w.report({
          code: 'staleClaim',
          tick: w.clock.tick,
          subject: String(v.id),
          detail: 'admitted vehicle immobile; reservation retained for safety',
        });
      }
    }
  }
}

/** Makes admission consume a real, connected route rather than a fallback. */
function ensureVehicleRoutes(w: SimWorld): void {
  for (const v of w.vehiclesInIdOrder()) {
    const lane = w.lanelet(v.lanelet);
    if (!lane) continue;

    // A driver who has been stuck long enough reconsiders, against the
    // congestion as it is now rather than as it was when they set off.
    reconsiderRoute(w, v);

    reconcileReservedChain(w, v);

    if (lane.kind === 'link' && v.admittedConnector) {
      const admitted = w.connector(v.admittedConnector);
      if (admitted?.fromLane === lane.id) {
        if (v.route[0] !== lane.id || v.route[1] !== admitted.id) {
          if (!pinReservedRoute(w, v)) {
            v.route = [lane.id, admitted.id, admitted.toLane];
            repairRoute(w, v);
          }
        }
        continue;
      }
      w.claims.releaseConnector(v.id, v.admittedConnector, w.conflicts);
      v.claims = [...w.claims.points(v.id)];
      v.admittedConnector = null;
    }

    const next = v.route[1];
    const connected =
      v.route[0] === lane.id &&
      next !== undefined &&
      (lane.kind === 'link'
        ? w.connector(next)?.fromLane === lane.id
        : w.connector(lane.id)?.toLane === next);
    if (!connected) {
      if (!pinReservedRoute(w, v)) repairRoute(w, v);
      continue;
    }

    // A route that simply RAN OUT while the lane still has somewhere to go.
    //
    // `connected` is satisfied by a two-element route, so a vehicle whose plan
    // ends at the current link was considered healthy and was never re-planned.
    // It then drove to the stop line and stayed there for the rest of its life,
    // holding the head of its lane. This is not a broken route - it is a short
    // one - so it is extended rather than repaired.
    if (v.route.length <= 1 && w.graph.exitsOf(lane.id).length > 0) {
      planFrom(w, v);
    }
  }
}

/**
 * Drops a reservation chain as a unit if a live edit broke any of its links.
 * Keeping a valid prefix would reintroduce partial acquisition and could leave
 * the vehicle stranded before the replacement refuge.
 */
function reconcileReservedChain(w: SimWorld, v: Vehicle): boolean {
  const lane = w.lanelet(v.lanelet);
  if (!lane) return false;

  let expectedFrom: string | undefined;
  if (lane.kind === 'connector') {
    expectedFrom = w.connector(lane.id)?.toLane;
  } else if (v.admittedConnector) {
    const admitted = w.connector(v.admittedConnector);
    expectedFrom = admitted?.fromLane === lane.id ? admitted.toLane : undefined;
  } else {
    expectedFrom = lane.id;
  }

  let valid = expectedFrom !== undefined;
  for (const id of v.reservedConnectors) {
    const connector = w.connector(id);
    if (!connector || connector.fromLane !== expectedFrom) {
      valid = false;
      break;
    }
    expectedFrom = connector.toLane;
  }

  // Revalidate the refuge property too. A live geometry edit can keep every
  // connector id intact while shortening the final link below this vehicle's
  // physical stopping length.
  const root = lane.kind === 'connector'
    ? w.connector(lane.id)
    : v.admittedConnector
      ? w.connector(v.admittedConnector)
      : v.reservedConnectors[0]
        ? w.connector(v.reservedConnectors[0])
        : undefined;
  if (valid && root) {
    const required = compactReservationChain(w, v, root);
    const expectedReservations =
      lane.kind === 'link' && !v.admittedConnector
        ? required?.map((connector) => connector.id)
        : required?.slice(1).map((connector) => connector.id);
    valid =
      expectedReservations !== undefined &&
      expectedReservations.length === v.reservedConnectors.length &&
      expectedReservations.every((id, index) => v.reservedConnectors[index] === id);
  }
  if (valid) return true;

  // Once the front entered the compound box, releasing a prefix is unsafe and
  // acquiring an extension would be partial hold-and-wait. Preserve ownership;
  // the audit will surface the edited short link for the user to resolve.
  if (lane.kind === 'connector' || v.clearingConnectors.length > 0) return false;

  for (const id of v.reservedConnectors) {
    w.claims.releaseConnector(v.id, id, w.conflicts);
  }
  v.reservedConnectors = [];

  // Before entry, an admission whose declared safe continuation disappeared
  // can be cancelled. Once physically on a connector it must retain ownership
  // until its rear clears.
  if (lane.kind === 'link' && v.admittedConnector) {
    w.claims.releaseConnector(v.id, v.admittedConnector, w.conflicts);
    v.admittedConnector = null;
  }
  v.claims = [...w.claims.points(v.id)];
  return false;
}

/** Reconstructs the route prefix pinned by the current grant and soft claim. */
function pinReservedRoute(w: SimWorld, v: Vehicle): boolean {
  const lane = w.lanelet(v.lanelet);
  if (!lane) return false;

  const prefix: string[] = [lane.id];
  let expectedLink: string | undefined;
  if (lane.kind === 'connector') {
    const current = w.connector(lane.id);
    if (!current) return false;
    expectedLink = current.toLane;
    prefix.push(expectedLink);
  } else {
    expectedLink = lane.id;
    if (v.admittedConnector) {
      const admitted = w.connector(v.admittedConnector);
      if (!admitted || admitted.fromLane !== expectedLink) return false;
      prefix.push(admitted.id, admitted.toLane);
      expectedLink = admitted.toLane;
    }
  }

  if (!v.admittedConnector && !v.reservedConnectors.length) return false;
  for (const id of v.reservedConnectors) {
    const connector = w.connector(id);
    if (!connector || connector.fromLane !== expectedLink) return false;
    if (prefix[prefix.length - 1] !== connector.fromLane) return false;
    prefix.push(connector.id, connector.toLane);
    expectedLink = connector.toLane;
  }

  const suffixAt = v.route.indexOf(expectedLink);
  const suffix = suffixAt >= 0 ? v.route.slice(suffixAt + 1) : [];
  v.route = [...prefix, ...suffix];
  // `repairRoute` deliberately reconstructs connector routes from scratch, so
  // invoking it while physically inside one would discard the pinned chain.
  if (lane.kind === 'link') repairRoute(w, v);
  return true;
}

export { DT };
