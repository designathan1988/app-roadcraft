import type { LaneletId } from '@world/lanelets';
import type { SimWorld } from '../world';
import type { Vehicle } from './state';
import { canStopComfortably, type Obstacle } from './idm';
import { bodyClassOfArchetype } from './archetypes';
import { pullOutRoom } from './laneChange';

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
 *
 * Two kinds of body are in a lane without being in its occupancy list, and
 * both used to be driven into:
 *
 *   - a vehicle sliding OUT of the lane after a lane change (its `shadow`);
 *   - a vehicle that left the same stop line on a DIFFERENT movement and whose
 *     body still sweeps the shared start of both turns (`divergeObstacle`).
 */
export function findLeader(w: SimWorld, v: Vehicle): Obstacle | null {
  const rt = w.rt(v.lanelet);
  const idx = rt.order.indexOf(v.id);
  let best: Obstacle | null = null;
  const consider = (o: Obstacle): void => {
    if (!best || o.gap < best.gap) best = o;
  };

  // Ahead in the same lane: the list is ascending by arc position.
  if (idx >= 0 && idx + 1 < rt.order.length) {
    const aheadId = rt.order[idx + 1];
    const lead = aheadId === undefined ? undefined : w.veh(aheadId);
    if (lead) {
      // Stopped at the kerb: hold back far enough to pull out round it - when
      // there is still room to stop there in comfort. A car already closer
      // than that follows the real gap: the hold point used to be a gap of
      // minus eight metres, and the safe speed stopped the car dead in one
      // tick (audit P1-47).
      const standing = lead.kerbStop && lead.kerbStop.phase !== 'approach' ? pullOutRoom(w, v) : 0;
      const real = lead.s - lead.archetype.length - v.s;
      const hold = real - Math.max(0, standing - Math.max(v.driver.s0, 0));
      consider({
        gap: hold < real && canStopComfortably(v.driver, v.v, hold - v.driver.s0) ? hold : real,
        speed: lead.v,
        accel: lead.accel,
        kind: 'vehicle',
      });
    }
  }
  for (const shadow of shadowsAhead(w, v.lanelet, v.s, v.id)) {
    consider({ gap: shadow.rear - v.s, speed: shadow.vehicle.v, accel: shadow.vehicle.accel, kind: 'vehicle' });
  }
  if (best) return best;

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
      consider({
        gap: dist + tail.s - tail.archetype.length,
        speed: tail.v,
        accel: tail.accel,
        kind: 'vehicle',
      });
    }
    for (const shadow of shadowsAhead(w, nextId, -Infinity, v.id)) {
      consider({ gap: dist + shadow.rear, speed: shadow.vehicle.v, accel: shadow.vehicle.accel, kind: 'vehicle' });
    }
    if (best) return best;
    const lanelet = w.lanelet(nextId);
    if (!lanelet) break;
    dist += lanelet.length;
  }

  return null;
}

/** Rears of bodies sliding out of a lane, ahead of `s` on it. */
function shadowsAhead(
  w: SimWorld,
  laneId: LaneletId,
  s: number,
  self: number,
): { vehicle: Vehicle; rear: number }[] {
  const out: { vehicle: Vehicle; rear: number }[] = [];
  for (const id of w.rt(laneId).shadows) {
    if (id === self) continue;
    const other = w.veh(id);
    if (!other?.shadow || other.shadow.lanelet !== laneId) continue;
    const front = other.s + other.shadow.offset;
    if (front <= s) continue;
    out.push({ vehicle: other, rear: front - other.archetype.length });
  }
  return out;
}

/**
 * The body of a vehicle that took a DIFFERENT movement out of the same lane,
 * while it still sweeps the start this vehicle's movement shares with it.
 *
 * Two turns leaving one stop line coincide at the line and part a few metres
 * later. Car-following only looked down its own connector, so once the leader
 * had turned onto the other one it vanished from view with its tail still on
 * the approach: measured in seeded traffic, 33 followers drove into such a
 * tail. `ConflictIndex.diverges` says, per pair and size, how far the leader's
 * centre has to get before the two bodies can no longer touch; until then its
 * rear is followed like any other leader's, projected onto the shared start.
 */
