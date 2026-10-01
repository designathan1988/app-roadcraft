import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { pointInPolygon } from '@core/polygon';
import { Level, halfWidth } from '@world/roadTypes';

/**
 * P2-26: two roads meeting at a slight bend (under the junction threshold)
 * met square to their own ends and left a wedge of terrain showing on the
 * outside of the bend. Every point of the asphalt across the joint is covered.
 */
describe('a slight bend between two roads', () => {
  for (const degrees of [2, 4, 4.9]) {
    it(`has no hole on the outside at ${degrees} degrees`, () => {
      const doc = new RoadDoc();
      const a = doc.addNode({ x: -200, y: 0 });
      const b = doc.addNode({ x: 0, y: 0 });
      const t = (degrees * Math.PI) / 180;
      const c = doc.addNode({ x: 200 * Math.cos(t), y: 200 * Math.sin(t) });
      doc.addSegment(a.id, b.id, 3);
      doc.addSegment(b.id, c.id, 3);
      const net = new Network(doc);
      net.rebuild();
      const rings = [...net.ribbons.values()].map((r) => r.rings[Level.Asphalt]!.flatten());
      // Across the joint, from one edge to the other, on the bisector.
      const nx = -Math.sin(t / 2);
      const ny = Math.cos(t / 2);
      const half = Math.min(...[...net.ribbons.values()].map((r) => halfWidth(r.road, Level.Asphalt)));
      let holes = 0;
      for (let k = -0.95; k <= 0.95; k += 0.05) {
        const p = { x: nx * half * k, y: ny * half * k };
        if (!rings.some((ring) => pointInPolygon(p, ring))) holes++;
      }
      expect(holes).toBe(0);
    });
  }
});
