import { EPS, FLATTEN_TOL, clamp } from './scalar';
import { type Vec2, add, addScaled, len, normalize, perp, scale, sub } from './vec2';

/**
 * A segment's curvature, stored so that dragging a node cannot deform it.
 *
 * `t` is the normalized position of the control point along the A->B chord and
 * `h` is its lateral offset **in absolute world units**. The V6 monolith divided
 * the lateral component by the chord length as well, so the bulge scaled with
 * the chord — stretching a segment silently changed how curved it was. Keeping
 * `h` absolute makes the curve move rigidly with its endpoints.
 */
export interface CurveShape {
  /** Control-point position along the chord, normalized to [0,1]. */
  readonly t: number;
  /** Control-point offset from the chord, in world units (signed). */
  readonly h: number;
}

export const STRAIGHT: null = null;

/** Reconstructs the quadratic control point from endpoints and shape. */
export function controlPoint(a: Vec2, b: Vec2, shape: CurveShape): Vec2 {
  const chord = sub(b, a);
  const u = normalize(chord);
  const n = perp(u);
  return addScaled(addScaled(a, chord, clamp(shape.t, 0, 1)), n, shape.h);
}

/**
 * Derives a `CurveShape` from a control point, inverting `controlPoint`.
 * Used by the editor when converting a freehand drag into a stored curve.
 */
export function shapeFromControl(a: Vec2, b: Vec2, c: Vec2): CurveShape {
  const chord = sub(b, a);
  const L = len(chord);
  if (L < EPS) return { t: 0.5, h: 0 };
  const u = scale(chord, 1 / L);
  const n = perp(u);
  const w = sub(c, a);
  return { t: (w.x * u.x + w.y * u.y) / L, h: w.x * n.x + w.y * n.y };
}

export const quadPoint = (a: Vec2, c: Vec2, b: Vec2, t: number): Vec2 => {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
};

/**
 * Number of uniform steps needed to flatten a quadratic within `tol`.
 *
 * A quadratic has a constant second derivative `B'' = 2(A - 2C + B)`, so the
 * maximum chordal deviation over `n` uniform steps is exactly `|B''| / (8n^2)`.
 * Solving for `n` gives the closed form below — no recursive subdivision needed.
 */
export function quadSegmentCount(a: Vec2, c: Vec2, b: Vec2, tol = FLATTEN_TOL): number {
  const d = len(sub(add(a, b), scale(c, 2)));
  return clamp(Math.ceil(Math.sqrt(d / (4 * tol))), 1, 64);
}

/** Flattens a quadratic into a point list, endpoints included. */
export function flattenQuad(
  a: Vec2,
  c: Vec2,
  b: Vec2,
  tol = FLATTEN_TOL,
): Vec2[] {
  const steps = quadSegmentCount(a, c, b, tol);
  const out: Vec2[] = new Array(steps + 1);
  for (let i = 0; i <= steps; i++) out[i] = quadPoint(a, c, b, i / steps);
  return out;
}

/**
 * Flattens a segment defined by endpoints plus an optional shape.
 * A `null` shape yields the two endpoints — a straight segment stays exact.
 */
export function flattenSegment(
  a: Vec2,
  b: Vec2,
  shape: CurveShape | null,
  tol = FLATTEN_TOL,
): Vec2[] {
  if (!shape || Math.abs(shape.h) < EPS) return [a, b];
  return flattenQuad(a, controlPoint(a, b, shape), b, tol);
}

/** Splits a quadratic at `t`, returning both halves' control triples. */
export function splitQuad(
  a: Vec2,
  c: Vec2,
  b: Vec2,
  t: number,
): { left: [Vec2, Vec2, Vec2]; right: [Vec2, Vec2, Vec2] } {
  const ac = { x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t };
  const cb = { x: c.x + (b.x - c.x) * t, y: c.y + (b.y - c.y) * t };
  const mid = { x: ac.x + (cb.x - ac.x) * t, y: ac.y + (cb.y - ac.y) * t };
  return { left: [a, ac, mid], right: [mid, cb, b] };
}

/**
 * Tightest radius of curvature of a quadratic, closed form.
 *
 * With P = c - a and Q = b - c, B'(t) = 2((1-t)P + tQ) and B'' = 2(Q - P),
 * so B' x B'' = 4 P x Q is constant and the radius |B'|^3 / |B' x B''| is
 * smallest where |B'| is: at the foot of the perpendicular from the origin
 * to the segment P..Q, clamped to [0, 1].
 */
export function quadMinRadius(a: Vec2, c: Vec2, b: Vec2): number {
  const px = c.x - a.x;
  const py = c.y - a.y;
  const qx = b.x - c.x;
  const qy = b.y - c.y;
  const cross = Math.abs(px * qy - py * qx);
  if (cross < EPS) return Infinity;
  const dx = px - qx;
  const dy = py - qy;
  const dd = dx * dx + dy * dy;
  const t = dd < EPS ? 0 : clamp((px * dx + py * dy) / dd, 0, 1);
  const speed = 2 * Math.hypot((1 - t) * px + t * qx, (1 - t) * py + t * qy);
  return (speed * speed * speed) / (4 * cross);
}

/**
 * The same curve, flattened just enough that it is nowhere tighter than
 * `minRadius`; `null` when only a straight line fits. Reducing |h| only ever
 * widens a quadratic's tightest bend, so a bisection on it is exact.
 */
export function fitShapeToRadius(a: Vec2, b: Vec2, shape: CurveShape | null, minRadius: number): CurveShape | null {
  if (!shape || Math.abs(shape.h) < EPS) return shape;
  const radius = (h: number): number => quadMinRadius(a, controlPoint(a, b, { t: shape.t, h }), b);
  if (radius(shape.h) >= minRadius) return shape;
  let lo = 0;
  let hi = Math.abs(shape.h);
  const sign = Math.sign(shape.h);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (radius(sign * mid) >= minRadius) lo = mid;
    else hi = mid;
  }
  return lo < 0.01 ? null : { t: shape.t, h: sign * lo };
}
