import { m } from '@world/units';
import { PED } from '../params';
import type { SimWorld } from '../world';
import type { Vehicle } from '../vehicles/state';
import type { SidewalkEdge } from '../peds/sidewalk';
import { pedestrianSignalState, signalStateFor } from '../signals/query';
import type { SignalController } from '../signals/fsm';
import { makeCrossingId } from '../signals/plan';
import { reservationCoversCrossing } from '../intersections/crossingSpans';
import { canStopComfortably } from '../vehicles/idm';
import { vehiclePose } from '../pose';

/*
 * Whether somebody may step onto a zebra: the same rule for every pedestrian
 * engine. It reads the signals, the vehicles and the zebra's geometry, and of
 * the person only how long they have waited.
 */

/**
 * Whether a pedestrian may step off the kerb.
 *
 * A pedestrian may only start if it can FINISH. That single rule, combined with
 * the plan-level clearance invariant and with crossing occupancy being a hard
 * conflict resource for vehicles, is what guarantees nobody is ever caught in
 * the road.
 */
export function mayEnterCrossing(w: SimWorld, crossing: SidewalkEdge, waited: number): boolean {
  const node = crossing.node;
  const segment = crossing.segment;
  if (node === undefined || segment === undefined) return true;

  // A signal or accepted gap cannot make an occupied piece of road empty.
  // Check the actual vehicle bodies before either admission path: a car may
  // have stopped partly on the zebra without holding a connector token.
  if (vehicleBodyOnCrossing(w, crossing)) return false;

  const need = crossing.length / PED.designSpeed + PED.startLag;
  const controller = w.controller(node);
  const junction = w.graph.junctions.get(node);
  const id = makeCrossingId(node, segment);

  // Connector admission is also a crossing reservation.  This closes the
  // one-tick race where a car reserved a turn and a pedestrian stepped onto
  // its zebra later in the same simulation tick.
  if (crossingReservedByVehicle(w, node, segment)) return false;

  if (controller && junction?.signalised) {
    const state = pedestrianSignalState(controller, id, crossing.length);
    if (state !== 'walk') return false;
    void need;
    // A car turning over this zebra at its own green, that has waited its
    // share while people kept stepping off in front of it: its turn. The
    // people at the kerb wait for it; those already on the zebra go first.
    if (turnOwedToVehicle(w, node, id, controller)) return false;
    return true;
  }

  // Uncontrolled: accept a gap in the lanes actually being crossed.
  return pedGapAccepted(w, crossing, waited);
}

/**
 * Every vehicle holding or clearing a connector, filed under each
 * `node:segment` that connector touches. Built once per pedestrian stage
 * (`indexReservations`): vehicles do not move while pedestrians step, and the
 * check used to walk the whole fleet - allocating a set per vehicle - for
 * every pedestrian asking to cross, about 0.76 ms of a 6.9 ms tick with 450
 * vehicles (tests/bench). Only the vehicles filed under the crossing asked
 * about are examined now, by exactly the same rules.
 */
const RESERVATIONS = new WeakMap<SimWorld, Map<string, { v: Vehicle; connector: string }[]>>();

export function indexReservations(w: SimWorld): void {
  const index = RESERVATIONS.get(w) ?? new Map<string, { v: Vehicle; connector: string }[]>();
  index.clear();
  RESERVATIONS.set(w, index);
  for (const v of w.vehicles.values()) {
    const lane = w.lanelet(v.lanelet);
    const connectorIds = new Set(v.clearingConnectors.map((token) => token.connector));
    if (v.admittedConnector) connectorIds.add(v.admittedConnector);
    if (lane?.kind === 'connector') connectorIds.add(lane.id);
    for (const connectorId of connectorIds) {
      const connector = w.connector(connectorId);
      if (!connector) continue;
      for (const segment of w.doc.node(connector.node)?.incident ?? []) {
        const key = `${connector.node}:${segment}`;
        const list = index.get(key);
        if (list) list.push({ v, connector: connectorId });
        else index.set(key, [{ v, connector: connectorId }]);
      }
    }
  }
}

function crossingReservedByVehicle(w: SimWorld, node: number, segment: number): boolean {
  for (const { v, connector: connectorId } of RESERVATIONS.get(w)?.get(`${node}:${segment}`) ?? []) {
    const connector = w.connector(connectorId);
    if (!connector || connector.node !== node) continue;
    const span = w.crossingSpans.span(connector.id, `${node}:${segment}`);
    if (reservationCoversCrossing(w, v, connector, segment, span)) return true;
  }
  return false;
}

/**
 * Whether a car at its line, at green, whose movement crosses this zebra has
 * waited longer than `PED_COURTESY` for people stepping off in front of it.
 * Giving way to every new arrival through the whole WALK, a turning car at a
 * busy crossing waited out cycle after cycle - four minutes, measured - and
 * the junction behind it locked.
 */
