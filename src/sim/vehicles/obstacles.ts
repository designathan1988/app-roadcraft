import type { SimWorld } from '../world';
import type { Vehicle } from './state';
import type { ConstraintSet } from './idm';
import { divergeObstacle, findLeader } from './leaderIndex';
import { signalStateFor } from '../signals/query';
import { mustStopAtSignal } from '../signals/permission';
import { nextConnector } from '../intersections/admission';

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
        const mustStop = mustStopAtSignal(
          state,
          conn.turn,
          v.rorCredit,
          v.driver,
          v.v,
          dStop,
        );
        if (mustStop) {
          constraints.obstacles.push({ gap: dStop, speed: 0, kind: 'signal' });
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
