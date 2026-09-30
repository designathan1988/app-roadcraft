import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { simOf } from './support/bodies';
import { Network } from '@world/network';
import { findAnchor, type Anchor } from '@editor/snap';
import { commitDraft } from '@editor/commit';

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

/** The same ring drawn through the editor, as a player draws it. */
function drawnRing(): RoadDoc {
  const doc = new RoadDoc();
  const net = new Network(doc);
  net.rebuild();
  const draw = (from: { x: number; y: number }, to: { x: number; y: number }): void => {
    const start = findAnchor(doc, net, from, 1);
    const endAt = findAnchor(doc, net, to, 1);
    const end: Anchor = endAt.kind === 'free' ? { kind: 'free', at: to } : endAt;
    commitDraft(doc, net, start, end, 1);
    net.rebuild();
  };
  const R = 90;
  const pts = Array.from({ length: 8 }, (_, i) =>
    ({ x: R * Math.cos((i * Math.PI) / 4), y: R * Math.sin((i * Math.PI) / 4) }));
  for (let i = 0; i < 8; i++) draw(pts[i]!, pts[(i + 1) % 8]!);
  for (const s of doc.segments.values()) doc.setSegmentDirection(s.id, 'aToB');
  for (const i of [0, 2, 4, 6]) {
    const p = pts[i]!;
    draw(p, { x: p.x * 5, y: p.y * 5 });
  }
  return doc;
}

function run(doc: RoadDoc, seconds: number, seed = 0x5eed): { left: number; worstStill: number } {
  const sim = simOf(doc, seed, 2);
  const seen = new Set<number>();
  const still = new Map<number, number>();
  let worstStill = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    step(sim, { traffic: true, pedestrians: false });
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

  // The ring used to fill up anyway, on other seeds, with every link holding
  // a car waiting for the next one: entries are now metered onto a small
  // cycle of links (`sim/intersections/cycles.ts`).
  for (const seed of [22, 23]) {
    it(`never locks solid when drawn with the editor (seed ${seed})`, () => {
      // Before metering, seed 22 left 2 vehicles out in 300 s.
      const { left } = run(drawnRing(), 300, seed);
      expect(left).toBeGreaterThan(20);
    });
  }
});
