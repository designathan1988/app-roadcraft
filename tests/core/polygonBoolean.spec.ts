import { describe, expect, it } from 'vitest';
import { area, difference, intersection, union, type MultiPoly, type Ring } from '@core/clipper';

const box = (x0: number, y0: number, x1: number, y1: number): Ring =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

describe('polygon set semantics', () => {
  it('preserves explicit holes regardless of input ring winding', () => {
    const outer = box(0, 0, 10, 10), hole = box(2, 2, 8, 8);
    for (const outside of [outer, outer.slice().reverse()]) {
      for (const inside of [hole, hole.slice().reverse()]) {
        const result = union([[outside, inside]]);
        expect(area(result)).toBeCloseTo(64, 6);
        expect(area(intersection(result, [[box(3, 3, 7, 7)]]))).toBeCloseTo(0, 6);
        expect(area(union(result))).toBeCloseTo(64, 6);
      }
    }
  });

  it('keeps a concave hole whose corner triangle centroid lies outside its parent', () => {
    const outer: MultiPoly = [[[[-1, -1], [11, -1], [11, 2], [2, 2], [2, 11], [-1, 11]]]];
    const inner: MultiPoly = [[[[0, 0], [10, 0], [10, 1], [1, 1], [1, 10], [0, 10]]]];
    const result = difference(outer, inner);
    expect(area(outer)).toBeCloseTo(63, 6);
    expect(area(inner)).toBeCloseTo(19, 6);
    expect(area(result)).toBeCloseTo(44, 6);
    expect(area(intersection(result, inner))).toBeCloseTo(0, 6);
  });

  it('is idempotent over holes, islands and disconnected components', () => {
    const shape: MultiPoly = [[box(0, 0, 20, 20), box(2, 2, 18, 18)],
      [box(5, 5, 7, 7)], [box(30, 0, 32, 2)]];
    const once = union(shape);
    expect(area(once)).toBeCloseTo(152, 6);
    expect(area(union(once, shape))).toBeCloseTo(152, 6);
    expect(area(difference(once, shape))).toBeCloseTo(0, 6);
  });

  it('does not double-fill coincident or shared edges', () => {
    const a: MultiPoly = [[box(0, 0, 10, 10)]];
    const b: MultiPoly = [[box(10, 0, 20, 10)]];
    expect(area(union(a, a))).toBeCloseTo(100, 6);
    expect(area(union(a, b))).toBeCloseTo(200, 6);
    expect(area(intersection(a, b))).toBeCloseTo(0, 6);
  });
});
