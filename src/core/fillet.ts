import { ACUTE_EPS, COARSE_EPS, EPS, SIN_EPS, clamp } from './scalar';
import { type Vec2, add, addScaled, dot, normalize, scale, sub } from './vec2';

export interface Fillet {
  /** Tangency point on the `dirA` side. */
  readonly ta: Vec2;
  /** Tangency point on the `dirB` side. */
  readonly tb: Vec2;
  /** Arc centre. */
  readonly c: Vec2;
  /** Arc radius. */
  readonly r: number;
  /** Distance from the corner to each tangency. */
  readonly run: number;
}

/**
 * Rounds the corner at `x` where the boundary leaves along `dirA` on one side
 * and `dirB` on the other. Both directions point *away* from the corner.
 *
 * This works whether the corner sits in front of the node or behind it. A
 * reflex wedge (two legs meeting at an obtuse turn) puts `x` behind the node,
 * and that is correct — it is the outer corner of an elbow.
 *
 * Returns `null` for wedges too acute to round, or for a straight-through
 * corner; callers fall back to a bevel in those cases.
 */
export function filletCorner(
  x: Vec2,
  dirA: Vec2,
  dirB: Vec2,
  r: number,
): Fillet | null {
  if (r <= 0) return null;
  const psi = Math.acos(clamp(dot(dirA, dirB), -1, 1));
  if (psi < ACUTE_EPS) return null; // too sharp to round; bevel instead
  if (Math.PI - psi < SIN_EPS) return null; // straight through; nothing to round

  const half = psi / 2;
  const tanHalf = Math.tan(half);
  const sinHalf = Math.sin(half);
  if (tanHalf < EPS || sinHalf < EPS) return null;

  const run = r / tanHalf;
  const bis = normalize(add(dirA, dirB));

  return {
    ta: addScaled(x, dirA, run),
    tb: addScaled(x, dirB, run),
    c: addScaled(x, bis, r / sinHalf),
    r,
    run,
  };
}

/**
 * Small relative clearance added to the acute setback.
 *
 * The exact separation distance leaves the two mouths precisely tangent. Exact
 * tangency is numerically fragile: a simplicity test treats a touching pair of
 * edges as an intersection, so the junction ring would be rejected and fall
 * back to a convex hull for what is in fact a valid shape. Nudging the mouths
 * apart makes the configuration robust.
 */
export const ACUTE_CLEARANCE = 1.02;

/**
 * Distance from the corner at which two rays separated by `psi`, carrying
 * half-widths `hwA` and `hwB`, stop overlapping.
 *
 * This is the bevel setback for an acute wedge. In the equal-width case it
 * reduces to `hw / sin(psi/2)`, which is also the closed form of the corner
 * point's distance from the node — so the acute case and the exact corner are
 * the same quantity, not two competing heuristics.
 */
export function acuteSetback(psi: number, hwA: number, hwB: number): number {
  const s = Math.sin(Math.max(psi, COARSE_EPS) / 2);
  return (ACUTE_CLEARANCE * (hwA + hwB)) / (2 * s);
}

/**
 * Default curb-return radius for a corner between two half-widths.
 *
 * Sized from real practice rather than from what merely avoids a defect. A
 * residential corner is turned at 3 to 5 m, a collector at 5 to 8, an arterial
 * at 10 to 15; at 0.4 m per unit that is roughly 7 to 38 units. The previous
 * coefficients produced 3.6 to 9 units — a MEDIAN radius of 1.9 m, which is a
 * quarter of the tightest real kerb return, and it read as a square corner at
 * every zoom.
 *
 * The narrower of the two footways still governs, because the kerb line has to
 * meet that footway tangentially; a radius chosen from the wider road would
 * overshoot the narrow one's own kerb. The upper clamp is what keeps a
 * boulevard-to-boulevard corner from eating the block, and the trim solver
 * scales the radius down per segment (`radiusScaleBySegment`) whenever the run
 * does not fit the available length, so a short block degrades smoothly instead
 * of being rejected.
 */
export const CURB_R_MIN = 7;

/**
 * Widest return we will hand out: 7.2 m.
 *
 * Also the honesty bound on the over-miter path in `resolveCorner`. When even
 * the radius needed to reach the separation setback exceeds this, the corner is
 * not a kerb return any more and pretending otherwise draws a fifty-metre arc;
 * the chord is the truthful shape there.
 */
export const CURB_R_MAX = 18;

export function curbRadius(hwA: number, hwB: number): number {
  return clamp(0.5 * Math.min(hwA, hwB), CURB_R_MIN, CURB_R_MAX);
}

/** Midpoint helper used by bevel/taper fallbacks. */
export const midpoint = (a: Vec2, b: Vec2): Vec2 =>
  scale(add(a, b), 0.5);

export const towards = (from: Vec2, to: Vec2, d: number): Vec2 =>
  addScaled(from, normalize(sub(to, from)), d);
