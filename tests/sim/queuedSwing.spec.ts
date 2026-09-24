import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { collisions, simOf } from './support/bodies';

/**
 * A BUS TURNING OFF A SHORT LINK, AND THE CAR WAITING BESIDE IT.
 *
 * Two signalised T junctions 50 units apart leave a 25-unit link between them,
 * shorter than a bus. A bus turning right off it still has its rear on the
 * link, swung across the lane beside it, while its front is in the turn - and
 * a car stands in that lane, a few units short of its stop line.
 *
 * The conflict sweep only placed a body where its front had reached the stop
 * line or beyond, so the waiting car was inside no zone at all: nothing held
 * the bus for it, and nothing held it short of the bus. Measured on this map
 * before the fix, with these seeds: a truck over a sedan, a bus over a truck,
 * a truck over a hatch.
 */
function closeTees(): RoadDoc {
  const doc = new RoadDoc();
  const west = doc.addNode({ x: -500, y: 0 });
  const a = doc.addNode({ x: -25, y: 0 });
  const b = doc.addNode({ x: 25, y: 0 });
  const east = doc.addNode({ x: 500, y: 0 });
  doc.addSegment(west.id, a.id, 2);
  doc.addSegment(a.id, b.id, 2);
  doc.addSegment(b.id, east.id, 2);
  doc.addSegment(doc.addNode({ x: -25, y: 400 }).id, a.id, 1);
  doc.addSegment(doc.addNode({ x: 25, y: -400 }).id, b.id, 1);
  return doc;
}

describe('a long vehicle turning off a short link', () => {
  for (const seed of [2, 5, 12]) {
    it(`never lays its body over a car waiting in the next lane (seed ${seed})`, () => {
      const sim = simOf(closeTees(), seed, 2);
      let overlaps = 0;
      for (let i = 0; i < Math.round(300 / DT); i++) {
        step(sim, { traffic: true, pedestrians: true });
        sim.clock.tick++;
        if (i % 5 === 0) overlaps += collisions(sim).length;
      }
      expect(overlaps).toBe(0);
    });
  }
});
