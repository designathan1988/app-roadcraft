import type { SimWorld } from '../world';
import type { Vehicle } from './state';
import { canStopComfortably, type ConstraintSet, type Obstacle } from './idm';
import { PED_CROSSING_STOP_BUFFER, pedestrianInSpan } from '../intersections/crossingSpans';
import { divergeObstacle, findLeader, shadowLeaderObstacle } from './leaderIndex';
import { signalStateFor } from '../signals/query';
import { signalHolds } from '../signals/permission';
import { mergeRemaining, nextConnector } from '../intersections/admission';
import { kerbStopObstacle } from './kerbStops';

/** Stop short of a zebra span somebody is on; null when the path is clear. */
function pedestrianAhead(w: SimWorld, v: Vehicle): Obstacle | null {
  const lane = w.lanelet(v.lanelet);
  if (!lane) return null;
  let connectorId: string | undefined;
  let offset: number;
  if (lane.kind === 'connector') {
    connectorId = lane.id;
    offset = -v.s;
  } else if (v.admittedConnector) {
    connectorId = v.admittedConnector;
    offset = lane.length - v.s;
  } else if (v.route[0] === lane.id && v.route[1] !== undefined && w.connector(v.route[1])) {
    // Not admitted yet: the turn it plans. Whether somebody is on the zebra
    // does not depend on the grant, and a stop that came and went with it
    // had a car creep up to the line and snap to a halt every 0.4 s.
    connectorId = v.route[1];
    offset = lane.length - v.s;
  } else {
    return null;
  }
  const conn = w.connector(connectorId);
  if (!conn) return null;
  let best: Obstacle | null = null;
  for (const segment of w.doc.node(conn.node)?.incident ?? []) {
    const span = pedestrianInSpan(w, conn.id, `${conn.node}:${segment}`);
    if (!span) continue;
    // While still on a link, keep the whole vehicle behind the near edge of
    // any zebra on the planned turn. The connector span begins later, inside
    // the junction; stopping at that distance left a car beside the walker
    // and made both wait for each other inside the crossing. Once the car is
    // on the connector, its measured span governs the stop instead.
    // The margin short of the line is kept while there is room to stop for it
    // in comfort; a car already past that point stops at the line itself
    // rather than being cut to a standstill where it is (audit P1-47).
    const buffered = offset - PED_CROSSING_STOP_BUFFER;
    const gap = lane.kind === 'link'
      ? Math.max(0, canStopComfortably(v.driver, v.v, buffered - v.driver.s0) ? buffered : offset)
      : offset + span.along - PED_STOP_MARGIN;
    // Already over the span: stopping there would park on the zebra. Carry on
    // through; the walker's own clearance keeps them out of a moving body.
    if (gap < 0) continue;
    if (!best || gap < best.gap) best = { gap: Math.max(0, gap), speed: 0, kind: 'pedestrian' };
  }
  return best;
}

/**
 * The vehicle ahead on ANOTHER movement into the lane this one runs into.
 *
 * Car following looks down the vehicle's own route, and two movements that
 * merge only meet on the lane after the junction: a car on the other one was
 * invisible until both had left it, and a merge zone had to be held by one car
 * at a time for the whole junction to keep them apart. Measured by the
 * distance each front still has to go to the start of the shared lane - where
 * the two paths end together - the car nearer it is the leader, and its rear
 * is followed like any other. That is what lets `mergeFollows` in admission
 * send the next car in behind it, one from each lane in turn.
 */
function mergeObstacle(w: SimWorld, v: Vehicle): Obstacle | null {
  const lane = w.lanelet(v.lanelet);
  const connectorId = lane?.kind === 'connector' ? lane.id : v.admittedConnector;
  const conn = connectorId ? w.connector(connectorId) : undefined;
  if (!conn) return null;
  const mine = mergeRemaining(w, v, conn);
  if (mine === null) return null;
  const junction = w.graph.junctions.get(conn.node);
  if (!junction) return null;
  let best: Obstacle | null = null;
  for (const otherId of junction.connectors) {
    if (otherId === conn.id) continue;
    const other = w.connector(otherId);
    if (!other || other.toLane !== conn.toLane) continue;
    const consider = (id: number): void => {
      const o = w.veh(id);
      if (!o || o.id === v.id) return;
      const theirs = mergeRemaining(w, o, other);
      if (theirs === null || theirs > mine || (theirs === mine && o.id > v.id)) return;
      const gap = mine - theirs - o.archetype.length;
      if (!best || gap < best.gap) best = { gap: Math.max(0, gap), speed: o.v, kind: 'vehicle' };
    };
    for (const id of w.rt(other.id).order) consider(id);
    for (const id of w.rt(other.fromLane).order) {
      if (w.veh(id)?.admittedConnector === other.id) consider(id);
    }
  }
  return best;
}

