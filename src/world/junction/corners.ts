import { ACUTE_EPS, COARSE_EPS, CORNER_MITER, SIN_EPS, TAPER_ANGLE, clamp } from '@core/scalar';
import { type Vec2, addScaled, dist, dot, sub } from '@core/vec2';
import { lineLine } from '@core/intersect';
import { CURB_R_MAX, acuteSetback, curbRadius, filletCorner, type Fillet } from '@core/fillet';
import { type Leg } from './legs';

export type CornerMode = 'fillet' | 'bevel' | 'collinear' | 'taper';

export interface Corner {
  /** Index of the leg whose LEFT boundary feeds this corner. */
  readonly i: number;
  /** Index of the leg whose RIGHT boundary leaves this corner. */
  readonly j: number;
  readonly mode: CornerMode;
  /** Intersection of the two boundary lines. Null in collinear/taper mode. */
  readonly x: Vec2 | null;
  /** Wedge angle at `x`, in radians. */
  readonly psi: number;
  readonly fillet: Fillet | null;
  /** Trim contribution this corner demands of leg `i`. */
  readonly trimI: number;
  /** Trim contribution this corner demands of leg `j`. */
  readonly trimJ: number;
}

/**
 * Resolves every corner of a junction.
 *
 * Corner `k` joins leg `i`'s **left** boundary line to the **right** boundary
 * line of the next leg counter-clockwise. Because the legs are in angular
 * order, walking those corners produces the boundary in order too.
 *
 * The V6 monolith had no corner concept at all: it jumped straight from one
 * leg's mouth to the next, so junction corners were arbitrary chords and the
 * kerb line simply died at each mouth (defect 1.7).
 */
export function computeCorners(
  legs: readonly Leg[],
  radiusScale: readonly number[] = [],
  mouthTrims: readonly number[] = [],
): Corner[] {
  const n = legs.length;
  if (n < 2) return [];

  const corners: Corner[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    corners.push(resolveCorner(legs, i, j, radiusScale, mouthTrims));
  }
  return corners;
}

