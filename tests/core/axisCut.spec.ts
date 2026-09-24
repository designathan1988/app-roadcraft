import { describe, expect, it } from 'vitest';
import { cutAtAxis } from '@core/axisCut';
import { area, intersection, type MultiPoly, type Poly, type Ring } from '@core/clipper';
import { Rng } from '@core/rng';

/**
 * `cutAtAxis` replaces a general boolean intersection in `splitToSpan`, so it
 * is held to the same answer: the two sides together are the polygon, each side
 * is what the clipper would have cut, and the two meet at the same points.
 */

const square = (x0: number, y0: number, x1: number, y1: number): Ring => [
  [x0, y0], [x1, y0], [x1, y1], [x0, y1],
];
const circle = (cx: number, cy: number, r: number, n = 24): Ring =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });

/** The clipper's answer for one side of the line, for comparison. */
function clipSide(polygon: Poly, axis: 0 | 1, at: number, side: 0 | 1): MultiPoly {
  const big = 1e5;
  const lo = side === 0 ? -big : at;
  const hi = side === 0 ? at : big;
  const rect: Ring = axis === 0 ? square(lo, -big, hi, big) : square(-big, lo, big, hi);
  return intersection([polygon], [[rect]]);
}

function check(polygon: Poly, axis: 0 | 1, at: number): [MultiPoly, MultiPoly] {
  const cut = cutAtAxis(polygon, axis, at);
  expect(cut).not.toBeNull();
  const [below, above] = cut as [MultiPoly, MultiPoly];
  const whole = area([polygon]);
  // Together, exactly the polygon.
  expect(area(below) + area(above)).toBeCloseTo(whole, 6);
  // Each side is the clipper's side, up to the few thousandths the cut may
  // have been moved off a vertex (times the polygon's extent across it).
  const tolerance = 0.04 * 60;
  expect(Math.abs(area(below) - area(clipSide(polygon, axis, at, 0)))).toBeLessThan(tolerance);
  expect(Math.abs(area(above) - area(clipSide(polygon, axis, at, 1)))).toBeLessThan(tolerance);

  // The line actually cut: the cut may have moved off a vertex, and every
  // point below it is strictly below except the ones made on it.
  let line = -Infinity;
  for (const p of below) for (const ring of p) for (const q of ring) line = Math.max(line, q[axis] as number);
  expect(Math.abs(line - at)).toBeLessThan(0.04);
  for (const p of above) for (const ring of p) for (const q of ring) {
    expect(q[axis] as number).toBeGreaterThanOrEqual(line);
  }
  // The two sides meet at the same points, to the last bit.
  const onLine = (side: MultiPoly): string[] => {
    const keys: string[] = [];
    for (const p of side) for (const ring of p) for (const q of ring) {
      if (q[axis] === line) keys.push(`${q[0]},${q[1]}`);
    }
    return keys.sort();
  };
  expect(onLine(below).length).toBeGreaterThan(0);
  expect(onLine(below)).toEqual(onLine(above));

  // The clipper's winding in world axes, on both sides and for both axes:
  // outer rings anticlockwise, holes clockwise.
  for (const side of [below, above]) {
    for (const p of side) {
      p.forEach((ring, r) => {
        let twice = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          twice += (ring[j]![0]! * ring[i]![1]!) - (ring[i]![0]! * ring[j]![1]!);
        }
        expect(r === 0 ? twice > 0 : twice < 0).toBe(true);
      });
    }
  }
  return [below, above];
}

describe('cutAtAxis', () => {
  it('cuts a square in two along either axis', () => {
    for (const axis of [0, 1] as const) {
      const [below, above] = check([square(-4, -3, 6, 5)], axis, 0.5);
      expect(below).toHaveLength(1);
      expect(above).toHaveLength(1);
    }
  });

  it('opens a hole the cut passes through into both sides', () => {
    const [below, above] = check([square(-10, -10, 10, 10), circle(0, 0, 4)], 0, 0.3);
    expect(below).toHaveLength(1);
    expect(above).toHaveLength(1);
    // No longer a hole: part of each side's outline.
    expect(below[0]).toHaveLength(1);
    expect(above[0]).toHaveLength(1);
  });

  it('keeps a hole that lies wholly on one side, in the right piece', () => {
    const [below, above] = check([square(-10, -10, 10, 10), circle(-5, 2, 2), circle(5, -3, 1.5)], 0, 0);
    expect(below[0]).toHaveLength(2);
    expect(above[0]).toHaveLength(2);
  });

  it('gives several pieces where a concave shape crosses the cut several times', () => {
    // A comb: three teeth rising from a common back.
    const comb: Ring = [
      [0, 0], [11, 0], [11, 8], [9, 8], [9, 3], [7, 3], [7, 8], [4, 8], [4, 3], [2, 3], [2, 8], [0, 8],
    ];
    const [below, above] = check([comb], 1, 5);
    expect(below).toHaveLength(1);
    expect(above).toHaveLength(3);
    const [left, right] = check([comb], 0, 5.5);
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
  });

  it('moves the cut off a vertex that lies exactly on it', () => {
    const diamond: Ring = [[0, -5], [5, 0], [0, 5], [-5, 0]];
    check([diamond], 0, 0);
    check([diamond], 1, 0);
    check([square(-2, -2, 2, 2)], 0, 2 - 1e-9);
  });

  it('accepts either winding and a repeated closing point', () => {
    const ring = square(-3, -3, 7, 4);
    check([[...ring].reverse()], 0, 1);
    check([[...ring, ring[0] as number[]], [...circle(0, 0, 1)].reverse()], 1, 0);
  });

  it('agrees with the clipper on random polygons with holes', () => {
    const rng = new Rng(20260924);
    for (let trial = 0; trial < 60; trial++) {
      // A star-shaped outline between radii 12 and 25, with holes well inside it.
      const n = 12 + Math.floor(rng.float() * 30);
      const outer: Ring = Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        const r = 12 + rng.float() * 13;
        return [Math.cos(a) * r, Math.sin(a) * r];
      });
      const holes: Ring[] = [];
      for (let k = 0; k < 3; k++) {
        const angle = rng.float() * Math.PI * 2;
        holes.push(circle(Math.cos(angle) * 6 * (k % 2 ? 1 : -0.4), Math.sin(angle) * 6, 1 + rng.float(), 10));
      }
      const polygon: Poly = [outer, ...holes.filter((h, i) =>
        holes.slice(0, i).every((o) => Math.hypot((o[0]![0]! - h[0]![0]!), (o[0]![1]! - h[0]![1]!)) > 7))];
      const axis = (trial % 2) as 0 | 1;
      check(polygon, axis, (rng.float() - 0.5) * 16);
    }
  });

  it('declines a polygon it cannot vouch for', () => {
    // A ring with no area.
    expect(cutAtAxis([[[0, 0], [5, 0], [10, 0]]], 0, 5)).toBeNull();
    // A "hole" that pokes outside its outline: crossings do not alternate.
    expect(cutAtAxis([square(0, 0, 10, 10), square(4, -5, 6, 5)], 0, 5)).toBeNull();
  });
});
