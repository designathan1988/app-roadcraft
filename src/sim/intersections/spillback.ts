import type { NodeId } from '@world/ids';
import type { Connector } from '@world/lanelets';
import { CONVOY_ROLLING, JAM_GAP } from '../params';
import type { Vehicle } from '../vehicles/state';
import type { SimWorld } from '../world';

/**
 * Don't-block-the-box, measured from real occupancy.
 *
 * This function replaces the single worst defect in the V6 monolith. Its
 * version was:
 *
 *   storage = downstreamStop - entryDistance - vehicleLength * 0.5
 *   if (downstreamControlled && storage < 0) return unavailable
 *
 * With both setbacks collapsing to `0.38 * L` on a link between two junctions,
 * that reduces to `storage = 0.24 * L - length / 2`, which is negative whenever
 * `L < length / 0.48` — 20 units for a sedan, 32 for a truck. Every link
 * shorter than that was PERMANENTLY impassable: nobody entered, the queue never
 * drained, and cars sat on a green forever while the network deadlocked. The
 * geometry also created such links automatically, since splitting a segment
 * near an existing node produces short stubs.
 *
 * Two properties make the replacement safe.
 *
 * First, the quantity is measured free space, not a formula of setbacks. There
 * is no term that scales with `L` in a way that can go negative.
 *
 * Second, an EMPTY outbound lane always accepts a vehicle, unconditionally. A
 * vehicle can legitimately be part-way into a junction while its nose is on the
 * next link, so refusing entry to an empty lane is never physically justified —
 * and it is exactly the refusal that wedged the old engine. This single line is
 * what makes the deadlock-freedom argument hold for every geometry the editor
 * can produce, not just for links above some threshold.
 */
export function hasDownstreamStorage(w: SimWorld, v: Vehicle, conn: Connector): boolean {
  const rt = w.rt(conn.toLane);

  // Admission runs before integration. A vehicle already granted this same
  // movement can therefore still be on the approach or inside the connector,
  // even though it will consume the outbound lane a few ticks later. Counting
  // only vehicles whose noses have crossed the lane boundary lets a following
  // convoy member see phantom free space and stop with its rear in the box.
  const committed = [...w.vehicles.values()].filter((other) =>
    other.id !== v.id &&
    (other.lanelet === conn.id || other.admittedConnector === conn.id),
  );

  const out = w.lanelet(conn.toLane);

  // A physically empty lane with nobody on the way into it always accepts.
  // This remains unconditional so pathological short links cannot become
  // permanently impassable.
  //
  // It used to accept whatever was on the way as well. Between two signalised
  // junctions a car length apart, the 25-unit link was empty whenever its last
  // car had just left, and three cars in a row were admitted into room for
  // one: the first two filled the link against the far red, and the third
  // stopped inside the junction it had been let into, across every other
  // movement there, for a whole phase. Seven times in five minutes. An empty
  // lane with cars already crossing towards it has only what they leave.
  //
  // Only towards a signal, which is what holds a short link full for a whole
  // phase. Towards a junction the stream normally flows on through - a ring
  // of short links, a road bending at a node - the old rule stays: metering
  // those a car at a time halved the flow round a ring and let it lock.
  if (rt.order.length === 0) {
    if (!committed.length || !out || !endsAtSignal(w, out.to)) return true;
    let room = out.length;
    for (const other of committed) room -= other.archetype.length + Math.max(JAM_GAP, other.driver.s0);
    return room >= v.archetype.length + Math.max(JAM_GAP, v.driver.s0);
  }

  if (!out) return false;

  // Free space runs from the lane entry to the rear bumper of its last vehicle.
  const tailId = rt.order[0];
  const tail = tailId === undefined ? undefined : w.veh(tailId);
  let free = tail ? tail.s - tail.archetype.length : out.length;
  if (endsAtSignal(w, out.to)) {
    // Towards a signal a rolling tail is not discharging: it is rolling up to
    // whatever holds it, very often the red. Counting its CURRENT rear, and
    // not debiting the cars already crossing towards it, let a third car into
    // a 25-unit link that a rolling motorcycle and the car behind it were
    // about to fill, and it stood inside the junction it had been let into.
    // So the queue is placed where it will come to rest, and every car
    // committed to the lane is debited from that, rolling tail or not.
    free = Math.min(out.length, restingRear(w, rt.order));
    for (const other of committed) {
      free -= other.archetype.length + Math.max(JAM_GAP, other.driver.s0);
    }
  } else if (tail && tail.v <= CONVOY_ROLLING) {
    // A rolling tail is discharging and the existing convoy rules keep its
    // followers moving. A stopped tail is a real queue: every car already in
    // the connector must be debited before another one is allowed into the box.
    for (const other of committed) {
      free -= other.archetype.length + Math.max(JAM_GAP, other.driver.s0);
    }
  }
  // A refuge must still contain the whole vehicle when IDM stops it at its own
  // standstill gap. Trucks have s0 > the fleet-wide jam gap; using JAM_GAP
  // alone made a 30-unit lane look safe while the truck rear remained in the
  // previous junction forever.
  return free >= v.archetype.length + Math.max(JAM_GAP, v.driver.s0);
}

/**
 * Where the rear of the last vehicle on a lane will come to rest.
 *
 * Walked from the front of the queue: each vehicle stops at the nearest
 * standing obstacle ahead of it (a red, a car standing beyond the lane) or at
 * its standstill gap behind the resting rear of the one in front, whichever is
 * nearer. A vehicle already standing stays where it is. Infinite when the
 * whole lane is on its way out.
 */
function restingRear(w: SimWorld, order: readonly number[]): number {
  let limit = Infinity;
  let rear = Infinity;
  for (let i = order.length - 1; i >= 0; i--) {
    const v = w.veh(order[i] as number);
    if (!v) continue;
    const own = v.v <= CONVOY_ROLLING ? v.s : v.s + standingReach(v);
    const nose = Math.max(v.s, Math.min(own, limit));
    rear = nose - v.archetype.length;
    limit = rear - Math.max(JAM_GAP, v.driver.s0);
  }
  return rear;
}

/**
 * How much further a vehicle will go before something standing still holds
 * it: the nearest obstacle ahead that is not moving away. Infinite when
 * nothing ahead is standing.
 */
function standingReach(v: Vehicle): number {
  let reach = Infinity;
  for (const o of v.constraints.obstacles) {
    if (o.speed > CONVOY_ROLLING) continue;
    reach = Math.min(reach, Math.max(0, o.gap));
  }
  return reach;
}

/** Whether a lane ends at a signalised junction. */
function endsAtSignal(w: SimWorld, node: NodeId | undefined): boolean {
  if (node === undefined) return false;
  return w.graph.junctions.get(node)?.signalised ?? false;
}
