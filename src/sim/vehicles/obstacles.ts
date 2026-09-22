import type { SimWorld } from '../world';
import type { Vehicle } from './state';
import type { ConstraintSet } from './idm';
import { findLeader } from './leaderIndex';
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
        const mustStop = mustStopAtSignal(
          state,
          conn.turn,
          v.rorCredit,
          v.archetype,
          v.v,
          dStop,
        );
        if (mustStop) {
          constraints.obstacles.push({ gap: dStop, speed: 0, kind: 'signal' });
        }
      }
    }
  }

  // Nowhere left to go: stop at the end of the road rather than vanish mid-lane.
  if (v.route.length <= 1 && lane.kind === 'link' && !lane.controlled) {
    constraints.obstacles.push({ gap: dStop, speed: 0, kind: 'endOfRoute' });
  }

  return constraints;
}
