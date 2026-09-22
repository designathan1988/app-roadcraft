import { ARC_TOL, DIV_EPS, EPS, MIN_ITER_STEP, MITER_LIMIT, normalizeAngle } from './scalar';
import {
  type Vec2,
  add,
  addScaled,
  angleOf,
  cross,
  dot,
  normalize,
  perp,
  sub,
} from './vec2';
import { segSeg } from './intersect';

export interface OffsetOptions {
  /** Miter is replaced by a round join beyond this multiple of |d|. */
  readonly miterLimit?: number;
  /** Max chordal deviation for round joins, in world units. */
  readonly arcTol?: number;
  /** Remove loops produced on the inner side of tight curves. */
  readonly prune?: boolean;
}

/**
 * Appends a circular arc of `radius` about `c`, from angle `a0` to `a1`,
 * sweeping the short way. The first point is emitted, the last is not — callers
 * push the endpoint themselves so joins stay exact.
 */
function pushArc(
  out: Vec2[],
  c: Vec2,
  radius: number,
  a0: number,
  a1: number,
  tol: number,
): void {
  const r = Math.abs(radius);
  const delta = normalizeAngle(a1 - a0);
  if (r < tol || Math.abs(delta) < EPS) return;
  // Largest angular step whose sagitta stays within `tol`.
  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / Math.max(maxStep, MIN_ITER_STEP)));
  for (let i = 0; i < steps; i++) {
    const a = a0 + (delta * i) / steps;
    out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
}

/**
 * Offsets an open polyline by a signed distance `d` along `perp(tangent)`.
 *
 * The V6 monolith placed each offset vertex at exactly `d` along the *vertex
 * normal*. That is wrong: the intersection of the two offset lines sits at
 * `d / cos(theta/2)` from the source vertex, where `theta` is the turn angle.
 * Using `d` alone pulls every corner toward the centreline, which is why lane
 * markings drifted off the carriageway and self-crossed on curves.
 *
 * The `miterLen` expression below is signed-correct for both sides of a turn on
 * its own: the inner side gets a short miter, the outer a long one. That single
 * expression is the whole fix.
 *
 * What is NOT true, and is worth stating because it reads as if it should be:
 * the result's points do not all lie at perpendicular distance |d| from the
 * source polyline. On the concave side of a turn the miter vertex's nearest
 * feature is the source *vertex*, at `|d| / cos(theta/2)`. The invariants the
 * tests actually pin are the miter distance itself, and that every offset
 * vertex sits exactly `d` from the supporting lines of both adjacent source
 * segments — which is what "parallel at distance d" means. See the note at the
 * top of `tests/core/offset.spec.ts`.
 */
export function offsetPolyline(
  pts: readonly Vec2[],
  d: number,
  opts: OffsetOptions = {},
): Vec2[] {
  const n = pts.length;
  if (n < 2) return pts.slice();
  if (Math.abs(d) < EPS) return pts.slice();

  const miterLimit = opts.miterLimit ?? MITER_LIMIT;
  const arcTol = opts.arcTol ?? ARC_TOL;
  const prune = opts.prune ?? true;

  // Per-segment unit tangents and left normals.
  const tan: Vec2[] = [];
  const nrm: Vec2[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i] as Vec2;
    const b = pts[i + 1] as Vec2;
    const t = normalize(sub(b, a));
    tan.push(t);
    nrm.push(perp(t));
  }
  if (tan.length === 0) return pts.slice();

  const out: Vec2[] = [addScaled(pts[0] as Vec2, nrm[0] as Vec2, d)];

  for (let i = 1; i < n - 1; i++) {
    const p = pts[i] as Vec2;
    const a = tan[i - 1] as Vec2;
    const b = tan[i] as Vec2;
    const na = nrm[i - 1] as Vec2;
    const nb = nrm[i] as Vec2;

    const cr = cross(a, b);
    const dt = dot(a, b);

    // Collinear and same direction: the vertex adds nothing to the offset.
    if (Math.abs(cr) < EPS && dt > 0) continue;

    // Full reversal: no bisector exists, so sweep a half-circle cap.
    if (dt < -1 + DIV_EPS) {
      pushArc(out, p, d, angleOf(na) + (d < 0 ? Math.PI : 0), angleOf(nb) + (d < 0 ? Math.PI : 0), arcTol);
      out.push(addScaled(p, nb, d));
      continue;
    }

    const bis = normalize(add(na, nb));
    const cosHalf = Math.sqrt(Math.max(0, (1 + dt) / 2));
    const miterLen = d / Math.max(cosHalf, EPS);

    if (Math.abs(miterLen) <= miterLimit * Math.abs(d)) {
      // Exact intersection of the two offset lines.
      out.push(addScaled(p, bis, miterLen));
    } else {
      // Outer side of a very sharp turn: round it instead of emitting a spike.
      out.push(addScaled(p, na, d));
      const sign = d < 0 ? Math.PI : 0;
      pushArc(out, p, d, angleOf(na) + sign, angleOf(nb) + sign, arcTol);
      out.push(addScaled(p, nb, d));
    }
  }

  out.push(addScaled(pts[n - 1] as Vec2, nrm[tan.length - 1] as Vec2, d));

  return prune ? pruneSelfIntersections(out) : out;
}

/**
 * Removes loops from an open chain by walking forward and short-cutting across
 * the first self-intersection found, scanning candidate partners from the far
 * end backwards so the *largest* loop is removed first. Nested loops therefore
 * collapse in a single pass.
 *
 * O(n^2), with n bounded by the flattening budget (<= ~64 points per segment).
 */
export function pruneSelfIntersections(q: readonly Vec2[]): Vec2[] {
  const m = q.length;
  if (m < 4) return q.slice();

  const out: Vec2[] = [q[0] as Vec2];
  let i = 0;
  let guard = 0;

  while (i < m - 1 && guard++ < m * 2) {
    const a0 = q[i] as Vec2;
    const a1 = q[i + 1] as Vec2;
    let cutJ = -1;
    let cutPoint: Vec2 | null = null;

    for (let j = m - 2; j > i + 1; j--) {
      const hit = segSeg(a0, a1, q[j] as Vec2, q[j + 1] as Vec2);
      if (hit) {
        cutJ = j;
        cutPoint = hit.point;
        break;
      }
    }

    if (cutJ >= 0 && cutPoint) {
      out.push(cutPoint);
      i = cutJ + 1;
    } else {
      out.push(a1);
      i++;
    }
  }
  return out;
}

/** True when an open chain has no self-intersections (ignoring shared vertices). */
export function isSimpleOpenChain(q: readonly Vec2[]): boolean {
  const m = q.length;
  for (let i = 0; i + 1 < m; i++) {
    for (let j = i + 2; j + 1 < m; j++) {
      if (segSeg(q[i] as Vec2, q[i + 1] as Vec2, q[j] as Vec2, q[j + 1] as Vec2)) {
        return false;
      }
    }
  }
  return true;
}
