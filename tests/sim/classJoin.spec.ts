import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { simOf } from './support/bodies';

/**
 * A street that simply carries on as a bigger road: an urban street widening
 * into a boulevard at a node of two legs. Players watched the traffic stand
 * still there. The two boulevard lanes merge into the street's one; a car had
 * started a lane change it could not finish before the line and stopped with
 * its body - by then entirely in its new lane - still counted in the old one,
 * and the car admitted to the merge from that old lane waited behind the
 * phantom while the phantom waited for the merge. Measured over five minutes
 * before the fix: cars stood for 106 s at a time and 44 got through the merge;
 * after it, 25 s and 74. A plain street join of the same shape stands 17 s.
 */
function join(pedestrians: boolean): { worstStill: number; eastbound: number; westbound: number } {
  const doc = new RoadDoc();
  const west = doc.addNode({ x: -600, y: 0 });
  const middle = doc.addNode({ x: 0, y: 0 });
  const bend = (20 * Math.PI) / 180;
  const east = doc.addNode({ x: Math.cos(bend) * 600, y: Math.sin(bend) * 600 });
  const street = doc.addSegment(west.id, middle.id, 1)!;
  const boulevard = doc.addSegment(middle.id, east.id, 3)!;
  const sim = simOf(doc, 7, 2);

  const still = new Map<number, number>();
  const last = new Map<number, number | undefined>();
  let worstStill = 0;
  let eastbound = 0;
  let westbound = 0;
  sim.clock.run(Math.round(300 / DT), () => {
    step(sim, { traffic: true, pedestrians });
    for (const v of sim.vehicles.values()) {
      const held = v.v < 0.05 ? (still.get(v.id) ?? 0) + DT : 0;
      still.set(v.id, held);
      worstStill = Math.max(worstStill, held);
      const segment = sim.graph.lanelets.get(v.lanelet)?.segment;
      const before = last.get(v.id);
      if (segment !== undefined && before !== undefined && segment !== before) {
        if (before === street.id && segment === boulevard.id) eastbound++;
        if (before === boulevard.id && segment === street.id) westbound++;
      }
      if (segment !== undefined) last.set(v.id, segment);
    }
  });
  return { worstStill, eastbound, westbound };
}

describe('a street carrying on as a boulevard', () => {
  it('never stands a car still for long, with people crossing', () => {
    const result = join(true);
    expect(result.worstStill).toBeLessThan(45);
    expect(result.eastbound).toBeGreaterThan(20);
    // Into the merge: 44 in five minutes before the fix, 74 after.
    expect(result.westbound).toBeGreaterThan(55);
  });
});