/** Extra space left in front of the zebra band (`CrossingSpan.along` already clears it). */
const PED_STOP_MARGIN = 0.5;

/**
 * Turns the world into constraints for one vehicle.
 *
 * Note what is NOT here: no branch that assigns a velocity, no clamp on
 * position, no special case for "inside a junction". A red light is an obstacle
 * at the stop line and nothing more, so green is simply the ABSENCE of that
 * obstacle — the instant a signal turns, the free-flow term of IDM goes
 * positive and the vehicle moves.
 *
 * The V6 monolith instead wrote `v.progress = min(v.progress, turnStart);
 * v.velocity = 0` whenever entry was refused, and computed `turnStart` from a
 * setback that could exceed the segment's own length, pinning vehicles at
 * position zero forever regardless of signal colour (defect 1b). None of that
 * can be expressed here.
 */
export function longitudinalConstraints(w: SimWorld, v: Vehicle): ConstraintSet {
  const constraints: ConstraintSet = { obstacles: [] };

  const leader = findLeader(w, v);
  if (leader) constraints.obstacles.push(leader);

  // A body that left the same stop line on another movement and is still
  // sweeping the start both movements share.
  const diverging = divergeObstacle(w, v);
  if (diverging) constraints.obstacles.push(diverging);

  // A vehicle ahead on another movement into the same lane.
  const merging = mergeObstacle(w, v);
  if (merging) constraints.obstacles.push(merging);

  // A body still overlapping the lane it is sliding out of must not be driven
  // into whatever is still there.
  const shadowLeader = shadowLeaderObstacle(w, v);
  if (shadowLeader) constraints.obstacles.push(shadowLeader);

  // A person on the stretch of a zebra this movement is about to drive over.
  // Admission only asks at the stop line; a walker who reaches the vehicle's
  // path afterwards used to be driven through at full speed.
  const walker = pedestrianAhead(w, v);
  if (walker) constraints.obstacles.push(walker);

  // Pulling in to the kerb to let somebody out or in (`kerbStops.ts`).
  const kerb = kerbStopObstacle(v);
  if (kerb) constraints.obstacles.push(kerb);

  const lane = w.lanelet(v.lanelet);
  if (!lane) return constraints;

  // Distance to the end of the current lanelet. Always non-negative, because
  // the integrator keeps `s <= length`.
  const dStop = Math.max(0, lane.length - v.s);

  if (lane.kind === 'link' && lane.controlled) {
    // A vehicle with an admission token is never held at the stop line.  Some
    // movements have no geometric conflict points, so `claims.length` alone
    // cannot represent admission.
    if (!v.admittedConnector) {
      const conn = nextConnector(w, v);
      const controller = conn ? w.controller(conn.node) : undefined;
      const junction = conn ? w.graph.junctions.get(conn.node) : undefined;

      if (conn && controller && junction?.signalised) {
        const state = signalStateFor(controller, conn.group);
        const adjacentStop = w.crossingSpans.approachStop(lane.id);
        const signalGap = adjacentStop === undefined ? dStop :
          Math.min(dStop, Math.max(0, adjacentStop - v.s));
        // THE DRIVER, not the archetype.
        //
        // `permission.ts` exists so that braking and admission reach the same
        // verdict from the same inputs, and its docblock says as much. This
        // call passed `v.archetype` while both admission call sites passed
        // `v.driver`, and `canStopComfortably` reads `p.b` - which differs by
        // up to +/-22% between the two (driver.b = archetype.b * (1 +
        // aggression * BRAKE_SPREAD)). So for a sizeable slice of the fleet
        // admission could grant a connector on the very amber tick the
        // vehicle decided to stop for, and vice versa.
        const mustStop = signalHolds(v, conn.id, state, conn.turn, signalGap);
        if (mustStop) {
          constraints.obstacles.push({ gap: signalGap, speed: 0, kind: 'signal' });
        }
      }
    }
  }

  // Nowhere left to go: stop at the end of the road rather than vanish
  // mid-lane.
  //
  // The `!lane.controlled` guard that used to be here opened a hole that
  // nothing could see into. A route of length 1 means there is no onward
  // connector at all, so on a CONTROLLED link none of the other branches fire
  // either: `nextConnector` is undefined, so no signal obstacle is pushed, and
  // `stepAdmission` skips the lane outright. The vehicle accelerated into its
  // own stop line and was pinned there by the integrator's clamp at v = 0 -
  // blocking the whole lane, invisible to `greenStall`, to `greenDenied` and
  // to every wedge detector, because all of them need a connector to reason
  // about. Whether the link happens to carry a signal has no bearing on the
  // fact that the road ends here.
  if (v.route.length <= 1 && lane.kind === 'link') {
    constraints.obstacles.push({ gap: dStop, speed: 0, kind: 'endOfRoute' });
  }

  return constraints;
}
