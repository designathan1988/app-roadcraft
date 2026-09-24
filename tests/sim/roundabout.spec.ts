import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { simOf } from './support/bodies';

/**
 * A ROUNDABOUT DRAWN AS A RING OF STREETS.
 *
 * The editor has no roundabout tool; a player draws one as a polygon of short
 * one-way streets with arms. It locked solid within a minute and not one
 * vehicle left it in five: the ring bends at every node, so nothing there was
 * a straight-on movement, and
 *
 *   - lane pairing treated every bend as a turn and merged the circulating
 *     carriageway's two lanes into one at every node (`carriedPair` in
 *     `world/lanelets.ts`);
 *   - nothing was the priority road, and a place freed on the ring went to
 *     whoever had asked first, so the arms filled the ring as fast as it
 *     emptied (`outranksForExit` in `sim/intersections/admission.ts`).
 */

function ring(oneWay: boolean): RoadDoc {
  const doc = new RoadDoc();
  const R = 90;
  const nodes = Array.from({ length: 8 }, (_, i) =>
    doc.addNode({ x: R * Math.cos((i * Math.PI) / 4), y: R * Math.sin((i * Math.PI) / 4) }));
  for (let i = 0; i < 8; i++) {
    const s = doc.addSegment(nodes[i]!.id, nodes[(i + 1) % 8]!.id, 1)!;
    // Counter-clockwise: right-hand traffic.
    if (oneWay) doc.setSegmentDirection(s.id, 'aToB');
  }
  for (const i of [0, 2, 4, 6]) {
    const n = nodes[i]!;
    const far = doc.addNode({ x: n.x * 5, y: n.y * 5 });
    doc.addSegment(n.id, far.id, 1);
  }
  return doc;
}

function run(doc: RoadDoc, seconds: number): { left: number; worstStill: number } {
  const sim = simOf(doc, 0x5eed, 2);
  const seen = new Set<number>();
  const still = new Map<number, number>();
  let worstStill = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    step(sim, { traffic: true, pedestrians: false });
    sim.clock.tick++;
    for (const v of sim.vehicles.values()) {
      seen.add(v.id);
      const held = v.v < 0.2 ? (still.get(v.id) ?? 0) + DT : 0;
      still.set(v.id, held);
      worstStill = Math.max(worstStill, held);
    }
  }
  return { left: seen.size - sim.vehicles.size, worstStill };
}

describe('a ring of one-way streets with four arms', () => {
  it('keeps moving under heavy demand', () => {
    const { left, worstStill } = run(ring(true), 300);
    // Before: 0 vehicles left the ring in 300 s, and the whole fleet stood
    // still from the first minute on.
    expect(left).toBeGreaterThan(30);
    expect(worstStill).toBeLessThan(150);
  });
});
