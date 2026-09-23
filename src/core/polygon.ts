import { EPS } from './scalar';
import type { Vec2 } from './vec2';
import { segSeg } from './intersect';

/**
 * True when a closed polygon has no self-intersections.
 *
 * This is the hard backstop behind the junction builder. The V6 monolith
 * emitted an angle-sorted "star" polygon with no such check, which is why
 * Y-junctions and skewed T-junctions rendered as bowties.
 *
 * O(n^2); n stays under ~200 after flattening, and in production it only runs
 * for junctions of degree >= 4.
 */
export function isSimple(points: readonly Vec2[]): boolean {
  const n = points.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a0 = points[i] as Vec2;
    const a1 = points[(i + 1) % n] as Vec2;
    for (let j = i + 1; j < n; j++) {
      // Skip the shared-vertex neighbours of edge i.
      if (j === i || (j + 1) % n === i || j === (i + 1) % n) continue;
      const b0 = points[j] as Vec2;
      const b1 = points[(j + 1) % n] as Vec2;
      if (segSeg(a0, a1, b0, b1)) return false;
    }
  }
  return true;
}

export function signedArea(points: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const pi = points[i] as Vec2;
    const pj = points[j] as Vec2;
    a += pj.x * pi.y - pi.x * pj.y;
  }
  return a / 2;
}

/** Ray-casting containment test. Points exactly on an edge are unspecified. */
export function pointInPolygon(p: Vec2, points: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const pi = points[i] as Vec2;
    const pj = points[j] as Vec2;
    const straddles = pi.y > p.y !== pj.y > p.y;
    if (!straddles) continue;
    const x = ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (p.x < x) inside = !inside;
  }
  return inside;
}

/** Shortest distance from `p` to the polygon boundary. */
export function distanceToBoundary(p: Vec2, points: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j] as Vec2;
    const b = points[i] as Vec2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 < EPS ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Monotone-chain convex hull, wound to positive signed area.
 *
 * This is the junction builder's last-resort fallback: a hull is always simple
 * and always contains every mouth corner, so a validation failure degrades to
 * "slightly too generous" rather than "visibly broken". A fuzz test asserts it
 * never actually fires.
 */
export function convexHull(input: readonly Vec2[]): Vec2[] {
  if (input.length < 4) return input.slice();
  const pts = input
    .slice()
    .sort((a, b) => a.x - b.x || a.y - b.y);

  const turn = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Vec2[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      turn(lower[lower.length - 2] as Vec2, lower[lower.length - 1] as Vec2, p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as Vec2;
    while (
      upper.length >= 2 &&
      turn(upper[upper.length - 2] as Vec2, upper[upper.length - 1] as Vec2, p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return signedArea(hull) >= 0 ? hull : hull.reverse();
}
