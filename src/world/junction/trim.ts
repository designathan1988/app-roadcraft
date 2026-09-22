import { MIN_RIBBON } from '@core/scalar';
import { MIN_DRIVABLE_RESERVE, RESERVE_CAP } from '../approach';
import type { Corner } from './corners';
import type { Leg } from './legs';

/**
 * THE trim solver. There is exactly one of these in the codebase.
 *
 * The V6 monolith had two competing formulas — `junctionCut` clamped to
 * `max(1.5, len * 0.42)` for the road body, while the junction polygon used
 * `min(that + 1.4, max(1, len * 0.48))`. On short stubs they disagreed, leaving
 * wedges of bare terrain at the mouth, and a separate bail-out skipped trimming
 * entirely (defect 1.5). Here the ribbon start and the junction mouth read the
 * same number by construction, and a test asserts it bit-for-bit.
 *
 * Each leg is pushed back far enough to clear BOTH of its adjacent corners,
 * including the room a curb return needs for its tangency point.
 */
export function computeTrims(legs: readonly Leg[], corners: readonly Corner[]): number[] {
  const n = legs.length;
  const trims = new Array<number>(n).fill(0);
  if (n < 2) return trims;

  for (const c of corners) {
    if (c.trimI > (trims[c.i] as number)) trims[c.i] = c.trimI;
    if (c.trimJ > (trims[c.j] as number)) trims[c.j] = c.trimJ;
  }

  for (let i = 0; i < n; i++) {
    trims[i] = Math.max(0, trims[i] as number);
  }
  return trims;
}

export interface SegmentTrimBudget {
  /** Trim demanded at the `a` end. */
  a: number;
  /** Trim demanded at the `b` end. */
  b: number;
  /** Arc length of the segment. */
  readonly length: number;
}

export interface ClampResult {
  readonly a: number;
  readonly b: number;
  /** Factor the two demands were scaled by; 1 when nothing was clamped. */
  readonly scale: number;
}

/**
 * Reconciles the two ends of a segment against its own length.
 *
 * Never bails out. When the two junctions want more than the segment has, both
 * demands are scaled by the same factor so the ribbon keeps a minimum visible
 * length, and the caller re-runs the junction build with that factor applied to
 * the curb radii so the tangency stays behind the mouth.
 */
export function clampSegmentTrims(budget: SegmentTrimBudget): ClampResult {
  // Two things compete for a segment's length: the junctions at each end, and
  // the drivable link between them. The link wins. A junction squeezed a little
  // tight is cosmetic; a link too short to hold a vehicle is a dead end that
  // wedges the network, which is exactly how the V6 monolith failed.
  //
  // On a comfortable segment the reserve is not binding and the junctions get
  // everything they asked for.
  const reserve = Math.min(MIN_DRIVABLE_RESERVE, budget.length * RESERVE_CAP);
  const available = budget.length - Math.max(MIN_RIBBON, reserve);
  const total = budget.a + budget.b;
  if (available <= 0) {
    // Pathologically short segment: split what little there is.
    const half = Math.max(0, (budget.length - MIN_RIBBON) / 2);
    return { a: half, b: half, scale: 0 };
  }
  if (total <= available) return { a: budget.a, b: budget.b, scale: 1 };

  const k = available / total;
  return { a: budget.a * k, b: budget.b * k, scale: k };
}
