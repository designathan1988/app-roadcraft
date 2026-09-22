import { dot } from '@core/vec2';
import type { Ring } from '@core/ring';
import type { RoadDoc } from '../doc';
import type { NodeId, SegmentId } from '../ids';
import type { PolylineCache } from '../geometry';
import {
  Level,
  SURFACE_LEVELS,
  type SurfaceLevel,
  halfWidth,
  roadProfile,
} from '../roadTypes';
import { type Leg, buildLegs } from './legs';
import { type Corner, computeCorners } from './corners';
import { computeTrims } from './trim';
import { buildJunctionRing, findSlabViolations } from './polygon';
import { COARSE_EPS, FINE_EPS } from '@core/scalar';

/** How a node behaves geometrically. */
export type SurfaceMode = 'none' | 'junction';

/** Two legs of the same class meeting at less than this angle need no junction. */
const CHAIN_BEND_COS = Math.cos((5 * Math.PI) / 180);

/** Runaway guard for the slab-separation loop, as a multiple of the widest leg. */
const SLAB_BUMP_CAP = 40;


export interface Junction {
  readonly nodeId: NodeId;
  readonly level: SurfaceLevel;
  readonly legs: readonly Leg[];
  readonly corners: readonly Corner[];
  /** Trim distance per leg, indexed the same way as `legs`. */
  readonly trims: readonly number[];
  /** The corner boundary: mouth cuts joined by curb returns. */
  readonly ring: Ring;
  /** Per-leg carriageway rectangles from the node out to each mouth. */
  readonly tongues: readonly Ring[];
  /** Everything this junction contributes to its level, unioned by the painter. */
  readonly rings: readonly Ring[];
  readonly usedHullFallback: boolean;
}

/**
 * Classifies a node.
 *
 * A degree-2 node joining two segments of the same class at a gentle angle is
 * not a junction at all: the two segments merge into one render chain and
 * nothing is drawn there, so no sliver polygon and no seam can appear.
 *
 * A node joining two different STRUCTURES is always a junction, however
 * straight it looks. It is the terminal of a ramp: the raised deck comes down
 * to the ground there and the two connect, so the node needs a mouth like any
 * other connection. Treated as a bend in a chain instead, no junction was built
 * and the ground road kept its closed end — its kerb and footway bands closed
 * across the carriageway and painted a pale stripe over the join, measured on a
 * saved map as a 7.5-unit cap on a road that visibly continued.
 */
export function surfaceMode(doc: RoadDoc, cache: PolylineCache, nodeId: NodeId): SurfaceMode {
  const node = doc.node(nodeId);
  if (!node || node.incident.length < 2) return 'none';
  if (node.incident.length > 2) return 'junction';

  const p = node.incident[0];
  const q = node.incident[1];
  if (p === undefined || q === undefined) return 'none';
  const sp = doc.segment(p);
  const sq = doc.segment(q);
  if (!sp || !sq) return 'none';
  if ((sp.structure ?? 'ground') !== (sq.structure ?? 'ground')) return 'junction';
  if (sp.type !== sq.type) return 'junction';

  // A chain needs the same WIDTH, not merely the same class.
  //
  // Width is `roadProfile(type, lanes, direction)`, and both `lanes` and
  // `direction` are per-segment overrides. Comparing only `type` merged a
  // two-lane street into an eight-lane one-way of the same class and called it
  // a bend in a chain: no junction, no trim and no taper, so a width step of
  // more than thirty units was drawn as a butt joint with each ribbon's closed
  // end sticking out of the other. The taper machinery in `corners.ts` exists
  // for exactly this shape and could never be reached.
  const wp = roadProfile(sp.type, sp.lanes, sp.direction);
  const wq = roadProfile(sq.type, sq.lanes, sq.direction);
  for (const level of SURFACE_LEVELS) {
    if (Math.abs(halfWidth(wp, level) - halfWidth(wq, level)) >= COARSE_EPS) return 'junction';
  }

  const legs = buildLegs(doc, cache, nodeId, Level.Asphalt);
  if (legs.length < 2) return 'none';
  // Directions point away from the node, so a straight-through node has them
  // opposed: dot near -1.
  const d = dot((legs[0] as Leg).dir, (legs[1] as Leg).dir);
  return d <= -CHAIN_BEND_COS ? 'none' : 'junction';
}

