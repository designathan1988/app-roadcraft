import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import type { SimWorld } from '@sim/world';
import { simOf } from './support/bodies';

/**
 * NOBODY PARKS ACROSS TWO LANES.
 *
 * A car stops at the kerb to let somebody out. The car behind it, queued a
 * jam gap behind, pulled out to pass - and a lane change is a curve driven
 * over road: until its body was clear of the old lane it still followed the
 * stopped car, so it got a body length sideways and stopped there, across
 * both lanes, blocking the one it had moved into as well, for as long as the
 * kerb stop lasted. The same happened moving into a lane beside a queue that
 * was rolling up to a red. Measured on an avenue with kerb stops, before:
 * 43 such stalls in six five-minute runs, one of them 93 s long.
 *
 * Now a change is only started when the body can get out of the old lane
 * before whatever will be standing there stops it (`canLeaveLane`), a driver
 * stopping behind a car at the kerb leaves room to pull out round it
 * (`pullOutRoom`), and a body already clear of the car ahead in the old lane
 * is no longer held by it (`shadowLeaderObstacle`).
 */
function avenue(withSignal: boolean): RoadDoc {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -900, y: 0 });
  const b = doc.addNode({ x: 900, y: 0 });
  if (!withSignal) {
    doc.addSegment(a.id, b.id, 2);
    return doc;
  }
  const m = doc.addNode({ x: 500, y: 0 });
  doc.addSegment(a.id, m.id, 2);
  doc.addSegment(m.id, b.id, 2);
  doc.addSegment(m.id, doc.addNode({ x: 500, y: 400 }).id, 1);
  doc.addSegment(m.id, doc.addNode({ x: 500, y: -400 }).id, 1);
  return doc;
}

/** Vehicles stood still, part way through a lane change, for three seconds or more. */
function stallsAcross(sim: SimWorld, seconds: number): number {
  const across = new Map<number, number>();
  let stalls = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    step(sim, { traffic: true, pedestrians: true });
    sim.clock.tick++;
    for (const v of sim.vehicles.values()) {
      const stuck = (Math.abs(v.lateral) > 0.05 || v.shadow !== null) && v.v < 0.2;
      const t = stuck ? (across.get(v.id) ?? 0) + DT : 0;
      across.set(v.id, t);
      if (t >= 3 && t < 3 + DT) stalls++;
    }
  }
  return stalls;
}

describe('traffic passing a car stopped at the kerb', () => {
  it('never stands across two lanes on a straight avenue', () => {
    // Before: 9 stalls in 300 s with this seed.
    expect(stallsAcross(simOf(avenue(false), 11, 2), 300)).toBe(0);
  });

  it('never stands across two lanes on an avenue queueing at a signal', () => {
    // Before: 11 stalls in 300 s with this seed, the longest 78 s.
    expect(stallsAcross(simOf(avenue(true), 22, 2), 300)).toBe(0);
  });
});
