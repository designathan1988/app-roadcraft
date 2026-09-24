import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { simOf } from './support/bodies';

/**
 * DON'T BLOCK THE BOX, BETWEEN TWO CLOSE JUNCTIONS.
 *
 * Two side streets join an avenue fifty units apart, one from each side: two
 * signalised T junctions with a link of 25 units between them, room for one
 * car per lane. The storage check let a car into the first junction because
 * the last car on that link was still ROLLING - "discharging" - and did not
 * count the cars already committed to the same link. The rolling car was
 * rolling up to the second junction's red. So two cars were admitted into
 * room for one, and the second stopped inside the first junction, across the
 * paths of every other movement there, for a whole red phase: `staleClaim`,
 * seven times in five minutes.
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

describe('two signalised junctions a car length apart', () => {
  it('never admits a car it has no room for', () => {
    const sim = simOf(closeTees(), 0x5eed, 2);
    sim.auditEnabled = true;
    let stuckInBox = 0;
    const still = new Map<number, number>();
    for (let i = 0; i < Math.round(300 / DT); i++) {
      step(sim, { traffic: true, pedestrians: true });
      sim.clock.tick++;
      for (const v of sim.vehicles.values()) {
        const inBox = sim.lanelet(v.lanelet)?.kind === 'connector';
        const held = inBox && v.v < 0.2 ? (still.get(v.id) ?? 0) + DT : 0;
        still.set(v.id, held);
        // Counted once per vehicle, on the tick it crosses ten seconds.
        if (held >= 10 && held < 10 + DT) stuckInBox++;
      }
    }
    expect(stuckInBox).toBe(0);
    expect(sim.issues.filter((x) => x.code === 'staleClaim')).toEqual([]);
  });
});