export interface BuildOptions {
  /** Per-segment curb-radius scale, keyed by segment id. Defaults to 1. */
  readonly radiusScaleBySegment?: ReadonlyMap<number, number>;
  /**
   * Final per-segment mouth limits, keyed by segment id.
   *
   * Network reconciliation supplies these for short links after both ends have
   * competed for the available length. Applying the same limit here keeps the
   * junction mouth and its ribbon bit-for-bit aligned.
   */
  readonly maxTrimBySegment?: ReadonlyMap<number, number>;
  /** Refinement passes for curved legs. Two is enough for a single quadratic. */
  readonly refinePasses?: number;
}

/**
 * Builds one surface level of one junction.
 *
 * Everything here is per-level: half-widths, corners, curb returns and trims.
 * That is what makes the level rings nest, and it is the structural fix for the
 * V6 monolith's seven layers all stopping at the same distance along every leg
 * (defect 1.2) as well as its single isotropic radius (defect 1.6).
 */
export function buildJunction(
  doc: RoadDoc,
  cache: PolylineCache,
  nodeId: NodeId,
  level: SurfaceLevel,
  opts: BuildOptions = {},
): Junction | null {
  const node = doc.node(nodeId);
  if (!node || node.incident.length < 2) return null;

  const passes = opts.refinePasses ?? 2;

  let legs = buildLegs(doc, cache, nodeId, level);

  // EVERYTHING per-leg below is keyed by SEGMENT, never carried across a
  // re-solve as a positional array.
  //
  // `buildLegs` reads the node's incident list in segment-id order and returns
  // it sorted by ANGLE. Any array handed back to it, or reused after it runs
  // again, is therefore indexed in a different order than it will be read in.
  // Both `scale` and `trims` used to be positional and both were silently
  // permuted on every refinement pass, so each leg was framed at another leg's
  // trim distance — which is exactly the error the refinement loop exists to
  // remove.
  const scaleOf = (leg: Leg): number => opts.radiusScaleBySegment?.get(leg.seg) ?? 1;
  const capTrims = (values: readonly number[], currentLegs: readonly Leg[]): number[] =>
    values.map((value, i) =>
      Math.min(value, opts.maxTrimBySegment?.get((currentLegs[i] as Leg).seg) ?? Infinity),
    );
  /** Re-keys this pass's positional trims so the next pass cannot mis-index them. */
  const bySegment = (
    values: readonly number[],
    currentLegs: readonly Leg[],
  ): Map<SegmentId, number> => {
    const out = new Map<SegmentId, number>();
    currentLegs.forEach((leg, i) => out.set(leg.seg, values[i] as number));
    return out;
  };

  let corners = computeCorners(legs, legs.map(scaleOf));
  let trims = capTrims(computeTrims(legs, corners), legs);

  // Curved legs: the mouth cut must be perpendicular to the tangent AT the trim
  // distance, not at the node. Re-frame the legs with the trims just found and
  // solve again. Converges in two passes for a quadratic.
  for (let pass = 0; pass < passes; pass++) {
    legs = buildLegs(doc, cache, nodeId, level, { trims: bySegment(trims, legs) });
    // Re-derived from the NEW leg order rather than reused from the old one.
    corners = computeCorners(legs, legs.map(scaleOf));
    trims = capTrims(computeTrims(legs, corners), legs);
  }

  // NOT DONE HERE. Three attempts, each measured — see VIS-5 and the
  // failed-attempts list in .codex/state.json.
  //
  // The staircase in a junction kerb is the gap between what one corner's arc
  // demands and where its leg is actually cut, which is the maximum over BOTH
  // its corners. Growing each arc until it reaches its own mouth fixes it:
  // sharp concave corners on the derived outline go 13 -> 1 on a four-leg
  // crossing of two classes and 20 -> 12 on a five-leg star.
  //
  // Both ways of arranging that growth break something load-bearing:
  //
  //   Let the mouths move out to meet the arcs — every junction lengthens, the
  //   link beside it shortens, and the 4x4 grid of 70-unit blocks ends with two
  //   vehicles holding a junction they can never enter. Scaling by the
  //   per-segment radius factor did not recover it.
  //
  //   Clamp the reported trims so the mouths cannot move — the radius then
  //   depends on THIS level's trims, and every level has its own. The levels
  //   stop nesting, which is the guarantee that keeps a kerb inside its footway,
  //   and the ring simplicity fuzz rate rises with it.
  //
  // The route that remains is to derive the growth once, from a single level's
  // trims, and apply that same radius at every level — which needs the caller
  // to coordinate across levels rather than building each one alone.
  //
  // `computeCorners` keeps its optional trims parameter for that work.

  // Non-adjacent legs must not have their mouths land inside another leg's
  // carriageway.
  // The cap is deliberately loose: a shallow fork legitimately needs a very
  // long gore, and the real bound on trim length is the segment itself, applied
  // globally afterwards. Capping here is what makes mouths overlap.
  const maxHw = legs.reduce((mx, l) => Math.max(mx, l.hw), 0);
  const bumpCap = SLAB_BUMP_CAP * maxHw;
  for (let attempt = 0; attempt < 8; attempt++) {
    const bad = findSlabViolations(legs, trims);
    if (bad.length === 0) break;
    const next = trims.slice();
    let changed = false;
    for (const i of bad) {
      const leg = legs[i] as Leg;
      const limit = opts.maxTrimBySegment?.get(leg.seg) ?? Infinity;
      const bumped = Math.min((next[i] as number) * 1.25 + 0.5, bumpCap, limit);
      // Only ever GROW. This assignment used to be unconditional, so whenever
      // `limit` or `bumpCap` bit, the loop named "bump" pushed the trim BELOW
      // what `computeCorners` demanded and reintroduced the very mouth-inside-
      // another-carriageway overlap it was invoked to remove.
      if (bumped > (next[i] as number) + FINE_EPS) {
        next[i] = bumped;
        changed = true;
      }
    }
    trims = next;
    // A length cap can make a slab violation geometrically unavoidable. The
    // ring validator below then falls back to a safe union shape; retrying the
    // same capped values cannot improve it.
    if (!changed) break;
  }

  // ---- a node the editor would have refused ------------------------------
  //
  // The map can still contain one: `localStorage`, an imported file, an undo
  // into an older state, or a map made before the rule existed. Refusing to
  // LOAD is not an option — that destroys the user's work — so the shape is
  // built degraded instead.
  //
  // DEGRADING A HAIRPIN JUNCTION HERE: TWO ATTEMPTS, BOTH MEASURED, BOTH WORSE.
  // Left undone deliberately; the rule that matters now runs upstream instead.
  //
  // The goal was: a node below `MIN_LEG_ANGLE` should not paint a long finger
  // of kerb and footway across open grass. `scripts/probe-tongues.mjs` puts a
  // 7-degree hairpin's tongue at 246 units, 16.6 times the road's half-width,
  // against 2.0 for a healthy cross or T.
  //
  //   1. Capping the TRIMS at three half-widths. The hull-fallback rate over
  //      five thousand random junctions went from under 1 % to 53 %, and the
  //      named 15-degree fork broke. Exactly what `corners.ts:112` predicts: a
  //      shorter setback puts one leg's mouth inside the other's carriageway
  //      and the ring stops being simple. Half the map on a convex hull is a
  //      worse map than a pale finger.
  //
  //   2. Shortening or dropping the TONGUES, leaving the ring untouched. The
  //      fuzz sweep catches it by sampling the midpoint between node and mouth:
  //      at a hairpin the corner ring's vertices all sit far from the node, so
  //      the tongue is the only thing covering the approach. Shortening it puts
  //      a HOLE in the drivable surface — a hole where a vehicle drives, which
  //      is worse than a pale patch where nothing does.
  //
  // Both would have needed an existing test weakened to land, and a test that
  // says "no hole in the surface a car drives on" is not one to weaken.
  //
  // What actually removes the defect is upstream, and is in place:
  // `MIN_LEG_ANGLE` now governs drawing (`editor/commit.ts`), dragging
  // (`RoadDoc.moveNode`) and loading (`Network.impossible`, surfaced in the
  // status bar and the inspector). No new hairpin can be made; an old one is
  // named and offered a repair.

  const built = buildJunctionRing(legs, corners, trims);

  return {
    nodeId,
    level,
    legs,
    corners,
    trims,
    ring: built.ring,
    tongues: built.tongues,
    rings: built.rings,
    usedHullFallback: built.usedHullFallback,
  };
}
