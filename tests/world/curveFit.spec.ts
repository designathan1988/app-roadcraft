import { describe, expect, it } from 'vitest';
import { controlPoint, fitShapeToRadius, quadMinRadius, quadPoint } from '@core/bezier';
import { RoadDoc } from '@world/doc';
import { casingHalf, roadProfile } from '@world/roadTypes';

/** Tightest circumradius of consecutive triples of a finely flattened curve. */
function sampledMinRadius(a: { x: number; y: number }, b: { x: number; y: number }, shape: { t: number; h: number }): number {
  const c = controlPoint(a, b, shape);
  const pts = Array.from({ length: 4001 }, (_, i) => quadPoint(a, c, b, i / 4000));
  let min = Infinity;
  for (let i = 1; i + 1 < pts.length; i++) {
    const p = pts[i - 1]!, q = pts[i]!, r = pts[i + 1]!;
    const ab = Math.hypot(q.x - p.x, q.y - p.y), bc = Math.hypot(r.x - q.x, r.y - q.y), ca = Math.hypot(p.x - r.x, p.y - r.y);
    const area2 = Math.abs((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    if (area2 > 1e-12) min = Math.min(min, (ab * bc * ca) / (2 * area2));
  }
  return min;
}

describe('a curve is never tighter than its road is wide', () => {
  it('the closed-form radius matches a fine sampling', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 60, y: 10 };
    for (const shape of [{ t: 0.5, h: 20 }, { t: 0.3, h: -35 }, { t: 0.8, h: 8 }]) {
      const exact = quadMinRadius(a, controlPoint(a, b, shape), b);
      expect(Math.abs(exact - sampledMinRadius(a, b, shape)) / exact).toBeLessThan(0.01);
    }
  });

  it('fitting flattens only as much as needed', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 40, y: 0 };
    const fitted = fitShapeToRadius(a, b, { t: 0.44, h: -17.88 }, 30);
    expect(fitted).not.toBeNull();
    const r = quadMinRadius(a, controlPoint(a, b, fitted!), b);
    expect(r).toBeGreaterThanOrEqual(30);
    expect(r).toBeLessThan(30.1);
    const loose = { t: 0.5, h: 2 };
    expect(fitShapeToRadius(a, b, loose, 30)).toBe(loose);
  });

  it('holds through move, curve, type and lane edits', () => {
    const doc = new RoadDoc();
    const na = doc.addNode({ x: 0, y: 0 });
    const nb = doc.addNode({ x: 120, y: 0 });
    const seg = doc.addSegment(na.id, nb.id, 1, { t: 0.5, h: 30 })!;
    const check = (): void => {
      const s = doc.segment(seg.id)!;
      if (!s.curve) return;
      const a = doc.node(s.a)!, b = doc.node(s.b)!;
      const r = quadMinRadius(a, controlPoint(a, b, s.curve), b);
      expect(r).toBeGreaterThanOrEqual(casingHalf(roadProfile(s.type, s.lanes, s.direction)) - 1e-6);
    };
    check();
    doc.setSegmentCurve(seg.id, { t: 0.5, h: 55 });
    check();
    doc.moveNode(nb.id, { x: 40, y: 5 });
    check();
    doc.setSegmentType(seg.id, 3);
    check();
    doc.setSegmentLanes(seg.id, 8);
    check();
  });
});