export function divergeObstacle(w: SimWorld, v: Vehicle): Obstacle | null {
  const here = w.lanelet(v.lanelet);
  if (!here) return null;

  let connectorId: LaneletId | undefined;
  let offset: number;
  if (here.kind === 'connector') {
    connectorId = here.id;
    offset = -v.s;
  } else {
    // Only the vehicle nearest the stop line needs this; everyone behind it
    // follows it.
    if (w.laneHead(here.id)?.id !== v.id) return null;
    connectorId = v.route[1];
    offset = here.length - v.s;
    const horizon = Math.max(50, v.v * v.driver.T * 3 + (v.v * v.v) / (2 * v.driver.b));
    if (offset > horizon) return null;
  }
  if (connectorId === undefined) return null;
  const siblings = w.conflicts.divergesOf(connectorId);
  if (!siblings.length) return null;

  const mine = bodyClassOfArchetype(v.archetype);
  let best: Obstacle | null = null;
  for (const d of siblings) {
    const other = w.connector(d.other);
    if (!other) continue;
    const candidates: { vehicle: Vehicle; front: number }[] = [];
    for (const id of w.rt(other.id).order) {
      const o = w.veh(id);
      if (o) candidates.push({ vehicle: o, front: o.s });
    }
    // Bodies whose front is already on the exit lane but whose tail may not be.
    for (const id of w.rt(other.toLane).order) {
      const o = w.veh(id);
      if (o && o.rearPath[0] === other.id) candidates.push({ vehicle: o, front: other.length + o.s });
    }
    for (const { vehicle: o, front } of candidates) {
      if (o.id === v.id) continue;
      const centre = front - o.archetype.length / 2;
      if (centre > d.otherExit(bodyClassOfArchetype(o.archetype), mine)) continue;
      // Whoever is further along the shared start leads.
      if (here.kind === 'connector' && front <= v.s) continue;
      const gap = offset + front - o.archetype.length;
      if (!best || gap < best.gap) best = { gap, speed: o.v, kind: 'vehicle' };
    }
  }
  return best;
}

/** Sideways clearance kept from a body in the lane being left, world units. */
const SHADOW_SIDE_MARGIN = 0.4;

/**
 * A vehicle mid-lane-change is itself an obstacle for its OWN forward motion
 * against whatever it still overlaps in the lane it is leaving.
 *
 * The occupancy index switches lanes on the transfer tick, so from that
 * instant `findLeader` only sees the NEW lane; nothing gated the vehicle's
 * own acceleration against a body still sitting in the OLD lane, at the
 * position the drawn body was still sweeping. That was invisible while the
 * slide was near-instant (`LATERAL_CLOSE_RATE`), because the overlap window
 * was under a second. Easing the slide to a believable three seconds
 * (`laneChangeOffset`) widened that window enough for a vehicle to drive its
 * own body into a leader — commonly a queued vehicle — it could no longer
 * see, because its forward motion only ever looked at the lane it had
 * already, administratively, left.
 */
export function shadowLeaderObstacle(w: SimWorld, v: Vehicle): Obstacle | null {
  if (!v.shadow) return null;
  const front = v.s + v.shadow.offset;
  // How far the FRONT of this body still reaches back towards the old lane's
  // centre - the front is what drives into a leader. The lanes are
  // `2 * clearAt` apart (`integrate.ts`) and the body centre is `lateral`
  // short of the new centre; the body points into the new lane, so its front
  // corners are carried further across by half its length, while the rear
  // corner is the one still swinging over the line.
  const spacing = 2 * v.shadow.clearAt;
  const angle = Math.atan(Math.abs(v.lateralSlope));
  const nearEdge = spacing - Math.abs(v.lateral) +
    (v.archetype.length / 2) * Math.sin(angle) - (v.archetype.width / 2) * Math.cos(angle);
  let best: Obstacle | null = null;
  for (const body of w.bodiesIn(v.shadow.lanelet)) {
    if (body.vehicle.id === v.id) continue;
    // Only a body this one can still touch. A car already most of the way
    // across is clear of the car in front in the old lane, and holding it
    // there - as if its whole body were still in that lane - is how a car
    // stood across both lanes behind a car stopped at the kerb, for as long
    // as that car stood.
    const reach = body.vehicle.archetype.width / 2 + Math.abs(body.vehicle.lateral) + SHADOW_SIDE_MARGIN;
    if (nearEdge >= reach) continue;
    const rear = body.s - body.vehicle.archetype.length;
    const gap = rear - front;
    if (gap < -v.archetype.length) continue; // already well behind: not a leader.
    if (!best || gap < best.gap) best = { gap, speed: body.vehicle.v, kind: 'vehicle' };
  }
  return best;
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
