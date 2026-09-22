import type { LaneletId } from '@world/lanelets';
import type { SimWorld } from '../world';
import type { Vehicle } from './state';
import type { Obstacle } from './idm';

/** How many lanelets ahead the leader search will walk. */
const LOOKAHEAD_HOPS = 3;

/**
 * Nearest obstacle ahead, following the vehicle's own planned lanelet sequence.
 *
 * Because a route already includes the CONNECTOR the vehicle will use, looking
 * across a junction is the same loop as looking down a straight — there is no
 * special case, and a vehicle correctly slows for a queue on the far side of a
 * junction before entering it.
 *
 * The V6 monolith rebuilt a full occupancy map from scratch in six different
 * places every frame and scanned all vehicles per lane-head test (defect 5.7).
 * Here each lanelet keeps a sorted occupancy list maintained on entry and exit.
 */
export function findLeader(w: SimWorld, v: Vehicle): Obstacle | null {
  const rt = w.rt(v.lanelet);
  const idx = rt.order.indexOf(v.id);

  // Ahead in the same lane: the list is ascending by arc position.
  if (idx >= 0 && idx + 1 < rt.order.length) {
    const aheadId = rt.order[idx + 1];
    const lead = aheadId === undefined ? undefined : w.veh(aheadId);
    if (lead) {
      return {
        gap: lead.s - lead.archetype.length - v.s,
        speed: lead.v,
        kind: 'vehicle',
      };
    }
  }

  // Head of this lanelet: walk forward along the planned route.
  const here = w.lanelet(v.lanelet);
  if (!here) return null;

  let dist = here.length - v.s;
  const horizon = Math.max(
    50,
    v.v * v.driver.T * 3 + (v.v * v.v) / (2 * v.driver.b),
  );

  const upcoming = upcomingLanelets(w, v, LOOKAHEAD_HOPS);
  for (const nextId of upcoming) {
    if (dist > horizon) return null;
    const nrt = w.rt(nextId);
    const tailId = nrt.order[0];
    const tail = tailId === undefined ? undefined : w.veh(tailId);
    if (tail) {
      return {
        gap: dist + tail.s - tail.archetype.length,
        speed: tail.v,
        kind: 'vehicle',
      };
    }
    const lanelet = w.lanelet(nextId);
    if (!lanelet) break;
    dist += lanelet.length;
  }

  return null;
}

/** The next `n` lanelets on the vehicle's route, excluding the current one. */
export function upcomingLanelets(w: SimWorld, v: Vehicle, n: number): LaneletId[] {
  const out: LaneletId[] = [];
  for (let i = 1; i < v.route.length && out.length < n; i++) {
    const id = v.route[i];
    if (id !== undefined && w.lanelet(id)) out.push(id);
  }
  return out;
}
