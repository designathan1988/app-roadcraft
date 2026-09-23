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

  // A physically empty lane always accepts the moving convoy. This remains
  // unconditional so pathological short links cannot become permanently
  // impassable. The phantom-space bug only exists when a downstream queue is
  // already present and another vehicle is crossing toward the same refuge.
  if (rt.order.length === 0) return true;

  const out = w.lanelet(conn.toLane);
  if (!out) return false;

  // Free space runs from the lane entry to the rear bumper of its last vehicle.
  const tailId = rt.order[0];
  const tail = tailId === undefined ? undefined : w.veh(tailId);
  let free = tail ? tail.s - tail.archetype.length : out.length;
  // A rolling tail is discharging and the existing convoy rules keep its
  // followers moving. A stopped tail is a real queue: every car already in
  // the connector must be debited before another one is allowed into the box.
  if (tail && tail.v <= CONVOY_ROLLING) {
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