function resolveCorner(
  legs: readonly Leg[],
  i: number,
  j: number,
  radiusScale: readonly number[],
  mouthTrims: readonly number[],
): Corner {
  const a = legs[i] as Leg;
  const b = legs[j] as Leg;

  // Leg `a`'s left boundary and leg `b`'s right boundary.
  const a0 = addScaled(a.origin, a.nrm, a.hw);
  const b0 = addScaled(b.origin, b.nrm, -b.hw);

  const psi = Math.acos(clamp(dot(a.dir, b.dir), -1, 1));
  const step = Math.abs(a.hw - b.hw);

  // --- A width step across a near-straight pair is a TAPER, not a corner. ---
  //
  // Keyed on the ANGLE, not on `lineLine` failing to find a crossing. Just
  // outside `SIN_EPS` the two boundary lines still cross, but they cross about
  // `step / sin(bend)` away from the node, and the miter branch below then
  // charges that whole distance to the trim. Measured on a boulevard becoming a
  // residential street: at 3.00 degrees of bend the trims are 72.9, and at 3.05
  // they are 306. A twentieth of a degree of node nudge turned a shoulder into
  // a junction six times longer than the road it served.
  //
  // `TAPER_ANGLE` now selects the band as well as setting the slope, which is
  // the same quantity read two ways rather than two competing constants.
  //
  // The run is HALVED because the two legs are anti-parallel and each is
  // charged its own trim: the lateral step is shared between `trimI` and
  // `trimJ`, so charging the full run to each would realise half the intended
  // taper angle.
  // Only when there IS a step. Two legs of equal width bent by a few degrees
  // are an ordinary shallow corner and the miter solves them correctly; calling
  // them collinear collapses the corner to a zero trim and the ring folds
  // through itself. That mistake took the fuzz hull-fallback rate from under
  // 1 % to 1.7 % and broke the named skewed T at 0/175/265.
  if (step >= COARSE_EPS && Math.PI - psi < TAPER_ANGLE) {
    const taperRun = step / Math.tan(TAPER_ANGLE) / 2;
    return { i, j, mode: 'taper', x: null, psi, fillet: null, trimI: taperRun, trimJ: taperRun };
  }

  const hit = lineLine(a0, a.dir, b0, b.dir, SIN_EPS);

  // --- Collinear pair: no corner point exists. -----------------------------
  if (!hit) {
    if (step < COARSE_EPS) return collinear(i, j, psi, 0);
    const taperRun = step / Math.tan(TAPER_ANGLE) / 2;
    return { i, j, mode: 'taper', x: null, psi, fillet: null, trimI: taperRun, trimJ: taperRun };
  }

  const x = hit.point;
  const reach = Math.max(dist(x, a.origin), dist(x, b.origin));
  const maxHw = Math.max(a.hw, b.hw);

  // --- Very acute wedge: rounding would run away, so bevel it. -------------
  //
  // The setback is used EXACTLY, with no miter clamp. `acuteSetback` is the
  // distance at which two rays separated by `psi` stop overlapping, so any
  // smaller value guarantees one leg's mouth lands inside the other's
  // carriageway — which is precisely how a shallow fork degenerates into a
  // self-intersecting ring. A shallow fork really does need a long gore area;
  // the only legitimate bound is the segment's own length, applied globally by
  // `clampSegmentTrims`.
  const scale = clamp(Math.min(radiusScale[i] ?? 1, radiusScale[j] ?? 1), 0, 1);
  const scaled = curbRadius(a.hwSidewalk, b.hwSidewalk) * scale;

  if (psi < ACUTE_EPS || reach > CORNER_MITER * maxHw) {
    const t = acuteSetback(psi, a.hw, b.hw);

    // Round the setback instead of chording it.
    //
    // A bevel is a STRAIGHT CHORD across the wedge, and it is what made skewed
    // junctions between different classes look chopped: measured over every
    // ordered class pair at 90/75/60/45/30/20 degrees, 18.8 % of all corners
    // landed here, and a diagonal road crossing a grid hits it at every corner.
    //
    // THE RADIUS PAYS ONLY THE REMAINING DISTANCE. `filletCorner` measures its
    // run from the miter point `x`, and lands the tangency at
    // `project(x, leg) + run`. An earlier version passed the whole setback as
    // the run and its comment claimed the trims still came out at `t` — they
    // came out at `project(x, leg) + t`, charging the setback twice. Measured
    // over 36 864 corners it inflated the mean trim by 20 %, drew "kerb
    // returns" of up to 126 units, and put 8.5 % of all corners above the
    // widest radius this engine is willing to hand out.
    //
    // The floor is still honoured on every path, which is what
    // .claude/rules/geometry.md requires: with `r >= rNeed` the tangency lands
    // at or beyond `t`, and the chord fallback uses `t` exactly.
    const rNeed = (t - Math.min(project(x, a), project(x, b))) * Math.tan(psi / 2);
    if (rNeed <= CURB_R_MAX) {
      // `filletCorner` refuses a wedge below `ACUTE_EPS`, where the arc centre
      // runs off to infinity and the construction stops being sound. Those keep
      // the chord, which is the right shape for a near-degenerate fork.
      const rounded = filletCorner(x, a.dir, b.dir, Math.max(scaled, rNeed));
      if (rounded) {
        return {
          i,
          j,
          mode: 'fillet',
          x,
          psi,
          fillet: rounded,
          trimI: project(rounded.ta, a),
          trimJ: project(rounded.tb, b),
        };
      }
    }
    return { i, j, mode: 'bevel', x, psi, fillet: null, trimI: t, trimJ: t };
  }

  // --- Normal case: a curb return. ----------------------------------------
  //
  // The radius is grown, when it has to be, until the arc's tangencies reach
  // the mouths the legs are ACTUALLY cut at. That is the whole of VIS-5.
  //
  // A leg's mouth is a straight cut at the maximum its two corners demand, so
  // one corner's tangency routinely sits short of it. The boundary then crosses
  // the mouth, turns square, retreats along the leg's boundary line to reach
  // the arc, and turns square again: a staircase in the kerb. Measured on the
  // derived outline, six sharp concave corners on a T and twenty on a five-leg
  // star, where a clean junction has none.
  //
  // Solving it is a fixed point, not a formula: enlarging the radius pushes the
  // tangency out, which raises the leg's trim, which is the number this reads.
  // `buildJunction` iterates until it settles. A circular arc has one radius and
  // therefore equal runs on both sides, so the LARGER of the two demands wins
  // and the shorter side's mouth grows to meet it on the next pass.
  //
  // Bounded by the same reach the miter test uses, so a pair of legs whose
  // trims differ absurdly keeps its step instead of sweeping an arc across the
  // whole junction.
  let radius = scaled;
  if (mouthTrims.length) {
    const need =
      Math.max(
        (mouthTrims[i] ?? 0) - project(x, a),
        (mouthTrims[j] ?? 0) - project(x, b),
      ) * Math.tan(psi / 2);
    if (need > radius && need <= CORNER_MITER * maxHw) radius = need;
  }
  const fillet = radius > 0 ? filletCorner(x, a.dir, b.dir, radius) : null;

  if (!fillet) {
    const t = Math.max(project(x, a), project(x, b));
    return { i, j, mode: 'bevel', x, psi, fillet: null, trimI: t, trimJ: t };
  }

  // The reported trims are CLAMPED to the mouths the legs already have.
  //
  // This is what makes reaching a mouth free. `computeTrims` takes the maximum
  // over a leg's two corners, so an unclamped tangency past the mouth would
  // push the mouth further out, which lengthens the junction, which eats the
  // link beside it — measured as two vehicles left holding a junction they
  // could never enter, on a grid of 70-unit blocks.
  //
  // Clamped, the growth is invisible to the trim solver: the arc simply starts
  // further along a boundary the ribbon already covers, and `buildJunctionRing`
  // follows `fillet.ta` rather than this number precisely because the two are
  // no longer the same point.
  const cap = (value: number, index: number): number =>
    mouthTrims.length ? Math.min(value, mouthTrims[index] ?? value) : value;

  return {
    i,
    j,
    mode: 'fillet',
    x,
    psi,
    fillet,
    trimI: cap(project(fillet.ta, a), i),
    trimJ: cap(project(fillet.tb, b), j),
  };
}

const collinear = (i: number, j: number, psi: number, t: number): Corner => ({
  i,
  j,
  mode: 'collinear',
  x: null,
  psi,
  fillet: null,
  trimI: t,
  trimJ: t,
});

/** Distance along `leg` at which `p` sits, measured from the leg's ray origin. */
export const project = (p: Vec2, leg: Leg): number =>
  dot(sub(p, leg.origin), leg.dir);
