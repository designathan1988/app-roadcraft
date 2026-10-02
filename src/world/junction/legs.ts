import { type Vec2, addScaled, angleOf } from '@core/vec2';
import { LEG_TRIM_CAP } from '../approach';
import type { RoadDoc, SegmentDirection } from '../doc';
import type { NodeId, SegmentId } from '../ids';
import { type RoadType, type SurfaceLevel, halfWidth, roadProfile, sidewalkHalf } from '../roadTypes';
import { type PolylineCache, frameFromNode, farNode, segmentStartsAt } from '../geometry';

/**
 * One approach arm of a junction, resolved at a specific surface level.
 *
 * `origin` is a *virtual* ray origin: the point from which a straight ray along
 * `dir` reaches the mouth at exactly `trim`. For a straight leg it is the node
 * itself. For a curved leg it is displaced so that the mouth cut stays
 * perpendicular to the tangent **at the trim distance** rather than at the
 * node — skipping that is the classic cause of junction mouths not lining up
 * with the road on curves.
 */
export interface Leg {
  readonly seg: SegmentId;
  readonly far: NodeId;
  readonly origin: Vec2;
  readonly dir: Vec2;
  readonly nrm: Vec2;
  readonly ang: number;
  /** Half-width of this leg at the level being built. */
  readonly hw: number;
  /** Half-width at the sidewalk level, used to size curb radii consistently. */
  readonly hwSidewalk: number;
  /** Total arc length of the segment carrying this leg. */
  readonly length: number;
  readonly typeIndex: number;
  readonly direction: SegmentDirection;
  /**
   * Whether any traffic on this leg travels TOWARD the junction.
   *
   * `direction` alone cannot answer this: `aToB` approaches the node when the
   * node is the segment's `b` end and departs from it when the node is the `a`
   * end. Only the builder knows which end this leg is, so it resolves the
   * question here rather than leaving every consumer to re-derive it — and get
   * it wrong. The painter used to put a stop bar on every leg, including a
   * one-way leg whose traffic only leaves: a stop line where nothing stops.
   */
  readonly approaching: boolean;
  readonly road: RoadType;
}

export interface LegBuildOptions {
  /**
   * Per-leg trim guesses, keyed by SEGMENT.
   *
   * It used to be a positional array, and that was a real defect: this builder
   * consumes its input in segment-id order but returns the legs sorted by
   * ANGLE, so the refinement pass in `build.ts` fed every leg the trim
   * belonging to whichever leg happened to share its index in the other
   * ordering. On any junction whose angular order differs from its id order —
   * which is almost all of them — each leg was framed at the wrong arc
   * distance, so the mouth cut was not perpendicular to the tangent at the
   * mouth and `origin` was back-projected by the wrong amount. That is
   * precisely the defect the refinement loop exists to remove.
   *
   * A map cannot be mis-indexed by a re-sort, so the bug cannot return.
   */
  readonly trims?: ReadonlyMap<SegmentId, number>;
}

/**
 * Builds the legs of a node, sorted counter-clockwise by outgoing angle.
 *
 * Sorting is by angle and the ring is emitted in that same order, which is the
 * first of four layers guaranteeing the junction polygon stays simple. The V6
 * monolith sorted by angle too, but then emitted each leg's two corners in a
 * fixed `-perp, +perp` order regardless of winding, which is what produced
 * bowtie polygons at Y and skewed-T junctions (defect 1.1).
 */
export function buildLegs(
  doc: RoadDoc,
  cache: PolylineCache,
  nodeId: NodeId,
  level: SurfaceLevel,
  opts: LegBuildOptions = {},
): Leg[] {
  const node = doc.node(nodeId);
  if (!node) return [];

  // Stable input order so cluster/leg indices are deterministic across rebuilds.
  const incident = node.incident.slice().sort((x, y) => x - y);

  const legs: Leg[] = incident.map((segId) => {
    const seg = doc.requireSegment(segId);
    const rt = roadProfile(seg.type, seg.lanes, seg.direction, seg.section);
    const pl = cache.get(doc, segId);
    const startsHere = segmentStartsAt(seg, nodeId);
    const hw = halfWidth(rt, level);

    // Initial guess: the leg's own half-width. Two refinement passes converge
    // for a single quadratic, which is all a segment can carry.
    //
    // `LEG_TRIM_CAP` bounds the GUESS only. A refined trim is framed where it
    // really is: the solver can settle past the cap on a short leg into a wide
    // junction, and framing it at the cap instead cut the mouth perpendicular
    // to the tangent 20 units short of the real mouth - on a curved leg, a
    // wedge of bare ground between the plate and the ribbon (the fuzzer's
    // `surfaceGap`).
    const refined = opts.trims?.get(segId);
    const guess = refined ?? hw;
    const clamped = Math.max(0, Math.min(guess, pl.length * (refined === undefined ? LEG_TRIM_CAP : 1)));
    const f = frameFromNode(pl, startsHere, clamped);

    return {
      seg: segId,
      far: farNode(seg, nodeId),
      // Back-project so that origin + dir * trim lands exactly on the mouth.
      origin: addScaled(f.p, f.dir, -clamped),
      dir: f.dir,
      nrm: f.nrm,
      ang: angleOf(f.dir),
      hw,
      hwSidewalk: sidewalkHalf(rt),
      length: f.length,
      typeIndex: seg.type,
      direction: seg.direction,
      approaching:
        seg.direction === 'both' ||
        (startsHere ? seg.direction === 'bToA' : seg.direction === 'aToB'),
      road: rt,
    };
  });

  legs.sort((p, q) => p.ang - q.ang || p.seg - q.seg);
  return legs;
}

/** The mouth corner on the `-nrm` side of a leg, at distance `t`. */
export const mouthRight = (leg: Leg, t: number): Vec2 =>
  addScaled(addScaled(leg.origin, leg.dir, t), leg.nrm, -leg.hw);

/** The mouth corner on the `+nrm` side of a leg, at distance `t`. */
export const mouthLeft = (leg: Leg, t: number): Vec2 =>
  addScaled(addScaled(leg.origin, leg.dir, t), leg.nrm, leg.hw);
