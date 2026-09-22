import { describe, expect, it } from 'vitest';

import { Polyline } from '@core/polyline';
import { Ring, lineEdge } from '@core/ring';
import { offsetPolyline } from '@core/offset';
import { flattenSegment, shapeFromControl } from '@core/bezier';
import { difference, intersection, union, type MultiPoly } from '@core/clipper';
import { addScaled, angleOf, dot, len, normalize, perp } from '@core/vec2';
import { clamp } from '@core/scalar';

const line = (...points: [number, number][]): Polyline =>
  Polyline.fromPoints(points.map(([x, y]) => ({ x, y })));

describe('vec2', () => {
  it('normalises to unit length', () => {
    expect(len(normalize({ x: 3, y: 4 }))).toBeCloseTo(1, 12);
  });

  it('perp is a quarter turn to the left', () => {
    const p = perp({ x: 1, y: 0 });
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(1, 12);
    expect(dot(p, { x: 1, y: 0 })).toBeCloseTo(0, 12);
  });

  it('angleOf agrees with atan2', () => {
    expect(angleOf({ x: -1, y: 1 })).toBeCloseTo(Math.atan2(1, -1), 12);
  });

  it('addScaled walks along a direction', () => {
    expect(addScaled({ x: 1, y: 1 }, { x: 0, y: 1 }, 4)).toEqual({ x: 1, y: 5 });
  });
});

describe('scalar', () => {
  it('clamps both ways', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});

describe('Polyline', () => {
  const l = line([0, 0], [100, 0], [100, 100]);

  it('measures its own length', () => {
    expect(l.length).toBeCloseTo(200, 9);
  });

  it('samples a frame whose tangent and normal are perpendicular unit vectors', () => {
    const frame = l.sampleAt(50);
    expect(frame.p.x).toBeCloseTo(50, 9);
    expect(len(frame.t)).toBeCloseTo(1, 9);
    expect(len(frame.n)).toBeCloseTo(1, 9);
    expect(dot(frame.t, frame.n)).toBeCloseTo(0, 9);
  });

  it('clamps a sample past either end', () => {
    expect(l.sampleAt(-10).p).toEqual(l.sampleAt(0).p);
    expect(l.sampleAt(1e6).p).toEqual(l.sampleAt(l.length).p);
  });

  it('finds the closest point and its arc position', () => {
    const hit = l.closestPoint({ x: 40, y: 25 });
    expect(hit.s).toBeCloseTo(40, 6);
    expect(hit.distance).toBeCloseTo(25, 6);
  });

  it('reverses without changing its length', () => {
    expect(l.reversed().length).toBeCloseTo(l.length, 9);
    expect(l.reversed().point(0)).toEqual(l.point(l.n - 1));
  });

  it('takes a sub-range', () => {
    expect(l.sub(50, 150).length).toBeCloseTo(100, 6);
  });
});

describe('offsetPolyline', () => {
  it('offsets a straight line by exactly the distance', () => {
    const out = offsetPolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }], 10);
    for (const p of out) expect(Math.abs(p.y)).toBeCloseTo(10, 6);
  });

  it('keeps a right-angle corner mitred rather than cut off', () => {
    const out = offsetPolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 10);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });
});

describe('bezier', () => {
  it('a zero-excursion curve is the straight chord', () => {
    const shape = shapeFromControl({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 0 });
    const points = flattenSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, shape);
    for (const p of points) expect(Math.abs(p.y)).toBeLessThan(1e-6);
  });

  it('bulges to the side the control point is on', () => {
    const shape = shapeFromControl({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 40 });
    const points = flattenSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, shape);
    const highest = Math.max(...points.map((p) => p.y));
    expect(highest).toBeGreaterThan(15);
  });

  it('always starts and ends on its endpoints', () => {
    const shape = shapeFromControl({ x: 0, y: 0 }, { x: 100, y: 60 }, { x: 20, y: 90 });
    const points = flattenSegment({ x: 0, y: 0 }, { x: 100, y: 60 }, shape);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[points.length - 1]).toEqual({ x: 100, y: 60 });
  });
});

describe('clipper', () => {
  const square = (s: number): MultiPoly => [[[[-s, -s], [s, -s], [s, s], [-s, s]]]];

  it('unions two overlapping squares into one ring', () => {
    const a: MultiPoly = [[[[0, 0], [10, 0], [10, 10], [0, 10]]]];
    const b: MultiPoly = [[[[5, 5], [15, 5], [15, 15], [5, 15]]]];
    expect(union([...a, ...b]).length).toBe(1);
  });

  it('difference leaves a hole', () => {
    const out = difference(square(10), square(4));
    expect(out[0]!.length).toBe(2);
  });

  it('intersection of disjoint shapes is empty', () => {
    const a: MultiPoly = [[[[0, 0], [1, 0], [1, 1], [0, 1]]]];
    const b: MultiPoly = [[[[10, 10], [11, 10], [11, 11], [10, 11]]]];
    expect(intersection(a, b)).toEqual([]);
  });
});

describe('Ring', () => {
  it('reports emptiness for an outline with no edges', () => {
    expect(new Ring({ x: 0, y: 0 }, []).isEmpty).toBe(true);
  });

  it('flattens a closed triangle back to its corners', () => {
    const ring = new Ring({ x: 0, y: 0 }, [lineEdge({ x: 10, y: 0 }), lineEdge({ x: 0, y: 10 })]);
    expect(ring.isEmpty).toBe(false);
    expect(ring.flatten().length).toBeGreaterThanOrEqual(3);
  });
});
