import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { buildSampleTown } from '@world/sampleTown';
import { footprintRects } from '@world/buildings/geometry';
import { structuralProblem } from '@world/buildings/validate';

/** The sample town: dense blocks, fronts on the pavement, nothing on a road or on a neighbour. */
describe('sample town', () => {
  const doc = new RoadDoc();
  const count = buildSampleTown(doc);
  const boxes = [...doc.buildings.all()].map((b) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of footprintRects(b)) for (const p of r) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { b, x0, y0, x1, y1 };
  });

  it('fills its blocks', () => {
    expect(count).toBeGreaterThan(50);
    expect(doc.segments.size).toBe(17);
  });

  it('puts nothing on a road and nothing on a neighbour', () => {
    for (const a of boxes) {
      expect(structuralProblem(a.b)).toBeNull();
      for (const x of [-270, -90, 90, 270]) expect(a.x1 <= x - 13 || a.x0 >= x + 13).toBe(true);
      for (const y of [-180, 180]) expect(a.y1 <= y - 13 || a.y0 >= y + 13).toBe(true);
      for (const c of boxes) {
        if (c === a) continue;
        expect(a.x0 < c.x1 - 0.5 && a.x1 > c.x0 + 0.5 && a.y0 < c.y1 - 0.5 && a.y1 > c.y0 + 0.5).toBe(false);
      }
    }
  });
});