function turnOwedToVehicle(w: SimWorld, node: NonNullable<SidewalkEdge["node"]>, crossing: string, controller: SignalController): boolean {
  for (const laneId of w.graph.junctions.get(node)?.inbound ?? []) {
    const head = w.laneHead(laneId);
    if (!head || head.admittedConnector || head.waited <= PED_COURTESY) continue;
    const lane = w.lanelet(laneId);
    if (!lane || lane.length - head.s > m(8)) continue;
    const conn = head.route[1] ? w.connector(head.route[1]) : undefined;
    if (!conn || conn.node !== node) continue;
    if (w.crossingSpans.span(conn.id, crossing as never) === null) continue;
    if (signalStateFor(controller, conn.group) !== 'green') continue;
    return true;
  }
  return false;
}

/** Seconds a car stands at a zebra giving way to people arriving at its kerb before it is its turn. */
export const PED_COURTESY = 8;

/**
 * Gap acceptance against approaching traffic on the lanes being crossed.
 *
 * At an uncontrolled zebra the pedestrian has priority once on it: admission
 * refuses every movement over an occupied crossing (`crossingBusy`). So the
 * question is not "is the road empty for the whole time I need to cross" —
 * with a crossing of forty units that demanded a seventeen-second gap and
 * held people at the kerb for three minutes — but "can everything coming
 * stop for me, and is nothing about to arrive regardless".
 */
export function pedGapAccepted(w: SimWorld, crossing: SidewalkEdge, waited: number): boolean {
  const impatience = Math.min(1.5, 0.05 * waited);
  const critical = Math.max(2.5, PED.criticalGap - impatience);

  for (const laneId of crossing.lanes ?? []) {
    const lane = w.lanelet(laneId);
    if (!lane || lane.to !== crossing.node) continue;
    const head = w.laneHead(laneId);
    if (!head) continue;
    // A vehicle standing at its line is not arriving. It has no admission
    // (`vehicleBodyOnCrossing` and `crossingReservedByVehicle` already refused
    // this crossing if it physically occupied or reserved it),
    // and admission will not grant it one while somebody is on the zebra.
    // Treating it as arriving at walking pace — distance over 0.5 u/s — kept
    // pedestrians at uncontrolled kerbs for over three minutes behind queues
    // that could not move until they had crossed.
    if (head.v < 0.5 && !head.admittedConnector) {
      // Its turn: a car that has stood at the zebra this long while people
      // kept stepping off in front of it goes next. On a busy pavement one
      // walker after another arrived and the car gave way to each - over a
      // minute at a bend. Whoever is on the zebra still goes first.
      if (head.waited > PED_COURTESY) return false;
      continue;
    }
    const distance = lane.length - head.s;
    const arrival = distance / Math.max(head.v, 0.5);
    if (arrival < critical || !canStopComfortably(head.driver, head.v, distance)) return false;
  }
  return true;
}

/** An approach vehicle's body can reach a zebra even without an admission token. */
function vehicleBodyOnCrossing(w: SimWorld, crossing: SidewalkEdge): boolean {
  for (const laneId of crossing.lanes ?? []) {
    const lane = w.lanelet(laneId);
    if (!lane || lane.to !== crossing.node) continue;
    for (const body of w.bodiesIn(laneId)) {
      if (vehicleBodyIntersectsCrossing(w, body.vehicle, crossing)) return true;
    }
  }
  return false;
}

export function vehicleBodyIntersectsCrossing(w: SimWorld, vehicle: Vehicle, crossing: SidewalkEdge): boolean {
  const pose = vehiclePose(w, vehicle, 1);
  if (!pose) return false;
  const first = crossing.path.point(0);
  const last = crossing.path.point(crossing.path.n - 1);
  const ux = Math.cos(pose.angle), uy = Math.sin(pose.angle);
  const toBody = (x: number, y: number): { along: number; across: number } => {
    const dx = x - pose.p.x, dy = y - pose.p.y;
    return { along: dx * ux + dy * uy, across: -dx * uy + dy * ux };
  };
  const a = toBody(first.x, first.y), b = toBody(last.x, last.y);
  let lo = 0, hi = 1;
  const clip = (start: number, end: number, extent: number): boolean => {
    const delta = end - start;
    if (Math.abs(delta) < 1e-9) return Math.abs(start) <= extent;
    const t0 = (-extent - start) / delta, t1 = (extent - start) / delta;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
    return lo <= hi;
  };
  return clip(a.along, b.along, vehicle.archetype.length / 2 + m(0.3)) &&
    clip(a.across, b.across, vehicle.archetype.width / 2 + m(0.3));
}
