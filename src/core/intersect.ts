import { EPS, GEO_EPS } from './scalar';
import { type Vec2, add, sub, scale, cross, dot, lenSq } from './vec2';

/**
 * Intersection of the infinite line through `a0` with direction `da` and the
 * infinite line through `b0` with direction `db`.
 *
 * Returns `null` when the directions are parallel within `sinEps`, measured as
 * |cross| of the two *unit* directions — so the epsilon is a real angle, not a
 * magnitude-dependent quantity.
 */
export function lineLine(
  a0: Vec2,
  da: Vec2,
  b0: Vec2,
  db: Vec2,
  sinEps = EPS,
): { point: Vec2; sA: number; sB: number } | null {
  const den = cross(da, db);
  if (Math.abs(den) < sinEps) return null;
  const w = sub(b0, a0);
  const sA = cross(w, db) / den;
  const sB = cross(w, da) / den;
  return { point: add(a0, scale(da, sA)), sA, sB };
}

/**
 * Intersection of the finite segments a->b and c->d.
 * `t` and `u` are the parametric positions on each segment, both in [0,1].
 */
export function segSeg(
  a: Vec2,
  b: Vec2,
  c: Vec2,
  d: Vec2,
): { point: Vec2; t: number; u: number } | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < EPS) return null; // parallel or degenerate
  const w = sub(c, a);
  const t = cross(w, s) / den;
  const u = cross(w, r) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { point: add(a, scale(r, t)), t, u };
}

/** Closest point on the finite segment a->b to `p`, with its parametric `t`. */
export function closestOnSegment(
  p: Vec2,
  a: Vec2,
  b: Vec2,
): { point: Vec2; t: number; distSq: number } {
  const ab = sub(b, a);
  const l2 = lenSq(ab);
  if (l2 < EPS) {
    const ap0 = sub(p, a);
    return { point: a, t: 0, distSq: lenSq(ap0) };
  }
  let t = dot(sub(p, a), ab) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const point = add(a, scale(ab, t));
  return { point, t, distSq: lenSq(sub(p, point)) };
}

/**
 * Does `p` lie inside the slab centred on the ray (`origin`, unit `dir`) of
 * half-width `hw`, and ahead of the origin?
 *
 * Used by the junction validator to prove that one leg's mouth corners do not
 * land inside a non-adjacent leg's carriageway.
 */
export function inForwardSlab(
  p: Vec2,
  origin: Vec2,
  dir: Vec2,
  hw: number,
  margin = GEO_EPS,
): boolean {
  const w = sub(p, origin);
  const along = dot(w, dir);
  if (along <= margin) return false;
  return Math.abs(cross(dir, w)) < hw - margin;
}
