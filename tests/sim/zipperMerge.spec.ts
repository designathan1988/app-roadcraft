import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { collisions, simOf } from './support/bodies';

/**
 * TWO LANES INTO ONE ZIP.
 *
 * An avenue narrowing into a street merges its two lanes into one at the
 * taper. The merge zone was claimed by one car at a time until its body had
 * left the junction, and a stream from one lane kept it for as long as it kept
 * rolling (each follower joined the claim ahead of it), so the head of the
 * other lane stood at the taper for over twenty seconds. Now the car nearer
 * the shared lane is FOLLOWED across movements (`mergeObstacle`), the next
 * car may merge in behind it (`mergeFollows`), and the lanes take turns
 * (`zipperHolds`).
 */
function laneDrop(): RoadDoc {
  const doc = new RoadDoc();
  const west = doc.addNode({ x: -700, y: 0 });
  const narrow = doc.addNode({ x: -100, y: 0 });
  const widen = doc.addNode({ x: 250, y: 0 });
  const east = doc.addNode({ x: 700, y: 0 });
  doc.addSegment(west.id, narrow.id, 2);
  doc.addSegment(narrow.id, widen.id, 1);
  doc.addSegment(widen.id, east.id, 2);
  return doc;
}

describe('an avenue narrowing into a street', () => {
  it('lets the two lanes into the merge in turn, without touching', () => {
    const sim = simOf(laneDrop(), 0x5eed, 2);
    let worstHeld = 0;
    let overlaps = 0;
    const held = new Map<number, number>();
    for (let i = 0; i < Math.round(300 / DT); i++) {
      step(sim, { traffic: true, pedestrians: false });
      sim.clock.tick++;
      if (i % 5 === 0) overlaps += collisions(sim).length;
      for (const [node, junction] of sim.graph.junctions) {
        if (sim.doc.node(node)?.incident.length !== 2) continue;
        for (const lane of junction.inbound) {
          const head = sim.laneHead(lane);
          if (!head) continue;
          const kinds = head.constraints.obstacles.map((o) => o.kind);
          // Held by the merge itself, not by a full street beyond it.
          const byMerge = head.v < 0.2 && kinds.includes('conflict') && !kinds.includes('spillback');
          const t = byMerge ? (held.get(head.id) ?? 0) + DT : 0;
          held.set(head.id, t);
          worstHeld = Math.max(worstHeld, t);
        }
      }
    }
    expect(overlaps).toBe(0);
    expect(worstHeld).toBeLessThan(12);
  });
});
