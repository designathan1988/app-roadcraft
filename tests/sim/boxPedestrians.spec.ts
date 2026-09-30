import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import type { NodeId } from '@world/ids';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { simOf } from './support/bodies';

/**
 * A TURNING CAR IS NOT LEFT STANDING IN THE BOX FOR PEOPLE ON THE EXIT ZEBRA.
 *
 * Two ways in, both measured on a three-by-three grid of streets:
 *
 *  - the pedestrian gate (`crossingReservedByVehicle`) let a walker step onto
 *    the zebra across a car's EXIT leg because the admitted car, still on its
 *    approach, "could stop comfortably before it" - but that zebra is beyond
 *    the box, so the car stopped inside the junction;
 *  - admission (`crossingBusy`) looked a fixed four seconds ahead of people
 *    already on the far half of that zebra, while the car, standing at its
 *    line, needed longer than that to get there. It met them mid-turn.
 *
 * Either way an admitted car stood in the middle of the junction, across every
 * other movement, for five seconds and more.
 */
function grid(): RoadDoc {
  const doc = new RoadDoc();
  const at = new Map<string, NodeId>();
  const node = (x: number, y: number): NodeId => {
    const key = `${x},${y}`;
    let id = at.get(key);
    if (id === undefined) {
      id = doc.addNode({ x, y }).id;
      at.set(key, id);
    }
    return id;
  };
  const stops = [-440, -220, 0, 220, 440];
  for (const fixed of [-220, 0, 220]) {
    for (let k = 0; k + 1 < stops.length; k++) {
      doc.addSegment(node(stops[k] as number, fixed), node(stops[k + 1] as number, fixed), 1);
      doc.addSegment(node(fixed, stops[k] as number), node(fixed, stops[k + 1] as number), 1);
    }
  }
  return doc;
}

describe('pedestrians and turning traffic on a grid of streets', () => {
  it('never holds an admitted car inside a junction for a pedestrian', () => {
    const sim = simOf(grid(), 0x5eed, 2);
    const held = new Map<number, number>();
    let stalls = 0;
    for (let i = 0; i < Math.round(240 / DT); i++) {
      step(sim, { traffic: true, pedestrians: true });
      for (const v of sim.vehicles.values()) {
        const inBox = sim.lanelet(v.lanelet)?.kind === 'connector';
        const forPedestrian = v.constraints.obstacles.some((o) => o.kind === 'pedestrian');
        const t = inBox && v.v < 0.2 && forPedestrian ? (held.get(v.id) ?? 0) + DT : 0;
        held.set(v.id, t);
        if (t >= 3 && t < 3 + DT) stalls++;
      }
    }
    expect(stalls).toBe(0);
  });
});
