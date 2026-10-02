import { describe, expect, it } from 'vitest';
import { cityBuilding } from '@world/buildings/cityBuildings';
import { instantiate } from '@world/buildings/blueprints';
import { floorHeight } from '@world/buildings/foundation';
import { footprintRects } from '@world/buildings/geometry';
import { PAD_BATTER, buildingPads } from '@world/buildings/pads';
import { type Building, asBuildingId } from '@world/buildings/types';

/** A building on a slope stands on graded ground, and the grading is stable. */
describe('building pads', () => {
  const model = cityBuilding('supermarket')!;
  const b = { ...instantiate(model.body, { x: 0, y: 0 }, 0, model.fn), id: asBuildingId(1) } as Building;
  // A hillside falling 1 in 8 towards +x.
  const slope = (x: number, _y: number): number => -x / 8;
  const apron = 16;
  const pads = buildingPads([b], slope, undefined, apron);
  const graded = (x: number, y: number): number => {
    const s = pads.shapeAt(x, y, slope(x, y));
    return slope(x, y) + (s.height - slope(x, y)) * s.weight;
  };

  it('levels the whole footprint', () => {
    const level = floorHeight(b, slope);
    for (const ring of footprintRects(b)) {
      for (const p of ring) expect(graded(p.x, p.y)).toBeLessThan(level);
      for (const p of ring) expect(level - graded(p.x, p.y)).toBeLessThan(0.5);
    }
  });

  it('gives the same floor on the graded ground as on the land', () => {
    expect(floorHeight(b, graded)).toBeCloseTo(floorHeight(b, slope), 6);
  });

  it('banks back to the land at the batter, never steeper', () => {
    const ring = footprintRects(b)[0]!;
    const maxX = Math.max(...ring.map((p) => p.x));
    let prev = graded(maxX + apron, 0);
    for (let d = 1; d < 400; d += 1) {
      const h = graded(maxX + apron + d, 0);
      expect(Math.abs(h - prev)).toBeLessThanOrEqual(1 / PAD_BATTER + 1 / 8 + 1e-6);
      prev = h;
    }
    expect(graded(maxX + 2000, 0)).toBeCloseTo(slope(maxX + 2000, 0), 6);
  });
});
