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

export const quadTangent = (a: Vec2, c: Vec2, b: Vec2, t: number): Vec2 =>
  normalize({
    x: 2 * ((1 - t) * (c.x - a.x) + t * (b.x - c.x)),
    y: 2 * ((1 - t) * (c.y - a.y) + t * (b.y - c.y)),
  });

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

/** Maximum distance from the curve to its chord — the sagitta. */
export function maxSagitta(shape: CurveShape | null): number {
  if (!shape) return 0;
  // For a quadratic, the extreme deviation from the chord occurs at t = 1/2
  // and equals half the control point's perpendicular offset.
  return Math.abs(shape.h) / 2;
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
