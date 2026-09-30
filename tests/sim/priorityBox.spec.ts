import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { simOf } from './support/bodies';

/**
 * DON'T BLOCK THE BOX AT A JUNCTION WITHOUT SIGNALS EITHER.
 *
 * Two side streets join a street 120 units apart. A car waiting at the second
 * junction to turn off holds its lane just as a red does, and the queue behind
 * it reaches back to the first junction. The storage check only placed a queue
 * where it would come to rest - and only debited the cars already crossing
 * towards it - for lanes ending at a signal; here it counted the last car's
 * current rear, the rolling cars ahead let the next one in, and it stood in
 * the first junction's box.
 */
function teesOnAStreet(): RoadDoc {
  const doc = new RoadDoc();
  const west = doc.addNode({ x: -500, y: 0 });
  const a = doc.addNode({ x: 0, y: 0 });
  const b = doc.addNode({ x: 120, y: 0 });
  const east = doc.addNode({ x: 500, y: 0 });
  doc.addSegment(west.id, a.id, 1);
  doc.addSegment(a.id, b.id, 1);
  doc.addSegment(b.id, east.id, 1);
  doc.addSegment(doc.addNode({ x: 0, y: 400 }).id, a.id, 0);
  doc.addSegment(doc.addNode({ x: 120, y: -400 }).id, b.id, 0);
  return doc;
}

describe('two priority junctions close together', () => {
  for (const seed of [1, 2, 3]) {
    it(`never leaves a car standing in a junction behind a queue (seed ${seed})`, () => {
      const sim = simOf(teesOnAStreet(), seed, 2);
      const held = new Map<number, number>();
      let stalls = 0;
      for (let i = 0; i < Math.round(300 / DT); i++) {
        step(sim, { traffic: true, pedestrians: true });
        for (const v of sim.vehicles.values()) {
          const inBox = sim.lanelet(v.lanelet)?.kind === 'connector';
          const behindCar = v.constraints.obstacles.some((o) => o.kind === 'vehicle' && o.gap < 8 && o.speed < 0.5);
          const t = inBox && v.v < 0.2 && behindCar ? (held.get(v.id) ?? 0) + DT : 0;
          held.set(v.id, t);
          if (t >= 3 && t < 3 + DT) stalls++;
        }
      }
      expect(stalls).toBe(0);
    });
  }
});
