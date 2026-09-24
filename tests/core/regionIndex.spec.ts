import { describe, expect, it } from 'vitest';
import { pointInPolygon } from '@core/polygon';
import { RegionIndex } from '@core/regionIndex';
import type { Vec2 } from '@core/vec2';

/** A deterministic stream in [0, 1). */
function stream(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

describe('region index', () => {
  const square: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const hole: Vec2[] = [{ x: 3, y: 3 }, { x: 3, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 3 }];
  const star: Vec2[] = Array.from({ length: 14 }, (_, i) => {
    const r = i % 2 ? 4 : 9;
    const a = (i / 14) * Math.PI * 2;
    return { x: 20 + Math.cos(a) * r, y: 5 + Math.sin(a) * r };
  });

  it('agrees with a ray cast over every ring, holes included', () => {
    const index = RegionIndex.fromRings([square, hole, star], 'evenodd', 2);
    const next = stream(7);
    for (let i = 0; i < 5000; i++) {
      const p = { x: -5 + next() * 40, y: -8 + next() * 26 };
      let inside = false;
      for (const ring of [square, hole, star]) if (pointInPolygon(p, ring)) inside = !inside;
      expect(index.contains(p.x, p.y)).toBe(inside);
    }
  });

  it('unions overlapping rings with the nonzero rule, whichever way they wind', () => {
    const a: Vec2[] = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 6 }, { x: 0, y: 6 }];
    const b: Vec2[] = [{ x: 4, y: 4 }, { x: 4, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 4 }];
    const index = RegionIndex.fromRings([a, b], 'nonzero', 3);
    expect(index.contains(5, 5)).toBe(true);
    expect(index.contains(1, 1)).toBe(true);
    expect(index.contains(9, 9)).toBe(true);
    expect(index.contains(9, 1)).toBe(false);
  });

  it('measures the run of a line inside and outside the region', () => {
    const index = RegionIndex.fromRings([square], 'nonzero', 4);
    const run = { lo: 0, hi: 0 };
    expect(index.run(2, 5, 1, 0, 50, run)).toBe(true);
    expect(run.lo).toBeCloseTo(-2, 9);
    expect(run.hi).toBeCloseTo(8, 9);
    expect(index.run(15, 5, 1, 0, 3, run)).toBe(false);
    expect(run.lo).toBeCloseTo(-3, 9);
    expect(run.hi).toBeCloseTo(3, 9);
    expect(index.span(15, 5, 1, 0, 3, run)).toBe(false);
    expect(index.boundaryDistance(2, 5, 5)).toBeCloseTo(2, 9);
    expect(index.boundaryDistance(50, 50, 5)).toBe(Infinity);
  });
});
